import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
process.env.VIRO_MAIL_MODE = 'outbox';
const { startHarness } = await import('./helpers.js');

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54421); });
after(async () => { await h.stop(); });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
const del = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'DELETE', url, headers });
const outbox = () => (h.app as any).mailer.outbox as { to: string; text: string }[];
const PK = { 'x-platform-key': 'platform-key' };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const chunk = (id: string, n: number, body: Buffer, auth: Record<string, string>, hash = sha(body)) =>
  h.app.inject({ method: 'PUT', url: `/api/v1/move/snapshots/${id}/chunks/${n}`, payload: body, headers: { ...auth, 'content-type': 'application/octet-stream', 'x-chunk-sha256': hash } });

async function person(email: string) {
  await post('/api/v1/signup', { name: 'Test Person', email, password: 'a-long-password-1', acceptTerms: true });
  await get(`/verify-email?token=${outbox().filter(m => m.to === email).pop()!.text.match(/token=([\w-]+)/)![1]}`);
  return { authorization: `Bearer ${(await post('/api/v1/auth/login', { email, password: 'a-long-password-1' })).json().token}` };
}
async function buy(auth: Record<string, string>, quotaGb: number) {
  await put('/api/v1/platform/billing/plans/care-year', { name: 'Care', audience: 'person', price: 250, currency: 'ZMW', period: 'year', active: true, moveQuotaGb: quotaGb }, PK);
  const method = (await post('/api/v1/platform/billing/methods', { kind: 'cash', label: 'Cash ' + Math.random(), instructions: 'Pay in person.' }, PK)).json().id;
  const order = (await post('/api/v1/billing/orders', { planCode: 'care-year', quantity: 1, methodId: method }, auth)).json();
  await post(`/api/v1/billing/orders/${order.id}/paid`, { payerName: 'T', transactionId: 'R' + Math.random() }, auth); await post(`/api/v1/platform/billing/orders/${order.id}/confirm`, {}, PK);
}
const header = { label: 'Old laptop', machine: 'LAPTOP-7', kdf: { alg: 'pbkdf2-sha256', iterations: 600000, salt: randomBytes(16).toString('base64') }, keyCheck: randomBytes(40).toString('base64') };

test('Viro Move stores only what the app sends, enforces the plan allowance, checks every chunk, and keeps each person snapshots private', async () => {
  const me = await person('move@example.com'), other = await person('other-move@example.com');
  assert.equal((await post('/api/v1/move/snapshots', header, me)).statusCode, 402, 'free plan: not included');
  assert.equal((await get('/api/v1/move/snapshots', me)).json().quotaBytes, 0);

  await buy(me, 0.01);                                                                            // about 10 MB
  const ent = (await get('/api/v1/entitlements', me)).json(); assert.ok(ent.features.includes('move.cloud')); assert.equal(ent.moveQuotaBytes, Math.round(0.01 * 1024 ** 3));
  assert.equal((await post('/api/v1/move/snapshots', { ...header, kdf: { ...header.kdf, iterations: 1000 } }, me)).statusCode, 400, 'a weak key derivation is refused');
  const snap = (await post('/api/v1/move/snapshots', header, me)); assert.equal(snap.statusCode, 201); const id = snap.json().id;

  const a = randomBytes(1024 * 1024), b = randomBytes(2 * 1024 * 1024);
  assert.equal((await chunk(id, 0, a, me, 'f'.repeat(64))).statusCode, 400, 'a chunk damaged in transit is refused');
  assert.equal((await chunk(id, 0, a, me)).statusCode, 200); assert.equal((await chunk(id, 1, b, me)).statusCode, 200);
  assert.equal((await chunk(id, 1, b, me)).statusCode, 200, 'sending a chunk again replaces it and does not double count');
  assert.equal((await chunk(id, 0, a, other)).statusCode, 404, 'another person cannot write to it');
  const manifest = randomBytes(300).toString('base64');
  assert.equal((await post(`/api/v1/move/snapshots/${id}/finish`, { manifest, chunks: 3 }, me)).statusCode, 409, 'a missing chunk is caught before finishing');
  assert.equal((await post(`/api/v1/move/snapshots/${id}/finish`, { manifest, chunks: 2 }, me)).statusCode, 200);
  assert.equal((await chunk(id, 2, a, me)).statusCode, 404, 'a finished snapshot is sealed');

  const list = (await get('/api/v1/move/snapshots', me)).json(); assert.equal(list.snapshots.length, 1); assert.equal(list.usedBytes, a.length + b.length); assert.equal(list.snapshots[0].status, 'complete');
  assert.equal((await get('/api/v1/move/snapshots', other)).json().snapshots.length, 0); assert.equal((await get(`/api/v1/move/snapshots/${id}`, other)).statusCode, 404);
  const full = (await get(`/api/v1/move/snapshots/${id}`, me)).json(); assert.equal(full.manifest, manifest); assert.equal(full.keyCheck, header.keyCheck); assert.equal(full.chunks, 2);
  const dl = await get(`/api/v1/move/snapshots/${id}/chunks/1`, me); assert.equal(dl.statusCode, 200); assert.ok(dl.rawPayload.equals(b)); assert.equal(dl.headers['x-chunk-sha256'], sha(b));
  assert.equal((await get(`/api/v1/move/snapshots/${id}/chunks/1`, other)).statusCode, 404);

  // over the allowance: 3 MB used of about 10.7 MB; a second snapshot of two 5 MB chunks does not fit
  const s2 = (await post('/api/v1/move/snapshots', header, me)).json().id; const big = randomBytes(5 * 1024 * 1024);
  assert.equal((await chunk(s2, 0, big, me)).statusCode, 200); const over = await chunk(s2, 1, big, me); assert.equal(over.statusCode, 413); assert.match(over.json().error, /storage allowance/);

  // deleting frees the space and removes the data
  assert.equal((await del(`/api/v1/move/snapshots/${id}`, other)).statusCode, 404); assert.equal((await del(`/api/v1/move/snapshots/${id}`, me)).statusCode, 200);
  assert.equal((await del(`/api/v1/move/snapshots/${s2}`, me)).statusCode, 200);
  assert.equal((await get('/api/v1/move/snapshots', me)).json().usedBytes, 0);
});
