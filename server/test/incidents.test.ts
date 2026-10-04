import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { hashPassword } from '../src/security.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54343); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });

async function mkOrg(name: string, email: string, autopilot = true) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function enroll(auth: Hdr, guid: string, hostname: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
type Dev = Awaited<ReturnType<typeof enroll>>;
const GB = 2 ** 30;
const LOW = { volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 3 * GB, isSystem: true }] };
const OK = { volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }] };
const putHealth = (d: Dev, over: object = OK) => put('/agent/v1/health', { collectedAt: new Date().toISOString(), ...over }, d.dev);
async function agentRuns(d: Dev, jobId: string, status: 'completed' | 'failed', result?: unknown) {
  assert.equal((await post(`/agent/v1/jobs/${jobId}/start`, {}, d.dev)).statusCode, 200);
  assert.equal((await post(`/agent/v1/jobs/${jobId}/result`, { status, result }, d.dev)).statusCode, 200);
}
const incidents = async (a: { auth: Hdr }, d: Dev) => (await get(`/api/v1/devices/${d.deviceId}/incidents`, a.auth)).json();
const storageInc = async (a: { auth: Hdr }, d: Dev) => (await incidents(a, d)).incidents.find((i: any) => i.code === 'storage.system_low');
const jobsOf = async (deviceId: string, type: string) => (await h.db.query(`SELECT id, status FROM jobs WHERE device_id=$1 AND type=$2 ORDER BY created_at`, [deviceId, type])).rows;

test('a repair is only RESOLVED after the symptom is verified gone and the observation window passes; the exit code alone resolves nothing', async () => {
  const a = await mkOrg('Inc Org', 'o@inc.test');
  const d = await enroll(a.auth, 'inc-dev-0001', 'INC-PC-1');
  await putHealth(d, LOW);

  // detected with evidence, cause and confidence; Autopilot started the safe cleanup and the incident tracks it
  let inc = await storageInc(a, d);
  assert.ok(inc, 'incident created'); assert.equal(inc.confidence, 'HIGH'); assert.match(inc.rootCause, /3 GB free|3\.0 GB|GB free/);
  assert.equal(inc.status, 'REPAIRING'); assert.equal(inc.actions.find((x: any) => x.kind === 'repair').by, 'autopilot');
  assert.ok(inc.evidence.some((e: any) => e.type === 'TELEMETRY' && e.value.freeBytes === 3 * GB), 'raw measurement kept as evidence');
  assert.equal(inc.beforeMetrics.systemFreeBytes, 3 * GB);
  const story = (await incidents(a, d)).story; assert.equal(story.status, 'Needs attention'); assert.equal(story.biggestProblem.title, 'System drive almost full');

  // the cleanup job "succeeds": that is NOT a resolution
  const job = (await jobsOf(d.deviceId, 'cleanup.run'))[0]; assert.ok(job);
  await agentRuns(d, job.id, 'completed', { freedBytes: 20 * GB });
  inc = await storageInc(a, d);
  assert.equal(inc.status, 'VERIFYING', 'exit success only starts verification'); assert.equal(inc.resolvedAt, null);
  assert.equal((await jobsOf(d.deviceId, 'health.check')).length, 1, 'a fresh health check was requested to verify the symptom');

  // health still bad after the repair: it did not work
  await putHealth(d, LOW);
  assert.ok(['UNRESOLVED', 'IMPROVED'].includes((await storageInc(a, d)).status));

  // try again on a second machine where the symptom disappears
  const d2 = await enroll(a.auth, 'inc-dev-0002', 'INC-PC-2');
  await putHealth(d2, LOW);
  await agentRuns(d2, (await jobsOf(d2.deviceId, 'cleanup.run'))[0].id, 'completed', { freedBytes: 290 * GB });
  await putHealth(d2, OK);
  let i2 = await storageInc(a, d2);
  assert.equal(i2.status, 'OBSERVING', 'technical result and symptom verified; now watching for recurrence'); assert.equal(i2.verification.symptomGone, true);
  assert.equal(i2.afterMetrics.systemFreeBytes, 300 * GB); assert.ok(new Date(i2.observationUntil) > new Date(), 'observation window open');
  await putHealth(d2, OK);
  assert.equal((await storageInc(a, d2)).status, 'OBSERVING', 'still inside the window');

  // window passes without recurrence -> RESOLVED with a service record
  await h.db.query(`UPDATE incidents SET observation_until = now() - interval '1 minute' WHERE id=$1`, [i2.id]);
  await putHealth(d2, OK);
  i2 = await storageInc(a, d2);
  assert.equal(i2.status, 'RESOLVED'); assert.equal(i2.resolution, 'viro-repair'); assert.equal(i2.beforeMetrics.systemFreeBytes, 3 * GB); assert.equal(i2.afterMetrics.systemFreeBytes, 300 * GB);
  const ev = (await h.db.query(`SELECT source, service_type, evidence FROM service_events WHERE device_id=$1`, [d2.deviceId])).rows;
  assert.equal(ev.length, 1); assert.equal(ev[0].source, 'AUTOMATIC'); assert.equal(ev[0].service_type, 'storage cleanup'); assert.equal(ev[0].evidence.after.systemFreeBytes, 300 * GB);

  // the problem comes back: the same incident reopens, recurrence is counted and shown
  await putHealth(d2, LOW);
  i2 = await storageInc(a, d2);
  assert.notEqual(i2.status, 'RESOLVED'); assert.equal(i2.recurrenceCount, 1); assert.ok(i2.evidence.some((e: any) => e.type === 'RECURRENCE'));
  assert.equal((await h.db.query(`SELECT count(*)::int n FROM incidents WHERE device_id=$1 AND code='storage.system_low'`, [d2.deviceId])).rows[0].n, 1, 'reopened, not duplicated');
});

