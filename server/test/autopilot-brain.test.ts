import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { autoAllowed, policyLevel, reactToHealth } from '../src/policies.js';
import { priorityOf, stanceOf } from '../src/autopilot-brain.js';
import { decideGate } from '../src/healthgate.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54348); });
after(async () => { await h.stop(); });

const fix = (recipe: string, extra: object = {}) => ({ jobType: 'repair.run', params: { recipe, ...extra }, label: recipe });

test('policy levels: OBSERVE does nothing, SAFE only level 1, BALANCED adds controlled level 2, AGGRESSIVE adds reversible update repair; personal data and network resets never', () => {
  const services = fix('services.restart-failed'), office = fix('office.quick-repair'), sfc = fix('windows.sfc'), upd = fix('windows.update-reset', { approved: true, options: { force: true } }), net = fix('network.reset');
  const clean = { jobType: 'cleanup.run', params: { categories: ['windows-temp'] }, label: 'c', confirm: 'x' }, personal = { jobType: 'cleanup.run', params: { categories: ['downloads'] }, label: 'c', confirm: 'x' };
  const table: Record<string, boolean[]> = { OBSERVE: [false, false, false, false, false, false], SAFE: [true, false, false, false, false, true], BALANCED: [true, true, true, false, false, true], AGGRESSIVE: [true, true, true, true, false, true] };
  for (const [lv, want] of Object.entries(table)) assert.deepEqual([services, office, sfc, upd, net, clean].map(f => autoAllowed(f as any, lv as any)), want, lv);
  for (const lv of ['OBSERVE', 'SAFE', 'BALANCED', 'AGGRESSIVE']) assert.equal(autoAllowed(personal as any, lv as any), false, 'personal folders are never cleaned automatically');
  assert.equal(autoAllowed(office as any), false, 'default is SAFE'); assert.equal(autoAllowed(office as any, true), true, 'legacy boolean still means level 2');
  assert.equal(policyLevel(undefined), 'OBSERVE'); assert.equal(policyLevel({ safeFixes: true, level2: true }), 'BALANCED'); assert.equal(policyLevel({ safeFixes: true }), 'SAFE'); assert.equal(policyLevel({ failedServices: true }), 'SAFE'); assert.equal(policyLevel({ level: 'AGGRESSIVE' }), 'AGGRESSIVE');
});

