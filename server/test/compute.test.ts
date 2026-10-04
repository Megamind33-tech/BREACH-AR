import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { startHarness } from './helpers.js';
import { hashPassword } from '../src/security.js';
import { complianceOf, XMR_ADDRESS } from '../src/compute.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54335); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const PK = { 'x-platform-key': 'platform-key' };
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });
const patch = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PATCH', url, payload: payload as any, headers });
async function mkOrg(name: string, email: string, sponsored = true) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false, plan: sponsored ? 'compute_sponsored' : 'standard' }, PK);
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function enroll(auth: Hdr, guid: string, hostname = guid) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, hostname, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
type Dev = Awaited<ReturnType<typeof enroll>>;
const beat = (d: Dev) => post('/agent/v1/heartbeat', { hostname: d.hostname, agentVersion: '1', metrics: {} }, d.dev);
const workerBeat = (d: Dev, b: object = {}) => post('/agent/v1/compute/heartbeat', { state: 'running', reason: 'idle and within policy', cpuCapPercent: 30, computeSeconds: 0, workerVersion: '0.1.0', policyVersion: 1, ...b }, d.dev);
const ADDR = '4' + 'A'.repeat(94);

test('compliance thresholds map days of silence to the commercial state', () => {
  assert.equal(complianceOf(0), 'ok'); assert.equal(complianceOf(0.4), 'ok'); assert.equal(complianceOf(1), 'grace'); assert.equal(complianceOf(7), 'grace');
  assert.equal(complianceOf(7.1), 'review'); assert.equal(complianceOf(14), 'review'); assert.equal(complianceOf(14.1), 'standard-required');
});

test('only public Monero addresses are accepted; private keys and seed phrases never match', () => {
  assert.ok(XMR_ADDRESS.test(ADDR)); assert.ok(XMR_ADDRESS.test('8' + 'B'.repeat(94))); assert.ok(XMR_ADDRESS.test('4' + 'A'.repeat(105)));
  assert.ok(!XMR_ADDRESS.test('a'.repeat(64)), '64-hex private spend/view key');
  assert.ok(!XMR_ADDRESS.test('abandon ability able about above absent absorb abstract absurd abuse access accident'), 'seed words');
  assert.ok(!XMR_ADDRESS.test(ADDR + 'x'.repeat(3))); assert.ok(!XMR_ADDRESS.test('1' + 'A'.repeat(94)));
});

test('policy management: admins only, validated with hard limits, scoped, audited; pool payout must be a public address', async () => {
  const a = await mkOrg('CP Org', 'o@cp.test');
  const tech = await (async () => { await h.db.query('INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,$2,$3,$4)', [a.orgId, 't@cp.test', await hashPassword('another long password'), 'technician']); return { authorization: `Bearer ${(await post('/api/v1/auth/login', { email: 't@cp.test', password: 'another long password' })).json().token}` } as Hdr; })();
  const set = (settings: object, scope: object = { type: 'org' }, auth = a.auth) => put('/api/v1/compute/policy', { scope, settings }, auth);
  assert.equal((await set({ enabled: true }, { type: 'org' }, tech)).statusCode, 403);
  assert.equal((await set({ enabled: true, maxCpuPercent: 95 })).statusCode, 400, 'above the hard maximum');
  assert.equal((await set({ enabled: true, maxCpuPercent: 2 })).statusCode, 400);
  assert.equal((await set({ enabled: true, maxTempC: 120 })).statusCode, 400);
  assert.equal((await set({ enabled: true, fallback: 'rm -rf' })).statusCode, 400);
  assert.equal((await set({ enabled: true, surprise: 1 })).statusCode, 400);
  assert.equal((await set({ enabled: true, windows: [{ days: [1], start: '25:00', end: '07:00' }] })).statusCode, 400);
  assert.equal((await set({ enabled: true, pool: { endpoints: [{ host: 'pool.example.org', port: 443 }], payoutAddress: 'a'.repeat(64) } })).statusCode, 400, 'a private key is refused');
  assert.equal((await set({ enabled: true, pool: { endpoints: [{ host: 'evil host;calc', port: 443 }] } })).statusCode, 400);
  assert.equal((await set({ enabled: true, pool: { endpoints: [{ host: 'pool.example.org', port: 443 }, { host: 'backup.example.org', port: 443 }], payoutAddress: ADDR } })).statusCode, 200);
  assert.equal((await set({ enabled: true }, { type: 'site', id: '00000000-0000-4000-8000-000000000000' })).statusCode, 404);
  assert.equal((await set({ enabled: true }, { type: 'site' })).statusCode, 400);
  const p = (await get('/api/v1/compute/policy', a.auth)).json(); assert.equal(p.policies.length, 1); assert.equal(p.plan, 'compute_sponsored'); assert.equal(p.defaults.maxCpuPercent, 30);
  assert.ok((await get('/api/v1/audit', a.auth)).json().entries.some((e: any) => e.action === 'compute.policy.update'));
  const other = await mkOrg('CP Other', 'o@cp-other.test'); assert.equal((await get('/api/v1/compute/policy', other.auth)).json().policies.length, 0);
});

