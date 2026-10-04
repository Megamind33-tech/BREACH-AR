import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { base32Decode, base32Encode, hotp, stepOf, sealSecret, openSecret, verifyTotp } from '../src/totp.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54431); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const PK = { 'x-platform-key': 'platform-key' };
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Hdr = {}) => h.app.inject({ method, url, payload: payload as any, headers });
const PW = 'correct horse battery';
const bearer = (t: string) => ({ authorization: `Bearer ${t}` }) as Hdr;
const codeFor = (secret: string, offsetSteps = 0) => hotp(base32Decode(secret), stepOf(Date.now()) + offsetSteps);
let n = 0;
async function mkOrg(name = 'Acct' + ++n, plan = 'standard') {
  const email = `owner@${name.toLowerCase()}.test`;
  const r = await call('POST', '/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: PW, autopilot: false, plan }, PK);
  const l = await call('POST', '/api/v1/auth/login', { email, password: PW });
  return { orgId: r.json().organizationId as string, email, auth: bearer(l.json().token), ownerId: (await call('GET', '/api/v1/me', undefined, bearer(l.json().token))).json().userId as string };
}
async function addUser(o: { auth: Hdr }, email: string, role: string) {
  const r = await call('POST', '/api/v1/users', { email, password: PW, role }, o.auth); assert.equal(r.statusCode, 201, r.body);
  const l = await call('POST', '/api/v1/auth/login', { email, password: PW });
  return { id: r.json().userId as string, auth: bearer(l.json().token), login: l };
}
/** Turns MFA on for the signed-in person and returns the secret, recovery codes and a fresh token. */
async function enableMfa(auth: Hdr) {
  const s = await call('POST', '/api/v1/account/mfa/setup', { password: PW }, auth); assert.equal(s.statusCode, 200, s.body);
  const secret = s.json().secret as string;
  const e = await call('POST', '/api/v1/account/mfa/enable', { code: codeFor(secret) }, auth); assert.equal(e.statusCode, 200, e.body);
  return { secret, recovery: e.json().recoveryCodes as string[], auth: bearer(e.json().token) };
}

test('one-time codes follow RFC 6238, reject reuse and drift beyond one step, and secrets are sealed at rest', () => {
  const secret = Buffer.from('12345678901234567890');
  assert.equal(hotp(secret, Math.floor(59 / 30)), '287082');                       // RFC 6238 appendix B, T=59 s (last six digits of 94287082)
  assert.equal(hotp(secret, Math.floor(1111111109 / 30)), '081804');
  assert.deepEqual(base32Decode(base32Encode(secret)), secret);
  const b32 = base32Encode(secret), now = 1_700_000_000_000, step = stepOf(now);
  assert.equal(verifyTotp(b32, hotp(secret, step), now), step);
  assert.equal(verifyTotp(b32, hotp(secret, step - 1), now), step - 1, 'one step of clock drift is tolerated');
  assert.equal(verifyTotp(b32, hotp(secret, step - 2), now), null, 'two steps is too far');
  assert.equal(verifyTotp(b32, hotp(secret, step), now, step), null, 'a step already used is refused');
  assert.equal(verifyTotp(b32, '12345', now), null); assert.equal(verifyTotp(b32, 'abcdef', now), null);
  const sealed = sealSecret(b32, 'server-secret'); assert.ok(!sealed.includes(b32)); assert.equal(openSecret(sealed, 'server-secret'), b32);
  assert.throws(() => openSecret(sealed, 'another-secret'));
});

test('two-step sign-in: set up with the password, then every sign-in needs a code; codes work once; recovery codes work once; repeated failures lock', async () => {
  const o = await mkOrg();
  assert.equal((await call('POST', '/api/v1/account/mfa/setup', { password: 'wrong password!!' }, o.auth)).statusCode, 403);
  assert.equal((await call('POST', '/api/v1/account/mfa/enable', { code: '123456' }, o.auth)).statusCode, 409, 'setup must be started first');
  const s = await call('POST', '/api/v1/account/mfa/setup', { password: PW }, o.auth);
  assert.match(s.json().uri, /^otpauth:\/\/totp\/Viro%20WorkCare:/); const secret = s.json().secret as string;
  assert.equal((await call('POST', '/api/v1/account/mfa/enable', { code: '000000' }, o.auth)).statusCode, 400, 'a wrong code does not switch it on');
  const stored = (await h.db.query('SELECT mfa_pending_enc FROM users WHERE id=$1', [o.ownerId])).rows[0].mfa_pending_enc as string;
  assert.ok(!stored.includes(secret), 'the secret is not stored in clear');
  const en = await call('POST', '/api/v1/account/mfa/enable', { code: codeFor(secret) }, o.auth);
  assert.equal(en.statusCode, 200); assert.equal(en.json().recoveryCodes.length, 10);
  assert.equal((await call('GET', '/api/v1/account', undefined, o.auth)).json().mfa.recoveryCodesLeft, 10);

  const login = (code?: string | null) => call('POST', '/api/v1/auth/login', { email: o.email, password: PW, ...(code === undefined ? {} : { code }) });
  const noCode = await login(); assert.equal(noCode.statusCode, 401); assert.equal(noCode.json().error, 'mfa_required');
  assert.equal((await login(null)).json().error, 'mfa_required', 'an explicit null code is the same as none');
  const used = await login(codeFor(secret));
  assert.equal(used.statusCode, 401, 'the code used to switch it on is spent: no reuse within its step');
  const ok = await login(codeFor(secret, 1)); assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await login(codeFor(secret, 1))).statusCode, 401, 'the same code cannot sign in twice');
  const rc = en.json().recoveryCodes[0] as string;
  assert.equal((await login(rc)).statusCode, 200); assert.equal((await login(rc)).statusCode, 401, 'a recovery code works once');
  assert.equal((await call('GET', '/api/v1/account', undefined, bearer(ok.json().token))).json().mfa.recoveryCodesLeft, 9);

  for (let i = 0; i < 5; i++) assert.ok([401, 423].includes((await login('000000')).statusCode));      // earlier misses count too, so the lock may arrive sooner
  const locked = await login(codeFor(secret, -1)); assert.equal(locked.statusCode, 423, 'five wrong codes lock it for a few minutes, even for a right code');
  await h.db.query('UPDATE users SET mfa_locked_until=NULL WHERE id=$1', [o.ownerId]);

  const t = bearer(ok.json().token);
  assert.equal((await call('POST', '/api/v1/account/mfa/disable', { password: PW, code: '000000' }, t)).statusCode, 403);
  const regen = await call('POST', '/api/v1/account/mfa/recovery-codes', { password: PW, code: en.json().recoveryCodes[1] }, t); assert.equal(regen.statusCode, 200, regen.body);
  assert.notDeepEqual(regen.json().recoveryCodes, en.json().recoveryCodes);
  assert.equal((await login(rc)).statusCode, 401, 'old recovery codes stop working when new ones are made');
  const act = await h.db.query("SELECT action FROM audit_log WHERE org_id=$1 AND action LIKE 'user.mfa.%' ORDER BY id", [o.orgId]);
  assert.deepEqual(act.rows.map(r => r.action), ['user.mfa.enable', 'user.mfa.recovery-codes']);
});

