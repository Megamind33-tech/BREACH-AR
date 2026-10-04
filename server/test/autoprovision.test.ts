import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54351); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const PK = { 'x-platform-key': 'platform-key' };
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
async function mkOrg(name: string, email: string, sponsored: boolean) {
  await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false, plan: sponsored ? 'compute_sponsored' : 'standard' }, PK);
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { authorization: `Bearer ${l.json().token}` } as Hdr;
}
async function enroll(auth: Hdr, guid: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname: guid, agentVersion: '0.1.9' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
const beat = (d: { dev: Hdr }, agentVersion: string) => post('/agent/v1/heartbeat', { hostname: 'pc', agentVersion, metrics: {} }, d.dev);
const anatomyJobs = async (id: string) => Number((await h.db.query(`SELECT count(*)::int n FROM jobs WHERE device_id=$1 AND type='anatomy.collect'`, [id])).rows[0].n);

test('a newly enrolled PC gets its anatomy collected automatically, once, and old agents are not asked', async () => {
  const a = await mkOrg('Auto Org', 'o@auto.test', false);
  const fresh = await enroll(a, 'auto-dev-000001'), old = await enroll(a, 'auto-dev-000002');
  const r = await beat(fresh, '0.1.9'); assert.equal(r.statusCode, 200);
  assert.equal(await anatomyJobs(fresh.deviceId), 1);
  assert.ok(r.json().jobs.some((j: any) => JSON.parse(j.payload ?? '{}').type === 'anatomy.collect' || j.type === 'anatomy.collect'), 'delivered on that same heartbeat');
  await beat(fresh, '0.1.9'); assert.equal(await anatomyJobs(fresh.deviceId), 1, 'not queued again within 6 hours');
  await beat(old, '0.1.3'); assert.equal(await anatomyJobs(old.deviceId), 0, 'agents without the feature are left alone');
});

test('a PC whose anatomy is already fresh is not asked again, a stale one is', async () => {
  const a = await mkOrg('Auto Org 2', 'o@auto2.test', false), d = await enroll(a, 'auto-dev-000003');
  const org = (await h.db.query('SELECT org_id FROM devices WHERE id=$1', [d.deviceId])).rows[0].org_id;
  await h.db.query(`INSERT INTO device_anatomy(device_id,org_id,data,collected_at) VALUES ($1,$2,'{}', now())`, [d.deviceId, org]);
  await beat(d, '0.1.9'); assert.equal(await anatomyJobs(d.deviceId), 0);
  await h.db.query(`UPDATE device_anatomy SET collected_at = now() - interval '3 days' WHERE device_id=$1`, [d.deviceId]);
  await beat(d, '0.1.9'); assert.equal(await anatomyJobs(d.deviceId), 1);
});

test('the heartbeat tells agents to install the compute worker only for sponsored organizations that have set a policy', async () => {
  const s = await mkOrg('Auto Sponsor', 'o@autos.test', true), p = await mkOrg('Auto Plain', 'o@autop.test', false);
  const ds = await enroll(s, 'auto-dev-000004'), dp = await enroll(p, 'auto-dev-000005');
  assert.equal((await beat(ds, '0.1.9')).json().compute.install, false, 'no policy yet');
  assert.equal((await put('/api/v1/compute/policy', { scope: { type: 'org' }, settings: { enabled: false } }, s)).statusCode, 200);
  assert.equal((await beat(ds, '0.1.9')).json().compute.install, true);
  assert.equal((await beat(dp, '0.1.9')).json().compute.install, false, 'a standard plan never gets it');
});
