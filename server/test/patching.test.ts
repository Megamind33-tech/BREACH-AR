import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { hashPassword } from '../src/security.js';
import { cmpVersion, rolloutTick } from '../src/patching.js';
import { validateSettings } from '../src/policies.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54336); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });
const del = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'DELETE', url, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });

async function mkOrg(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function mkUser(orgId: string, email: string, role: string) {
  await h.db.query('INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,$2,$3,$4)', [orgId, email, await hashPassword('another long password'), role]);
  return { authorization: `Bearer ${(await post('/api/v1/auth/login', { email, password: 'another long password' })).json().token}` } as Hdr;
}
async function enroll(auth: Hdr, guid: string, hostname = guid) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
type Dev = Awaited<ReturnType<typeof enroll>>;
const GB = 2 ** 30;
const putHealth = (d: Dev, over: object = {}) => put('/agent/v1/health', { collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }], ...over }, d.dev);
/** Plays the agent: start a queued job and report a result. */
async function agentRuns(d: Dev, jobId: string, status: 'completed' | 'failed', result?: unknown, error?: string) {
  assert.equal((await post(`/agent/v1/jobs/${jobId}/start`, {}, d.dev)).statusCode, 200);
  assert.equal((await post(`/agent/v1/jobs/${jobId}/result`, { status, result, error }, d.dev)).statusCode, 200);
}
const jobsOf = async (deviceId: string, type: string) => (await h.db.query(`SELECT id, status, params FROM jobs WHERE device_id=$1 AND type=$2 ORDER BY created_at`, [deviceId, type])).rows;
const scan = async (a: { auth: Hdr }, d: Dev, result: object) => { const id = (await post('/api/v1/jobs', { type: 'updates.scan', target: { deviceIds: [d.deviceId] } }, a.auth)).json().jobs[0].id; await agentRuns(d, id, 'completed', { scannedAt: new Date().toISOString(), ...result }); };
const DRV = '11111111-1111-4111-8111-111111111111';
const drvUpdate = { id: DRV, title: 'Intel - Net - 23.110.0.5', isDriver: true, driver: { manufacturer: 'Intel', model: 'Wi-Fi 6 AX201', class: 'Net', version: '23.110.0.5', hardwareId: 'PCI\\VEN_8086&DEV_A0F0' } };

test('cmpVersion orders dotted versions numerically', () => {
  assert.ok(cmpVersion('1.10.0', '1.9.9') > 0); assert.ok(cmpVersion('2.0', '2.0.0') === 0); assert.ok(cmpVersion('120.0.1', '121') < 0); assert.ok(cmpVersion('ad 9.0.14', '9.8.0') < 0);
});

