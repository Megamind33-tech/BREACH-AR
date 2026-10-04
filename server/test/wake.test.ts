import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startHarness } from './helpers.js';
import { planWake, broadcastOf, subnetOf, type NetAdapter } from '../src/wake.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54352); });
after(async () => { await h.stop(); });

const lan = (ip: string, over: Partial<NetAdapter> = {}): NetAdapter => ({ name: 'Ethernet', mac: 'AA:BB:CC:00:11:22', ip, prefix: 24, gateway: '192.168.1.1', wired: true, wakeOnMagicPacket: true, ...over });
const dev = (id: string, ip: string, network: NetAdapter[] | null, publicIp: string | null = '41.1.1.1') => ({ id, hostname: 'PC-' + id, public_ip: publicIp, network: network && network.map(a => ({ ...a, ip })) });

test('the network arithmetic is right', () => {
  assert.equal(broadcastOf('192.168.1.9', 24), '192.168.1.255'); assert.equal(broadcastOf('10.4.7.200', 16), '10.4.255.255'); assert.equal(broadcastOf('172.16.5.130', 25), '172.16.5.255');
  assert.equal(subnetOf('192.168.1.9', 24), subnetOf('192.168.1.200', 24)); assert.notEqual(subnetOf('192.168.1.9', 24), subnetOf('192.168.2.9', 24));
});

test('a helper is chosen only with evidence it is on the same network, and the reasons are plain when a PC cannot be woken', () => {
  const target = { ...dev('T', '192.168.1.50', [lan('')]), online: false };
  const ok = planWake(target, [dev('R', '192.168.1.20', [lan('')])]);
  assert.ok(ok.canWake); assert.deepEqual(ok.pick, { mac: 'AA:BB:CC:00:11:22', broadcast: '192.168.1.255', relayId: 'R' }); assert.deepEqual(ok.reasons, []);
  // another router (different public address) or another subnet is never used: the packet would not arrive, and guessing would hide that
  assert.ok(!planWake(target, [dev('R', '192.168.1.20', [lan('')], '41.9.9.9')]).canWake);
  assert.ok(!planWake(target, [dev('R', '192.168.2.20', [lan('')])]).canWake);
  assert.match(planWake(target, []).reasons.join(' '), /No other computer is online on this computer's network/);
  // honest warnings
  const wifi = planWake({ ...dev('T', '192.168.1.50', [lan('', { wired: false })]), online: false }, [dev('R', '192.168.1.20', [lan('')])]);
  assert.match(wifi.reasons.join(' '), /Wi-Fi/); assert.ok(wifi.canWake, 'it is still tried; the warning explains why it may not work');
  assert.match(planWake({ ...dev('T', '192.168.1.50', [lan('', { wakeOnMagicPacket: false })]), online: false }, [dev('R', '192.168.1.20', [lan('')])]).reasons.join(' '), /turned off/);
  assert.match(planWake({ id: 'T', hostname: 'T', online: false, public_ip: null, network: null }, []).reasons[0]!, /not reported its network/);
  // the cable adapter wins over Wi-Fi when a PC has both
  const both = planWake({ ...dev('T', '192.168.1.50', [lan('', { wired: false, mac: '11:11:11:11:11:11' }), lan('', { mac: '22:22:22:22:22:22' })]), online: false }, [dev('R', '192.168.1.20', [lan('')])]);
  assert.equal(both.pick!.mac, '22:22:22:22:22:22');
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
const PK = { 'x-platform-key': 'platform-key' };
const PW = 'correct horse battery';
async function org(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: PW, autopilot: false }, PK);
  const l = await post('/api/v1/auth/login', { email, password: PW });
  return { id: r.json().organizationId as string, auth: { authorization: `Bearer ${l.json().token}` } };
}
async function enroll(o: { auth: Record<string, string> }, name: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, o.auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: 'G-' + randomBytes(6).toString('hex'), hostname: name, agentVersion: '0.1.0' });
  return { id: e.json().deviceId as string, auth: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } };
}
const beat = (d: { auth: Record<string, string> }, hostname: string, network?: unknown) => post('/agent/v1/heartbeat', { hostname, agentVersion: '0.1.0', metrics: {}, ...(network ? { network } : {}) }, d.auth);

