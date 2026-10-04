import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { hashPassword } from '../src/security.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54329); });
after(async () => { await h.stop(); });

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });

async function mkOrg(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false }, { 'x-platform-key': 'platform-key' });
  assert.equal(r.statusCode, 201);
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  assert.equal(l.statusCode, 200);
  return { auth: { authorization: `Bearer ${l.json().token}` }, orgId: r.json().organizationId as string };
}
async function enroll(auth: Record<string, string>, guid: string, host: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  assert.equal(t.statusCode, 201);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname: host, agentVersion: '0.1.0' });
  assert.equal(e.statusCode, 201);
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } };
}
const hbBody = (extra: object = {}) => ({ hostname: 'x', agentVersion: '1', metrics: {}, ...extra });

test('platform key is required to create organizations', async () => {
  const r = await post('/api/v1/platform/organizations', { name: 'x', ownerEmail: 'a@b.co', ownerPassword: 'correct horse battery', autopilot: false }, { 'x-platform-key': 'nope' });
  assert.equal(r.statusCode, 401);
});

test('enroll -> heartbeat -> inventory -> device page', async () => {
  const a = await mkOrg('Acme', 'admin@acme.test');
  const { deviceId, dev } = await enroll(a.auth, 'guid-acme-001', 'ACME-PC1');
  const hb = await post('/agent/v1/heartbeat', hbBody({ hostname: 'ACME-PC1', loggedInUser: 'ACME\\jo', uptimeSeconds: 100, metrics: { cpuPercent: 12.5, ramPercent: 40 } }), dev);
  assert.equal(hb.statusCode, 200);
  const inv = await h.app.inject({ method: 'PUT', url: '/agent/v1/inventory', headers: dev, payload: {
    collectedAt: new Date().toISOString(), hardware: { cpu: 'Test CPU', ramBytes: 8589934592 },
    software: [{ name: 'Chrome', version: '1.0', publisher: 'Google' }] } });
  assert.equal(inv.statusCode, 200);
  const d = (await get(`/api/v1/devices/${deviceId}`, a.auth)).json();
  assert.equal(d.status, 'online');
  assert.equal(d.hostname, 'ACME-PC1');
  assert.equal(d.inventory.hardware.cpu, 'Test CPU');
  assert.equal(d.inventory.software.length, 1);
  assert.equal(d.credential_hash, undefined);
  assert.equal((await get('/api/v1/devices', a.auth)).json().total, 1);
});

test('inventory with non-Latin software names and users round-trips (UTF8 database)', async () => {
  const a = await mkOrg('Unicode Org', 'u@uni.test');
  const { deviceId, dev } = await enroll(a.auth, 'guid-uni-0001', 'UNI-PC');
  const put = await h.app.inject({ method: 'PUT', url: '/agent/v1/inventory', headers: dev, payload: {
    collectedAt: new Date().toISOString(), hardware: { cpu: 'CPU' },
    software: [{ name: 'Яндекс Браузер', version: '1', publisher: '株式会社' }] } });
  assert.equal(put.statusCode, 200);
  const d = (await get(`/api/v1/devices/${deviceId}`, a.auth)).json();
  assert.equal(d.inventory.software[0].name, 'Яндекс Браузер');
});

test('health snapshot ingest -> scored device page, fleet list and overview; isolated per org', async () => {
  const a = await mkOrg('Health Org', 'h@health.test');
  const b = await mkOrg('Other Health Org', 'h@other-health.test');
  const { deviceId, dev } = await enroll(a.auth, 'guid-health-001', 'SLOW-PC');
  await enroll(b.auth, 'guid-health-002', 'OTHER-PC');
  const GB = 2 ** 30;
  const snap = { collectedAt: new Date().toISOString(), memory: { totalBytes: 8 * GB },
    volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 4 * GB, isSystem: true }],
    physicalDisks: [{ name: 'SSD', mediaType: 'SSD', health: 'Healthy', isSystem: true }] };
  assert.equal((await h.app.inject({ method: 'PUT', url: '/agent/v1/health', headers: dev, payload: { ...snap, perf: { cpuAvgPercent: 500 } } })).statusCode, 400, 'rejects nonsense');
  assert.equal((await h.app.inject({ method: 'PUT', url: '/agent/v1/health', headers: dev, payload: snap })).statusCode, 200);
  const page = (await get(`/api/v1/devices/${deviceId}`, a.auth)).json();
  assert.ok(page.health.overall < 100);
  assert.ok(page.health.deductions.some((x: any) => x.code === 'storage.system_low'));
  assert.equal(page.healthHistory.length, 1);
  const list = (await get('/api/v1/devices', a.auth)).json();
  assert.equal(list.devices[0].health_score, page.health.overall);
  const ov = (await get('/api/v1/overview', a.auth)).json();
  assert.equal(ov.computers, 1);
  assert.equal(ov.topIssues[0].code, 'storage.system_low');
  const ovB = (await get('/api/v1/overview', b.auth)).json();
  assert.equal(ovB.unassessed, 1, 'other org sees none of the first org health data');
  assert.deepEqual(ovB.topIssues, []);
});