test('an organization can require two-step sign-in: unprotected staff can only reach their account until it is set up; only an owner can change the rule', async () => {
  const o = await mkOrg();
  const tech = await addUser(o, `tech@${o.email.split('@')[1]}`, 'technician'), viewer = await addUser(o, `view@${o.email.split('@')[1]}`, 'viewer');
  const admin = await addUser(o, `admin@${o.email.split('@')[1]}`, 'admin');
  const settings = { name: 'Acme', countryCode: 'ZM', utcOffsetMinutes: 120, notificationEmails: [] as string[] };
  assert.equal((await call('PUT', '/api/v1/org/settings', { ...settings, requireMfa: true }, admin.auth)).statusCode, 403, 'an admin cannot change the requirement');
  assert.equal((await call('PUT', '/api/v1/org/settings', { ...settings, requireMfa: true }, o.auth)).statusCode, 200);

  const again = await call('POST', '/api/v1/auth/login', { email: `tech@${o.email.split('@')[1]}`, password: PW });
  assert.equal(again.json().mfaSetupRequired, true);
  const limited = bearer(again.json().token);
  const blocked = await call('GET', '/api/v1/devices', undefined, limited); assert.equal(blocked.statusCode, 403); assert.equal(blocked.json().error, 'mfa_setup_required');
  assert.equal((await call('GET', '/api/v1/me', undefined, limited)).json().mfaSetupRequired, true);
  assert.equal((await call('GET', '/api/v1/account', undefined, limited)).statusCode, 200);
  const done = await enableMfa(limited);
  assert.equal((await call('GET', '/api/v1/devices', undefined, done.auth)).statusCode, 200, 'the fresh token after setup has full access');
  assert.equal((await call('POST', '/api/v1/account/mfa/disable', { password: PW, code: codeFor(done.secret, 1) }, done.auth)).statusCode, 409, 'cannot switch it off while the organization requires it');

  const v = await call('POST', '/api/v1/auth/login', { email: `view@${o.email.split('@')[1]}`, password: PW });
  assert.equal(v.json().mfaSetupRequired, undefined, 'viewers are not in the required roles');
  assert.equal((await call('GET', '/api/v1/devices', undefined, viewer.auth)).statusCode, 200);
});