test('priorities follow the product order and each open problem has a stance: working, watching, will-fix, waiting for the window, or needs a person', () => {
  const order = ['security.active_threat', 'hw.storage.unhealthy', 'stability.app:outlook.exe', 'security.av_off', 'perf.ram_pressure', 'storage.system_low', 'updates.stale', 'drivers.device_error', 'preventive.boot_slower'];
  assert.deepEqual(order.map(c => priorityOf(c).rank), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const svc = { code: 'perf.service_failed', fix: fix('services.restart-failed') } as any;
  assert.equal(stanceOf({ ...svc, status: 'REPAIR_READY' }, 'SAFE', true).stance, 'will-fix');
  assert.equal(stanceOf({ ...svc, status: 'REPAIR_READY' }, 'OBSERVE', true).stance, 'needs-admin');
  assert.match(stanceOf({ code: 'x', fix: fix('office.quick-repair'), status: 'REPAIR_READY' }, 'SAFE', true).note, /needs approval at Autopilot level safe/);
  assert.equal(stanceOf({ code: 'x', fix: fix('windows.sfc'), status: 'REPAIR_READY' }, 'BALANCED', false).stance, 'waiting-window');
  assert.equal(stanceOf({ code: 'x', fix: fix('windows.sfc'), status: 'REPAIR_READY' }, 'BALANCED', true).stance, 'will-fix');
  const s = (status: string) => stanceOf({ code: 'x', fix: null, status }, 'BALANCED', true).stance;
  assert.deepEqual(['REPAIRING', 'VERIFYING', 'OBSERVING', 'HARDWARE_ACTION_REQUIRED', 'USER_ACTION_REQUIRED', 'UNRESOLVED', 'DETECTED'].map(s), ['working', 'working', 'observing', 'needs-hardware', 'needs-user', 'needs-admin', 'diagnosing']);
});

test('the Health Engine tells the Compute worker to ALLOW, THROTTLE, PAUSE or BLOCK, and machine health always wins', () => {
  const i = (code: string, status = 'REPAIR_READY', impact = 'high', remedy = 'safe-fix') => ({ code, status, impact, remedy });
  assert.equal(decideGate([]).gate, 'ALLOW');
  assert.equal(decideGate([i('perf.startup_heavy', 'REPAIR_READY', 'medium', 'review')]).gate, 'ALLOW', 'ordinary software findings do not stop compute');
  assert.equal(decideGate([i('perf.throttling')]).gate, 'THROTTLE');
  assert.equal(decideGate([i('cleanup', 'REPAIRING')]).gate, 'PAUSE');
  assert.equal(decideGate([i('stability.app:outlook.exe')]).gate, 'PAUSE');
  assert.equal(decideGate([i('stability.app:notepad.exe', 'REPAIR_READY', 'medium')]).gate, 'ALLOW');
  const block = decideGate([i('hw.storage.unhealthy', 'HARDWARE_ACTION_REQUIRED', 'high', 'hardware'), i('perf.throttling')]);
  assert.equal(block.gate, 'BLOCK'); assert.match(block.reason, /hardware fault/);
  assert.equal(decideGate([i('hardware.hdd_system', 'HARDWARE_ACTION_REQUIRED', 'medium', 'hardware')]).gate, 'BLOCK');
  assert.equal(decideGate([i('hw.storage.unhealthy', 'RESOLVED', 'high', 'hardware')]).gate, 'ALLOW');
});

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });
async function mkOrg(name: string, email: string, level?: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery' }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  const auth = { authorization: `Bearer ${l.json().token}` } as Hdr;
  if (level) assert.equal((await put('/api/v1/autopilot', { level }, auth)).statusCode, 200);
  return { auth, orgId: r.json().organizationId as string };
}
async function enroll(auth: Hdr, guid: string, hostname: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
type Dev = Awaited<ReturnType<typeof enroll>>;
const GB = 2 ** 30, DAY = 86_400_000;
const crash = (msAgo: number, app = 'outlook.exe') => ({ app, kind: 'crash', appVersion: '16.0.1', module: 'mso.dll', moduleVersion: '16.0', exceptionCode: 'c0000005', at: new Date(Date.now() - msAgo).toISOString() });
const FIVE = (app = 'outlook.exe') => [1, 1.5, 2, 2.5, 3].map(n => crash(n * DAY, app));
const OK = { volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }] };
const health = (d: Dev, over: object = {}) => put('/agent/v1/health', { collectedAt: new Date().toISOString(), ...OK, ...over }, d.dev);
const jobsOf = async (deviceId: string, type?: string) => (await h.db.query(`SELECT id, type, status, params FROM jobs WHERE device_id=$1 ${type ? 'AND type=$2' : ''} ORDER BY created_at`, type ? [deviceId, type] : [deviceId])).rows;
const officeJobs = async (d: Dev) => (await jobsOf(d.deviceId, 'repair.run')).filter(j => j.params.recipe === 'office.quick-repair');
async function agentRuns(d: Dev, jobId: string, status: 'completed' | 'failed', result?: unknown) {
  assert.equal((await post(`/agent/v1/jobs/${jobId}/start`, {}, d.dev)).statusCode, 200);
  assert.equal((await post(`/agent/v1/jobs/${jobId}/result`, { status, result }, d.dev)).statusCode, 200);
}

