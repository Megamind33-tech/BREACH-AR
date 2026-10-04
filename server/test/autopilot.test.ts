import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { schedulerTick, autoAllowed, validateSettings } from '../src/policies.js';
import { rolloutTick } from '../src/patching.js';
import { autopilotSettings, describeAutopilot, DEFAULT_WINDOW } from '../src/autopilot.js';
import { CLEAN_CATEGORIES } from '../src/catalog.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54340); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });

async function mkOrg(name: string, email: string, autopilot?: boolean) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', ...(autopilot === undefined ? {} : { autopilot }) }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function enroll(auth: Hdr, guid: string, hostname = guid) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
type Dev = Awaited<ReturnType<typeof enroll>>;
const GB = 2 ** 30;
const putHealth = (d: Dev, over: object = {}) => put('/agent/v1/health', { collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }], ...over }, d.dev);
async function agentRuns(d: Dev, jobId: string, status: 'completed' | 'failed', result?: unknown) {
  assert.equal((await post(`/agent/v1/jobs/${jobId}/start`, {}, d.dev)).statusCode, 200);
  assert.equal((await post(`/agent/v1/jobs/${jobId}/result`, { status, result }, d.dev)).statusCode, 200);
}
const jobTypes = async (deviceId: string) => (await h.db.query(`SELECT type, params FROM jobs WHERE device_id=$1 ORDER BY created_at`, [deviceId])).rows;

test('a new organization runs on Autopilot by default; it is an ordinary, valid, visible policy that can be tuned or switched off', async () => {
  const a = await mkOrg('Auto Org', 'o@auto.test');
  const st = (await get('/api/v1/autopilot', a.auth)).json();
  assert.equal(st.exists, true); assert.equal(st.enabled, true);
  assert.deepEqual(st.window, DEFAULT_WINDOW);
  assert.ok(st.does.length >= 4 && st.does.some((x: string) => /security updates/i.test(x)) && st.does.some((x: string) => /never deletes personal files/i.test(x)));
  const pols = (await get('/api/v1/policies', a.auth)).json().policies;
  assert.equal(pols.length, 1); assert.equal(pols[0].name, 'Autopilot');
  assert.equal(validateSettings(pols[0].settings).ok, true);
  assert.equal(pols[0].settings.restartAfterUpdates, 'auto');

  // the window can be changed (validated), and the change is audited
  assert.equal((await put('/api/v1/autopilot', { window: { days: [1, 2, 3], start: '22:00', end: '04:00' } }, a.auth)).statusCode, 200);
  assert.equal((await get('/api/v1/autopilot', a.auth)).json().window.start, '22:00');
  assert.equal((await put('/api/v1/autopilot', { window: { days: [9], start: '22:00', end: '04:00' } }, a.auth)).statusCode, 400);
  assert.equal((await put('/api/v1/autopilot', { enabled: false }, a.auth)).json().enabled, false);
  assert.ok((await get('/api/v1/audit', a.auth)).json().entries.some((e: any) => e.action === 'autopilot.update'));

  // opting out at creation, enabling later, and role checks
  const b = await mkOrg('Manual Org', 'o@manual.test', false);
  const sb = (await get('/api/v1/autopilot', b.auth)).json(); assert.equal(sb.exists, false); assert.equal(sb.enabled, false);
  assert.equal((await put('/api/v1/autopilot', { enabled: true }, b.auth)).json().enabled, true);
  assert.equal((await get('/api/v1/policies', b.auth)).json().policies.length, 1);
  await h.db.query(`INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,'v@manual.test','x','viewer')`, [b.orgId]);
  assert.equal((await put('/api/v1/autopilot', { enabled: false }, {})).statusCode, 401);
  assert.equal(describeAutopilot({ days: [1, 5], start: '23:00', end: '03:00' }).some(x => /Monday, Friday/.test(x)), true);
});