test('people: create, change role, disable (refused on the next request), enable, remove, with the owner and rank guards, and nothing crosses organizations', async () => {
  const a = await mkOrg(), b = await mkOrg();
  const dom = a.email.split('@')[1];
  const admin = await addUser(a, `admin@${dom}`, 'admin'), tech = await addUser(a, `tech@${dom}`, 'technician');
  assert.equal((await call('GET', '/api/v1/users', undefined, tech.auth)).statusCode, 403, 'technicians cannot list people');
  const list = (await call('GET', '/api/v1/users', undefined, a.auth)).json();
  assert.equal(list.users.length, 3); assert.ok(list.users.every((u: any) => 'mfa' in u && 'disabled_at' in u && !('password_hash' in u)));
  assert.equal((await call('POST', '/api/v1/users', { email: `x@${dom}`, password: PW, role: 'owner' }, admin.auth)).statusCode, 403, 'no creating someone above yourself');

  assert.equal((await call('GET', '/api/v1/me', undefined, tech.auth)).statusCode, 200);
  assert.equal((await call('PATCH', `/api/v1/users/${tech.id}`, { disabled: true }, admin.auth)).statusCode, 200);
  assert.equal((await call('GET', '/api/v1/me', undefined, tech.auth)).statusCode, 401, 'a disabled person is refused immediately');
  assert.equal((await call('POST', '/api/v1/auth/login', { email: `tech@${dom}`, password: PW })).statusCode, 401, 'and cannot sign in');
  assert.equal((await call('PATCH', `/api/v1/users/${tech.id}`, { disabled: false }, admin.auth)).statusCode, 200);
  assert.equal((await call('POST', '/api/v1/auth/login', { email: `tech@${dom}`, password: PW })).statusCode, 200);

  assert.equal((await call('PATCH', `/api/v1/users/${admin.id}`, { disabled: true }, admin.auth)).statusCode, 409, 'not yourself');
  assert.equal((await call('PATCH', `/api/v1/users/${a.ownerId}`, { role: 'viewer' }, admin.auth)).statusCode, 403, 'not someone above you');
  assert.equal((await call('PATCH', `/api/v1/users/${a.ownerId}`, { role: 'viewer' }, a.auth)).statusCode, 409, 'the only owner stays an owner');
  assert.equal((await call('PATCH', `/api/v1/users/${a.ownerId}`, { disabled: true }, a.auth)).statusCode, 409);
  assert.equal((await call('PATCH', `/api/v1/users/${tech.id}`, {}, admin.auth)).statusCode, 400, 'an empty change is refused');
  assert.equal((await call('PATCH', `/api/v1/users/${tech.id}`, { role: 'viewer' }, admin.auth)).json().role, 'viewer');

  assert.equal((await call('PATCH', `/api/v1/users/${tech.id}`, { disabled: true }, b.auth)).statusCode, 404, 'another organization cannot touch them');
  assert.equal((await call('DELETE', `/api/v1/users/${tech.id}`, undefined, b.auth)).statusCode, 404);
  assert.equal((await call('POST', `/api/v1/users/${tech.id}/mfa-reset`, undefined, b.auth)).statusCode, 404);

  const reset = await call('POST', `/api/v1/users/${tech.id}/password`, { password: 'a brand new password' }, admin.auth); assert.equal(reset.statusCode, 200);
  assert.equal((await call('POST', '/api/v1/auth/login', { email: `tech@${dom}`, password: 'a brand new password' })).statusCode, 200);

  // A person who lost their phone and recovery codes: an administrator clears their MFA and they set it up again.
  const mine = await call('POST', '/api/v1/auth/login', { email: `tech@${dom}`, password: 'a brand new password' });
  const withMfa = await enableMfa(bearer(mine.json().token)).catch(() => null);
  assert.equal(withMfa, null, 'password was changed, so the old setup password is wrong: setup needs the current one');
  const m2 = await call('POST', '/api/v1/account/mfa/setup', { password: 'a brand new password' }, bearer(mine.json().token)); assert.equal(m2.statusCode, 200);
  await call('POST', '/api/v1/account/mfa/enable', { code: codeFor(m2.json().secret) }, bearer(mine.json().token));
  assert.equal((await call('POST', '/api/v1/auth/login', { email: `tech@${dom}`, password: 'a brand new password' })).json().error, 'mfa_required');
  assert.equal((await call('POST', `/api/v1/users/${tech.id}/mfa-reset`, undefined, admin.auth)).statusCode, 200);
  assert.equal((await call('POST', '/api/v1/auth/login', { email: `tech@${dom}`, password: 'a brand new password' })).statusCode, 200);

  assert.equal((await call('DELETE', `/api/v1/users/${tech.id}`, undefined, admin.auth)).statusCode, 200);
  assert.equal((await call('GET', '/api/v1/me', undefined, tech.auth)).statusCode, 401, 'a removed person is refused too');
  const acts = (await h.db.query("SELECT action FROM audit_log WHERE org_id=$1 AND action LIKE 'user.%' ORDER BY id", [a.orgId])).rows.map(r => r.action);
  for (const want of ['user.create', 'user.disable', 'user.enable', 'user.role', 'user.password-reset', 'user.mfa.reset', 'user.remove']) assert.ok(acts.includes(want), want);
});

