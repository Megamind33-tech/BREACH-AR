import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.VIRO_MAIL_MODE = 'outbox'; process.env.ALERT_EMAIL = 'owner@viro.test';
const { startHarness } = await import('./helpers.js');

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54392); });
after(async () => { await h.stop(); });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
const outbox = () => (h.app as any).mailer.outbox as { to: string; subject: string; text: string }[];
const PK = { 'x-platform-key': 'platform-key' };

test('the site can report anonymous events from its own address, and nothing else gets through', async () => {
  const pre = await h.app.inject({ method: 'OPTIONS', url: '/api/v1/public/event', headers: { origin: 'https://workcare.viro3.online', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(pre.statusCode, 204); assert.equal(pre.headers['access-control-allow-origin'], 'https://workcare.viro3.online');
  const stranger = await h.app.inject({ method: 'OPTIONS', url: '/api/v1/public/event', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(stranger.headers['access-control-allow-origin'], undefined, 'another site is not allowed');
  assert.equal((await post('/api/v1/public/event', { event: 'visit', source: 'facebook' })).statusCode, 204);
  assert.equal((await post('/api/v1/public/event', { event: 'visit', source: 'facebook' })).statusCode, 204);
  assert.equal((await post('/api/v1/public/event', { event: 'download_click', source: 'facebook<b>' })).statusCode, 204);
  assert.equal((await post('/api/v1/public/event', { event: 'visit' })).statusCode, 204);
  assert.equal((await post('/api/v1/public/event', { event: 'download' })).statusCode, 400, 'real downloads are counted by the server, not reported');
  assert.equal((await post('/api/v1/public/event', { event: 'visit', who: 'me' })).statusCode, 400, 'no extra fields are accepted');
  assert.equal((await get('/api/v1/platform/growth')).statusCode, 401, 'the numbers are for operators');
  const g = (await get('/api/v1/platform/growth?days=7', PK)).json();
  assert.equal(g.totals.visit, 3); assert.equal(g.totals.download_click, 1);
  const fb = g.sources.find((s: any) => s.source === 'facebook'); assert.equal(fb.visit, 2); assert.ok(g.sources.some((s: any) => s.source === 'facebook' && s.download_click === 0) || fb.download_click === 0);
  assert.ok(g.sources.some((s: any) => s.source === 'direct' && s.visit === 1));
  assert.ok(g.sources.some((s: any) => s.source === 'facebookb' && s.download_click === 1), 'markup is stripped from a source');
});

test('when a customer says they have paid the owner is emailed, and the console counts it', async () => {
  await h.app.inject({ method: 'PUT', url: '/api/v1/platform/billing/plans/care-year', payload: { name: 'Care', audience: 'person', price: 250, currency: 'ZMW', period: 'year', active: true } as any, headers: PK });
  const method = (await post('/api/v1/platform/billing/methods', { kind: 'mobile_money', label: 'Airtel Money', instructions: 'Send the amount and quote your reference.', details: { Number: '0970000000' }, currency: 'ZMW' }, PK)).json().id;
  const order = (await post('/api/v1/checkout', { name: 'Mwila Banda', email: 'mwila@example.com', password: 'a-long-password-1', acceptTerms: true, planCode: 'care-year', quantity: 1, methodId: method, source: { source: 'facebook', campaign: 'slow-pc' } })).json();
  assert.ok(!outbox().some(m => m.to === 'owner@viro.test'), 'placing an order is not yet a payment');
  const token = outbox().find(m => m.to === 'mwila@example.com')!.text.match(/token=([\w-]+)/)![1]!; await get(`/verify-email?token=${token}`);
  const auth = { authorization: `Bearer ${(await post('/api/v1/auth/login', { email: 'mwila@example.com', password: 'a-long-password-1' })).json().token}` };
  assert.equal((await get('/api/v1/platform/fleet', PK)).json().ordersAwaiting, 0);
  assert.equal((await post(`/api/v1/billing/orders/${order.id}/paid`, { payerName: 'Mwila Banda', payerPhone: '0971112222', transactionId: 'MP998877' }, auth)).statusCode, 200);
  const mail = outbox().find(m => m.to === 'owner@viro.test')!; assert.ok(mail, 'the owner is told');
  assert.ok(mail.subject.includes(order.reference) && mail.text.includes('MP998877') && mail.text.includes('facebook, slow-pc') && mail.text.includes('platform.html'));
  assert.equal((await get('/api/v1/platform/fleet', PK)).json().ordersAwaiting, 1);
  const g = (await get('/api/v1/platform/growth', PK)).json(); assert.equal(g.totals.orders, 1); assert.equal(g.sources.find((s: any) => s.source === 'facebook').orders, 1);
});