test('waking a computer: a helper on the same network is asked to send the signal, and only inside the same organization', async () => {
  const a = await org('Wake Co', 'owner@wake.test'), b = await org('Other Co', 'owner@other.test');
  const target = await enroll(a, 'SLEEPER'), helper = await enroll(a, 'HELPER'), stranger = await enroll(b, 'STRANGER');
  const net = (mac: string, ip: string) => [{ name: 'Ethernet', mac, ip, prefix: 24, gateway: '192.168.1.1', wired: true, wakeOnMagicPacket: true }];
  assert.equal((await beat(target, 'SLEEPER', [{ name: 'x', mac: 'not-a-mac', ip: '192.168.1.5', prefix: 24, wired: true }])).statusCode, 400, 'a malformed adapter is refused');
  assert.equal((await beat(target, 'SLEEPER', net('AA:BB:CC:00:11:22', '192.168.1.50'))).statusCode, 200);
  assert.equal((await beat(helper, 'HELPER', net('AA:BB:CC:00:11:33', '192.168.1.20'))).statusCode, 200);
  assert.equal((await beat(stranger, 'STRANGER', net('AA:BB:CC:00:11:44', '192.168.1.30'))).statusCode, 200);   // same address and subnet, different organization

  const plan = (await get(`/api/v1/devices/${target.id}/wake`, a.auth)).json();
  assert.ok(plan.canWake); assert.deepEqual(plan.relays.map((r: any) => r.hostname), ['HELPER']);
  assert.equal(plan.pick, undefined, 'the plan shown to the console does not expose internals');

  const w = await post(`/api/v1/devices/${target.id}/wake`, {}, a.auth);
  assert.equal(w.statusCode, 202, w.body);
  const job = (await h.db.query('SELECT device_id, type, params FROM jobs WHERE id=$1', [w.json().jobId])).rows[0];
  assert.equal(job.type, 'wol.send'); assert.equal(job.device_id, helper.id);                                  // runs on the helper, not on the sleeping PC
  assert.deepEqual(job.params, { mac: 'AA:BB:CC:00:11:22', broadcasts: ['192.168.1.255'] });
  const audit = (await h.db.query("SELECT action FROM audit_log WHERE org_id=$1 AND action='device.wake'", [a.id])).rows;
  assert.equal(audit.length, 1);

  // Another organization can neither see nor wake it; the job type cannot be created directly.
  assert.equal((await get(`/api/v1/devices/${target.id}/wake`, b.auth)).statusCode, 404);
  assert.equal((await post(`/api/v1/devices/${target.id}/wake`, {}, b.auth)).statusCode, 404);
  const direct = await post('/api/v1/jobs', { type: 'wol.send', params: { mac: 'AA:BB:CC:00:11:22' }, target: { deviceIds: [helper.id] } }, a.auth);
  assert.ok(direct.statusCode >= 400, 'wol.send is internal only');
  // With nobody else online on the network, the answer says why.
  await h.db.query('UPDATE devices SET last_seen_at = now() - interval \'1 day\' WHERE id=$1', [helper.id]);
  const none = await post(`/api/v1/devices/${target.id}/wake`, {}, a.auth);
  assert.equal(none.statusCode, 409); assert.match(none.json().error, /No other computer is online/);
});

test('a computer that was uninstalled and then installed again is a live computer again', async () => {
  const o = await org('Reinstall Co', 'owner@reinstall.test');
  const first = await enroll(o, 'AGAIN');
  await h.db.query('UPDATE devices SET uninstalled_at=now() WHERE id=$1', [first.id]);
  const guid = (await h.db.query('SELECT machine_guid FROM devices WHERE id=$1', [first.id])).rows[0].machine_guid;
  const tok = await post('/api/v1/enrollment-tokens', {}, o.auth);
  const again = await post('/agent/v1/enroll', { enrollmentToken: tok.json().token, machineGuid: guid, hostname: 'AGAIN', agentVersion: '0.1.0' });
  assert.equal(again.statusCode, 201); assert.equal(again.json().deviceId, first.id, 'the same computer, not a duplicate');
  assert.equal((await h.db.query('SELECT uninstalled_at FROM devices WHERE id=$1', [first.id])).rows[0].uninstalled_at, null);
});