test('organization settings: validated, audited, and only admins write them', async () => {
  const o = await mkOrg('SettingsOrg');
  const dom = o.email.split('@')[1]; const viewer = await addUser(o, `v@${dom}`, 'viewer');
  const good = { name: '  Viro School  ', countryCode: 'ZM', utcOffsetMinutes: 120, requireMfa: false, notificationEmails: ['IT@Example.com', 'it@example.com', 'boss@example.com'] };
  assert.equal((await call('PUT', '/api/v1/org/settings', good, viewer.auth)).statusCode, 403);
  const r = await call('PUT', '/api/v1/org/settings', good, o.auth); assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { name: 'Viro School', plan: 'standard', countryCode: 'ZM', utcOffsetMinutes: 120, requireMfa: false, notificationEmails: ['it@example.com', 'boss@example.com'] });
  assert.equal((await call('GET', '/api/v1/org/settings', undefined, viewer.auth)).json().countryCode, 'ZM', 'viewers may read');
  assert.equal((await call('GET', '/api/v1/me', undefined, o.auth)).json().organization.name, 'Viro School');
  for (const bad of [{ countryCode: 'zm' }, { countryCode: 'ZMB' }, { utcOffsetMinutes: 9999 }, { notificationEmails: ['nope'] }, { name: '   ' }, { extra: 1 }]) assert.equal((await call('PUT', '/api/v1/org/settings', { ...good, ...bad }, o.auth)).statusCode, 400, JSON.stringify(bad));
  assert.equal((await h.db.query("SELECT count(*)::int n FROM audit_log WHERE org_id=$1 AND action='org.settings'", [o.orgId])).rows[0].n, 1);
});

test('the mining workload cannot be enabled until an owner accepts the compute terms; the acceptance is signed and recorded', async () => {
  const o = await mkOrg('ConsentOrg', 'compute_sponsored'); const dom = o.email.split('@')[1]; const admin = await addUser(o, `a@${dom}`, 'admin');
  const addr = '4' + 'A'.repeat(94);
  const mine = { enabled: true, fallback: 'xmrig', pool: { endpoints: [{ host: 'pool.example.test', port: 443, tls: true }], payoutAddress: addr } };
  const put = (s: object, auth = o.auth) => call('PUT', '/api/v1/compute/policy', { scope: { type: 'org' }, settings: s }, auth);
  const before = await put(mine); assert.equal(before.statusCode, 409); assert.equal(before.json().error, 'consent_required');
  assert.equal((await put({ enabled: true, fallback: 'selftest' })).statusCode, 200, 'the harmless self-test workload does not need it');
  const c0 = (await call('GET', '/api/v1/compute/consent', undefined, admin.auth)).json(); assert.equal(c0.accepted, false); assert.ok(c0.wording.text.length > 100);
  assert.equal((await call('POST', '/api/v1/compute/consent', {}, admin.auth)).statusCode, 403, 'only an owner accepts');
  assert.equal((await call('POST', '/api/v1/compute/consent', {}, o.auth)).statusCode, 200);
  const c1 = (await call('GET', '/api/v1/compute/consent', undefined, admin.auth)).json(); assert.equal(c1.accepted, true); assert.equal(c1.current.user_email, o.email);
  assert.equal((await put(mine)).statusCode, 200);
  const rec = (await h.db.query('SELECT wording_sha256, signature FROM compute_consents WHERE org_id=$1', [o.orgId])).rows[0];
  assert.match(rec.wording_sha256, /^[0-9a-f]{64}$/); assert.ok(rec.signature.length > 40);
  const other = await mkOrg('ConsentOther', 'compute_sponsored'); assert.equal((await put(mine, other.auth)).statusCode, 409, 'one organization\'s consent does not cover another');
});
