import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { nextPeriodEnd, newReference } from '../src/billing.js';

test('subscriptions extend from their end and never shorten; references are unambiguous', () => {
  const now = new Date('2026-10-04T00:00:00Z');
  assert.equal(nextPeriodEnd('month', null, now)!.toISOString().slice(0, 10), '2026-11-04');
  assert.equal(nextPeriodEnd('year', new Date('2027-01-10T00:00:00Z'), now)!.toISOString().slice(0, 10), '2028-01-10');      // still running: added on top
  assert.equal(nextPeriodEnd('year', new Date('2025-01-10T00:00:00Z'), now)!.toISOString().slice(0, 10), '2027-10-04');      // lapsed: starts from today
  assert.equal(nextPeriodEnd('once', null, now), null);
  assert.match(newReference(), /^VBL-[2-9A-Z]{6}$/);
});

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54381); });
after(async () => { await h.stop(); });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
const PK = { 'x-platform-key': 'platform-key' }; const PW = 'correct horse battery';
async function org(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: PW, autopilot: false }, PK);
  const l = await post('/api/v1/auth/login', { email, password: PW }); return { id: r.json().organizationId as string, auth: { authorization: `Bearer ${l.json().token}` } };
}

test('nothing is on sale until the owner prices it, and a payment only counts once an operator confirms it', async () => {
  const a = await org('Shop A', 'a@shop.test'), b = await org('Shop B', 'b@shop.test');
  assert.deepEqual((await get('/api/v1/billing', a.auth)).json().plans, []);                         // plans start hidden
  assert.equal((await get('/api/v1/billing')).statusCode, 401);

  // the owner sets a plan (hidden until switched on) and the ways to pay
  assert.equal((await put('/api/v1/platform/billing/plans/care-year', { name: 'Care', audience: 'person', price: 250, currency: 'ZMW', period: 'year', per: 'pc', features: ['Verified fixes'], active: false }, PK)).statusCode, 200);
  assert.deepEqual((await get('/api/v1/billing', a.auth)).json().plans, []);
  assert.equal((await put('/api/v1/platform/billing/plans/care-year', { name: 'Care', audience: 'person', price: 250, currency: 'ZMW', period: 'year', per: 'pc', features: ['Verified fixes'], active: true }, PK)).statusCode, 200);
  assert.equal((await put('/api/v1/platform/billing/plans/care-year', { name: 'Care', audience: 'person', price: 250, currency: 'ZMW', period: 'year', active: true }, { 'x-platform-key': 'wrong' })).statusCode, 401);
  const momo = (await post('/api/v1/platform/billing/methods', { kind: 'mobile_money', label: 'MTN Mobile Money', instructions: 'Send the amount to the number below and put your reference in the note.', details: { number: '0970000000', name: 'Orange Mobility Solutions' }, currency: 'ZMW' }, PK)).json().id;
  const bank = (await post('/api/v1/platform/billing/methods', { kind: 'bank', label: 'Bank transfer', instructions: 'Transfer to the account below and quote your reference.', details: { account: '0000', bank: 'Example Bank' } }, PK)).json().id;
  const cash = (await post('/api/v1/platform/billing/methods', { kind: 'cash', label: 'Pay in person', instructions: 'Pay at our office and ask for a receipt.', details: { where: 'Lusaka' } }, PK)).json().id;
  const usd = (await post('/api/v1/platform/billing/methods', { kind: 'mobile_money', label: 'USD wallet', instructions: 'Send USD to the wallet.', currency: 'USD' }, PK)).json().id;

  const view = (await get('/api/v1/billing', a.auth)).json();
  assert.equal(view.plans.length, 1); assert.equal(view.methods.length, 4); assert.ok(!JSON.stringify(view.methods).includes('0970000000'), 'payment details are only shown once an order exists');
  assert.equal((await post('/api/v1/billing/orders', { planCode: 'care-year', quantity: 3, methodId: usd }, a.auth)).statusCode, 400);          // wrong currency for the wallet
  assert.equal((await post('/api/v1/billing/orders', { planCode: 'nope', quantity: 1, methodId: momo }, a.auth)).statusCode, 404);

  // place an order: the amount is computed by the server, never taken from the customer
  const o = await post('/api/v1/billing/orders', { planCode: 'care-year', quantity: 3, methodId: momo }, a.auth);
  assert.equal(o.statusCode, 201); const order = o.json();
  assert.equal(order.amount, 750); assert.equal(order.currency, 'ZMW'); assert.match(order.reference, /^VBL-/); assert.equal(order.pay.details.number, '0970000000');
  assert.equal((await get('/api/v1/billing', a.auth)).json().subscription, null, 'placing an order grants nothing');

  // another organization cannot touch it
  assert.equal((await post(`/api/v1/billing/orders/${order.id}/paid`, { payerName: 'Eve', transactionId: 'X1' }, b.auth)).statusCode, 404);
  // the customer says they paid: still nothing is active
  assert.equal((await post(`/api/v1/billing/orders/${order.id}/paid`, { payerName: 'Chanda M', payerPhone: '0961111111', transactionId: 'MP2610041234' }, a.auth)).statusCode, 200);
  assert.equal((await get('/api/v1/billing', a.auth)).json().subscription, null);
  assert.equal((await post(`/api/v1/platform/billing/orders/${order.id}/confirm`, {}, { 'x-platform-key': 'wrong' })).statusCode, 401);
  assert.equal((await post(`/api/v1/platform/billing/orders/${order.id}/confirm`, {}, a.auth)).statusCode, 403, 'an organization admin cannot confirm their own payment');

  const queue = (await get('/api/v1/platform/billing?status=submitted', PK)).json();
  assert.equal(queue.orders.length, 1); assert.equal(queue.orders[0].payer_txn, 'MP2610041234'); assert.equal(queue.orders[0].reference, order.reference);

  // the operator confirms the money arrived: the subscription starts, once
  const ok = await post(`/api/v1/platform/billing/orders/${order.id}/confirm`, {}, PK); assert.equal(ok.statusCode, 200);
  const sub = (await get('/api/v1/billing', a.auth)).json().subscription; assert.equal(sub.plan, 'care-year'); assert.equal(sub.quantity, 3); assert.equal(sub.active, true);
  assert.equal((await post(`/api/v1/platform/billing/orders/${order.id}/confirm`, {}, PK)).statusCode, 409);

  // a second year bought while the first is running is added on top
  const end1 = new Date(sub.validUntil).getTime();
  const o2 = (await post('/api/v1/billing/orders', { planCode: 'care-year', quantity: 1, methodId: bank }, a.auth)).json();
  await post(`/api/v1/billing/orders/${o2.id}/paid`, { payerName: 'Chanda M', transactionId: 'BK-9' }, a.auth);
  await post(`/api/v1/platform/billing/orders/${o2.id}/confirm`, {}, PK);
  const sub2 = (await get('/api/v1/billing', a.auth)).json().subscription; assert.ok(new Date(sub2.validUntil).getTime() - end1 > 360 * 86_400_000); assert.equal(sub2.quantity, 3);

  // cash: same path, and an operator can refuse a payment that never arrived
  const o3 = (await post('/api/v1/billing/orders', { planCode: 'care-year', quantity: 1, methodId: cash }, b.auth)).json();
  await post(`/api/v1/billing/orders/${o3.id}/paid`, { payerName: 'Bwalya K', transactionId: 'RCPT-1' }, b.auth);
  assert.equal((await post(`/api/v1/platform/billing/orders/${o3.id}/reject`, { reason: 'no payment received' }, PK)).statusCode, 200);
  const bView = (await get('/api/v1/billing', b.auth)).json(); assert.equal(bView.subscription, null); assert.equal(bView.orders[0].status, 'rejected'); assert.equal(bView.orders[0].reject_reason, 'no payment received');
  assert.equal((await get('/api/v1/billing', a.auth)).json().orders.length, 2, 'each organization sees only its own orders');

  // a pending order can be cancelled, a paid one cannot
  const o4 = (await post('/api/v1/billing/orders', { planCode: 'care-year', quantity: 1, methodId: cash }, a.auth)).json();
  assert.equal((await post(`/api/v1/billing/orders/${o4.id}/cancel`, {}, a.auth)).statusCode, 200);
  assert.equal((await post(`/api/v1/billing/orders/${order.id}/cancel`, {}, a.auth)).statusCode, 404);
});