test('Autopilot schedules health/updates work always, but installs, cleanup and hardware tests only inside the maintenance window', async () => {
  const a = await mkOrg('Auto Sched', 'o@autosched.test');
  const d = await enroll(a.auth, 'auto-dev-0001', 'AUTO-PC-1');
  const inWin = new Date('2026-10-05T01:30:00Z');      // Monday 01:30, organization offset 0
  await schedulerTick(h.db, h.signer, inWin);
  const types = (await jobTypes(d.deviceId)).map(x => `${x.type}${x.params?.recipe ? ':' + x.params.recipe : ''}`);
  for (const t of ['health.check', 'security.status', 'updates.scan', 'updates.install', 'repair.run:cleanup.safe', 'hardware.diagnose']) assert.ok(types.includes(t), `${t} in window; got ${types}`);
  assert.deepEqual((await jobTypes(d.deviceId)).find(x => x.type === 'updates.install')!.params, { scope: 'security' }, 'security only, never "all"');
  const recent = (await get('/api/v1/autopilot', a.auth)).json().recent;   // what Autopilot did, for the console
  assert.ok(recent.some((x: any) => x.type === 'updates.install' && x.hostname === 'AUTO-PC-1'), 'listed as recent activity');
  assert.ok(!recent.some((x: any) => x.type === 'health.check'), 'routine checks are not noise');

  const d2 = await enroll(a.auth, 'auto-dev-0002', 'AUTO-PC-2');
  await schedulerTick(h.db, h.signer, new Date('2026-10-05T12:00:00Z'));       // midday: outside the window
  const t2 = (await jobTypes(d2.deviceId)).map(x => x.type);
  assert.ok(t2.includes('health.check') && t2.includes('updates.scan'));
  for (const bad of ['updates.install', 'hardware.diagnose']) assert.ok(!t2.includes(bad), `${bad} must wait for the window`);
  assert.ok(!(await jobTypes(d2.deviceId)).some(x => x.type === 'repair.run'), 'cleanup waits for the window');
});

test('safe problems are fixed automatically and only from the allowlist; judgement calls and personal data never are', async () => {
  const a = await mkOrg('Auto Fix', 'o@autofix.test');
  const d = await enroll(a.auth, 'autofix-dev-0001', 'FIX-PC');
  await putHealth(d, { defender: { antivirusEnabled: true, realTimeProtection: true, signatureAgeDays: 20 }, avProducts: ['Windows Defender'], volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 3 * GB, isSystem: true }] });
  const jobs = await jobTypes(d.deviceId);
  assert.ok(jobs.some(j => j.type === 'security.update-signatures'), 'stale definitions are refreshed by themselves: ' + JSON.stringify(jobs.map(j => j.type)));
  const clean = jobs.find(j => j.type === 'cleanup.run'); assert.ok(clean, 'a full system drive triggers the safe cleanup');
  for (const c of clean!.params.categories) assert.equal((CLEAN_CATEGORIES as any)[c].class, 'SAFE', 'only safe-class categories');

  // cooldown: a second health report does not pile up more jobs
  const n = (await jobTypes(d.deviceId)).length; await putHealth(d, { defender: { antivirusEnabled: true, realTimeProtection: true, signatureAgeDays: 20 }, avProducts: ['Windows Defender'] });
  assert.equal((await jobTypes(d.deviceId)).length, n);

  // Autopilot switched off: nothing is done automatically
  const m = await mkOrg('Auto Off', 'o@autooff.test');
  await put('/api/v1/autopilot', { enabled: false }, m.auth);
  const d3 = await enroll(m.auth, 'autofix-dev-0003', 'OFF-PC');
  await putHealth(d3, { defender: { antivirusEnabled: true, realTimeProtection: true, signatureAgeDays: 20 }, avProducts: ['Windows Defender'] });
  assert.equal((await jobTypes(d3.deviceId)).length, 0);

  // the allowlist itself
  assert.equal(autoAllowed({ jobType: 'repair.run', params: { recipe: 'windows.update-reset', approved: true, options: { force: true } }, label: 'x' }), false, 'review-risk repairs need a person');
  assert.equal(autoAllowed({ jobType: 'repair.run', params: { recipe: 'network.reset' }, label: 'x' }), false);
  assert.equal(autoAllowed({ jobType: 'repair.run', params: { recipe: 'services.restart-failed' }, label: 'x' }), true);
  assert.equal(autoAllowed({ jobType: 'cleanup.run', params: { categories: ['downloads'] }, label: 'x', confirm: 'y' }), false, 'personal folders are never automatic');
  assert.equal(autoAllowed({ jobType: 'system.reboot', params: {}, label: 'x' }), false);
  assert.equal(autoAllowed({ jobType: 'security.scan', params: { scanType: 'full' }, label: 'x' }), false);
  assert.equal(autoAllowed({ jobType: 'security.scan', params: { scanType: 'quick' }, label: 'x' }), true);
  assert.ok(autopilotSettings().autoRepair?.safeFixes);
});

