import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHarness } from './helpers.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54421); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const PK = { 'x-platform-key': 'platform-key' };
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Hdr = {}) => h.app.inject({ method, url, payload: payload as any, headers });
const ADDR = '4' + 'A'.repeat(94), ADDR2 = '4' + 'B'.repeat(94);
async function mkOrg(name: string, sponsored = true) {
  const email = `o@${name.toLowerCase()}.test`;
  const r = await call('POST', '/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false, plan: sponsored ? 'compute_sponsored' : 'standard' }, PK);
  const l = await call('POST', '/api/v1/auth/login', { email, password: 'correct horse battery' });
  const auth = { authorization: `Bearer ${l.json().token}` } as Hdr;
  await call('POST', '/api/v1/compute/consent', {}, auth);
  const t = await call('POST', '/api/v1/enrollment-tokens', {}, auth);
  const e = await call('POST', '/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: 'G-' + randomUUID(), hostname: name + '-PC', agentVersion: '0.1.0' });
  return { auth, orgId: r.json().organizationId as string, deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
type Org = Awaited<ReturnType<typeof mkOrg>>;
const policy = (o: Org, settings: object) => call('PUT', '/api/v1/compute/policy', { scope: { type: 'org' }, settings }, o.auth);
const xmrig = (extra: object = {}) => ({ enabled: true, fallback: 'xmrig', pool: { endpoints: [{ host: 'pool.example.test', port: 443, tls: true }], payoutAddress: ADDR }, ...extra });
const audit = async (o: Org, qs = '') => (await call('GET', '/api/v1/compute/mining-audit' + qs, undefined, o.auth)).json().entries as any[];
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

test('session route: needs a device, a mining registration, and tolerates explicit JSON null for every optional field', async () => {
  const o = await mkOrg('MRtA');
  assert.equal((await call('POST', '/agent/v1/compute/session', {}, {})).statusCode, 401);
  const sid = randomUUID();
  const body = { sessionId: sid, startedAt: ago(30), runtimeSeconds: 30 };
  assert.equal((await call('POST', '/agent/v1/compute/session', body, o.dev)).statusCode, 409, 'no registration until the policy was fetched');
  await policy(o, xmrig());
  assert.equal((await call('GET', '/agent/v1/compute/policy', undefined, o.dev)).statusCode, 200);
  const nulls = { ...body, stoppedAt: null, averageHashrate: null, peakHashrate: null, stopReason: null, engineVersion: null, workerVersion: null, sample: null };
  const r = await call('POST', '/agent/v1/compute/session', nulls, o.dev);
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().final, false);
  const withSample = { ...body, acceptedShares: 2, sample: { hashrate: null, cpuUsagePercent: null, cpuTempC: null, memoryPercent: null, poolConnected: null, lastShareAt: null } };
  assert.equal((await call('POST', '/agent/v1/compute/session', withSample, o.dev)).statusCode, 200);
  assert.equal((await call('POST', '/agent/v1/compute/session', { sessionId: 'nope' }, o.dev)).statusCode, 400);
  const stop = await call('POST', '/agent/v1/compute/session', { ...body, stoppedAt: ago(1), stopReason: 'engine exited', acceptedShares: 3, averageHashrate: 120.5, peakHashrate: 150 }, o.dev);
  assert.equal(stop.json().final, true);
  const s = (await call('GET', '/api/v1/compute/sessions', undefined, o.auth)).json();
  assert.equal(s.sessions.length, 1); assert.equal(s.sessions[0].stop_reason, 'engine exited'); assert.equal(s.sessions[0].accepted_shares, 3); assert.equal(s.totals.sessions, 1); assert.equal(s.totals.running, 0);
});

test('mining reads are scoped to the caller organization and need at least the viewer role', async () => {
  const a = await mkOrg('MRtB1'), b = await mkOrg('MRtB2');
  for (const o of [a, b]) { await policy(o, xmrig()); await call('GET', '/agent/v1/compute/policy', undefined, o.dev); await call('POST', '/agent/v1/compute/session', { sessionId: randomUUID(), startedAt: ago(20), runtimeSeconds: 20, sample: { hashrate: 10 } }, o.dev); }
  const sa = (await call('GET', '/api/v1/compute/sessions', undefined, a.auth)).json();
  assert.equal(sa.sessions.length, 1); assert.equal(sa.sessions[0].device_id, a.deviceId);
  assert.equal((await call('GET', `/api/v1/compute/sessions?deviceId=${b.deviceId}`, undefined, a.auth)).json().sessions.length, 0, 'another organization\'s device id yields nothing');
  assert.ok((await audit(a)).every(e => e.device_id == null || e.device_id === a.deviceId));
  assert.equal((await call('GET', '/api/v1/compute/telemetry', undefined, a.auth)).statusCode, 200);
  assert.equal((await call('GET', '/api/v1/compute/sessions')).statusCode, 401);
  assert.equal((await call('GET', '/api/v1/compute/mining-audit')).statusCode, 401);
});

test('every policy, plan and device change writes a mining audit entry with the right risk flag', async () => {
  const o = await mkOrg('MRtC', false);
  const plan = (p: string) => call('PATCH', `/api/v1/platform/organizations/${o.orgId}/plan`, { plan: p }, PK);
  assert.equal((await plan('compute_sponsored')).statusCode, 200);
  let e = await audit(o);
  assert.equal(e[0].action, 'plan.change'); assert.equal(e[0].actor_type, 'platform'); assert.equal(e[0].high_risk, true); assert.equal(e[0].previous.plan, 'standard');
  assert.equal((await plan('standard')).statusCode, 200); assert.equal((await plan('compute_sponsored')).statusCode, 200);

  assert.equal((await policy(o, xmrig())).statusCode, 200);
  e = await audit(o); assert.equal(e[0].action, 'policy.create'); assert.equal(e[0].actor_type, 'user'); assert.equal(e[0].high_risk, true);
  assert.ok(e[0].reasons.includes('payout address set'));

  await call('GET', '/agent/v1/compute/policy', undefined, o.dev);
  e = await audit(o); assert.equal(e[0].action, 'device.enable'); assert.equal(e[0].actor_type, 'system'); assert.equal(e[0].device_id, o.deviceId);
  const n = (await audit(o)).length;
  await call('GET', '/agent/v1/compute/policy', undefined, o.dev);
  assert.equal((await audit(o)).length, n, 'fetching an unchanged policy writes nothing');

  assert.equal((await policy(o, xmrig({ pool: { endpoints: [{ host: 'pool.example.test', port: 443, tls: true }], payoutAddress: ADDR2 } }))).statusCode, 200);
  e = await audit(o); assert.equal(e[0].action, 'policy.update'); assert.ok(e[0].reasons.includes('payout address changed'));
  assert.equal((await policy(o, xmrig({ pool: { endpoints: [{ host: 'pool.example.test', port: 443, tls: true }], payoutAddress: ADDR2 }, startAfterIdleMinutes: 20 }))).statusCode, 200);
  e = await audit(o); assert.equal(e[0].high_risk, false, 'a low-risk edit is recorded but not flagged'); assert.deepEqual(e[0].reasons, []);

  assert.equal((await policy(o, { enabled: false })).statusCode, 200);
  e = await audit(o); assert.equal(e[0].action, 'policy.disable');
  await call('GET', '/agent/v1/compute/policy', undefined, o.dev);
  e = await audit(o); assert.equal(e[0].action, 'device.disable');

  const id = (await call('GET', '/api/v1/compute/policy', undefined, o.auth)).json().policies[0].id;
  assert.equal((await call('DELETE', `/api/v1/compute/policy/${id}`, undefined, o.auth)).statusCode, 200);
  e = await audit(o); assert.equal(e[0].action, 'policy.delete'); assert.equal(e[0].previous.enabled, false);
  const risky = await audit(o, '?highRiskOnly=true'); assert.ok(risky.length >= 3 && risky.every(x => x.high_risk));
});

test('an organization created on the sponsored plan is audited as high-risk; a standard one is not', async () => {
  const s = await mkOrg('MRtD1', true), t = await mkOrg('MRtD2', false);
  const es = await audit(s); assert.equal(es.length, 1); assert.equal(es[0].action, 'plan.change'); assert.equal(es[0].high_risk, true);
  assert.equal((await audit(t)).length, 0);
});
