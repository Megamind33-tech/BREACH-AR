import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHarness } from './helpers.js';
import { freshnessOf, headlineOf } from '../src/twin.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54451); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const PK = { 'x-platform-key': 'platform-key' };
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Hdr = {}) => h.app.inject({ method, url, payload: payload as any, headers });
const GB = 2 ** 30;
const CLEAN = { perf: { cpuAvgPercent: 10, ramPercent: 40, commitPercent: 50, diskLatencyMs: 4, diskQueue: 0.1, cpuFrequencyPercent: 100 }, memory: { totalBytes: 16 * GB },
  volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }], physicalDisks: [{ name: 'SSD', mediaType: 'SSD', health: 'Healthy', isSystem: true }], startup: [], processes: [], failedServices: [],
  updates: { pendingCount: 0, pendingCriticalCount: 0, pendingTitles: [], rebootRequired: false, lastInstallDays: 5 }, defender: { antivirusEnabled: true, realTimeProtection: true, signatureAgeDays: 0, activeThreats: 0 },
  avProducts: ['Windows Defender'], firewall: { domain: true, private: true, public: true }, crashes: [], unexpectedShutdowns7d: 0, driverErrors: [] };

async function mkOrg(name: string, plan = 'standard') {
  const email = `o@${name.toLowerCase()}.test`;
  const r = await call('POST', '/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false, plan }, PK);
  const l = await call('POST', '/api/v1/auth/login', { email, password: 'correct horse battery' });
  const auth = { authorization: `Bearer ${l.json().token}` } as Hdr;
  return { orgId: r.json().organizationId as string, auth };
}
async function enroll(o: { auth: Hdr }, host: string, health: object | null = CLEAN) {
  const t = await call('POST', '/api/v1/enrollment-tokens', {}, o.auth);
  const e = await call('POST', '/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: 'G-' + randomUUID(), hostname: host, agentVersion: '0.1.10' });
  const dev = { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr; const id = e.json().deviceId as string;
  await call('POST', '/agent/v1/heartbeat', { hostname: host, agentVersion: '0.1.10', metrics: {} }, dev);
  if (health) assert.equal((await call('PUT', '/agent/v1/health', { collectedAt: new Date().toISOString(), ...health }, dev)).statusCode, 200);
  return { id, dev };
}

test('freshness and headline helpers: stale data is never presented as live', () => {
  const now = Date.now();
  assert.equal(freshnessOf(null, 120, now), 'never'); assert.equal(freshnessOf(new Date(now - 30_000), 120, now), 'live');
  assert.equal(freshnessOf(new Date(now - 10 * 60_000), 120, now), 'recent'); assert.equal(freshnessOf(new Date(now - 5 * 3600_000), 120, now), 'stale');
  assert.equal(headlineOf('healthy', []), 'Working normally');
});

test('devices: a clean PC is healthy, a PC with a nearly full system drive needs attention with a plain finding; each shape matches the contract; another organization sees nothing', async () => {
  const o = await mkOrg('TwinA'), other = await mkOrg('TwinB');
  const good = await enroll(o, 'GOOD-PC');
  const bad = await enroll(o, 'FULL-PC', { ...CLEAN, volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 9 * GB, isSystem: true }] });
  await enroll(other, 'OTHER-PC');
  const list = (await call('GET', '/api/v1/twin/devices', undefined, o.auth)).json().devices as any[];
  assert.equal(list.length, 2); const byName = Object.fromEntries(list.map(d => [d.name, d]));
  assert.equal(byName['GOOD-PC'].status, 'healthy'); assert.equal(byName['GOOD-PC'].headline, 'Working normally'); assert.equal(byName['GOOD-PC'].freshness, 'live');
  assert.equal(byName['FULL-PC'].status, 'attention'); assert.match(byName['FULL-PC'].headline, /free/i);
  for (const d of list) { assert.equal(d.schemaVersion, 1); assert.equal(d.kind, 'pc'); assert.equal(d.source, 'server'); assert.ok(!Number.isNaN(Date.parse(d.timestamp))); }
  const detail = (await call('GET', `/api/v1/twin/devices/${bad.id}`, undefined, o.auth)).json();
  assert.equal(detail.status, 'attention'); const f = detail.findings.find((x: any) => x.id === 'storage.system_low');
  assert.ok(f, 'the storage finding is present'); assert.equal(f.severity, 'attention'); assert.equal(f.evidenceType, 'measured'); assert.ok(f.recommendedAction);
  assert.ok(detail.components.some((c: any) => c.component === 'storage'));
  assert.ok(detail.components.some((c: any) => c.status === 'unavailable' && c.unavailableReason), 'components with no data say so instead of looking healthy');
  assert.equal((await call('GET', `/api/v1/twin/devices/${good.id}`, undefined, other.auth)).statusCode, 404, 'another organization cannot read it');
  assert.equal((await call('GET', '/api/v1/twin/devices')).statusCode, 401);
});

test('passport entries come only from real rows and are newest first; alerts list open alerts only', async () => {
  const o = await mkOrg('TwinP'); const d = await enroll(o, 'PASS-PC');
  const p = (await call('GET', `/api/v1/twin/devices/${d.id}/passport`, undefined, o.auth)).json().events as any[];
  assert.equal(p[0].kind === 'enrolled' || p.some(e => e.kind === 'enrolled'), true); assert.ok(p.every(e => e.schemaVersion === 1 && e.origin));
  await h.db.query(`INSERT INTO service_events(device_id, org_id, occurred_at, source, service_type, reason, status) VALUES ($1,$2,now(),'TECHNICIAN','battery replacement','worn','CONFIRMED')`, [d.id, o.orgId]).catch(() => {});
  const p2 = (await call('GET', `/api/v1/twin/devices/${d.id}/passport`, undefined, o.auth)).json().events as any[];
  assert.deepEqual(p2.map(e => e.at), [...p2.map(e => e.at)].sort().reverse());
  await h.db.query(`INSERT INTO alerts(org_id,device_id,code,severity,message) VALUES ($1,$2,'t.x','critical','Protection is switched off')`, [o.orgId, d.id]);
  const al = (await call('GET', '/api/v1/twin/alerts', undefined, o.auth)).json().alerts as any[];
  assert.equal(al.length, 1); assert.equal(al[0].severity, 'critical'); assert.match(al[0].title, /PASS-PC/);
});

test('commands: only the listed capabilities exist, unknown or extra fields are refused, a disruptive one needs explicit confirmation, a viewer cannot send any, and each is audited', async () => {
  const o = await mkOrg('TwinC'); const d = await enroll(o, 'CMD-PC');
  const cmd = (body: unknown, auth = o.auth) => call('POST', `/api/v1/twin/devices/${d.id}/commands`, body, auth);
  assert.equal((await cmd({ capability: 'EXECUTE', command: 'calc' })).statusCode, 400, 'no generic execute');
  assert.equal((await cmd({ capability: 'RUN_QUICK_SCAN', command: 'calc' })).statusCode, 400, 'extra fields are refused');
  const scan = await cmd({ capability: 'RUN_QUICK_SCAN' }); assert.equal(scan.statusCode, 202, scan.body);
  assert.equal((await cmd({ capability: 'RUN_APPROVED_TEST', test: 'hardware' })).statusCode, 202);
  assert.equal((await cmd({ capability: 'RUN_APPROVED_TEST', test: 'registry-wipe' })).statusCode, 400);
  const need = await cmd({ capability: 'RUN_APPROVED_MAINTENANCE_ACTION', action: 'cleanup' }); assert.equal(need.statusCode, 409); assert.equal(need.json().error, 'confirmation_required');
  assert.equal((await cmd({ capability: 'RUN_APPROVED_MAINTENANCE_ACTION', action: 'cleanup', confirm: true })).statusCode, 202);
  const types = (await h.db.query("SELECT type FROM jobs WHERE device_id=$1 AND type <> 'anatomy.collect' ORDER BY created_at", [d.id])).rows.map(r => r.type);
  assert.deepEqual(types, ['health.check', 'hardware.diagnose', 'cleanup.run']);
  await h.db.query('INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,$2,$3,$4)', [o.orgId, 'v@twinc.test', (await import('../src/security.js')).hashPassword ? await (await import('../src/security.js')).hashPassword('another long password') : 'x', 'viewer']);
  const vt = { authorization: `Bearer ${(await call('POST', '/api/v1/auth/login', { email: 'v@twinc.test', password: 'another long password' })).json().token}` };
  assert.equal((await cmd({ capability: 'RUN_QUICK_SCAN' }, vt)).statusCode, 403);
  assert.equal((await h.db.query("SELECT count(*)::int n FROM audit_log WHERE org_id=$1 AND action='twin.command'", [o.orgId])).rows[0].n, 3);
  const other = await mkOrg('TwinD'); assert.equal((await call('POST', `/api/v1/twin/devices/${d.id}/commands`, { capability: 'RUN_QUICK_SCAN' }, other.auth)).statusCode, 404);
  assert.deepEqual((await call('GET', '/api/v1/twin/capabilities', undefined, o.auth)).json().capabilities.sort(), ['GET_ALERTS', 'GET_COMPUTE_STATUS', 'GET_DEVICE_HEALTH', 'GET_MACHINE_PASSPORT', 'PAUSE_COMPUTE', 'RESUME_COMPUTE', 'RUN_APPROVED_MAINTENANCE_ACTION', 'RUN_APPROVED_TEST', 'RUN_QUICK_SCAN']);
});

test('compute from the phone: view always; pause only where compute is already enabled; resume only clears a phone pause and never enables compute; the PC policy honours the pause', async () => {
  const std = await mkOrg('TwinE'); const sd = await enroll(std, 'STD-PC');
  const s0 = (await call('GET', `/api/v1/twin/devices/${sd.id}/compute`, undefined, std.auth)).json();
  assert.equal(s0.available, false); assert.equal(s0.canPause, false); assert.equal(s0.canResume, false);
  assert.equal((await call('POST', `/api/v1/twin/devices/${sd.id}/compute/pause`, {}, std.auth)).statusCode, 409, 'nothing to pause');
  assert.equal((await call('POST', `/api/v1/twin/devices/${sd.id}/compute/resume`, {}, std.auth)).statusCode, 409, 'resume cannot switch compute on');

  const o = await mkOrg('TwinF', 'compute_sponsored'); const d = await enroll(o, 'CMP-PC');
  await call('PUT', '/api/v1/compute/policy', { scope: { type: 'org' }, settings: { enabled: true, fallback: 'selftest' } }, o.auth);
  const policy = async () => JSON.parse((await call('GET', '/agent/v1/compute/policy', undefined, d.dev)).json().policy);
  assert.equal((await policy()).enabled, true);
  const s1 = (await call('GET', `/api/v1/twin/devices/${d.id}/compute`, undefined, o.auth)).json();
  assert.equal(s1.available, true); assert.equal(s1.enabledByPolicy, true); assert.equal(s1.canPause, true); assert.equal(s1.canResume, false);
  assert.equal((await call('POST', `/api/v1/twin/devices/${d.id}/compute/pause`, { minutes: 1 }, o.auth)).statusCode, 400, 'a pause is at least five minutes');
  const paused = await call('POST', `/api/v1/twin/devices/${d.id}/compute/pause`, { minutes: 60 }, o.auth); assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(paused.json().state, 'paused-from-phone'); assert.equal(paused.json().canResume, true);
  assert.equal((await policy()).enabled, false, 'the signed policy the PC fetches now says disabled');
  assert.equal((await call('POST', `/api/v1/twin/devices/${d.id}/compute/resume`, {}, o.auth)).statusCode, 200);
  assert.equal((await policy()).enabled, true);
  await call('PUT', '/api/v1/compute/policy', { scope: { type: 'org' }, settings: { enabled: false } }, o.auth);
  assert.equal((await call('POST', `/api/v1/twin/devices/${d.id}/compute/resume`, {}, o.auth)).statusCode, 409, 'resume never turns compute on once the policy is off');
  const acts = (await h.db.query("SELECT action FROM mining_audit_log WHERE org_id=$1 AND action IN ('device.pause','device.resume') ORDER BY id", [o.orgId])).rows.map(r => r.action);
  assert.deepEqual(acts, ['device.pause', 'device.resume']);
});
