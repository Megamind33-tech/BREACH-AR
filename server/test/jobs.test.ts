import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { startHarness } from './helpers.js';
import { hashPassword } from '../src/security.js';
import { sweepJobs } from '../src/jobs.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54330); });
after(async () => { await h.stop(); });

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
type Hdr = Record<string, string>;

async function mkOrg(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function mkUser(orgId: string, email: string, role: string) {
  await h.db.query('INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,$2,$3,$4)', [orgId, email, await hashPassword('another long password'), role]);
  const l = await post('/api/v1/auth/login', { email, password: 'another long password' });
  return { authorization: `Bearer ${l.json().token}` } as Hdr;
}
async function enroll(auth: Hdr, guid: string, siteId?: string) {
  const t = await post('/api/v1/enrollment-tokens', siteId ? { siteId } : {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname: guid, agentVersion: '0.1.0' });
  assert.equal(e.statusCode, 201);
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr, publicKey: e.json().jobSigningPublicKey as string };
}
const beat = async (dev: Hdr) => (await post('/agent/v1/heartbeat', { hostname: 'x', agentVersion: '0.0.1', metrics: {} }, dev)).json();
const mkJob = async (auth: Hdr, deviceId: string, type = 'health.check', params: object = {}) =>
  post('/api/v1/jobs', { type, params, target: { deviceIds: [deviceId] } }, auth);