test('new job types are validated; drivers only via rollout; software only from the approved catalog; policies cannot schedule them', async () => {
  const a = await mkOrg('Types Org', 'o@types.test'), tech = await mkUser((await mkOrg('X', 'x@types.test')).orgId, 'unused@types.test', 'technician').catch(() => ({} as Hdr));
  const d = await enroll(a.auth, 'types-dev-0001');
  const job = (type: string, params: object) => post('/api/v1/jobs', { type, params, target: { deviceIds: [d.deviceId] } }, a.auth);
  assert.equal((await job('updates.install', { scope: 'security' })).statusCode, 201);
  assert.equal((await job('updates.install', { scope: 'everything' })).statusCode, 400);
  assert.equal((await job('driver.install', { updateIds: [DRV] })).statusCode, 400, 'internal only');
  assert.equal((await job('driver.rollback', { infName: 'oem12.inf' })).statusCode, 201);
  assert.equal((await job('driver.rollback', { infName: '..\\x.inf' })).statusCode, 400);
  assert.equal((await job('software.install', { wingetId: 'Mozilla.Firefox' })).statusCode, 400, 'not approved');
  assert.equal((await post('/api/v1/software/catalog', { name: 'Firefox', wingetId: 'Mozilla.Firefox' }, a.auth)).statusCode, 201);
  assert.equal((await post('/api/v1/software/catalog', { name: 'Firefox', wingetId: 'Mozilla.Firefox' }, a.auth)).statusCode, 409);
  assert.equal((await job('software.install', { wingetId: 'mozilla.firefox' })).statusCode, 201, 'approved (case-insensitive)');
  assert.equal((await job('software.uninstall', { wingetId: 'Mozilla.Firefox' })).statusCode, 400, 'approved for install only');
  assert.equal((await post('/api/v1/software/catalog', { name: 'Flash', wingetId: 'Adobe.Flash', allowUninstall: true }, a.auth)).statusCode, 201);
  assert.equal((await job('software.uninstall', { wingetId: 'Adobe.Flash' })).statusCode, 201);
  assert.equal((await job('software.install', { wingetId: 'x --source evil' })).statusCode, 400);
  assert.equal((await job('message.send', { text: 'Please save your work.' })).statusCode, 201);
  for (const bad of ['say "hi"', 'a`b', '<b>x</b>', 'x'.repeat(301)]) assert.equal((await job('message.send', { text: bad })).statusCode, 400, bad);
  assert.equal((await job('system.reboot', { delaySeconds: 10 })).statusCode, 400);
  assert.equal((await job('system.shutdown', { delaySeconds: 10 })).statusCode, 400);
  { const r = await job('system.shutdown', { delaySeconds: 60, message: 'Switching off soon' }); assert.equal(r.statusCode, 201, r.body); }
  assert.equal((await job('system.shutdown', { message: 'x" /f /t 0 "' })).statusCode, 400);
  assert.equal((await job('system.reboot', { delaySeconds: 120, message: 'Restart soon' })).statusCode, 201);
  assert.equal((await job('system.reboot', { delaySeconds: 120, message: 'x" /f /t 0 "' })).statusCode, 400);
  for (const type of ['driver.install', 'software.install', 'message.send', 'system.reboot'])
    assert.equal(validateSettings({ schedules: [{ key: 'a', type, params: {}, everyMinutes: 60 }] }).ok, false, `${type} cannot be scheduled by a policy`);
  assert.ok(validateSettings({ schedules: [{ key: 'a', type: 'updates.install', params: { scope: 'security' }, weekly: { days: [0], time: '03:00' }, windowOnly: true }, { key: 'b', type: 'security.scan', params: { scanType: 'quick' }, everyMinutes: 1440 }] }).ok);
  void tech;
});

test('updates overview aggregates real scan results per org', async () => {
  const a = await mkOrg('Upd Org', 'o@upd.test'), b = await mkOrg('Upd Other', 'o@upd-other.test');
  const d1 = await enroll(a.auth, 'upd-dev-0001', 'PC1'), d2 = await enroll(a.auth, 'upd-dev-0002', 'PC2'), db_ = await enroll(b.auth, 'upd-dev-0003', 'OTHER');
  const u = (id: string, title: string, sec: boolean) => ({ id, title, kb: 'KB1', categories: [sec ? 'Security Updates' : 'Updates'] });
  await scan(a, d1, { pendingCount: 3, securityCount: 2, driverCount: 0, rebootRequired: true, updates: [u('a', 'Sec A', true), u('b', 'Sec B', true), u('c', 'Optional', false)], drivers: [] });
  await scan(a, d2, { pendingCount: 1, securityCount: 1, driverCount: 0, rebootRequired: false, updates: [u('a', 'Sec A', true)], drivers: [] });
  await scan(b, db_, { pendingCount: 99, securityCount: 99, driverCount: 0, updates: [], drivers: [] });
  const o = (await get('/api/v1/updates/overview', a.auth)).json();
  assert.equal(o.devicesScanned, 2); assert.equal(o.pendingSecurity, 3); assert.equal(o.pendingTotal, 4);
  assert.equal(o.topUpdates[0].id, 'a'); assert.equal(o.topUpdates[0].devices, 2); assert.equal(o.devices[0].hostname, 'PC1');
  assert.equal((await get('/api/v1/updates/overview', b.auth)).json().pendingTotal, 99);
});

