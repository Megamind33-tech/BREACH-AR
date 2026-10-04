import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { startHarness } from './helpers.js';
import { bucketOf, eligible, evaluateIntegrity, STAGES } from '../src/agentupdate.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54333); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const PK = { 'x-platform-key': 'platform-key' };
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });
const patch = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PATCH', url, payload: payload as any, headers });
async function mkOrg(name: string, email: string) {
  await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false }, PK);
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr };
}
async function enroll(auth: Hdr, guid: string, ring?: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname: guid, agentVersion: '0.1.0' });
  const d = { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
  if (ring) await patch(`/api/v1/devices/${d.deviceId}`, { updateRing: ring }, auth);
  return d;
}
type Dev = Awaited<ReturnType<typeof enroll>>;
const beat = async (d: Dev, extra: object = {}, version = '0.1.0') => (await post('/agent/v1/heartbeat', { hostname: 'x', agentVersion: version, metrics: {}, ...extra }, d.dev)).json();
const pkg = (seed: string) => Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from(seed.repeat(400))]);
const exeHash = (v: string) => createHash('sha256').update('exe-' + v).digest('hex');
const upload = (version: string, body = pkg(version)) => h.app.inject({ method: 'POST', url: `/api/v1/platform/releases?version=${version}&exeSha256=${exeHash(version)}`, headers: { ...PK, 'content-type': 'application/octet-stream' }, payload: body });
const setRelease = (version: string, b: object) => patch(`/api/v1/platform/releases/${version}`, b, PK);