test('organizations are fully isolated', async () => {
  const a = await mkOrg('Org A', 'a@iso.test');
  const b = await mkOrg('Org B', 'b@iso.test');
  const da = await enroll(a.auth, 'guid-iso-a', 'A-PC');
  await enroll(b.auth, 'guid-iso-b', 'B-PC');
  const listB = (await get('/api/v1/devices', b.auth)).json();
  assert.deepEqual(listB.devices.map((d: any) => d.hostname), ['B-PC']);
  assert.equal((await get(`/api/v1/devices/${da.deviceId}`, b.auth)).statusCode, 404);
  const auditB = (await get('/api/v1/audit', b.auth)).json();
  assert.ok(auditB.entries.every((e: any) => e.target_id !== da.deviceId));
  const siteA = (await post('/api/v1/sites', { name: 'HQ' }, a.auth)).json();
  assert.equal((await post('/api/v1/enrollment-tokens', { siteId: siteA.id }, b.auth)).statusCode, 404);
});

test('rejects bad credentials, bad/expired/exhausted tokens, revoked devices', async () => {
  const a = await mkOrg('Fail Org', 'f@fail.test');
  assert.equal((await post('/api/v1/auth/login', { email: 'f@fail.test', password: 'wrong wrong wrong' })).statusCode, 401);
  assert.equal((await get('/api/v1/devices')).statusCode, 401);
  assert.equal((await post('/agent/v1/enroll', { enrollmentToken: 'vet_bogus_bogus', machineGuid: 'g-12345678', hostname: 'x', agentVersion: '1' })).statusCode, 401);

  const one = (await post('/api/v1/enrollment-tokens', { maxUses: 1 }, a.auth)).json();
  const body = (g: string, tok = one.token) => ({ enrollmentToken: tok, machineGuid: g, hostname: 'x', agentVersion: '1' });
  assert.equal((await post('/agent/v1/enroll', body('guid-fail-0001'))).statusCode, 201);
  assert.equal((await post('/agent/v1/enroll', body('guid-fail-0002'))).statusCode, 401, 'exhausted token');

  const t2 = (await post('/api/v1/enrollment-tokens', {}, a.auth)).json();
  await h.db.query("UPDATE enrollment_tokens SET expires_at = now() - interval '1 minute' WHERE id=$1", [t2.id]);
  assert.equal((await post('/agent/v1/enroll', body('guid-fail-0003', t2.token))).statusCode, 401, 'expired token');

  const { dev, deviceId } = await enroll(a.auth, 'guid-fail-0004', 'FAIL-PC');
  assert.equal((await post('/agent/v1/heartbeat', hbBody(), { authorization: `Bearer ${deviceId}.wrongsecret` })).statusCode, 401);
  assert.equal((await post('/agent/v1/heartbeat', hbBody({ metrics: { cpuPercent: 900 } }), dev)).statusCode, 400, 'out-of-range metric');
  await h.db.query('UPDATE devices SET revoked_at=now() WHERE id=$1', [deviceId]);
  assert.equal((await post('/agent/v1/heartbeat', hbBody(), dev)).statusCode, 401, 'revoked device');
});

test('device goes offline after the online window; re-enrollment reuses the row and rotates the secret', async () => {
  const a = await mkOrg('Reconnect Org', 'r@re.test');
  const first = await enroll(a.auth, 'guid-re-0001', 'RE-PC');
  await post('/agent/v1/heartbeat', hbBody({ hostname: 'RE-PC' }), first.dev);
  await h.db.query("UPDATE devices SET last_seen_at = now() - interval '10 minutes' WHERE id=$1", [first.deviceId]);
  assert.equal((await get(`/api/v1/devices/${first.deviceId}`, a.auth)).json().status, 'offline');
  const second = await enroll(a.auth, 'guid-re-0001', 'RE-PC-RENAMED');
  assert.equal(second.deviceId, first.deviceId);
  assert.equal((await post('/agent/v1/heartbeat', hbBody(), first.dev)).statusCode, 401, 'old secret invalidated');
  assert.equal((await post('/agent/v1/heartbeat', hbBody(), second.dev)).statusCode, 200);
});