test('restart after updates follows policy: ask (alert), auto (visible countdown job), never; a reboot resolves the alert', async () => {
  const a = await mkOrg('Restart Org', 'o@restart.test');
  const d = await enroll(a.auth, 'restart-dev-001'), d2 = await enroll(a.auth, 'restart-dev-002'), d3 = await enroll(a.auth, 'restart-dev-003');
  const install = async (dev: Dev) => { const id = (await post('/api/v1/jobs', { type: 'updates.install', params: { scope: 'security' }, target: { deviceIds: [dev.deviceId] } }, a.auth)).json().jobs[0].id; await agentRuns(dev, id, 'completed', { installed: 2, rebootRequired: true }); };
  await install(d);   // no policy: default is ask
  const alerts = (await get('/api/v1/alerts', a.auth)).json().alerts;
  assert.ok(alerts.some((x: any) => x.code === 'device.restart_pending' && x.device_id === d.deviceId));
  assert.equal((await jobsOf(d.deviceId, 'system.reboot')).length, 0);
  await post('/agent/v1/heartbeat', { hostname: 'x', agentVersion: '1', uptimeSeconds: 100000, metrics: {} }, d.dev);
  assert.ok((await get('/api/v1/alerts', a.auth)).json().alerts.some((x: any) => x.code === 'device.restart_pending'), 'still pending: uptime says it has not restarted');
  await h.db.query(`UPDATE alerts SET first_seen_at = now() - interval '1 hour' WHERE code='device.restart_pending'`);
  await post('/agent/v1/heartbeat', { hostname: 'x', agentVersion: '1', uptimeSeconds: 120, metrics: {} }, d.dev);
  assert.ok(!(await get('/api/v1/alerts', a.auth)).json().alerts.some((x: any) => x.code === 'device.restart_pending'), 'restarted: alert resolved');

  await post('/api/v1/devices/assign', { deviceIds: [d2.deviceId], addTags: ['auto'] }, a.auth); await post('/api/v1/devices/assign', { deviceIds: [d3.deviceId], addTags: ['manual'] }, a.auth);
  await post('/api/v1/policies', { name: 'Auto restart', scope: { type: 'tag', tag: 'auto' }, settings: { restartAfterUpdates: 'auto' } }, a.auth);
  await post('/api/v1/policies', { name: 'Never restart', scope: { type: 'tag', tag: 'manual' }, settings: { restartAfterUpdates: 'never' } }, a.auth);
  await install(d2); await install(d3);
  const rb = await jobsOf(d2.deviceId, 'system.reboot'); assert.equal(rb.length, 1); assert.equal(rb[0].params.delaySeconds, 600, 'ten-minute visible countdown');
  assert.equal((await jobsOf(d3.deviceId, 'system.reboot')).length, 0);
  assert.ok(!(await get('/api/v1/alerts', a.auth)).json().alerts.some((x: any) => x.device_id === d3.deviceId && x.code === 'device.restart_pending'));
});