test('enrollment returns the signing public key; delivered jobs verify and tampering is detected', async () => {
  const a = await mkOrg('Sign Org', 'o@sign.test');
  const d = await enroll(a.auth, 'sign-0001');
  assert.equal(d.publicKey, h.signer.publicKeySpkiBase64);
  const created = await mkJob(a.auth, d.deviceId, 'hardware.diagnose');
  assert.equal(created.statusCode, 201);
  const hb = await beat(d.dev);
  assert.equal(hb.jobs.length, 1);
  const { payload, signature } = hb.jobs[0];
  const pub = createPublicKey({ key: Buffer.from(d.publicKey, 'base64'), format: 'der', type: 'spki' });
  const ok = (p: string, s: string) => verify('sha256', Buffer.from(p), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64'));
  assert.ok(ok(payload, signature));
  assert.ok(!ok(payload.replace('hardware.diagnose', 'service.restart'), signature), 'tampered payload must not verify');
  const body = JSON.parse(payload);
  assert.equal(body.deviceId, d.deviceId);
  assert.equal(body.orgId, a.orgId);
  assert.equal(body.type, 'hardware.diagnose');
});

test('lifecycle queued -> running -> completed, with idempotent and invalid transitions', async () => {
  const a = await mkOrg('Life Org', 'o@life.test');
  const d = await enroll(a.auth, 'life-0001');
  const other = await enroll(a.auth, 'life-0002');
  const jobId = (await mkJob(a.auth, d.deviceId)).json().jobs[0].id;
  assert.equal((await get(`/api/v1/jobs/${jobId}`, a.auth)).json().status, 'queued');
  assert.equal((await post(`/agent/v1/jobs/${jobId}/start`, {}, other.dev)).statusCode, 404, 'another device cannot start it');
  assert.equal((await post(`/agent/v1/jobs/${jobId}/result`, { status: 'completed' }, d.dev)).statusCode, 409, 'cannot finish before starting');
  assert.equal((await post(`/agent/v1/jobs/${jobId}/start`, {}, d.dev)).statusCode, 200);
  assert.equal((await post(`/agent/v1/jobs/${jobId}/start`, {}, d.dev)).statusCode, 409, 'cannot start twice');
  assert.equal((await post(`/agent/v1/jobs/${jobId}/result`, { status: 'completed' }, other.dev)).statusCode, 404);
  assert.equal((await get(`/api/v1/jobs/${jobId}`, a.auth)).json().status, 'running');
  assert.equal((await post(`/agent/v1/jobs/${jobId}/result`, { status: 'completed', result: { hello: 'world' } }, d.dev)).statusCode, 200);
  assert.deepEqual((await post(`/agent/v1/jobs/${jobId}/result`, { status: 'completed', result: { hello: 'world' } }, d.dev)).json(), { ok: true, duplicate: true });
  assert.equal((await post(`/agent/v1/jobs/${jobId}/result`, { status: 'failed' }, d.dev)).statusCode, 409, 'terminal state cannot change');
  const j = (await get(`/api/v1/jobs/${jobId}`, a.auth)).json();
  assert.equal(j.status, 'completed');
  assert.deepEqual(j.result, { hello: 'world' });
  assert.equal((await beat(d.dev)).jobs.length, 0, 'finished jobs are never redelivered');
  const audit = (await get('/api/v1/audit', a.auth)).json().entries.map((e: any) => e.action);
  for (const act of ['job.create', 'job.start', 'job.finish']) assert.ok(audit.includes(act), act);
});

test('organizations cannot see, target, cancel or receive each other jobs', async () => {
  const a = await mkOrg('Iso A', 'a@jiso.test'), b = await mkOrg('Iso B', 'b@jiso.test');
  const da = await enroll(a.auth, 'jiso-org-a'), db_ = await enroll(b.auth, 'jiso-org-b');
  const jobA = (await mkJob(a.auth, da.deviceId)).json().jobs[0].id;
  assert.equal((await mkJob(b.auth, da.deviceId)).statusCode, 404, 'cannot target other org device');
  assert.equal((await get(`/api/v1/jobs/${jobA}`, b.auth)).statusCode, 404);
  assert.equal((await post(`/api/v1/jobs/${jobA}/cancel`, {}, b.auth)).statusCode, 404);
  assert.equal((await get('/api/v1/jobs', b.auth)).json().jobs.length, 0);
  assert.equal((await beat(db_.dev)).jobs.length, 0);
  assert.equal((await post('/api/v1/jobs', { type: 'health.check', target: { all: true } }, b.auth)).json().count, 1, '"all" only means my org');
  assert.equal((await get(`/api/v1/jobs?deviceId=${da.deviceId}`, b.auth)).json().jobs.length, 0);
});

test('roles and validation are enforced', async () => {
  const a = await mkOrg('Role Job Org', 'o@rj.test');
  const viewer = await mkUser(a.orgId, 'v@rj.test', 'viewer'), tech = await mkUser(a.orgId, 't@rj.test', 'technician');
  const d = await enroll(a.auth, 'rolejob-0001');
  assert.equal((await mkJob(viewer, d.deviceId)).statusCode, 403);
  assert.equal((await mkJob(tech, d.deviceId, 'health.check')).statusCode, 201);
  assert.equal((await mkJob(tech, d.deviceId, 'service.restart', { name: 'Spooler' })).statusCode, 403, 'changing jobs need admin');
  { const rr = await mkJob(a.auth, d.deviceId, 'service.restart', { name: 'Spooler' }); assert.equal(rr.statusCode, 201, rr.body); }
  assert.equal((await mkJob(a.auth, d.deviceId, 'rm.everything')).statusCode, 400, 'unknown type');
  assert.equal((await mkJob(a.auth, d.deviceId, 'service.restart', { name: 'x; del /q *' })).statusCode, 400, 'injection-shaped param');
  assert.equal((await mkJob(a.auth, d.deviceId, 'service.restart', { name: 'a', extra: 1 })).statusCode, 400, 'unknown param');
  assert.equal((await mkJob(a.auth, d.deviceId, 'health.check', { command: 'calc' })).statusCode, 400, 'health.check takes no params');
  assert.equal((await post('/api/v1/jobs', { type: 'health.check', target: { all: true, siteId: '00000000-0000-4000-8000-000000000000' } }, a.auth)).statusCode, 400, 'exactly one target');
  assert.equal((await mkJob(a.auth, '00000000-0000-4000-8000-000000000000')).statusCode, 404);
  assert.equal((await get('/api/v1/job-types', viewer)).json().types.length >= 9 && (await get('/api/v1/job-types', viewer)).json().types.some((t: any) => t.type === 'security.scan'), true);
});

test('cancel: queued jobs stop immediately, running jobs are told to stop', async () => {
  const a = await mkOrg('Cancel Org', 'o@cancel.test');
  const d = await enroll(a.auth, 'cancel-0001');
  const q = (await mkJob(a.auth, d.deviceId)).json().jobs[0].id;
  assert.equal((await post(`/api/v1/jobs/${q}/cancel`, {}, a.auth)).json().status, 'cancelled');
  assert.equal((await beat(d.dev)).jobs.length, 0, 'cancelled job not delivered');
  assert.equal((await post(`/agent/v1/jobs/${q}/start`, {}, d.dev)).statusCode, 409);
  assert.equal((await post(`/api/v1/jobs/${q}/cancel`, {}, a.auth)).statusCode, 409, 'already terminal');

  const r = (await mkJob(a.auth, d.deviceId, 'hardware.diagnose')).json().jobs[0].id;
  await post(`/agent/v1/jobs/${r}/start`, {}, d.dev);
  const c = (await post(`/api/v1/jobs/${r}/cancel`, {}, a.auth)).json();
  assert.equal(c.status, 'running'); assert.equal(c.cancelRequested, true);
  assert.deepEqual((await beat(d.dev)).cancel, [r]);
  await post(`/agent/v1/jobs/${r}/result`, { status: 'cancelled' }, d.dev);
  assert.equal((await get(`/api/v1/jobs/${r}`, a.auth)).json().status, 'cancelled');
});

test('bulk targeting by site, department, all; batch listing and counts', async () => {
  const a = await mkOrg('Bulk Org', 'o@bulk.test');
  const hq = (await post('/api/v1/sites', { name: 'HQ' }, a.auth)).json(), br = (await post('/api/v1/sites', { name: 'Branch' }, a.auth)).json();
  const fin = (await post('/api/v1/departments', { siteId: hq.id, name: 'Finance' }, a.auth)).json();
  const d1 = await enroll(a.auth, 'bulk-dev-1', hq.id), d2 = await enroll(a.auth, 'bulk-dev-2', hq.id), d3 = await enroll(a.auth, 'bulk-dev-3', br.id);
  await h.db.query('UPDATE devices SET department_id=$1 WHERE id=$2', [fin.id, d1.deviceId]);
  const bySite = (await post('/api/v1/jobs', { type: 'inventory.refresh', target: { siteId: hq.id } }, a.auth)).json();
  assert.equal(bySite.count, 2);
  assert.equal((await post('/api/v1/jobs', { type: 'inventory.refresh', target: { departmentId: fin.id } }, a.auth)).json().count, 1);
  assert.equal((await post('/api/v1/jobs', { type: 'health.check', target: { all: true } }, a.auth)).json().count, 3);
  const batch = (await get(`/api/v1/jobs?batchId=${bySite.batchId}`, a.auth)).json();
  assert.equal(batch.jobs.length, 2); assert.deepEqual(batch.counts, { queued: 2 });
  assert.equal((await beat(d3.dev)).jobs.length, 1, 'branch device only got the "all" job');
  assert.equal((await beat(d2.dev)).jobs.length, 2);
  void d1;
});

test('sweeper fails expired queued jobs and jobs whose device vanished mid-run', async () => {
  const a = await mkOrg('Sweep Org', 'o@sweep.test');
  const d = await enroll(a.auth, 'sweep-0001');
  const q = (await mkJob(a.auth, d.deviceId)).json().jobs[0].id;
  const r = (await mkJob(a.auth, d.deviceId, 'hardware.diagnose')).json().jobs[0].id;
  await post(`/agent/v1/jobs/${r}/start`, {}, d.dev);
  assert.equal(await sweepJobs(h.db), 0, 'nothing to sweep yet');
  await h.db.query("UPDATE jobs SET expires_at = now() - interval '1 minute' WHERE id=$1", [q]);
  await h.db.query("UPDATE jobs SET started_at = now() - interval '2 hours' WHERE id=$1", [r]);
  assert.equal(await sweepJobs(h.db), 2);
  const jq = (await get(`/api/v1/jobs/${q}`, a.auth)).json(), jr = (await get(`/api/v1/jobs/${r}`, a.auth)).json();
  assert.equal(jq.status, 'failed'); assert.match(jq.error, /expired/);
  assert.equal(jr.status, 'failed'); assert.match(jr.error, /stopped reporting/);
  assert.equal((await post(`/agent/v1/jobs/${r}/start`, {}, d.dev)).statusCode, 409);
});

test('an undelivered job is redelivered after a minute, not on every heartbeat', async () => {
  const a = await mkOrg('Redeliver Org', 'o@redeliver.test');
  const d = await enroll(a.auth, 'redeliver-0001');
  const id = (await mkJob(a.auth, d.deviceId)).json().jobs[0].id;
  assert.equal((await beat(d.dev)).jobs.length, 1);
  assert.equal((await beat(d.dev)).jobs.length, 0);
  await h.db.query("UPDATE jobs SET dispatched_at = now() - interval '2 minutes' WHERE id=$1", [id]);
  assert.equal((await beat(d.dev)).jobs.length, 1);
  await h.db.query("UPDATE jobs SET expires_at = now() - interval '1 second' WHERE id=$1", [id]);
  await h.db.query("UPDATE jobs SET dispatched_at = NULL WHERE id=$1", [id]);
  assert.equal((await beat(d.dev)).jobs.length, 0, 'expired jobs are never delivered');
  assert.equal((await post(`/agent/v1/jobs/${id}/start`, {}, d.dev)).statusCode, 409, 'and cannot be started');
});

test('a completed hardware.diagnose job feeds the device page and health score; other orgs never see it', async () => {
  const a = await mkOrg('Hw Org', 'o@hw.test'), b = await mkOrg('Hw Other', 'o@hw-other.test');
  const d = await enroll(a.auth, 'hwdiag-0001');
  await h.app.inject({ method: 'PUT', url: '/agent/v1/health', headers: d.dev, payload: { collectedAt: new Date().toISOString(), physicalDisks: [{ name: 'SSD', mediaType: 'SSD', health: 'Healthy', isSystem: true }] } });
  const id = (await mkJob(a.auth, d.deviceId, 'hardware.diagnose')).json().jobs[0].id;
  await post(`/agent/v1/jobs/${id}/start`, {}, d.dev);
  const result = { storage: { disks: [{ index: 0, model: 'WD SSD', health: 'Healthy', reliability: { readErrorsUncorrected: 2 } }] }, unavailable: [{ component: 'ACPI thermal', reason: 'access denied' }] };
  await post(`/agent/v1/jobs/${id}/result`, { status: 'completed', result }, d.dev);
  const page = (await get(`/api/v1/devices/${d.deviceId}`, a.auth)).json();
  assert.equal(page.hardwareDiagnosis.verdict, 'critical');
  assert.equal(page.hardwareDiagnosis.unavailable[0].component, 'ACPI thermal');
  assert.equal(page.health.status, 'critical');
  assert.ok(page.health.deductions.some((x: any) => x.code === 'hw.storage.uncorrectable'));
  assert.equal((await get('/api/v1/overview', a.auth)).json().critical, 1);
  assert.equal((await get('/api/v1/overview', b.auth)).json().critical, 0);
});

test('regression: agents send explicit nulls for absent result/error on success', async () => {
  const a = await mkOrg('Null Org', 'o@null.test');
  const d = await enroll(a.auth, 'nulljob-0001');
  const id = (await mkJob(a.auth, d.deviceId)).json().jobs[0].id;
  await post(`/agent/v1/jobs/${id}/start`, {}, d.dev);
  assert.equal((await post(`/agent/v1/jobs/${id}/result`, { status: 'completed', result: null, error: null }, d.dev)).statusCode, 200);
  assert.equal((await get(`/api/v1/jobs/${id}`, a.auth)).json().status, 'completed');
});

test('repair and cleanup jobs: approval, allowlists and personal data protection are enforced by the server', async () => {
  const a = await mkOrg('Repair Org', 'o@repair.test');
  const tech = await mkUser(a.orgId, 't@repair.test', 'technician');
  const d = await enroll(a.auth, 'repair-0001');
  const run = (auth: Hdr, params: object, type = 'repair.run') => post('/api/v1/jobs', { type, params, target: { deviceIds: [d.deviceId] } }, auth);
  assert.equal((await run(a.auth, { recipe: 'services.restart-failed' })).statusCode, 201);
  assert.equal((await run(a.auth, { recipe: 'windows.update-reset' })).statusCode, 400, 'review recipe needs approved:true');
  assert.equal((await run(a.auth, { recipe: 'windows.update-reset', approved: true })).statusCode, 201);
  assert.equal((await run(a.auth, { recipe: 'format.c' })).statusCode, 400);
  assert.equal((await run(a.auth, { recipe: 'startup.disable', approved: true })).statusCode, 400, 'needs entries');
  assert.equal((await run(a.auth, { recipe: 'startup.disable', approved: true, options: { entries: [{ location: 'HKLM/x/Run', name: 'Teams' }] } })).statusCode, 201);
  assert.equal((await run(tech, { recipe: 'dns.flush' })).statusCode, 403, 'repairs need admin');
  const sfc = (await get(`/api/v1/jobs?deviceId=${d.deviceId}`, a.auth)).json();
  assert.ok(sfc.jobs.length >= 3);
  // long recipes get long timeouts, short ones do not
  const sfcJob = (await run(a.auth, { recipe: 'windows.sfc' })).json().jobs[0].id;
  assert.equal(JSON.parse((await h.db.query('SELECT payload FROM jobs WHERE id=$1', [sfcJob])).rows[0].payload).timeoutSeconds, 3600);

  const clean = (params: object) => run(a.auth, params, 'cleanup.run');
  assert.equal((await clean({ categories: ['windows-temp', 'browser-cache'] })).statusCode, 201);
  assert.equal((await clean({ categories: ['recycle-bin'] })).statusCode, 400, 'REVIEW category needs approveReview');
  assert.equal((await clean({ categories: ['recycle-bin'], approveReview: true })).statusCode, 201);
  for (const personal of ['documents', 'downloads', 'desktop', 'pictures', 'C:/Users', '../..']) assert.equal((await clean({ categories: [personal], approveReview: true })).statusCode, 400, personal);
  assert.equal((await clean({ categories: [] })).statusCode, 400);
  assert.equal((await run(tech, {}, 'cleanup.preview')).statusCode, 201, 'previews are read-only, technician is enough');
  assert.equal((await run(a.auth, { repairId: 'not-a-uuid' }, 'repair.rollback')).statusCode, 400);
});

test('storage recovery aggregates the latest cleanup previews per org, by category; overview counts what was resolved today', async () => {
  const a = await mkOrg('Storage Org', 'o@storage.test'), b = await mkOrg('Storage Other', 'o@storage-other.test');
  const d1 = await enroll(a.auth, 'storage-dev-1'), d2 = await enroll(a.auth, 'storage-dev-2'), db_ = await enroll(b.auth, 'storage-dev-3');
  const finish = async (d: { deviceId: string; dev: Hdr }, type: string, params: object, result: object, auth: Hdr) => {
    const id = (await post('/api/v1/jobs', { type, params, target: { deviceIds: [d.deviceId] } }, auth)).json().jobs[0].id;
    await post(`/agent/v1/jobs/${id}/start`, {}, d.dev); await post(`/agent/v1/jobs/${id}/result`, { status: 'completed', result }, d.dev);
  };
  const preview = (win: number, chrome: number, bin: number) => ({ categories: [
    { id: 'windows-temp', title: 'Windows temporary files', class: 'SAFE', bytesFound: win }, { id: 'browser-cache', title: 'Browser caches', class: 'SAFE', bytesFound: chrome },
    { id: 'recycle-bin', title: 'Recycle Bin', class: 'REVIEW', bytesFound: bin }] });
  await finish(d1, 'cleanup.preview', {}, preview(100, 50, 7), a.auth);
  await finish(d1, 'cleanup.preview', {}, preview(300, 200, 9), a.auth);   // newer scan replaces the older one
  await finish(d2, 'cleanup.preview', {}, preview(10, 0, 0), a.auth);
  await finish(db_, 'cleanup.preview', {}, preview(999999, 0, 0), b.auth);
  const r = (await get('/api/v1/storage/recovery', a.auth)).json();
  assert.equal(r.devicesScanned, 2); assert.equal(r.devicesTotal, 2);
  assert.equal(r.safeBytes, 300 + 200 + 10); assert.equal(r.reviewBytes, 9);
  assert.equal(r.categories[0].id, 'windows-temp'); assert.equal(r.categories[0].bytes, 310); assert.equal(r.categories[0].devices, 2);
  assert.ok(r.personalDataNeverTouched.includes('Downloads'));
  assert.equal((await get('/api/v1/storage/recovery', b.auth)).json().safeBytes, 999999, 'each org sees only its own devices');

  await finish(d1, 'cleanup.run', { categories: ['windows-temp'] }, { freedBytes: 500 }, a.auth);
  await finish(d1, 'repair.run', { recipe: 'services.restart-failed' }, { applied: true, verified: true }, a.auth);
  await finish(d2, 'repair.fix-safe', {}, { fixedCount: 2, repairs: [{ after: { freedBytes: 250 } }] }, a.auth);
  const ov = (await get('/api/v1/overview', a.auth)).json();
  assert.equal(ov.today.problemsResolved, 3); assert.equal(ov.today.storageRecoveredBytes, 750);
  assert.equal((await get('/api/v1/overview', b.auth)).json().today.problemsResolved, 0);
});

test('health deductions carry a concrete fix job where one exists (and never for hardware faults)', async () => {
  const { scoreHealth, SnapshotSchema } = await import('../src/health.js');
  const GB = 2 ** 30;
  const snap = SnapshotSchema.parse({ collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 4 * GB, isSystem: true }],
    failedServices: [{ name: 'Foo', exitCode: 1 }], updateSearchStuckMinutes: 30, startup: Array.from({ length: 21 }, (_, i) => ({ name: 'a' + i })) });
  const dd = scoreHealth(snap).deductions;
  const fix = (code: string) => dd.find(x => x.code === code)!.fix;
  assert.equal(fix('storage.system_low')!.jobType, 'cleanup.run');
  assert.ok((fix('storage.system_low')!.params.categories as string[]).every(c => !['recycle-bin', 'windows-old'].includes(c)), 'auto fix is SAFE only');
  assert.equal((fix('perf.service_failed')!.params as any).recipe, 'services.restart-failed');
  assert.equal((fix('updates.search_stuck')!.params as any).approved, true);
  assert.equal(fix('perf.startup_heavy'), undefined, 'startup needs a human choice');
});
