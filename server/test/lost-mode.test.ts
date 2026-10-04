import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startHarness } from './helpers.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54393); });
after(async () => { await h.stop(); });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
const PK = { 'x-platform-key': 'platform-key' }; const PW = 'correct horse battery';

async function org(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: PW, autopilot: false }, PK);
  const l = await post('/api/v1/auth/login', { email, password: PW }); return { id: r.json().organizationId as string, auth: { authorization: `Bearer ${l.json().token}` } };
}
async function enroll(o: { auth: Record<string, string> }, name: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, o.auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: 'G-' + randomBytes(6).toString('hex'), hostname: name, agentVersion: '0.1.14' });
  return { id: e.json().deviceId as string, auth: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } };
}
const beat = (d: { id: string; auth: Record<string, string> }, extra: Record<string, unknown> = {}) =>
  post('/agent/v1/heartbeat', { hostname: 'X', agentVersion: '0.1.14', metrics: {}, ...extra }, d.auth);

test('reporting a computer lost: the passphrase is never returned, the heartbeat carries a salted hash to check locally, and another organization sees none of it', async () => {
  const a = await org('Lost Co', 'owner@lost.test'), b = await org('Other Lost', 'owner@other-lost.test');
  const pc = await enroll(a, 'STOLEN-LAPTOP');
  assert.equal((await beat(pc)).json().lost.locked, false, 'nothing is locked before it is reported');

  const r = await post(`/api/v1/devices/${pc.id}/lost`, { passphrase: 'open sesame', note: 'taken from the office' }, a.auth);
  assert.equal(r.statusCode, 200); assert.match(r.json().message, /lock/);
  assert.equal((await get(`/api/v1/devices/${pc.id}`, a.auth)).json().lost_passphrase, undefined, 'the stored hash is never sent to the console either');

  const bh = (await beat(pc)).json(); assert.equal(bh.lost.locked, true);
  assert.ok(bh.lost.salt && bh.lost.hash && bh.lost.iterations > 1000, 'the agent gets what it needs to check an entry without the network');
  assert.equal(bh.pollSeconds, 3, 'it checks in quickly while locked, so an unlock or a cancel reaches it fast');

  assert.equal((await get(`/api/v1/devices/${pc.id}`, b.auth)).statusCode, 404, 'another organization cannot see this device at all');
  assert.equal((await post(`/api/v1/devices/${pc.id}/lost/cancel`, {}, b.auth)).statusCode, 404);

  // an uninstall claim from a device that is reported lost is not believed
  assert.equal((await post('/agent/v1/goodbye', {}, pc.auth)).statusCode, 200);
  assert.equal((await get(`/api/v1/devices/${pc.id}`, a.auth)).json().revoked_at, null, 'it stays on the fleet; the uninstall was not accepted while lost');

  // the agent reports a successful local unlock
  assert.equal((await post('/agent/v1/lost/recovered', {}, pc.auth)).statusCode, 200);
  assert.equal((await beat(pc)).json().lost.locked, false);
  assert.equal((await get(`/api/v1/devices/${pc.id}`, a.auth)).json().lost_mode, false);
});

test('an administrator can cancel lost mode directly, without the passphrase', async () => {
  const a = await org('Lost Co 2', 'owner@lost2.test');
  const pc = await enroll(a, 'FOUND-LAPTOP');
  await post(`/api/v1/devices/${pc.id}/lost`, { passphrase: 'another passphrase' }, a.auth);
  assert.equal((await beat(pc)).json().lost.locked, true);
  const r = await post(`/api/v1/devices/${pc.id}/lost/cancel`, {}, a.auth); assert.equal(r.statusCode, 200);
  assert.equal((await beat(pc)).json().lost.locked, false);
  assert.equal((await post(`/api/v1/devices/${pc.id}/lost/cancel`, {}, a.auth)).statusCode, 404, 'cancelling twice has nothing to cancel');
});

test('the networks a lost computer connects from are kept as a trail, one row per network, not one per heartbeat', async () => {
  const a = await org('Lost Co 3', 'owner@lost3.test');
  const pc = await enroll(a, 'TRACKED-LAPTOP');
  await beat(pc); await beat(pc); await beat(pc);        // same test client, same address every time
  const once = (await get(`/api/v1/devices/${pc.id}/locations`, a.auth)).json();
  assert.equal(once.locations.length, 1, 'no new row while the address has not changed');
  assert.equal(once.lost_mode, false);
});

test('a serial reported stolen shows up in the public check, with no other detail, and clears once recovered', async () => {
  const a = await org('Lost Co 4', 'owner@lost4.test');
  const pc = await enroll(a, 'SERIAL-LAPTOP');
  await post('/agent/v1/anatomy', { version: 1, collectedAt: new Date().toISOString(), system: { serial: 'ABC-123-XYZ' } }, pc.auth);
  assert.equal((await post('/api/v1/public/stolen-check', { serial: 'abc123xyz' })).json().reported, false);
  await post(`/api/v1/devices/${pc.id}/lost`, { passphrase: 'yet another passphrase' }, a.auth);
  const r = await post('/api/v1/public/stolen-check', { serial: 'abc-123-xyz' });    // punctuation and case do not matter
  assert.equal(r.json().reported, true); assert.ok(r.json().since);
  await post(`/api/v1/devices/${pc.id}/lost/cancel`, {}, a.auth);
  assert.equal((await post('/api/v1/public/stolen-check', { serial: 'ABC123XYZ' })).json().reported, false, 'recovered: no longer shown as stolen');
});

test('lost mode is a paid feature: a personal account on the free plan cannot use it', async () => {
  const { hashPassword } = await import('../src/security.js');
  const orgId = (await h.db.query(`INSERT INTO organizations(name,kind) VALUES ('Free Chanda','personal') RETURNING id`)).rows[0].id;
  await h.db.query(`INSERT INTO users(org_id,email,password_hash,role,email_verified_at) VALUES ($1,'chanda-free@example.com',$2,'owner',now())`, [orgId, await hashPassword('a-long-password-1')]);
  const auth = { authorization: `Bearer ${(await post('/api/v1/auth/login', { email: 'chanda-free@example.com', password: 'a-long-password-1' })).json().token}` };
  const pc = await enroll({ auth }, 'FREE-LAPTOP');
  const r = await post(`/api/v1/devices/${pc.id}/lost`, { passphrase: 'does not matter here' }, auth);
  assert.equal(r.statusCode, 402); assert.equal(r.json().upgrade, true); assert.match(r.json().error, /paid plan/);
});