test('the same Outlook problem is handled according to the Autopilot level; a level change is audited and shown', async () => {
  const outcome: Record<string, number> = {};
  for (const lv of ['OBSERVE', 'SAFE', 'BALANCED']) {
    const a = await mkOrg(`Lvl ${lv}`, `o@lvl-${lv.toLowerCase()}.test`, lv);
    assert.equal((await get('/api/v1/autopilot', a.auth)).json().level, lv);
    const d = await enroll(a.auth, `lvl-dev-${lv}`, `LVL-${lv}`);
    await health(d, { stability: { windowDays: 14, crashes: FIVE(), recentChanges: [] } });
    outcome[lv] = (await officeJobs(d)).length;
    const act = (await get('/api/v1/autopilot/activity', a.auth)).json();
    const item = [...act.working, ...act.willFix, ...act.needsYou].find((i: any) => i.code === 'stability.app:outlook.exe');
    assert.ok(item, `${lv}: listed`); assert.equal(item.priority, 'Stability');
    assert.equal(item.stance, lv === 'BALANCED' ? 'working' : 'needs-admin', `${lv}: ${item.note}`);
    if (lv === 'SAFE') assert.match(item.note, /needs approval at Autopilot level safe/);
    if (lv === 'OBSERVE') assert.match(item.note, /observe only/);
    if (lv !== 'BALANCED') assert.equal(act.working.length, 0);
    assert.ok((await get('/api/v1/audit', a.auth)).json().entries.some((e: any) => e.action === 'autopilot.update'));
  }
  assert.deepEqual(outcome, { OBSERVE: 0, SAFE: 0, BALANCED: 1 });
  const bad = await mkOrg('Lvl Bad', 'o@lvl-bad.test'); assert.equal((await put('/api/v1/autopilot', { level: 'YOLO' }, bad.auth)).statusCode, 400);
});

test('heavy repairs wait for the maintenance window and only one runs at a time on a computer', async () => {
  const a = await mkOrg('Heavy Org', 'o@heavy.test', 'BALANCED');
  const d = await enroll(a.auth, 'heavy-dev-0001', 'HEAVY-PC');
  await health(d);
  const sfc = new Map([['perf.x', fix('windows.sfc') as any]]), dism = new Map([['perf.y', fix('windows.dism') as any]]);
  const setLocalHour = async (hr: number) => { const m = new Date().getUTCHours() * 60 + new Date().getUTCMinutes(); await h.db.query('UPDATE organizations SET utc_offset_minutes=$2 WHERE id=$1', [a.orgId, ((hr * 60 - m + 1440 + 720) % 1440) - 720]); };
  await setLocalHour(14);                                                     // window is 01:00-05:00
  assert.equal(await reactToHealth(h.db, h.signer, a.orgId, d.deviceId, new Set(), new Date(), sfc), 0, 'afternoon: SFC waits');
  assert.equal((await jobsOf(d.deviceId, 'repair.run')).length, 0);
  await setLocalHour(2);
  assert.equal(await reactToHealth(h.db, h.signer, a.orgId, d.deviceId, new Set(), new Date(), sfc), 1, 'night: SFC starts');
  await h.db.query(`INSERT INTO incidents(org_id,device_id,code,category,impact,title,root_cause,confidence,status,remedy,safety_level) VALUES ($1,$2,'perf.z','performance','high','t','r','HIGH','REPAIRING','safe-fix',2)`, [a.orgId, d.deviceId]);
  assert.equal(await reactToHealth(h.db, h.signer, a.orgId, d.deviceId, new Set(), new Date(), dism), 0, 'a second heavy repair does not start while one is being carried out');
});

