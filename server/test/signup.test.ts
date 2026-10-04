import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.VIRO_MAIL_MODE = 'outbox';
const { startHarness } = await import('./helpers.js');
import { planFeatures, FREE, PLUS, ALL } from '../src/entitlements.js';

test('the free and paid lists do not overlap and every plan resolves to known features', () => {
  assert.ok(FREE.length > 0 && PLUS.length > 0); assert.equal(FREE.filter(f => PLUS.includes(f)).length, 0);
  assert.deepEqual(planFeatures('person', []), PLUS); assert.deepEqual(planFeatures('business', []), ALL);
  assert.deepEqual(planFeatures('person', ['fix.verified', 'not-a-feature']), ['fix.verified']);
  assert.ok(planFeatures('shop', []).includes('certificate.issue') && !planFeatures('person', []).includes('certificate.issue'));
});

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54391); });
after(async () => { await h.stop(); });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
const outbox = () => (h.app as any).mailer.outbox as { to: string; subject: string; text: string }[];
const PK = { 'x-platform-key': 'platform-key' }; const PW = 'correct horse battery';

test('anyone can create a personal account, nothing works until the email is confirmed, and the form never reveals who has an account', async () => {
  const body = { name: 'Chanda Mwila', email: 'chanda@example.com', password: 'a-long-password-1', acceptTerms: true };
  assert.equal((await post('/api/v1/signup', { ...body, acceptTerms: false })).statusCode, 400);
  assert.equal((await post('/api/v1/signup', { ...body, password: 'short' })).statusCode, 400);
  const first = await post('/api/v1/signup', body); assert.equal(first.statusCode, 202);
  const again = await post('/api/v1/signup', body); assert.equal(again.statusCode, 202); assert.deepEqual(again.json(), first.json());       // same answer for an address that already exists
  assert.equal(outbox().filter(m => m.to === 'chanda@example.com').length, 1, 'the second request sent nothing');

  const login = () => post('/api/v1/auth/login', { email: 'chanda@example.com', password: body.password });
  const blocked = await login(); assert.equal(blocked.statusCode, 403); assert.equal(blocked.json().emailNotVerified, true);

  const token = outbox().find(m => m.to === 'chanda@example.com')!.text.match(/token=([\w-]+)/)![1]!;
  assert.equal((await post('/api/v1/signup/verify', { token: 'x'.repeat(30) })).statusCode, 400);
  const page = await get(`/verify-email?token=${token}`); assert.equal(page.statusCode, 200); assert.match(page.body, /Your email is confirmed/);
  assert.match((await get(`/verify-email?token=${token}`)).body, /not valid any more/, 'a link works once');

  const ok = await login(); assert.equal(ok.statusCode, 200); const auth = { authorization: `Bearer ${ok.json().token}` };
  assert.equal((await get('/api/v1/me', auth)).json().organization.kind, 'personal');
  const free = (await get('/api/v1/entitlements', auth)).json(); assert.equal(free.kind, 'personal'); assert.equal(free.plan, null); assert.ok(free.features.includes('clean.space')); assert.ok(!free.features.includes('fix.verified'));

  // paid features on the server are closed to the free plan
  assert.equal((await get('/api/v1/devices/00000000-0000-4000-8000-000000000000/history', auth)).statusCode, 402);
  assert.equal((await post('/api/v1/devices/00000000-0000-4000-8000-000000000000/certificates', { buyerEmail: 'b@example.com' }, auth)).statusCode, 402);

  // buying a plan, confirmed by an operator, opens the paid set; letting it lapse closes it again
  await put('/api/v1/platform/billing/plans/care-year', { name: 'Care', audience: 'person', price: 250, currency: 'ZMW', period: 'year', active: true }, PK);
  const method = (await post('/api/v1/platform/billing/methods', { kind: 'cash', label: 'Cash', instructions: 'Pay in person.' }, PK)).json().id;
  const order = (await post('/api/v1/billing/orders', { planCode: 'care-year', quantity: 1, methodId: method }, auth)).json();
  assert.ok(!(await get('/api/v1/entitlements', auth)).json().features.includes('fix.verified'), 'ordering is not paying');
  await post(`/api/v1/billing/orders/${order.id}/paid`, { payerName: 'Chanda', transactionId: 'R1' }, auth);
  await post(`/api/v1/platform/billing/orders/${order.id}/confirm`, {}, PK);
  const plus = (await get('/api/v1/entitlements', auth)).json(); assert.equal(plus.plan, 'care-year'); assert.equal(plus.active, true);
  for (const f of ['fix.verified', 'uninstall.forced', 'health.warnings', 'move.cloud']) assert.ok(plus.features.includes(f), f);
  assert.ok(!plus.features.includes('certificate.issue'));
  await h.db.query(`UPDATE subscriptions SET current_period_end = now() - interval '1 day'`);
  const lapsed = (await get('/api/v1/entitlements', auth)).json(); assert.equal(lapsed.active, false); assert.ok(!lapsed.features.includes('fix.verified')); assert.ok(lapsed.features.includes('clean.space'));
});

test('organizations an operator set up keep every feature, and an unverified resend gives no hint either way', async () => {
  const r = await post('/api/v1/platform/organizations', { name: 'School', ownerEmail: 'it@school.test', ownerPassword: PW, autopilot: false }, PK);
  const l = await post('/api/v1/auth/login', { email: 'it@school.test', password: PW }); assert.equal(l.statusCode, 200, 'operator-created users are already trusted');
  const e = (await get('/api/v1/entitlements', { authorization: `Bearer ${l.json().token}` })).json(); assert.equal(e.kind, 'business'); assert.ok(e.features.includes('fix.verified') && e.features.includes('certificate.issue')); assert.ok(r.json().organizationId);
  const before = outbox().length;
  assert.equal((await post('/api/v1/signup/resend', { email: 'nobody@example.com' })).statusCode, 202);
  assert.equal((await post('/api/v1/signup/resend', { email: 'it@school.test' })).statusCode, 202);
  assert.equal(outbox().length, before, 'no mail for unknown or already-confirmed addresses');
});
