import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.VIRO_MAIL_MODE = 'outbox';
const { startHarness } = await import('./helpers.js');
import { planFeatures, FREE, PLUS, ALL } from '../src/entitlements.js';
import { sweepUnpaidAccounts } from '../src/signup.js';

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

test('an account only exists together with an order for a paid plan, and nothing is open until the money is confirmed', async () => {
  // nothing is on sale yet, so nobody can open an account
  const body = { name: 'Chanda Mwila', email: 'chanda@example.com', password: 'a-long-password-1', acceptTerms: true, planCode: 'care-year', quantity: 1, methodId: '00000000-0000-4000-8000-000000000000' };
  assert.equal((await post('/api/v1/checkout', body)).statusCode, 404);
  assert.equal((await post('/api/v1/signup', { name: 'x', email: 'a@b.co', password: 'a-long-password-1', acceptTerms: true })).statusCode, 404, 'there is no free sign-up');
  assert.equal((await h.db.query(`SELECT count(*)::int n FROM users WHERE email='chanda@example.com'`)).rows[0].n, 0, 'a refused purchase leaves no account behind');

  await put('/api/v1/platform/billing/plans/care-year', { name: 'Care', audience: 'person', price: 250, currency: 'ZMW', period: 'year', active: true }, PK);
  const method = (await post('/api/v1/platform/billing/methods', { kind: 'mobile_money', label: 'MTN Mobile Money', instructions: 'Send the amount and quote your reference.', details: { Number: '0970000000' }, currency: 'ZMW' }, PK)).json().id;
  const pub = (await get('/api/v1/public/plans')).json(); assert.equal(pub.plans.length, 1); assert.equal(pub.methods[0].label, 'MTN Mobile Money'); assert.ok(!JSON.stringify(pub).includes('0970000000'), 'payment details are only given with an order');
  const ok = { ...body, methodId: method };
  assert.equal((await post('/api/v1/checkout', { ...ok, acceptTerms: false })).statusCode, 400);
  assert.equal((await post('/api/v1/checkout', { ...ok, password: 'short' })).statusCode, 400);
  assert.equal((await post('/api/v1/checkout', { ...ok, planCode: 'nope' })).statusCode, 404);

  const first = await post('/api/v1/checkout', ok); assert.equal(first.statusCode, 201); const order = first.json();
  assert.equal(order.amount, 250); assert.match(order.reference, /^VBL-/); assert.equal(order.pay.details.Number, '0970000000');
  assert.equal((await post('/api/v1/checkout', ok)).statusCode, 409, 'an existing customer signs in to buy more');
  const mail = outbox().find(m => m.to === 'chanda@example.com')!; assert.ok(mail.text.includes(order.reference) && mail.text.includes('0970000000'), 'the confirmation email keeps the way to pay');

  const login = () => post('/api/v1/auth/login', { email: 'chanda@example.com', password: ok.password });
  const blocked = await login(); assert.equal(blocked.statusCode, 403); assert.equal(blocked.json().emailNotVerified, true);
  const token = mail.text.match(/token=([\w-]+)/)![1]!;
  assert.equal((await post('/api/v1/signup/verify', { token: 'x'.repeat(30) })).statusCode, 400);
  const page = await get(`/verify-email?token=${token}`); assert.equal(page.statusCode, 200); assert.match(page.body, /Your email is confirmed/);
  assert.match((await get(`/verify-email?token=${token}`)).body, /not valid any more/, 'a link works once');

  const auth = { authorization: `Bearer ${(await login()).json().token}` };
  assert.equal((await get('/api/v1/me', auth)).json().organization.kind, 'personal');
  const free = (await get('/api/v1/entitlements', auth)).json(); assert.equal(free.plan, null); assert.ok(free.features.includes('clean.space')); assert.ok(!free.features.includes('fix.verified'), 'ordering is not paying');
  assert.equal((await get('/api/v1/devices/00000000-0000-4000-8000-000000000000/history', auth)).statusCode, 402);
  assert.equal((await post('/api/v1/devices/00000000-0000-4000-8000-000000000000/certificates', { buyerEmail: 'b@example.com' }, auth)).statusCode, 402);

  // the buyer says they paid; the operator confirms the money arrived; only then do the paid features open
  assert.equal((await post(`/api/v1/billing/orders/${order.id}/paid`, { payerName: 'Chanda', transactionId: 'MP123' }, auth)).statusCode, 200);
  assert.ok(!(await get('/api/v1/entitlements', auth)).json().features.includes('fix.verified'));
  await post(`/api/v1/platform/billing/orders/${order.id}/confirm`, {}, PK);
  const plus = (await get('/api/v1/entitlements', auth)).json(); assert.equal(plus.plan, 'care-year'); assert.equal(plus.active, true);
  for (const f of ['fix.verified', 'uninstall.forced', 'health.warnings', 'move.cloud']) assert.ok(plus.features.includes(f), f);
  assert.ok(!plus.features.includes('certificate.issue'));
  await h.db.query(`UPDATE subscriptions SET current_period_end = now() - interval '1 day'`);
  const lapsed = (await get('/api/v1/entitlements', auth)).json(); assert.equal(lapsed.active, false); assert.ok(!lapsed.features.includes('fix.verified')); assert.ok(lapsed.features.includes('clean.space'));
});

test('an account that never pays is removed after two weeks, and one that paid is kept', async () => {
  const method = (await post('/api/v1/platform/billing/methods', { kind: 'cash', label: 'Cash', instructions: 'Pay in person.' }, PK)).json().id;
  await post('/api/v1/checkout', { name: 'Never Pays', email: 'never@example.com', password: 'a-long-password-1', acceptTerms: true, planCode: 'care-year', quantity: 1, methodId: method });
  assert.equal(await sweepUnpaidAccounts(h.db), 0, 'a new order is given time');
  await h.db.query(`UPDATE organizations SET created_at = now() - interval '15 days' WHERE name='Never Pays' OR id IN (SELECT org_id FROM users WHERE email='chanda@example.com')`);
  assert.equal(await sweepUnpaidAccounts(h.db), 1);
  assert.equal((await h.db.query(`SELECT count(*)::int n FROM users WHERE email='never@example.com'`)).rows[0].n, 0);
  assert.equal((await h.db.query(`SELECT count(*)::int n FROM users WHERE email='chanda@example.com'`)).rows[0].n, 1, 'a paying customer stays');
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