test('what needs a person is ordered by priority, and escalations, hardware limits and unsupported applications are said plainly', async () => {
  const a = await mkOrg('Attn Org', 'o@attn.test', 'OBSERVE');
  const d = await enroll(a.auth, 'attn-dev-0001', 'ATTN-PC');
  await health(d, { volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 2 * GB, isSystem: true }], defender: { antivirusEnabled: false }, avProducts: [], memory: { totalBytes: 4 * GB, availableBytes: 0.3 * GB }, physicalDisks: [{ name: 'HDD', mediaType: 'HDD', health: 'Healthy', sizeBytes: 500e9, isSystem: true }],
    stability: { windowDays: 14, crashes: [1, 2, 3, 4].map(n => crash(n * DAY, 'contoso.exe')).map((c, i) => ({ ...c, module: `m${i}.dll`, appVersion: null })), recentChanges: [] } });
  const act = (await get('/api/v1/autopilot/activity', a.auth)).json();
  const ranks = act.needsYou.map((i: any) => i.priority);
  assert.deepEqual(ranks, [...ranks].sort((x: string, y: string) => ['Safety', 'Data protection', 'Stability', 'Security', 'Performance', 'Storage', 'Updates', 'Drivers', 'Preventive'].indexOf(x) - ['Safety', 'Data protection', 'Stability', 'Security', 'Performance', 'Storage', 'Updates', 'Drivers', 'Preventive'].indexOf(y)), 'sorted by priority');
  const by = (code: string) => act.needsYou.find((i: any) => i.code === code);
  assert.equal(by('stability.app:contoso.exe').stance, 'needs-user'); assert.match(by('stability.app:contoso.exe').nextStep, /no automatic repair for contoso\.exe/i);
  assert.ok(act.needsYou.some((i: any) => i.stance === 'needs-hardware'), 'a hardware limit is reported as such');
  assert.equal((await jobsOf(d.deviceId)).filter(j => ['repair.run', 'cleanup.run', 'security.update-signatures', 'security.scan'].includes(j.type)).length, 0, 'observe-only made no change');
  // the weekly summary now lists these with their next step, most important first
  const s = (await get('/api/v1/summary', a.auth)).json();
  assert.ok(s.needsYou.length >= 3); assert.match(s.text, /ATTN-PC/);
  // a failed repair escalates to a person
  const b = await mkOrg('Attn Fail', 'o@attnfail.test', 'BALANCED'); const e = await enroll(b.auth, 'attn-dev-0002', 'FAIL-PC');
  await health(e, { stability: { windowDays: 14, crashes: FIVE(), recentChanges: [] } });
  await agentRuns(e, (await officeJobs(e))[0].id, 'failed', { error: 'exit 17002' });
  const f = (await get('/api/v1/autopilot/activity', b.auth)).json();
  const esc = f.needsYou.find((i: any) => i.code === 'stability.app:outlook.exe'); assert.equal(esc.stance, 'needs-admin'); assert.match(esc.note, /did not work/);
});

test('preventive maintenance: a filling drive, a declining computer and slower start-up become incidents from recorded history, and Autopilot cleans before the drive is full', async () => {
  const a = await mkOrg('Prev Org', 'o@prev.test', 'SAFE');
  const d = await enroll(a.auth, 'prev-dev-0001', 'PREV-PC'), quiet = await enroll(a.auth, 'prev-dev-0002', 'QUIET-PC');
  for (const dev of [d, quiet]) await health(dev);
  const hist = (dev: Dev, rows: { daysAgo: number; overall: number; free: number }[]) => Promise.all(rows.map(r => h.db.query(`INSERT INTO device_health_history(device_id,org_id,at,overall,categories,metrics) VALUES ($1,$2,now() - make_interval(secs => $3::float8),$4,'{}'::jsonb,$5)`, [dev.deviceId, a.orgId, r.daysAgo * 86_400, r.overall, JSON.stringify({ systemFreeBytes: r.free * GB })])));
  await h.db.query('DELETE FROM device_health_history WHERE device_id = ANY($1::uuid[])', [[d.deviceId, quiet.deviceId]]);   // start from a clean history
  await hist(d, Array.from({ length: 11 }, (_, i) => ({ daysAgo: 10 - i + 0.5, overall: 99 - i * 3, free: 55 - i * 2.4 })));
  await hist(quiet, Array.from({ length: 11 }, (_, i) => ({ daysAgo: 10 - i + 0.5, overall: 90, free: 300 })));
  await h.db.query(`INSERT INTO benchmarks(org_id,device_id,kind,metrics,taken_at) VALUES ($1,$2,'baseline','{"bootSeconds":60}', now() - interval '20 days'), ($1,$2,'periodic','{"bootSeconds":130}', now() - interval '1 day')`, [a.orgId, d.deviceId]);
  await health(d, { volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 30 * GB, isSystem: true }], defender: { antivirusEnabled: false }, avProducts: [], firewall: { domain: false, private: false, public: false }, startup: Array.from({ length: 26 }, (_, i) => ({ name: 'App' + i })) }); await health(quiet);
  const incs = (await get(`/api/v1/devices/${d.deviceId}/incidents`, a.auth)).json().incidents; const code = (c: string) => incs.find((i: any) => i.code === c);
  const filling = code('preventive.storage_filling'); assert.ok(filling, JSON.stringify(incs.map((i: any) => i.code))); assert.match(filling.rootCause, /2\.\d GB per day/); assert.match(filling.rootCause, /has not been measured/); assert.equal(filling.category, 'storage');
  assert.equal(filling.status, 'REPAIRING', 'Autopilot recovers safe space before the drive is full'); assert.equal((await jobsOf(d.deviceId, 'cleanup.run')).length, 1);
  const lastRows = (await h.db.query('SELECT overall, at FROM device_health_history WHERE device_id=$1 ORDER BY at DESC LIMIT 3', [d.deviceId])).rows; const declining = code('preventive.health_declining'); assert.ok(declining, JSON.stringify(lastRows) + JSON.stringify(incs.map((i: any) => i.code))); assert.match(declining.rootCause, /Nothing has failed yet/); assert.equal(declining.status, 'USER_ACTION_REQUIRED');
  const slow = code('preventive.boot_slower'); assert.ok(slow); assert.match(slow.rootCause, /130 seconds, up from 60 seconds/);
  assert.equal((await get(`/api/v1/devices/${quiet.deviceId}/incidents`, a.auth)).json().incidents.filter((i: any) => i.code.startsWith('preventive.')).length, 0, 'a steady computer raises nothing');
  assert.ok((await get('/api/v1/autopilot/activity', a.auth)).json().needsYou.some((i: any) => i.priority === 'Preventive'));
});