test('a failed or ineffective repair escalates to a person instead of being retried forever or hidden', async () => {
  const a = await mkOrg('Inc Fail', 'o@incfail.test');
  const d = await enroll(a.auth, 'incfail-dev-0001', 'FAIL-PC');
  await putHealth(d, LOW);
  const job = (await jobsOf(d.deviceId, 'cleanup.run'))[0];
  await agentRuns(d, job.id, 'failed', { error: 'access denied' });
  let inc = await storageInc(a, d); assert.equal(inc.status, 'UNRESOLVED');
  assert.ok(inc.evidence.some((e: any) => e.type === 'COMMAND_OUTPUT'), 'the failure is recorded, not hidden');
  await putHealth(d, LOW);
  inc = await storageInc(a, d); assert.equal(inc.status, 'ADMIN_APPROVAL_REQUIRED', 'a human is asked');
  assert.equal((await jobsOf(d.deviceId, 'cleanup.run')).length, 1, 'no automatic retry loop');
});

test('a person can start the fix for an incident (audited, role-checked); hardware problems are never "fixed" by software', async () => {
  const a = await mkOrg('Inc Manual', 'o@incmanual.test', false), b = await mkOrg('Inc Other', 'o@incother.test', false);
  await h.db.query(`INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,'v@incmanual.test',$2,'viewer')`, [a.orgId, await hashPassword('another long password')]);
  const viewer = { authorization: `Bearer ${(await post('/api/v1/auth/login', { email: 'v@incmanual.test', password: 'another long password' })).json().token}` };
  const d = await enroll(a.auth, 'incman-dev-0001', 'MAN-PC');
  await putHealth(d, LOW);
  let inc = await storageInc(a, d); assert.equal(inc.status, 'REPAIR_READY'); assert.equal(inc.canFix, true);
  assert.equal((await get('/api/v1/incidents', b.auth)).json().incidents.length, 0, 'isolated per organization');
  assert.equal((await post(`/api/v1/incidents/${inc.id}/fix`, {}, b.auth)).statusCode, 404);
  assert.equal((await post(`/api/v1/incidents/${inc.id}/fix`, {}, viewer)).statusCode, 403);
  const r = await post(`/api/v1/incidents/${inc.id}/fix`, {}, a.auth); assert.equal(r.statusCode, 202);
  assert.equal((await jobsOf(d.deviceId, 'cleanup.run')).length, 1);
  inc = await storageInc(a, d); assert.equal(inc.status, 'REPAIRING'); assert.equal(inc.actions[0].by, 'user');
  assert.equal((await post(`/api/v1/incidents/${inc.id}/fix`, {}, a.auth)).statusCode, 409, 'cannot start a second repair while one is running');
  assert.ok((await get('/api/v1/audit', a.auth)).json().entries.some((e: any) => e.action === 'incident.fix'));
  const list = (await get('/api/v1/incidents', a.auth)).json().incidents; assert.equal(list[0].hostname, 'MAN-PC');

  // hardware: 4 GB of RAM and a mechanical system disk are limits software cannot remove
  const hw = await enroll(a.auth, 'incman-dev-0002', 'OLD-PC');
  await putHealth(hw, { ...OK, memory: { totalBytes: 4 * GB, availableBytes: 0.5 * GB }, perf: { ramPercent: 96, cpuAvgPercent: 20 }, physicalDisks: [{ name: 'HDD', mediaType: 'HDD', health: 'Healthy', sizeBytes: 500 * GB, isSystem: true }] });
  const hi = (await incidents(a, hw)).incidents;
  const hard = hi.filter((i: any) => i.remedy === 'hardware'); assert.ok(hard.length >= 1, JSON.stringify(hi.map((i: any) => [i.code, i.status])));
  assert.ok(hard.every((i: any) => i.status === 'HARDWARE_ACTION_REQUIRED' && !i.canFix));
  assert.equal((await post(`/api/v1/incidents/${hard[0].id}/fix`, {}, a.auth)).statusCode, 409);
  assert.equal((await jobsOf(hw.deviceId, 'repair.run')).length + (await jobsOf(hw.deviceId, 'cleanup.run')).length, 0, 'no software repair was attempted for a hardware limit');
  const story = (await incidents(a, hw)).story; assert.ok(story.hardwareAction.length >= 1);

  // diagnosis: ranked causes with evidence and confidence
  const diag = (await get(`/api/v1/devices/${hw.deviceId}/diagnosis`, a.auth)).json();
  assert.ok(diag.causes.length >= 1 && diag.causes[0].rank === 1); assert.ok(diag.causes.every((c: any) => c.confidence && Array.isArray(c.evidence) && c.cause));
  assert.equal((await get(`/api/v1/devices/${hw.deviceId}/diagnosis`, b.auth)).statusCode, 404);
});
