import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHarness } from './helpers.js';
import { hashPassword } from '../src/security.js';
import { isPrivateAddress, sign, validateWebhookUrl, webhookTick } from '../src/webhooks.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54338); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const patch = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PATCH', url, payload: payload as any, headers });
const del = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'DELETE', url, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });

async function mkOrg(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function enroll(auth: Hdr, guid: string, hostname: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
const GB = 2 ** 30;
const health = (d: { dev: Hdr }, over: object = {}) => h.app.inject({ method: 'PUT', url: '/agent/v1/health', headers: d.dev, payload: { collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }], ...over } });

interface Hit { headers: Record<string, string | string[] | undefined>; body: string }
function receiver(status: () => number) {
  const hits: Hit[] = [];
  const srv: Server = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => { hits.push({ headers: req.headers, body }); res.statusCode = status(); res.end('x'); });
  });
  return new Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }>(ok => srv.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`, hits, close: () => new Promise(r => srv.close(() => r())) })));
}

test('address and URL policy: https only, no credentials, never private or reserved addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
    assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
  assert.equal(validateWebhookUrl('https://hooks.example.com/x'), null);
  assert.match(validateWebhookUrl('http://hooks.example.com/x')!, /https/);
  assert.match(validateWebhookUrl('https://user:pw@hooks.example.com/x')!, /credentials/);
  assert.match(validateWebhookUrl('not a url')!, /valid/);
  assert.match(validateWebhookUrl('ftp://x.example.com')!, /https/);
});

test('the signature is a verifiable HMAC over timestamp and body', () => {
  const s = sign('secret', '1700000000', '{"a":1}');
  assert.match(s, /^sha256=[0-9a-f]{64}$/);
  assert.equal(s, sign('secret', '1700000000', '{"a":1}'));
  assert.notEqual(s, sign('secret', '1700000001', '{"a":1}'));
  assert.notEqual(s, sign('other', '1700000000', '{"a":1}'));
});

test('a webhook receives signed opened and resolved events, retries a failing receiver, and is isolated, admin-only and audited', async () => {
  const a = await mkOrg('Hook Org', 'o@hook.test'), b = await mkOrg('Hook Other', 'o@hook-other.test');

  // plain http is refused at creation
  let r = await post('/api/v1/alert-webhooks', { url: 'http://hooks.example.com/x' }, a.auth);
  assert.equal(r.statusCode, 400);

  process.env.VIRO_ALLOW_PRIVATE_WEBHOOKS = '1';   // development switch: lets the test receiver on 127.0.0.1 be used
  let status = 500;
  const rx = await receiver(() => status);
  try {
    r = await post('/api/v1/alert-webhooks', { url: rx.url, minSeverity: 'warning' }, a.auth);
    assert.equal(r.statusCode, 201);
    const { id, secret } = r.json(); assert.match(secret, /^[0-9a-f]{64}$/);
    assert.equal((await get('/api/v1/alert-webhooks', a.auth)).json().webhooks[0].secret, undefined, 'the secret is never listed again');
    assert.equal((await get('/api/v1/alert-webhooks', b.auth)).json().webhooks.length, 0, 'isolated per organization');
    assert.equal((await del(`/api/v1/alert-webhooks/${id}`, b.auth)).statusCode, 404);

    const d = await enroll(a.auth, 'hook-dev-0001', 'HOOK-PC');
    await health(d, { volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 3 * GB, isSystem: true }], defender: { antivirusEnabled: false }, avProducts: [] });

    // receiver is down (500): the delivery is retried later, alerting itself is unaffected
    await webhookTick(h.db);
    assert.ok(rx.hits.length >= 1);
    let q = await h.db.query(`SELECT status, attempts, last_error FROM alert_deliveries WHERE webhook_id=$1 ORDER BY id`, [id]);
    assert.ok(q.rows.every(x => x.status === 'pending' && /HTTP 500/.test(x.last_error)), JSON.stringify(q.rows));
    assert.ok((await get('/api/v1/alerts', a.auth)).json().alerts.length >= 2);

    // receiver recovers; make the retries due
    status = 200; const before = rx.hits.length;
    await h.db.query(`UPDATE alert_deliveries SET next_attempt_at=now() WHERE webhook_id=$1`, [id]);
    await webhookTick(h.db);
    assert.ok(rx.hits.length > before);
    q = await h.db.query(`SELECT status FROM alert_deliveries WHERE webhook_id=$1`, [id]);
    assert.ok(q.rows.length >= 2 && q.rows.every(x => x.status === 'ok'));

    // every request carries a valid signature and the alert content
    const hit = rx.hits[rx.hits.length - 1];
    const ts = String(hit.headers['x-viro-timestamp']);
    assert.equal(hit.headers['x-viro-signature'], sign(secret, ts, hit.body));
    const p = JSON.parse(hit.body);
    assert.equal(p.event, 'opened'); assert.equal(p.organizationId, a.orgId);
    assert.equal(p.alert.device.hostname, 'HOOK-PC'); assert.ok(['critical', 'warning'].includes(p.alert.severity));
    assert.match(p.text, /HOOK-PC/);

    // no duplicates on the next tick
    const n = rx.hits.length; await webhookTick(h.db); assert.equal(rx.hits.length, n);

    // fixing the problem resolves the alerts, and the receiver is told
    await health(d, { defender: { antivirusEnabled: true, realTimeProtection: true, signatureAgeDays: 0 }, avProducts: ['Windows Defender'] });
    await webhookTick(h.db);
    const events = rx.hits.map(x => JSON.parse(x.body).event);
    assert.ok(events.includes('resolved'), events.join(','));

    // the other organization received nothing about this org's devices
    await enroll(b.auth, 'hook-dev-0002', 'OTHER-PC');
    assert.ok(rx.hits.every(x => !/OTHER-PC/.test(x.body)));

    // test endpoint, disable, delete, audit
    assert.equal((await post(`/api/v1/alert-webhooks/${id}/test`, {}, a.auth)).statusCode, 200);
    assert.equal(rx.hits.map(x => JSON.parse(x.body).event).pop(), 'test');
    status = 503; assert.equal((await post(`/api/v1/alert-webhooks/${id}/test`, {}, a.auth)).statusCode, 502);
    assert.equal((await patch(`/api/v1/alert-webhooks/${id}`, { enabled: false }, a.auth)).json().enabled, false);
    assert.equal((await del(`/api/v1/alert-webhooks/${id}`, a.auth)).statusCode, 200);
    const acts = (await get('/api/v1/audit', a.auth)).json().entries.map((e: any) => e.action);
    for (const x of ['webhook.create', 'webhook.update', 'webhook.delete']) assert.ok(acts.includes(x), x);
  } finally { delete process.env.VIRO_ALLOW_PRIVATE_WEBHOOKS; await rx.close(); }
});

test('a private target is refused at delivery time in production mode, and a technician cannot manage webhooks', async () => {
  const a = await mkOrg('Hook Prod', 'o@hookprod.test');
  const r = await post('/api/v1/alert-webhooks', { url: 'https://127.0.0.1/hook' }, a.auth);
  assert.equal(r.statusCode, 201);
  const t = await post(`/api/v1/alert-webhooks/${r.json().id}/test`, {}, a.auth);
  assert.equal(t.statusCode, 502); assert.match(t.json().error, /private or reserved/);
  await h.db.query(`INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,'tech@hookprod.test',$2,'technician')`, [a.orgId, await hashPassword('another long password')]);
  const l = await post('/api/v1/auth/login', { email: 'tech@hookprod.test', password: 'another long password' });
  const tech = { authorization: `Bearer ${l.json().token}` };
  assert.equal((await get('/api/v1/alert-webhooks', tech)).statusCode, 403);
  assert.equal((await post('/api/v1/alert-webhooks', { url: 'https://example.com/x' }, tech)).statusCode, 403);
});