test('compute obeys machine health; a repair that needs a restart follows the restart policy', async () => {
  const a = await mkOrg('Gate Org', 'o@gate.test', 'BALANCED');
  const ok = await enroll(a.auth, 'gate-dev-0001', 'OK-PC'), sick = await enroll(a.auth, 'gate-dev-0002', 'SICK-PC'), fixing = await enroll(a.auth, 'gate-dev-0003', 'FIXING-PC');
  await health(ok);
  const beat = async (d: Dev) => (await post('/agent/v1/compute/heartbeat', { state: 'idle-wait', reason: 'x' }, d.dev)).json();
  assert.equal((await beat(ok)).health.gate, 'ALLOW');
  await health(fixing, { stability: { windowDays: 14, crashes: FIVE(), recentChanges: [] } });           // Autopilot starts the Office repair
  const g = (await beat(fixing)).health; assert.equal(g.gate, 'PAUSE'); assert.match(g.reason, /repair/);
  await health(sick, { physicalDisks: [{ name: 'SSD', mediaType: 'SSD', health: 'Unhealthy', sizeBytes: 256e9, isSystem: true }] });
  await h.db.query(`INSERT INTO incidents(org_id,device_id,code,category,impact,title,root_cause,confidence,status,remedy,safety_level) VALUES ($1,$2,'hw.storage.unhealthy','hardware','high','Drive unhealthy','r','HIGH','HARDWARE_ACTION_REQUIRED','hardware',4)`, [a.orgId, sick.deviceId]);
  const b = (await beat(sick)).health; assert.equal(b.gate, 'BLOCK'); assert.match(b.reason, /hardware fault/);
  assert.equal((await post('/agent/v1/compute/heartbeat', { state: 'idle-wait' }, {})).statusCode, 401);

  // the Office repair finishes and reports that Windows wants a restart: the policy ("auto" by default) schedules a visible countdown restart
  await agentRuns(fixing, (await officeJobs(fixing))[0].id, 'completed', { summary: 'Repaired and verified: ok', report: { rebootRequired: true, summary: 'Repaired and verified: ok' } });
  const reboots = await jobsOf(fixing.deviceId, 'system.reboot'); assert.equal(reboots.length, 1); assert.ok(reboots[0].params.delaySeconds >= 300, 'a countdown so people can save their work');
});