test('staged driver rollout: test on one, verify health, pilot, a failing pilot halts everything, rollback removes the new package', async () => {
  const a = await mkOrg('Driver Org', 'o@driver.test'), b = await mkOrg('Driver Other', 'o@driver-other.test');
  const devs = await Promise.all([1, 2, 3, 4].map(n => enroll(a.auth, `driver-dev-000${n}`, `DRV-PC-${n}`)));
  const [d1, d2, d3, d4] = devs; const other = await enroll(b.auth, 'driver-dev-0009', 'OTHER-PC');
  for (const d of devs) { await putHealth(d); await scan(a, d, { pendingCount: 0, securityCount: 0, driverCount: 1, updates: [], drivers: [drvUpdate] }); }
  await putHealth(other); await scan(b, other, { driverCount: 1, updates: [], drivers: [drvUpdate] });

  const ov = (await get('/api/v1/drivers/overview', a.auth)).json();
  assert.equal(ov.outdated, 4); assert.equal(ov.updates[0].devices.length, 4); assert.equal(ov.updates[0].manufacturer, 'Intel'); assert.match(ov.note, /Windows Update/);
  const start = (deviceId: string, updateId = DRV, auth = a.auth) => post('/api/v1/driver-rollouts', { updateId, deviceId }, auth);
  assert.equal((await start(d1.deviceId, '22222222-2222-4222-8222-222222222222')).statusCode, 404, 'driver not pending there');
  assert.equal((await start(other.deviceId)).statusCode, 404, 'cannot start with another org device');
  const created = await start(d1.deviceId); assert.equal(created.statusCode, 201);
  const rid = created.json().id;
  assert.equal((await start(d2.deviceId)).statusCode, 409, 'one active rollout per driver');
  assert.equal((await post(`/api/v1/driver-rollouts/${rid}/advance`, { stage: 'pilot' }, a.auth)).statusCode, 409, 'test stage not verified yet');
  assert.equal((await post(`/api/v1/driver-rollouts/${rid}/advance`, { stage: 'fleet' }, a.auth)).statusCode, 409, 'cannot skip the pilot');

  // agent installs on the test device; the engine then schedules a post-install health check
  const inst = (await jobsOf(d1.deviceId, 'driver.install'))[0];
  assert.deepEqual(inst.params, { updateIds: [DRV] });
  await agentRuns(d1, inst.id, 'completed', { driversBefore: [{ id: DRV, installed: [] }], driversAfter: [{ id: DRV, installed: [] }], packagesAdded: ['oem17.inf'] });   // hardware not attached: only the driver store knows what was added
  await rolloutTick(h.db, h.signer);
  const verify = (await jobsOf(d1.deviceId, 'health.check'))[0]; assert.ok(verify, 'verification health check queued');
  assert.equal((await post(`/api/v1/driver-rollouts/${rid}/advance`, { stage: 'pilot' }, a.auth)).statusCode, 409, 'still not verified');
  await agentRuns(d1, verify.id, 'completed', {}); await putHealth(d1);            // healthy after the install
  await rolloutTick(h.db, h.signer);
  assert.equal((await get(`/api/v1/driver-rollouts/${rid}`, a.auth)).json().devices[0].status, 'verified');

  const adv = await post(`/api/v1/driver-rollouts/${rid}/advance`, { stage: 'pilot', deviceIds: [d2.deviceId, d3.deviceId] }, a.auth);
  assert.equal(adv.statusCode, 200); assert.equal(adv.json().devices, 2);
  assert.equal((await jobsOf(d4.deviceId, 'driver.install')).length, 0, 'not part of the pilot');
  assert.equal((await jobsOf(other.deviceId, 'driver.install')).length, 0, 'other orgs are never touched');

  // pilot device 2 is fine, pilot device 3 develops a driver error after the install: rollout halts
  for (const [d, bad] of [[d2, false], [d3, true]] as [Dev, boolean][]) {
    await agentRuns(d, (await jobsOf(d.deviceId, 'driver.install'))[0].id, 'completed', { driversBefore: [{ id: DRV, installed: [{ infName: 'oem1.inf' }] }], driversAfter: [{ id: DRV, installed: [{ infName: 'oem1.inf' }, { infName: 'oem30.inf' }] }] });
    await rolloutTick(h.db, h.signer);
    await agentRuns(d, (await jobsOf(d.deviceId, 'health.check'))[0].id, 'completed', {});
    await putHealth(d, bad ? { driverErrors: [{ name: 'Intel Wi-Fi 6', code: 43 }] } : {});
  }
  await rolloutTick(h.db, h.signer);
  const ro = (await get(`/api/v1/driver-rollouts/${rid}`, a.auth)).json();
  assert.equal(ro.status, 'halted'); assert.match(ro.halt_reason, /new driver errors/);
  assert.equal(ro.devices.find((x: any) => x.hostname === 'DRV-PC-2').status, 'verified');
  assert.equal(ro.devices.find((x: any) => x.hostname === 'DRV-PC-3').status, 'failed');
  assert.equal((await post(`/api/v1/driver-rollouts/${rid}/advance`, { stage: 'fleet' }, a.auth)).statusCode, 409, 'a halted rollout never advances');
  assert.equal((await jobsOf(d4.deviceId, 'driver.install')).length, 0, 'the fleet never received the bad driver');

  const rb = (await post(`/api/v1/driver-rollouts/${rid}/rollback`, {}, a.auth)).json();
  assert.equal(rb.rollbackQueued, 3);
  assert.deepEqual((await jobsOf(d1.deviceId, 'driver.rollback'))[0].params, { infName: 'oem17.inf' }, 'removes only the package that was added');
  assert.deepEqual((await jobsOf(d3.deviceId, 'driver.rollback'))[0].params, { infName: 'oem30.inf' });
  assert.equal((await post(`/api/v1/driver-rollouts/${rid}/halt`, {}, b.auth)).statusCode, 404);
  assert.ok((await get('/api/v1/audit/search?action=rollout.', a.auth)).json().entries.length >= 3);
});

