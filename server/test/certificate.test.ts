import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
process.env.VIRO_MAIL_MODE = 'outbox';
const { startHarness } = await import('./helpers.js');
import { canonical, normaliseCode, newCode, CertSigner } from '../src/certificate.js';
import { machineHistory } from '../src/machine-history.js';
import { maskEmail } from '../src/mailer.js';

const reading = (over: any = {}): any => ({
  version: 1, collectedAt: new Date().toISOString(),
  system: { manufacturer: 'Dell Inc.', model: 'Latitude 5400', serial: 'ABC1234XYZ', formFactor: 'laptop', totalPhysicalMemoryBytes: 8 * 2 ** 30 },
  cpu: { name: 'Intel(R) Core(TM) i5-8365U CPU @ 1.60GHz' },
  memory: { slotsTotal: 2, modules: [{ capacityBytes: 8 * 2 ** 30, manufacturer: 'Samsung', partNumber: 'M471', serial: 'MEM1' }] },
  battery: { cycleCount: 640, wearPercent: 45, manufactureDate: '2020-03-02' },
  os: { caption: 'Microsoft Windows 11 Pro', build: '26200', installedAt: '2024-06-01' },
  evidence: { windowsInstalls: [{ date: '2020-05-20', product: 'Windows 10 Pro', build: '18363' }, { date: '2022-02-10', product: 'Windows 10 Pro', build: '19044' }], currentWindowsInstall: '2024-06-01' },
  diagnostics: { storage: { disks: [{ model: 'Samsung SSD 860', mediaType: 'SSD', health: 'Healthy', sizeBytes: 5e11, reliability: { powerOnHours: 21000, wearPercent: 12, unsafeShutdowns: 7 } }] } },
  unavailable: [], ...over,
});

test('machine history counts upgrades exactly, labels what is measured, and admits what a reinstall erases', () => {
  const h = machineHistory({ anatomy: reading(), changes: [{ detected_at: '2026-05-01T00:00:00Z', kind: 'memory', change: 'added', label: '8 GB Samsung' }], service: [], firstSeenByViro: '2026-01-01', now: new Date('2026-10-01') });
  assert.equal(h.summary.windowsUpgrades, 2); assert.equal(h.summary.memoryChangesSeen, 1); assert.equal(h.summary.watchedSince, '2026-01-01');
  assert.ok(h.facts.every(f => ['measured', 'observed', 'recorded'].includes(f.basis)));
  assert.ok(h.facts.some(f => f.label.includes('unsafe power-offs') && f.value === '7'));
  assert.ok(h.limits.some(l => /minimum/.test(l)));
  assert.equal(machineHistory({ anatomy: null, changes: [], service: [], firstSeenByViro: null }).hasData, false);
});

test('codes, masking and canonical signing are stable and tamper-evident', () => {
  assert.equal(normaliseCode('viro 7k2m-9qpx-4hna'), 'VIRO-7K2M-9QPX-4HNA'); assert.equal(normaliseCode('nonsense'), null); assert.match(newCode(), /^VIRO-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  assert.equal(maskEmail('jane.doe@example.com'), 'j***@e***.com'); assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  const s = CertSigner.fromPem(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  const sig = s.sign('{"a":1}'); assert.equal(s.verify('{"a":1}', sig), true); assert.equal(s.verify('{"a":2}', sig), false);
});

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54371); });
after(async () => { await h.stop(); });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
const PK = { 'x-platform-key': 'platform-key' }; const PW = 'correct horse battery';
async function org(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: PW, autopilot: false }, PK);
  const l = await post('/api/v1/auth/login', { email, password: PW }); return { id: r.json().organizationId as string, auth: { authorization: `Bearer ${l.json().token}` } };
}
async function enroll(o: { auth: Record<string, string> }, name: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, o.auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: 'G-' + randomBytes(6).toString('hex'), hostname: name, agentVersion: '0.1.0' });
  return { id: e.json().deviceId as string, auth: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } };
}
const outbox = () => (h.app as any).mailer.outbox as { to: string; subject: string; text: string; html: string }[];