test('with Autopilot, a driver rollout the administrator started widens by itself, and still halts on a failure', async () => {
  const a = await mkOrg('Auto Drv', 'o@autodrv.test');
  const DRV = '33333333-3333-4333-8333-333333333333';
  const upd = { id: DRV, title: 'Intel - Net - 23.110.0.5', isDriver: true, driver: { manufacturer: 'Intel', model: 'Wi-Fi', class: 'Net', version: '23.110.0.5', hardwareId: 'PCI\\VEN_8086' } };
  const devs = await Promise.all([1, 2, 3].map(n => enroll(a.auth, `autodrv-dev-000${n}`, `AD-PC-${n}`)));
  for (const d of devs) {
    await putHealth(d);
    const id = (await post('/api/v1/jobs', { type: 'updates.scan', target: { deviceIds: [d.deviceId] } }, a.auth)).json().jobs[0].id;
    await agentRuns(d, id, 'completed', { scannedAt: new Date().toISOString(), pendingCount: 0, securityCount: 0, driverCount: 1, updates: [], drivers: [upd] });
  }
  const rid = (await post('/api/v1/driver-rollouts', { updateId: DRV, deviceId: devs[0].deviceId }, a.auth)).json().id;
  const install = async (d: Dev, bad = false) => {
    const j = (await h.db.query(`SELECT id FROM jobs WHERE device_id=$1 AND type='driver.install' AND status='queued'`, [d.deviceId])).rows[0];
    await agentRuns(d, j.id, 'completed', { driversBefore: [{ id: DRV, installed: [] }], driversAfter: [{ id: DRV, installed: [{ infName: 'oem9.inf' }] }] });
    await rolloutTick(h.db, h.signer);
    const v = (await h.db.query(`SELECT id FROM jobs WHERE device_id=$1 AND type='health.check' AND status='queued'`, [d.deviceId])).rows[0];
    await agentRuns(d, v.id, 'completed', {}); await putHealth(d, bad ? { driverErrors: [{ name: 'Intel Wi-Fi', code: 43 }] } : {});
    await rolloutTick(h.db, h.signer);
  };
  await install(devs[0]);                      // test stage verified -> Autopilot starts the pilot (no manual advance call)
  let ro = (await get(`/api/v1/driver-rollouts/${rid}`, a.auth)).json();
  assert.equal(ro.stage, 'pilot', 'advanced without anyone clicking'); assert.equal(ro.devices.filter((x: any) => x.stage === 'pilot').length, 2);
  await install(devs[1]); await install(devs[2]);
  ro = (await get(`/api/v1/driver-rollouts/${rid}`, a.auth)).json();
  assert.equal(ro.status, 'completed', JSON.stringify(ro.devices));
  const by = (await h.db.query(`SELECT next FROM audit_log WHERE org_id=$1 AND action='rollout.advance'`, [a.orgId])).rows;
  assert.ok(by.some(r => r.next?.by === 'autopilot'), 'the automatic step is recorded in the audit log');

  // a failing pilot device halts an automatic rollout too
  const DRV2 = '44444444-4444-4444-8444-444444444444';
  const upd2 = { ...upd, id: DRV2, title: 'Realtek - Audio' };
  for (const d of devs) {
    const id = (await post('/api/v1/jobs', { type: 'updates.scan', target: { deviceIds: [d.deviceId] } }, a.auth)).json().jobs[0].id;
    await agentRuns(d, id, 'completed', { scannedAt: new Date().toISOString(), pendingCount: 0, securityCount: 0, driverCount: 1, updates: [], drivers: [upd2] });
  }
  const rid2 = (await post('/api/v1/driver-rollouts', { updateId: DRV2, deviceId: devs[0].deviceId }, a.auth)).json().id;
  await install(devs[0]);
  await install(devs[1], true);                // the first pilot device gets a driver error
  const r2 = (await get(`/api/v1/driver-rollouts/${rid2}`, a.auth)).json();
  assert.equal(r2.status, 'halted'); assert.match(r2.halt_reason, /new driver errors/);
  const left = (await h.db.query(`SELECT status FROM jobs WHERE device_id=$1 AND type='driver.install' AND params->'updateIds'->>0=$2`, [devs[2].deviceId, DRV2])).rows;
  assert.ok(left.length === 1 && left[0].status === 'cancelled', 'the other pilot device install was cancelled when the rollout halted: ' + JSON.stringify(left));
});