test('a rollout completes when the fleet stage is fully verified', async () => {
  const a = await mkOrg('Complete Org', 'o@complete.test');
  const [d1, d2, d3] = await Promise.all([1, 2, 3].map(n => enroll(a.auth, `complete-dev-000${n}`)));
  for (const d of [d1, d2, d3]) { await putHealth(d); await scan(a, d, { driverCount: 1, updates: [], drivers: [drvUpdate] }); }
  const rid = (await post('/api/v1/driver-rollouts', { updateId: DRV, deviceId: d1.deviceId }, a.auth)).json().id;
  const finish = async (d: Dev) => { await agentRuns(d, (await jobsOf(d.deviceId, 'driver.install'))[0].id, 'completed', {}); await rolloutTick(h.db, h.signer); await agentRuns(d, (await jobsOf(d.deviceId, 'health.check'))[0].id, 'completed', {}); await putHealth(d); await rolloutTick(h.db, h.signer); };
  await finish(d1);
  assert.equal((await post(`/api/v1/driver-rollouts/${rid}/advance`, { stage: 'pilot', deviceIds: [d2.deviceId] }, a.auth)).statusCode, 200); await finish(d2);
  assert.equal((await post(`/api/v1/driver-rollouts/${rid}/advance`, { stage: 'fleet' }, a.auth)).json().devices, 1); await finish(d3);
  assert.equal((await get(`/api/v1/driver-rollouts/${rid}`, a.auth)).json().status, 'completed');
});

test('software rules raise and resolve alerts from real inventory; inventory aggregates; catalog changes are audited', async () => {
  const a = await mkOrg('Soft Org', 'o@soft.test'), b = await mkOrg('Soft Other', 'o@soft-other.test');
  const d1 = await enroll(a.auth, 'soft-dev-0001', 'S-PC1'), d2 = await enroll(a.auth, 'soft-dev-0002', 'S-PC2'), db_ = await enroll(b.auth, 'soft-dev-0003', 'B-PC');
  const inv = (d: Dev, software: object[]) => put('/agent/v1/inventory', { collectedAt: new Date().toISOString(), hardware: {}, software }, d.dev);
  await inv(d1, [{ name: 'Google Chrome', version: '118.0.1' }, { name: 'uTorrent', version: '3.5' }]);
  await inv(d2, [{ name: 'Google Chrome', version: '126.0.2' }]);
  await inv(db_, [{ name: 'uTorrent', version: '3.5' }]);
  assert.equal((await post('/api/v1/software/rules', { kind: 'prohibited', pattern: 'torrent', note: 'policy 4.2' }, a.auth)).statusCode, 201);
  assert.equal((await post('/api/v1/software/rules', { kind: 'min_version', pattern: 'chrome' }, a.auth)).statusCode, 400, 'needs minVersion');
  const ruleId = (await post('/api/v1/software/rules', { kind: 'min_version', pattern: 'google chrome', minVersion: '120.0' }, a.auth)).json().id;
  let v = (await get('/api/v1/software/violations', a.auth)).json().violations;
  assert.equal(v.length, 2); assert.ok(v.some((x: any) => x.hostname === 'S-PC1' && /Prohibited software installed: uTorrent 3.5 \(policy 4.2\)/.test(x.message)));
  assert.ok(v.some((x: any) => x.hostname === 'S-PC1' && /Google Chrome 118.0.1 is older than the required 120.0/.test(x.message)));
  assert.ok(!v.some((x: any) => x.hostname === 'S-PC2'), 'up-to-date Chrome is fine');
  assert.equal((await get('/api/v1/software/violations', b.auth)).json().violations.length, 0, 'rules apply only within their org');
  await inv(d1, [{ name: 'Google Chrome', version: '127.0.0' }]);           // uTorrent removed, Chrome updated
  assert.equal((await get('/api/v1/software/violations', a.auth)).json().violations.length, 0, 'alerts resolve themselves');
  await inv(d2, [{ name: 'Google Chrome', version: '110.0.0' }]);
  assert.equal((await get('/api/v1/software/violations', a.auth)).json().violations.length, 1);
  assert.equal((await del(`/api/v1/software/rules/${ruleId}`, a.auth)).statusCode, 200);
  assert.equal((await get('/api/v1/software/violations', a.auth)).json().violations.length, 0, 'deleting a rule clears its alerts');
  const apps = (await get('/api/v1/software/inventory?q=chrome', a.auth)).json();
  assert.equal(apps.applications.length, 1); assert.equal(apps.applications[0].devices, 2); assert.equal(apps.applications[0].versions[0].version, '127.0.0');
  assert.equal((await get('/api/v1/software/inventory', b.auth)).json().applications.length, 1);
  assert.ok((await get('/api/v1/audit/search?action=software.', a.auth)).json().entries.length >= 3);
});