test('viewers cannot administer; audit trail records actions', async () => {
  const a = await mkOrg('Role Org', 'o@role.test');
  await h.db.query("INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,'v@role.test',$2,'viewer')", [a.orgId, await hashPassword('viewer viewer viewer')]);
  const l = await post('/api/v1/auth/login', { email: 'v@role.test', password: 'viewer viewer viewer' });
  const viewer = { authorization: `Bearer ${l.json().token}` };
  assert.equal((await post('/api/v1/enrollment-tokens', {}, viewer)).statusCode, 403);
  assert.equal((await get('/api/v1/devices', viewer)).statusCode, 200);
  await post('/api/v1/enrollment-tokens', {}, a.auth);
  const audit = (await get('/api/v1/audit', a.auth)).json();
  assert.ok(audit.entries.some((e: any) => e.action === 'enrollment_token.create'));
});

test('security overview: per-device shield states, isolation, and scan jobs are validated', async () => {
  const a = await mkOrg('Shield Org', 'o@shield.test'), b = await mkOrg('Shield Other', 'o@shield-other.test');
  const d1 = await enroll(a.auth, 'shield-dev-001', 'GOOD-PC'), d2 = await enroll(a.auth, 'shield-dev-002', 'RISKY-PC'); await enroll(b.auth, 'shield-dev-003', 'B-PC');
  const put = (d: { dev: Record<string, string> }, p: object) => h.app.inject({ method: 'PUT', url: '/agent/v1/health', headers: d.dev, payload: { collectedAt: new Date().toISOString(), ...p } });
  await put(d1, { defender: { antivirusEnabled: true, realTimeProtection: true, signatureAgeDays: 0 }, avProducts: ['Windows Defender'], firewall: { domain: true, private: true, public: true }, security: { engine: 'Microsoft Defender', engineIsDefender: true, lastQuickScan: new Date().toISOString(), signatureUpdatedAt: new Date().toISOString() } });
  await put(d2, { defender: { antivirusEnabled: false }, avProducts: [], firewall: { domain: true, private: true, public: false } });
  const o = (await get('/api/v1/security/overview', a.auth)).json();
  assert.equal(o.protected, 1); assert.equal(o.atRisk, 1); assert.equal(o.devices[0].hostname, 'RISKY-PC', 'at-risk first');
  assert.ok(o.devices[0].reasons.some((r: string) => /Defender is off/.test(r)));
  assert.equal((await get('/api/v1/security/overview', b.auth)).json().atRisk, 0);
  const job = (params: object, type = 'security.scan') => post('/api/v1/jobs', { type, params, target: { deviceIds: [d1.deviceId] } }, a.auth);
  assert.equal((await job({ scanType: 'full' })).statusCode, 201);
  assert.equal((await job({})).statusCode, 201, 'defaults to quick');
  assert.equal((await job({ scanType: 'custom', path: 'C:/' })).statusCode, 400);
  assert.equal((await job({ scanType: 'full', extra: 1 })).statusCode, 400);
  assert.equal((await job({}, 'security.update-signatures')).statusCode, 201);
  const full = (await h.db.query(`SELECT payload FROM jobs WHERE device_id=$1 AND params->>'scanType'='full'`, [d1.deviceId])).rows[0].payload;
  assert.equal(JSON.parse(full).timeoutSeconds, 22000);
});

test('regression: the heartbeat the real agent sends (explicit nulls for absent sections) is accepted', async () => {
  const a = await mkOrg('Null Beat Org', 'o@nullbeat.test'); const d = await enroll(a.auth, 'nullbeat-dev-01', 'NB-PC');
  const r = await post('/agent/v1/heartbeat', { hostname: 'NB-PC', agentVersion: '0.1.0', loggedInUser: null, ipAddress: '10.0.0.5', osCaption: 'Windows 11', osBuild: '26200', uptimeSeconds: 100,
    metrics: { cpuPercent: 12.5, ramPercent: 40, systemDiskFreeBytes: 1, systemDiskTotalBytes: 2, onBattery: false, userIdleSeconds: null },
    observedAt: new Date().toISOString(), integrity: null, updateResult: null }, d.dev);
  assert.equal(r.statusCode, 200, r.body);
  const full = await post('/agent/v1/heartbeat', { hostname: 'NB-PC', agentVersion: '0.1.0', metrics: {}, integrity: { exeSha256: 'a'.repeat(64), signed: false, signatureTrusted: false, signer: null, serviceOk: null, serviceIssue: null, dataDirProtected: null, installedPath: 'C:/x' }, updateResult: { version: '1.0.0', status: 'ok', detail: null } }, d.dev);
  assert.equal(full.statusCode, 200, full.body);
});