test('rollout eligibility: rings and stable percentage buckets that only ever grow', () => {
  assert.ok(eligible('internal', 'internal', 'x')); assert.ok(!eligible('internal', 'pilot', 'x')); assert.ok(!eligible('internal', 'stable', 'x'));
  assert.ok(eligible('pilot', 'internal', 'x') && eligible('pilot', 'pilot', 'x')); assert.ok(!eligible('pilot', 'stable', 'x'));
  for (const ring of ['internal', 'pilot'] as const) for (const s of ['10', '50', '100'] as const) assert.ok(eligible(s, ring, 'anything'), 'internal/pilot rings are always ahead of the percentage');
  const ids = Array.from({ length: 2000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const at = (s: '10' | '50' | '100') => ids.filter(id => eligible(s, 'stable', id));
  const [p10, p50, p100] = [at('10'), at('50'), at('100')];
  assert.ok(p10.length > 120 && p10.length < 280, `~10% got ${p10.length}`); assert.ok(p50.length > 900 && p50.length < 1100); assert.equal(p100.length, 2000);
  assert.ok(p10.every(id => p50.includes(id)), 'the 10% are a subset of the 50%');
  assert.equal(bucketOf(ids[3]!), bucketOf(ids[3]!), 'stable');
  assert.deepEqual([...STAGES], ['internal', 'pilot', '10', '50', '100']);
});

test('uploaded releases are signed, immutable, hashed, and invisible until activated', async () => {
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/v1/platform/releases?version=1.0.0&exeSha256=' + exeHash('1.0.0'), headers: { 'content-type': 'application/octet-stream' }, payload: pkg('a') })).statusCode, 401);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/v1/platform/releases?version=1.0.0&exeSha256=' + exeHash('1.0.0'), headers: { ...PK, 'content-type': 'application/octet-stream' }, payload: Buffer.from('not a zip at all'.repeat(100)) })).statusCode, 400);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/v1/platform/releases?version=1.0&exeSha256=' + exeHash('1.0.0'), headers: { ...PK, 'content-type': 'application/octet-stream' }, payload: pkg('a') })).statusCode, 400, 'bad version');
  const body = pkg('1.0.0'); const up = await upload('1.0.0', body);
  assert.equal(up.statusCode, 201); assert.equal(up.json().sha256, createHash('sha256').update(body).digest('hex'));
  assert.equal((await upload('1.0.0')).statusCode, 409, 'immutable');
  const a = await mkOrg('Rel Org', 'o@rel.test'); const d = await enroll(a.auth, 'rel-dev-00001', 'internal');
  assert.equal((await beat(d)).update, null, 'draft releases are never offered');
  assert.equal((await setRelease('1.0.0', { status: 'active' })).statusCode, 200);
  const offer = (await beat(d)).update;
  assert.equal(offer.version, '1.0.0');
  const pub = createPublicKey({ key: Buffer.from(h.signer.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' });
  assert.ok(verify('sha256', Buffer.from(offer.manifest), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(offer.signature, 'base64')), 'manifest is signed with the pinned key');
  const m = JSON.parse(offer.manifest); assert.equal(m.exeSha256, exeHash('1.0.0')); assert.equal(m.sha256, offer.sha256); assert.equal(m.size, body.length); assert.equal(m.computeExeSha256, undefined, 'no compute hash unless the publisher states one');
  const dl = await h.app.inject({ method: 'GET', url: offer.url, headers: d.dev });
  assert.equal(dl.statusCode, 200); assert.ok(dl.rawPayload.equals(body), 'downloaded bytes are exactly what was uploaded');
  assert.equal(createHash('sha256').update(dl.rawPayload).digest('hex'), m.sha256);
  assert.equal((await h.app.inject({ method: 'GET', url: offer.url })).statusCode, 401, 'download needs a device credential');
  assert.equal((await beat(d, {}, '1.0.0')).update, null, 'already current: nothing offered');
  assert.equal((await beat(d, {}, '1.2.0')).update, null, 'never downgrades');
});

test('staged rollout: internal ring first, then pilot, then percentages; stages only move forward', async () => {
  await upload('2.0.0'); await setRelease('2.0.0', { status: 'active' });
  const a = await mkOrg('Stage Org', 'o@stage.test');
  const internal = await enroll(a.auth, 'stage-dev-0001', 'internal'), pilot = await enroll(a.auth, 'stage-dev-0002', 'pilot'), stable = await Promise.all(Array.from({ length: 30 }, (_, i) => enroll(a.auth, `stage-dev-1${String(i).padStart(3, '0')}`)));
  const offered = async (d: Dev) => (await beat(d, {}, '1.5.0')).update?.version ?? null;
  assert.equal(await offered(internal), '2.0.0'); assert.equal(await offered(pilot), null);
  assert.equal((await Promise.all(stable.map(offered))).filter(Boolean).length, 0);
  await setRelease('2.0.0', { stage: 'pilot' }); assert.equal(await offered(pilot), '2.0.0'); assert.equal((await Promise.all(stable.map(offered))).filter(Boolean).length, 0);
  await setRelease('2.0.0', { stage: '10' }); const n10 = (await Promise.all(stable.map(offered))).filter(Boolean).length;
  await setRelease('2.0.0', { stage: '50' }); const n50 = (await Promise.all(stable.map(offered))).filter(Boolean).length;
  await setRelease('2.0.0', { stage: '100' }); const n100 = (await Promise.all(stable.map(offered))).filter(Boolean).length;
  assert.ok(n10 <= n50 && n50 <= n100 && n100 === 30 && n10 < 30, `10%: ${n10}, 50%: ${n50}, 100%: ${n100}`);
  assert.equal((await setRelease('2.0.0', { stage: 'pilot' })).statusCode, 409, 'no going backwards');
  await setRelease('2.0.0', { status: 'halted' }); assert.equal(await offered(internal), null, 'halting stops offers immediately');
  assert.equal((await h.app.inject({ method: 'GET', url: '/agent/v1/releases/2.0.0/download', headers: internal.dev })).statusCode, 404, 'and downloads');
  assert.equal((await patch('/api/v1/platform/releases/9.9.9', { status: 'active' }, PK)).statusCode, 404);
  assert.equal((await patch('/api/v1/platform/releases/2.0.0', { status: 'active' })).statusCode, 401);
  const list = (await get('/api/v1/platform/releases', PK)).json().releases; assert.equal(list[0].version, '2.0.0');
  assert.equal((await patch(`/api/v1/devices/${internal.deviceId}`, { updateRing: 'nonsense' }, a.auth)).statusCode, 400);
});

test('a release that keeps failing halts itself before it reaches the rest of the fleet', async () => {
  await upload('3.0.0'); await setRelease('3.0.0', { status: 'active', stage: '100' });
  const a = await mkOrg('Halt Org', 'o@halt.test');
  const ds = await Promise.all([1, 2, 3, 4, 5].map(n => enroll(a.auth, `halt-dev-0000${n}`)));
  assert.equal((await beat(ds[4]!, {}, '2.5.0')).update.version, '3.0.0');
  await beat(ds[0]!, { updateResult: { version: '3.0.0', status: 'ok' } }, '3.0.0');
  await beat(ds[1]!, { updateResult: { version: '3.0.0', status: 'rolled_back', detail: 'new agent never confirmed' } }, '2.5.0');
  await beat(ds[2]!, { updateResult: { version: '3.0.0', status: 'failed', detail: 'hash mismatch' } }, '2.5.0');
  assert.equal((await beat(ds[4]!, {}, '2.5.0')).update.version, '3.0.0', 'two failures is below the threshold of three devices');
  await beat(ds[3]!, { updateResult: { version: '3.0.0', status: 'rolled_back' } }, '2.5.0');
  assert.equal((await beat(ds[4]!, {}, '2.5.0')).update, null, 'auto-halted');
  const r = (await get('/api/v1/platform/releases', PK)).json().releases.find((x: any) => x.version === '3.0.0');
  assert.equal(r.status, 'halted'); assert.match(r.halt_reason, /3 of 4 devices failed/); assert.equal(r.updated, 1); assert.equal(r.failed, 3);
});

test('tamper detection: modified binary, service drift, exposed data folder, unsigned binary (when required) and outdated agents alert and clear when fixed', async () => {
  await upload('4.0.0'); await setRelease('4.0.0', { status: 'active', stage: '100' });
  const a = await mkOrg('Tamper Org', 'o@tamper.test'); const d = await enroll(a.auth, 'tamper-dev-0001');
  const codes = async () => (await get('/api/v1/alerts', a.auth)).json().alerts.map((x: any) => x.code).sort();
  await beat(d, { integrity: { exeSha256: exeHash('4.0.0'), serviceOk: true, dataDirProtected: true } }, '4.0.0');
  assert.deepEqual(await codes(), [], 'a matching, well-configured agent is quiet');
  await beat(d, { integrity: { exeSha256: 'f'.repeat(64), serviceOk: false, serviceIssue: 'start type is Manual, expected Automatic', dataDirProtected: false } }, '4.0.0');
  assert.deepEqual(await codes(), ['tamper.binary_modified', 'tamper.config_exposed', 'tamper.service_misconfigured']);
  const bin = (await get('/api/v1/alerts', a.auth)).json().alerts.find((x: any) => x.code === 'tamper.binary_modified');
  assert.equal(bin.severity, 'critical'); assert.match(bin.message, /signed release 4.0.0/);
  await beat(d, { integrity: { exeSha256: exeHash('4.0.0'), serviceOk: true, dataDirProtected: true } }, '4.0.0');
  assert.deepEqual(await codes(), [], 'fixed conditions resolve themselves');
  await beat(d, {}, '0.9.0'); assert.deepEqual(await codes(), ['agent.outdated']);
  await beat(d, {}, '4.0.0'); assert.deepEqual(await codes(), []);
  const unknown = await enroll(a.auth, 'tamper-dev-0002');
  await beat(unknown, { integrity: { exeSha256: 'a'.repeat(64) } }, '7.7.7'); assert.ok(!(await codes()).includes('tamper.binary_modified'), 'unknown (dev) builds are not accused');
  const org = (await h.db.query('SELECT org_id FROM devices WHERE id=$1', [unknown.deviceId])).rows[0].org_id;
  await evaluateIntegrity(h.db, org, unknown.deviceId, '7.7.7', { signed: false }, true);
  assert.ok((await codes()).includes('tamper.certificate_invalid'), 'unsigned binary is critical when signatures are required');
  await evaluateIntegrity(h.db, org, unknown.deviceId, '7.7.7', { signed: true, signatureTrusted: true }, true);
  assert.ok(!(await codes()).includes('tamper.certificate_invalid'));
});

test('a clean uninstall tells Control: the device is retired, credentials die, queued jobs are cancelled', async () => {
  const a = await mkOrg('Bye Org', 'o@bye.test'); const d = await enroll(a.auth, 'bye-dev-000001');
  const jid = (await post('/api/v1/jobs', { type: 'health.check', target: { deviceIds: [d.deviceId] } }, a.auth)).json().jobs[0].id;
  assert.equal((await post('/agent/v1/goodbye', {}, d.dev)).statusCode, 200);
  assert.equal((await post('/agent/v1/heartbeat', { hostname: 'x', agentVersion: '1', metrics: {} }, d.dev)).statusCode, 401);
  assert.equal((await get(`/api/v1/jobs/${jid}`, a.auth)).json().status, 'cancelled');
  assert.ok((await get('/api/v1/audit', a.auth)).json().entries.some((e: any) => e.action === 'device.uninstalled'));
  assert.equal((await get('/api/v1/devices', a.auth)).json().total, 0);
});


test('a release can carry the compute worker\x27s hash in its signed manifest, and a malformed hash is refused', async () => {
  const ch = 'ab'.repeat(32);
  const ok = await h.app.inject({ method: 'POST', url: `/api/v1/platform/releases?version=9.9.0&exeSha256=${exeHash('9.9.0')}&computeExeSha256=${ch}`, headers: { ...PK, 'content-type': 'application/octet-stream' }, payload: pkg('9.9.0') });
  assert.equal(ok.statusCode, 201);
  assert.equal(JSON.parse((await h.db.query('SELECT manifest FROM agent_releases WHERE version=$1', ['9.9.0'])).rows[0].manifest).computeExeSha256, ch);
  assert.equal((await h.app.inject({ method: 'POST', url: `/api/v1/platform/releases?version=9.9.1&exeSha256=${exeHash('9.9.1')}&computeExeSha256=zz`, headers: { ...PK, 'content-type': 'application/octet-stream' }, payload: pkg('9.9.1') })).statusCode, 400);
});