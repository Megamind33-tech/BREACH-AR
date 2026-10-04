import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.VIRO_MAIL_MODE = 'outbox';
const { startHarness } = await import('./helpers.js');

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54401); });
after(async () => { await h.stop(); });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
const outbox = () => (h.app as any).mailer.outbox as { to: string; subject: string; text: string }[];
const PK = { 'x-platform-key': 'platform-key' };

async function personal(email: string) {
  await post('/api/v1/signup', { name: 'Test Person', email, password: 'a-long-password-1', acceptTerms: true });
  const token = outbox().filter(m => m.to === email).pop()!.text.match(/token=([\w-]+)/)![1]!; await get(`/verify-email?token=${token}`);
  return { authorization: `Bearer ${(await post('/api/v1/auth/login', { email, password: 'a-long-password-1' })).json().token}` };
}

test('asking a technician is part of a paid plan, the reply is emailed to the person, and nobody else can see the request', async () => {
  const me = await personal('help@example.com'), other = await personal('other@example.com');
  const ask = { subject: 'My laptop is very slow', message: 'It takes ten minutes to start and the fan is loud all the time.', contact: '0961111111', details: { machine: 'HP ProBook', windows: 'Windows 11', freeGb: 4, issues: ['Disk almost full'] } };
  assert.equal((await post('/api/v1/help/requests', ask, me)).statusCode, 402, 'free plan: not included');

  await put('/api/v1/platform/billing/plans/help-year', { name: 'Care with help', audience: 'shop', price: 400, currency: 'ZMW', period: 'year', active: true }, PK);
  const method = (await post('/api/v1/platform/billing/methods', { kind: 'cash', label: 'Cash', instructions: 'Pay in person.' }, PK)).json().id;
  const order = (await post('/api/v1/billing/orders', { planCode: 'help-year', quantity: 1, methodId: method }, me)).json();
  await post(`/api/v1/billing/orders/${order.id}/paid`, { payerName: 'Test', transactionId: 'R9' }, me); await post(`/api/v1/platform/billing/orders/${order.id}/confirm`, {}, PK);

  assert.equal((await post('/api/v1/help/requests', { ...ask, message: 'short' }, me)).statusCode, 400);
  const sent = await post('/api/v1/help/requests', ask, me); assert.equal(sent.statusCode, 201);
  assert.equal((await get('/api/v1/help/requests', me)).json().requests.length, 1); assert.equal((await get('/api/v1/help/requests', other)).json().requests.length, 0);
  assert.equal((await get('/api/v1/platform/help', me)).statusCode, 403, 'the team queue is not for customers');

  const queue = (await get('/api/v1/platform/help?status=open', PK)).json().requests; assert.equal(queue.length, 1);
  assert.equal(queue[0].email, 'help@example.com'); assert.equal(queue[0].contact, '0961111111'); assert.equal(queue[0].details.freeGb, 4);
  const before = outbox().length;
  assert.equal((await post(`/api/v1/platform/help/${queue[0].id}/reply`, { reply: 'Please restart and open Viro, then run Fix my PC. Tell me what changes.' }, PK)).statusCode, 200);
  const mail = outbox().slice(before).find(m => m.to === 'help@example.com')!; assert.match(mail.subject, /Re: My laptop is very slow/); assert.match(mail.text, /Fix my PC/);
  const mine = (await get('/api/v1/help/requests', me)).json().requests[0]; assert.equal(mine.status, 'answered'); assert.match(mine.reply, /restart/);
  assert.equal((await post(`/api/v1/platform/help/${queue[0].id}/close`, {}, PK)).statusCode, 200);
});
