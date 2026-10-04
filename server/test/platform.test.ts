import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startHarness } from './helpers.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54351); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const PK = { 'x-platform-key': 'platform-key' };
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Hdr = {}) => h.app.inject({ method, url, payload: payload as any, headers });
const bearer = (t: string): Hdr => ({ authorization: `Bearer ${t}` });
const PW = 'correct horse battery';

async function platformAdmin(email: string) {
  assert.equal((await call('POST', '/api/v1/platform/admins', { email, password: PW }, PK)).statusCode, 201);
  const l = await call('POST', '/api/v1/platform/auth/login', { email, password: PW });
  assert.equal(l.statusCode, 200); return bearer(l.json().token);
}
async function org(name: string, email: string, platform: Hdr) {
  const r = await call('POST', '/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: PW, autopilot: false }, platform);
  assert.equal(r.statusCode, 201, r.body);
  const l = await call('POST', '/api/v1/auth/login', { email, password: PW });
  return { id: r.json().organizationId as string, auth: bearer(l.json().token) };
}

test('two sides: the platform and an organization have separate sign-ins, and neither token works on the other side', async () => {
  const op = await platformAdmin('ops@platform.test');
  const a = await org('Acme', 'owner@acme.test', op);
  // An organization token is refused on every platform route; a platform token is refused on every organization route.
  for (const u of ['/api/v1/platform/overview', '/api/v1/platform/organizations', '/api/v1/platform/admins', '/api/v1/platform/audit'])
    assert.equal((await call('GET', u, undefined, a.auth)).statusCode, 403, u);
  assert.equal((await call('GET', '/api/v1/platform/overview')).statusCode, 401);
  for (const u of ['/api/v1/me', '/api/v1/devices', '/api/v1/users', '/api/v1/sites']) assert.equal((await call('GET', u, undefined, op)).statusCode, 403, u);
  // The platform sees every organization; an organization's login never works as a platform login.
  assert.equal((await call('POST', '/api/v1/platform/auth/login', { email: 'owner@acme.test', password: PW })).statusCode, 401);
  assert.equal((await call('POST', '/api/v1/auth/login', { email: 'ops@platform.test', password: PW })).statusCode, 401);
  const list = (await call('GET', '/api/v1/platform/organizations', undefined, op)).json().organizations;
  assert.ok(list.find((o: any) => o.name === 'Acme' && o.owner_email === 'owner@acme.test' && o.users === 1 && o.devices === 0));
  const ov = (await call('GET', '/api/v1/platform/overview', undefined, op)).json();
  assert.ok(ov.organizations.total >= 1 && ov.organizations.suspended === 0);
});

test('suspending an organization locks out its people and computers; resuming restores them; nothing is deleted', async () => {
  const op = await platformAdmin('ops2@platform.test');
  const o = await org('Suspendable Ltd', 'owner@susp.test', op);
  const tok = await call('POST', '/api/v1/enrollment-tokens', {}, o.auth);
  const enrol = await call('POST', '/agent/v1/enroll', { enrollmentToken: tok.json().token, machineGuid: 'GUID-' + randomBytes(6).toString('hex'), hostname: 'PC-S', agentVersion: '0.1.0' });
  assert.equal(enrol.statusCode, 201);
  const dev = { authorization: `Bearer ${enrol.json().deviceId}.${enrol.json().deviceSecret}` };
  assert.equal((await call('GET', '/agent/v1/self', undefined, dev)).statusCode, 200);

  assert.equal((await call('POST', `/api/v1/platform/organizations/${o.id}/suspend`, { reason: 'unpaid invoice' }, op)).statusCode, 200);
  assert.equal((await call('GET', '/api/v1/me', undefined, o.auth)).statusCode, 403, 'a token issued before the suspension stops working');
  assert.equal((await call('POST', '/api/v1/auth/login', { email: 'owner@susp.test', password: PW })).statusCode, 403);
  assert.equal((await call('GET', '/agent/v1/self', undefined, dev)).statusCode, 403, 'its computers are refused too');
  const row = (await call('GET', '/api/v1/platform/organizations', undefined, op)).json().organizations.find((x: any) => x.id === o.id);
  assert.equal(row.suspended_reason, 'unpaid invoice'); assert.equal(row.devices, 1);

  assert.equal((await call('POST', `/api/v1/platform/organizations/${o.id}/resume`, undefined, op)).statusCode, 200);
  const back = await call('POST', '/api/v1/auth/login', { email: 'owner@susp.test', password: PW });
  assert.equal(back.statusCode, 200);
  assert.equal((await call('GET', '/agent/v1/self', undefined, dev)).statusCode, 200);
  const audit = (await call('GET', '/api/v1/platform/audit', undefined, op)).json().events.map((e: any) => e.action);
  assert.ok(audit.includes('platform.organization.suspend') && audit.includes('platform.organization.resume') && audit.includes('platform.organization.create'));
});

test('inside an organization, admins manage their own people and nobody can grant more access than they have', async () => {
  const op = await platformAdmin('ops3@platform.test');
  const a = await org('Alpha Co', 'owner@alpha.test', op), b = await org('Beta Co', 'owner@beta.test', op);
  const tech = await call('POST', '/api/v1/users', { email: 'tech@alpha.test', password: PW, role: 'technician' }, a.auth);
  assert.equal(tech.statusCode, 201);
  const adm = await call('POST', '/api/v1/users', { email: 'admin@alpha.test', password: PW, role: 'admin' }, a.auth);
  const adminAuth = bearer((await call('POST', '/api/v1/auth/login', { email: 'admin@alpha.test', password: PW })).json().token);
  assert.equal((await call('POST', '/api/v1/users', { email: 'x@alpha.test', password: PW, role: 'owner' }, adminAuth)).statusCode, 403, 'an admin cannot create an owner');
  assert.equal((await call('POST', '/api/v1/users', { email: 'y@alpha.test', password: PW, role: 'viewer' }, adminAuth)).statusCode, 201);
  const techAuth = bearer((await call('POST', '/api/v1/auth/login', { email: 'tech@alpha.test', password: PW })).json().token);
  assert.equal((await call('POST', '/api/v1/users', { email: 'z@alpha.test', password: PW, role: 'viewer' }, techAuth)).statusCode, 403, 'a technician cannot manage people');
  // Another organization never sees these people, and cannot change or remove them.
  assert.equal((await call('GET', '/api/v1/users', undefined, b.auth)).json().users.length, 1);
  assert.equal((await call('DELETE', `/api/v1/users/${tech.json().userId}`, undefined, b.auth)).statusCode, 404);
  // The last owner stays, and nobody removes themselves.
  const owners = (await call('GET', '/api/v1/users', undefined, a.auth)).json().users.filter((u: any) => u.role === 'owner');
  assert.equal((await call('PATCH', `/api/v1/users/${owners[0].id}`, { role: 'admin' }, a.auth)).statusCode, 409);
  assert.equal((await call('DELETE', `/api/v1/users/${owners[0].id}`, undefined, a.auth)).statusCode, 409);
  assert.equal((await call('DELETE', `/api/v1/users/${adm.json().userId}`, undefined, a.auth)).statusCode, 200);
});

test('platform admins: at least one stays active, passwords can be reset without being read, and the key still works for scripts', async () => {
  const op = await platformAdmin('ops4@platform.test');
  const me = (await call('GET', '/api/v1/platform/admins', undefined, op)).json().admins.find((x: any) => x.email === 'ops4@platform.test');
  assert.equal((await call('POST', `/api/v1/platform/admins/${me.id}/disable`, undefined, op)).statusCode, 409, 'you cannot disable yourself');
  const o = await org('Reset Co', 'owner@reset.test', op);
  const owner = (await call('GET', `/api/v1/platform/organizations/${o.id}/users`, undefined, op)).json().users[0];
  assert.equal((await call('POST', `/api/v1/platform/organizations/${o.id}/users/${owner.id}/reset-password`, { password: 'a brand new passphrase' }, op)).statusCode, 200);
  assert.equal((await call('POST', '/api/v1/auth/login', { email: 'owner@reset.test', password: PW })).statusCode, 401);
  assert.equal((await call('POST', '/api/v1/auth/login', { email: 'owner@reset.test', password: 'a brand new passphrase' })).statusCode, 200);
  assert.equal((await call('GET', '/api/v1/platform/overview', undefined, PK)).statusCode, 200);                       // scripts keep working with the key
  assert.equal((await call('GET', '/api/v1/platform/overview', undefined, { 'x-platform-key': 'wrong' })).statusCode, 401);
  const second = await call('POST', '/api/v1/platform/admins', { email: 'ops5@platform.test', password: PW }, op);
  assert.equal((await call('POST', `/api/v1/platform/admins/${second.json().adminId}/disable`, undefined, op)).statusCode, 200);
  assert.equal((await call('POST', '/api/v1/platform/auth/login', { email: 'ops5@platform.test', password: PW })).statusCode, 401, 'a disabled admin cannot sign in');
});