test('opt-in: Autopilot starts driver rollouts itself, one at a time, in the window, never for network/display/boot drivers, on the healthiest PC', async () => {
  const { autoStartDriverRollouts } = await import('../src/patching.js');
  const a = await mkOrg('Auto Start', 'o@autostart.test');
  const NET = '55555555-5555-4555-8555-555555555555', CARD = '66666666-6666-4666-8666-666666666666';
  const mk = (id: string, cls: string, title: string) => ({ id, title, isDriver: true, driver: { manufacturer: 'X', model: title, class: cls, version: '1.0.0.1', hardwareId: 'PCI\X' } });
  const devs = await Promise.all([1, 2, 3].map(n => enroll(a.auth, `autostart-dev-000${n}`, `AS-PC-${n}`)));
  await putHealth(devs[0], { defender: { antivirusEnabled: false }, avProducts: [] });          // the least healthy PC
  await putHealth(devs[1]); await putHealth(devs[2]);
  for (const d of devs) {
    await post('/agent/v1/heartbeat', { hostname: 'x', agentVersion: '0.1.0', metrics: {} }, d.dev);
    const id = (await post('/api/v1/jobs', { type: 'updates.scan', target: { deviceIds: [d.deviceId] } }, a.auth)).json().jobs[0].id;
    await agentRuns(d, id, 'completed', { scannedAt: new Date().toISOString(), pendingCount: 0, securityCount: 0, driverCount: 2, updates: [], drivers: [mk(NET, 'Net', 'Wi-Fi adapter'), mk(CARD, 'Image', 'Card reader')] });
  }
  const setLocalHour = async (h: number) => { const utcMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes(); const off = ((h * 60 - utcMin + 1440 + 720) % 1440) - 720; await h2.db.query('UPDATE organizations SET utc_offset_minutes=$2 WHERE id=$1', [a.orgId, off]); };
  const h2 = h;
  const rollouts = async () => (await h.db.query(`SELECT id, subject_id, status, meta FROM rollouts WHERE org_id=$1`, [a.orgId])).rows;

  await setLocalHour(2);
  assert.equal(await autoStartDriverRollouts(h.db, h.signer), 0, 'off by default');
  assert.equal((await put('/api/v1/autopilot', { driverAutoStart: true }, a.auth)).json().driverAutoStart, true);
  assert.equal((await get('/api/v1/autopilot', a.auth)).json().window.start, '01:00', 'the window is kept');

  await setLocalHour(12);
  assert.equal(await autoStartDriverRollouts(h.db, h.signer), 0, 'outside the maintenance window nothing starts');
  await setLocalHour(2);
  assert.equal(await autoStartDriverRollouts(h.db, h.signer), 1);
  const ro = await rollouts(); assert.equal(ro.length, 1);
  assert.equal(ro[0].subject_id, CARD, 'the network driver is never started automatically'); assert.equal(ro[0].meta.by, 'autopilot');
  const inst = (await h.db.query(`SELECT device_id FROM jobs WHERE type='driver.install' AND org_id=$1`, [a.orgId])).rows;
  assert.equal(inst.length, 1); assert.notEqual(inst[0].device_id, devs[0].deviceId, 'not the unhealthy PC');
  assert.equal(await autoStartDriverRollouts(h.db, h.signer), 0, 'one active rollout at a time');
  await h.db.query(`UPDATE rollouts SET status='halted' WHERE id=$1`, [ro[0].id]);
  assert.equal(await autoStartDriverRollouts(h.db, h.signer), 0, 'a driver is not retried within 30 days');
  assert.ok((await h.db.query(`SELECT 1 FROM audit_log WHERE org_id=$1 AND action='rollout.start' AND next->>'by'='autopilot'`, [a.orgId])).rowCount);
});