test('the signed policy a PC fetches: resolution order, plan gating, per-device worker id, expiry, and it verifies with the pinned key', async () => {
  const a = await mkOrg('Sig Org', 'o@sig.test'); const sponsoredOff = await mkOrg('Std Org', 'o@std.test', false);
  const site = (await post('/api/v1/sites', { name: 'HQ' }, a.auth)).json(); const dep = (await post('/api/v1/departments', { siteId: site.id, name: 'Lab' }, a.auth)).json();
  const d1 = await enroll(a.auth, 'sig-dev-000001'), d2 = await enroll(a.auth, 'sig-dev-000002'), dStd = await enroll(sponsoredOff.auth, 'sig-dev-000003');
  await post('/api/v1/devices/assign', { deviceIds: [d2.deviceId], siteId: site.id, departmentId: dep.id }, a.auth);
  const fetchPolicy = async (d: Dev) => { const r = (await get('/agent/v1/compute/policy', d.dev)).json(); return { ...r, p: JSON.parse(r.policy) }; };
  assert.equal((await fetchPolicy(d1)).p.enabled, false, 'no policy: disabled');
  await put('/api/v1/compute/policy', { scope: { type: 'org' }, settings: { enabled: true, maxCpuPercent: 30 } }, a.auth);
  await put('/api/v1/compute/policy', { scope: { type: 'department', id: dep.id }, settings: { enabled: true, maxCpuPercent: 10, allowOnBattery: true } }, a.auth);
  const p1 = await fetchPolicy(d1), p2 = await fetchPolicy(d2);
  assert.equal(p1.p.maxCpuPercent, 30); assert.equal(p2.p.maxCpuPercent, 10, 'department overrides the organization default'); assert.equal(p2.p.allowOnBattery, true);
  assert.match(p1.p.workerId, /^[A-Z]{2}-[A-Z0-9]{3,12}-[A-Z0-9]{3,8}-[A-Z0-9]{8}(-[A-F0-9]{4})?$/, 'a readable COUNTRY-ORG-SITE-DEVICE worker id, never a raw id');
  assert.equal(p1.workerId, p1.p.workerId); assert.equal((await fetchPolicy(d1)).p.workerId, p1.p.workerId, 'stable across repeat fetches');
  assert.notEqual((await fetchPolicy(d2)).p.workerId, p1.p.workerId, 'never reused across devices');
  assert.ok(!p1.p.workerId.includes(a.orgId) && !p1.p.workerId.includes(d1.deviceId), 'never the raw, non-reviewable device/org id');
  const pub = createPublicKey({ key: Buffer.from(h.signer.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' });
  assert.ok(verify('sha256', Buffer.from(p1.policy), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(p1.signature, 'base64')));
  assert.ok(!verify('sha256', Buffer.from(p1.policy.replace('"maxCpuPercent":30', '"maxCpuPercent":90')), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(p1.signature, 'base64')), 'an edited policy does not verify');
  const until = new Date(p1.p.validUntil).getTime() - Date.now(); assert.ok(until > 47 * 3600_000 && until <= 48 * 3600_000 + 5000);
  assert.ok(p1.p.version > 0);
  await put('/api/v1/compute/policy', { scope: { type: 'org' }, settings: { enabled: true, maxCpuPercent: 25 } }, a.auth);
  assert.ok((await fetchPolicy(d1)).p.version >= p1.p.version, 'versions never go backwards');
  await put('/api/v1/compute/policy', { scope: { type: 'org' }, settings: { enabled: true } }, sponsoredOff.auth);
  assert.equal((await fetchPolicy(dStd)).p.enabled, false, 'a standard-plan organization never gets an enabled policy');
  assert.equal((await patch(`/api/v1/platform/organizations/${sponsoredOff.orgId}/plan`, { plan: 'compute_sponsored' })).statusCode, 401, 'platform key required');
  assert.equal((await patch(`/api/v1/platform/organizations/${sponsoredOff.orgId}/plan`, { plan: 'compute_sponsored' }, PK)).statusCode, 200);
  assert.equal((await fetchPolicy(dStd)).p.enabled, true, 'switching the plan takes effect on the next fetch');
});

test('worker telemetry: states, usage accounting that cannot be inflated, and the sponsorship dashboard', async () => {
  const a = await mkOrg('Dash Org', 'o@dash.test'); const b = await mkOrg('Dash Other', 'o@dash-other.test');
  const ds = await Promise.all([1, 2, 3, 4, 5].map(n => enroll(a.auth, `dash-dev-00000${n}`, `PC-${n}`)));
  const other = await enroll(b.auth, 'dash-dev-000009', 'B-PC');
  await put('/api/v1/compute/policy', { scope: { type: 'org' }, settings: { enabled: true, maxCpuPercent: 30 } }, a.auth);
  for (const d of ds.slice(0, 4)) await beat(d);                       // PC-5 stays silent (agent offline)
  await workerBeat(ds[0]!, { state: 'running', computeSeconds: 40, hashRate: 1500 });
  await workerBeat(ds[1]!, { state: 'user-active', reason: 'the user became active' });
  await workerBeat(ds[2]!, { state: 'on-battery', reason: 'the PC is running on battery' });
  await beat(other); await workerBeat(other, { state: 'running', computeSeconds: 30 });
  let o = (await get('/api/v1/compute/overview', a.auth)).json();
  assert.equal(o.status, 'ACTIVE'); assert.equal(o.eligible, 5); assert.equal(o.contributing, 1); assert.equal(o.userActive, 1); assert.deepEqual(o.paused, { 'on-battery': 1 });
  assert.equal(o.offline, 2, 'PC-4 (agent up, worker silent) and PC-5 (offline)'); assert.equal(o.maxCpuPercent, 30); assert.equal(o.hashRateHps, 1500);
  assert.equal(o.devices.find((x: any) => x.hostname === 'PC-4').status, 'worker-silent'); assert.equal(o.devices.find((x: any) => x.hostname === 'PC-5').status, 'offline');
  assert.match(o.note, /mining engine/);
  const secs = async (id: string) => Number((await h.db.query('SELECT COALESCE(sum(seconds),0) s FROM compute_usage WHERE device_id=$1', [id])).rows[0].s);
  assert.ok(await secs(ds[0]!.deviceId) <= 40 && await secs(ds[0]!.deviceId) > 0);
  // a tampered worker claiming an hour of compute one second later cannot inflate its numbers
  await workerBeat(ds[0]!, { state: 'running', computeSeconds: 3600 });
  assert.ok(await secs(ds[0]!.deviceId) < 100, `usage stayed physically plausible: ${await secs(ds[0]!.deviceId)}s`);
  assert.equal((await workerBeat(ds[0]!, { computeSeconds: 99999 })).statusCode, 400, 'absurd values are rejected outright');
  assert.equal((await workerBeat(ds[0]!, { cpuCapPercent: 500 })).statusCode, 400);
  o = (await get('/api/v1/compute/overview', a.auth)).json(); assert.ok(o.computeHoursToday > 0 && o.computeHoursToday < 0.1);
  const ob = (await get('/api/v1/compute/overview', b.auth)).json(); assert.equal(ob.eligible, 0, 'each org sees only its own PCs'); assert.equal(ob.status, 'INACTIVE');
  assert.equal((await post('/agent/v1/compute/heartbeat', { state: 'running' }, {})).statusCode, 401);
});

test('a PC whose engine runs but cannot reach the pool is shown distinctly, not lumped in with ordinary pauses', async () => {
  const a = await mkOrg('Blocked Pool Org', 'o@blockedpool.test');
  const d = await enroll(a.auth, 'blocked-dev-000001', 'FRONT-DESK');
  await put('/api/v1/compute/policy', { scope: { type: 'org' }, settings: { enabled: true, maxCpuPercent: 30 } }, a.auth);
  await beat(d);
  await workerBeat(d, { state: 'pool-unreachable', reason: 'The mining pool (pool.hashvault.pro) could not be reached from this PC for 3 minute(s). This is usually a firewall or antivirus product blocking the connection; Viro does not work around security software.' });
  const o = (await get('/api/v1/compute/overview', a.auth)).json();
  const row = o.devices.find((x: any) => x.hostname === 'FRONT-DESK');
  assert.equal(row.status, 'pool-unreachable'); assert.match(row.reason, /firewall or antivirus/); assert.equal(o.contributing, 0, 'not counted as contributing while blocked');
  assert.deepEqual(o.paused, { 'pool-unreachable': 1 });
});

test('compliance: silence is measured only while the PC is online, escalates by days, and never touches the device', async () => {
  const a = await mkOrg('Comp Org', 'o@comp.test'); const std = await mkOrg('Comp Std', 'o@comp-std.test', false);
  const ds = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => enroll(a.auth, `comp-dev-0000${String(n).padStart(2, '0')}`, `C-${n}`)));
  await put('/api/v1/compute/policy', { scope: { type: 'org' }, settings: { enabled: true } }, a.auth);
  for (const d of ds) await beat(d);
  for (const d of ds.slice(0, 9)) await workerBeat(d);                    // nine healthy workers
  let c = (await get('/api/v1/compute/compliance', a.auth)).json();
  assert.equal(c.overall, 'ok'); assert.equal(c.billingState, 'COMPUTE SPONSORED'); assert.match(c.guarantee, /never changes anything on a PC/);
  await h.db.query(`UPDATE devices SET enrolled_at = now() - interval '3 days' WHERE id=$1`, [ds[9]!.deviceId]);
  c = (await get('/api/v1/compute/compliance', a.auth)).json(); assert.equal(c.counts.grace, 1); assert.equal(c.overall, 'grace'); assert.equal(c.billingState, 'GRACE PERIOD');
  await h.db.query(`UPDATE devices SET enrolled_at = now() - interval '10 days' WHERE id=$1`, [ds[9]!.deviceId]);
  assert.equal((await get('/api/v1/compute/compliance', a.auth)).json().billingState, 'SPONSORSHIP REVIEW');
  await h.db.query(`UPDATE devices SET enrolled_at = now() - interval '20 days' WHERE id=$1`, [ds[9]!.deviceId]);
  c = (await get('/api/v1/compute/compliance', a.auth)).json(); assert.equal(c.billingState, 'STANDARD PLAN REQUIRED'); assert.equal(c.devices[0].hostname, 'C-10'); assert.ok(c.devices[0].unavailableDays > 19);
  await h.db.query(`UPDATE devices SET last_seen_at = now() - interval '2 days' WHERE id=$1`, [ds[9]!.deviceId]);
  assert.equal((await get('/api/v1/compute/compliance', a.auth)).json().overall, 'ok', 'an offline PC is offline, not non-compliant');
  await h.db.query(`UPDATE devices SET last_seen_at = now() WHERE id=$1`, [ds[9]!.deviceId]);
  // nothing about the PC changed: it can still receive jobs and heartbeat normally
  assert.equal((await post('/api/v1/jobs', { type: 'health.check', target: { deviceIds: [ds[9]!.deviceId] } }, a.auth)).statusCode, 201);
  assert.equal((await beat(ds[9]!)).statusCode, 200);
  assert.equal((await get('/api/v1/compute/compliance', std.auth)).json().billingState, 'STANDARD');
});

test('the worker reports its thermal level and temperature, and nonsense or a missing sensor is handled honestly', async () => {
  const a = await mkOrg('Thermal Org', 'o@thermal.test'); const d = await enroll(a.auth, 'thermal-dev-0001');
  assert.equal((await workerBeat(d, { state: 'hot', reason: 'CPU temperature is 72°C', thermal: 'warning', cpuTempC: 72 })).statusCode, 200);
  const row = (await h.db.query('SELECT state, thermal, cpu_temp_c FROM compute_state WHERE device_id=$1', [d.deviceId])).rows[0];
  assert.equal(row.state, 'hot'); assert.equal(row.thermal, 'warning'); assert.equal(row.cpu_temp_c, 72);
  assert.equal((await workerBeat(d, { thermal: 'on-fire' })).statusCode, 400); assert.equal((await workerBeat(d, { cpuTempC: 900 })).statusCode, 400);
  assert.equal((await workerBeat(d, { thermal: null, cpuTempC: null })).statusCode, 200, 'a PC with no readable sensor reports nothing rather than a made-up number');
  assert.equal((await h.db.query('SELECT thermal, cpu_temp_c FROM compute_state WHERE device_id=$1', [d.deviceId])).rows[0].thermal, null);
});