test('the certificate goes only to the buyer, only after a fresh inspection, and a forged or edited copy does not verify', async () => {
  const seller = await org('Resale Co', 'owner@resale.test'), other = await org('Other Co', 'owner@other.test');
  const pc = await enroll(seller, 'LAPTOP-7');
  assert.equal((await post('/agent/v1/anatomy', reading({ collectedAt: new Date(Date.now() - 3600_000).toISOString() }), pc.auth)).statusCode, 201);   // an old reading exists
  assert.equal((await get(`/api/v1/devices/${pc.id}/history`, seller.auth)).json().summary.windowsUpgrades, 2);
  assert.equal((await get(`/api/v1/devices/${pc.id}/history`, other.auth)).statusCode, 404);

  assert.equal((await post(`/api/v1/devices/${pc.id}/certificates`, { buyerEmail: 'not-an-email' }, seller.auth)).statusCode, 400);
  const req = await post(`/api/v1/devices/${pc.id}/certificates`, { buyerEmail: 'buyer@example.com' }, seller.auth);
  assert.equal(req.statusCode, 202); assert.equal(req.json().buyerEmail, 'b***@e***.com'); assert.ok(!JSON.stringify(req.json()).includes('VIRO-'), 'the seller is never given the code');
  assert.equal((await post(`/api/v1/devices/${pc.id}/certificates`, { buyerEmail: 'buyer@example.com' }, seller.auth)).statusCode, 409);
  assert.equal(outbox().length, 0, 'the older reading must not be enough');

  // the fresh reading the inspection job produces triggers issuing
  assert.equal((await post('/agent/v1/anatomy', reading({ collectedAt: new Date(Date.now() + 1000).toISOString() }), pc.auth)).statusCode, 201);
  assert.equal(outbox().length, 1); const mail = outbox()[0]!; assert.equal(mail.to, 'buyer@example.com');
  const code = mail.text.match(/VIRO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/)![0];
  const list = (await get(`/api/v1/devices/${pc.id}/certificates`, seller.auth)).json().certificates;
  assert.equal(list[0].status, 'issued'); assert.equal(list[0].sentTo, 'b***@e***.com'); assert.ok(!JSON.stringify(list).includes(code), 'the seller cannot read the code back');
  assert.ok(!(await h.db.query(`SELECT buyer_email_pending FROM resale_certificates`)).rows.some((r: any) => r.buyer_email_pending), 'the address is erased once sent');

  const v = (await get(`/api/v1/verify/${code}`)).json(); assert.equal(v.state, 'valid'); assert.equal(v.signatureValid, true); assert.equal(v.statement.machine.serialLast4, '4XYZ'.slice(-4)); assert.equal(v.statement.history.summary.windowsUpgrades, 2);
  assert.ok(!JSON.stringify(v).includes('ABC1234XYZ'), 'the full serial number is never published');
  assert.equal((await get(`/api/v1/verify/${code.toLowerCase().replace(/-/g, ' ')}`)).json().state, 'valid');
  assert.equal((await get('/api/v1/verify/VIRO-AAAA-BBBB-CCCC')).statusCode, 404);
  assert.equal((await post(`/api/v1/verify/${code}/check-serial`, { serial: 'abc-1234 xyz' })).json().match, true);
  assert.equal((await post(`/api/v1/verify/${code}/check-serial`, { serial: 'WRONG0000' })).json().match, false);
  const page = await get(`/verify/${code}`); assert.equal(page.statusCode, 200); assert.match(page.body, /Genuine Viro certificate/); assert.match(page.body, /measured/);

  // editing the stored statement (what a forger would have to do) breaks the signature
  await h.db.query(`UPDATE resale_certificates SET statement = replace(statement, '"ramGb":8', '"ramGb":64')`);
  assert.equal((await get(`/api/v1/verify/${code}`)).json().state, 'invalid');
  assert.match((await get(`/verify/${code}`)).body, /does not verify/);
  await h.db.query(`UPDATE resale_certificates SET statement = replace(statement, '"ramGb":64', '"ramGb":8')`);
  assert.equal((await get(`/api/v1/verify/${code}`)).json().state, 'valid');

  // revoking works and only the owner organization can do it
  const id = list[0].id;
  assert.equal((await post(`/api/v1/certificates/${id}/revoke`, { reason: 'wrong machine' }, other.auth)).statusCode, 404);
  assert.equal((await post(`/api/v1/certificates/${id}/revoke`, { reason: 'wrong machine' }, seller.auth)).statusCode, 200);
  assert.equal((await get(`/api/v1/verify/${code}`)).json().state, 'revoked');
});

test('the public key endpoint lets anyone check a signature independently', async () => {
  const k = (await get('/api/v1/public/certificate-key')).json(); assert.equal(k.keyId.length, 12); assert.ok(k.spkiBase64.length > 50);
});
