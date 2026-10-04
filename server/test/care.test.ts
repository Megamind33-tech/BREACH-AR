import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { carePolicy, measuredRuntime, rankBatteryDrain, type Sample } from '../src/care.js';
import { scoreHealth } from '../src/health.js';
import { decideGate } from '../src/healthgate.js';
import { autoAllowed } from '../src/policies.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54352); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>; type Dev = { deviceId: string; dev: Hdr };
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });
const GB = 1024 ** 3;
async function mkOrg(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function enroll(auth: Hdr, guid: string): Promise<Dev> {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname: guid, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } };
}
const events = (d: Dev, evs: { kind: string; data?: object; at?: string }[]) => post('/agent/v1/care/events', { events: evs.map(e => ({ at: e.at ?? new Date().toISOString(), kind: e.kind, data: e.data ?? {} })) }, d.dev);
const base = { collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }], defender: { antivirusEnabled: true, realTimeProtection: true, signatureAgeDays: 0 }, avProducts: ['Windows Defender'], firewall: { domain: true, private: true, public: true } };
const score = (extra: object) => scoreHealth({ ...base, ...extra } as any);
const code = (r: ReturnType<typeof scoreHealth>, c: string) => r.deductions.find(d => d.code === c);

test('the care policy follows the Autopilot level and is clamped by the organization settings', () => {
  assert.deepEqual(carePolicy('OBSERVE'), { printerAuto: false, printerDrivers: false, ramTargetPercent: 50, autoTrimIdle: false, suggestClose: true, autoCloseSafe: false, popups: true, thermalWarningC: 85 });
  // printing: the queue and spooler are looked after from SAFE up; changing drivers needs BALANCED or higher
  assert.deepEqual([carePolicy('SAFE').printerAuto, carePolicy('SAFE').printerDrivers, carePolicy('BALANCED').printerDrivers, carePolicy('AGGRESSIVE').printerDrivers], [true, false, true, true]);
  assert.equal(carePolicy('SAFE').autoTrimIdle, true); assert.equal(carePolicy('BALANCED').autoCloseSafe, false); assert.equal(carePolicy('AGGRESSIVE').autoCloseSafe, true);
  assert.equal(carePolicy('SAFE', { ramTargetPercent: 40, thermalWarningC: 80, popups: false }).ramTargetPercent, 40);
});

test('battery runtime comes only from real discharge periods, and drain causes are ranked with their evidence', () => {
  const t0 = Date.UTC(2026, 9, 1, 9, 0); const S = (min: number, pct: number, on = true): Sample => ({ at: new Date(t0 + min * 60_000), percent: pct, onBattery: on, dischargeWatts: null, fullChargeWh: null, designWh: null, healthPercent: null });
  assert.equal(measuredRuntime([]), null); assert.equal(measuredRuntime([S(0, 90), S(5, 89)]), null, 'too short to conclude anything');
  const run = measuredRuntime([S(0, 100), S(10, 95), S(20, 90), S(30, 85), S(40, 80), S(50, 75), S(60, 70)])!;
  assert.equal(run.ratePercentPerHour, 30); assert.equal(run.typicalMinutes, 200); assert.equal(run.periods, 1);
  assert.equal(measuredRuntime([S(0, 100), S(10, 95), S(20, 90, false), S(30, 100, false), S(40, 100), S(50, 95), S(60, 90), S(70, 85), S(80, 80)])?.periods, 1, 'charging time is not counted as battery time, and a new discharge starts a new period');
  assert.equal(measuredRuntime([S(0, 80), S(10, 79), S(20, 79), S(30, 78)]), null, 'a small drop is too little to extrapolate from');

  assert.deepEqual(rankBatteryDrain({ hasBattery: false }), []);
  const causes = rankBatteryDrain({ hasBattery: true, reading: { healthPercent: 57, fullChargeWh: 29, designWh: 51, dischargeWatts: 22 }, topCpu: [{ name: 'chrome', cpuPercent: 45, memoryMb: 900, assessment: 'NEVER_AUTOCLOSE' }, { name: 'AdobeARM', cpuPercent: 12, memoryMb: 60, assessment: 'SAFE_TO_SUGGEST_CLOSE' }, { name: 'calm', cpuPercent: 2, memoryMb: 50 }],
    wakeLocks: [{ kind: 'SYSTEM', type: 'PROCESS', name: 'Teams.exe' }, { kind: 'EXECUTION', type: 'DRIVER', name: 'audio' }], browsers: [{ browser: 'chrome', processes: 31, memoryMb: 2400 }], backgroundApps: ['Teams', 'Dropbox'], powerPlan: 'High performance' });
  assert.equal(causes[0].cause, 'The battery has lost capacity'); assert.equal(causes[0].impact, 'HIGH'); assert.match(causes[0].evidence, /29 Wh of the 51 Wh.*57%/);
  assert.equal(causes[1].cause, 'chrome is using the processor'); assert.ok(causes.some(c => c.cause.includes('prevent')) && causes.some(c => c.cause.includes('31') === false && c.cause.includes('chrome has many')) && causes.some(c => c.cause.includes('High performance')));
  assert.ok(!causes.some(c => c.cause.includes('calm')), 'a quiet program is not blamed'); assert.ok(!causes.some(c => /without an obvious program/.test(c.cause)), 'a named culprit exists, so no vague cause');
  assert.deepEqual(causes.map(c => c.rank), causes.map((_, i) => i + 1));
  const vague = rankBatteryDrain({ hasBattery: true, reading: { dischargeWatts: 24 }, topCpu: [{ name: 'x', cpuPercent: 3, memoryMb: 1 }] }); assert.equal(vague[0].confidence, 'LOW'); assert.match(vague[0].evidence, /could not be narrowed/);
  assert.deepEqual(rankBatteryDrain({ hasBattery: true, reading: { healthPercent: 95 }, topCpu: [], wakeLocks: [] }), [], 'a healthy quiet battery has nothing to report');
});

test('slow start-up, idle memory and a suspected cooling fault become findings with the right remedy, and only when measured', () => {
  assert.equal(code(score({ boot: { lastBootSeconds: 40 } }), 'perf.slow_boot'), undefined);
  assert.equal(code(score({ boot: null }), 'perf.slow_boot'), undefined, 'no measurement, no finding');
  const fix = code(score({ boot: { lastBootSeconds: 98, degrading: [{ name: 'Spotify', seconds: 11 }], optimizableStartup: 4 } }), 'perf.slow_boot')!;
  assert.equal(fix.remedy, 'safe-fix'); assert.equal(fix.fix!.params.recipe, 'startup.optimize'); assert.match(fix.reason, /98 seconds.*Spotify \(\+11 s\)/);
  const pending = code(score({ boot: { lastBootSeconds: 98, lastBootAt: '2026-10-01T08:00:00Z', startupOptimizedAt: '2026-10-01T09:00:00Z', optimizableStartup: 0 } }), 'perf.slow_boot')!;
  assert.equal(pending.remedy, 'manual'); assert.match(pending.recommendation, /Restart/); assert.equal(pending.fix, undefined);
  assert.equal(code(score({ boot: { lastBootSeconds: 98, optimizableStartup: 0 } }), 'perf.slow_boot')!.remedy, 'review');
  assert.equal(code(score({ boot: { lastBootSeconds: 98, optimizableStartup: 2 }, physicalDisks: [{ name: 'D', mediaType: 'HDD', isSystem: true }] }), 'perf.slow_boot'), undefined, 'a mechanical system disk is judged by its own thresholds');
  assert.ok(code(score({ boot: { lastBootSeconds: 210, optimizableStartup: 0 }, physicalDisks: [{ name: 'D', mediaType: 'HDD', isSystem: true }] }), 'perf.slow_boot')!.recommendation.includes('SSD'));

  assert.equal(code(score({ care: { memory: { usedPercent: 48, targetPercent: 50, idleTrimmableMb: 2000 } } }), 'perf.ram_idle_waste'), undefined, 'under the target');
  assert.equal(code(score({ care: { memory: { usedPercent: 72, targetPercent: 50, idleTrimmableMb: 100 } } }), 'perf.ram_idle_waste'), undefined, 'nothing idle to give back');
  const idle = code(score({ care: { memory: { usedPercent: 72, targetPercent: 50, idleTrimmableMb: 1900 } } }), 'perf.ram_idle_waste')!;
  assert.equal(idle.fix!.params.recipe, 'memory.trim-idle'); assert.match(idle.reason, /72%.*target 50%.*1.9 GB/);
  assert.equal(autoAllowed(idle.fix!, 'SAFE'), true, 'trimming idle memory is harmless, so it is allowed at the most cautious automatic level');
  assert.equal(autoAllowed({ jobType: 'repair.run', params: { recipe: 'startup.optimize' }, label: '' }, 'SAFE'), false); assert.equal(autoAllowed({ jobType: 'repair.run', params: { recipe: 'startup.optimize' }, label: '' }, 'BALANCED'), true);

  const cool = code(score({ care: { thermal: { coolingSuspected: true, cpuTempC: 91, sustainedHotMinutesLowLoad: 22 } } }), 'hardware.cooling')!;
  assert.equal(cool.remedy, 'hardware'); assert.match(cool.reason, /91°C.*22 minutes.*Software is unlikely/);
  assert.equal(code(score({ care: { thermal: { coolingSuspected: false, cpuTempC: 91 } } }), 'hardware.cooling'), undefined);
  assert.equal(decideGate([{ code: 'hardware.cooling', status: 'HARDWARE_ACTION_REQUIRED', impact: 'medium', remedy: 'hardware' }]).gate, 'BLOCK', 'a cooling fault keeps compute off');
});

test('the agent receives its care policy, and events are stored, clamped and validated', async () => {
  const a = await mkOrg('Care Org', 'o@care.test'), d = await enroll(a.auth, 'care-dev-0001');
  assert.equal((await get('/agent/v1/care/policy', d.dev)).json().autoTrimIdle, false, 'no Autopilot policy: observe only');
  await h.db.query(`INSERT INTO policies(org_id,name,enabled,scope_type,settings) VALUES ($1,'Autopilot',true,'org',$2)`, [a.orgId, JSON.stringify({ schedules: [], autoRepair: { level: 'AGGRESSIVE', safeFixes: true, level2: true }, care: { ramTargetPercent: 45 } })]);
  const p = (await get('/agent/v1/care/policy', d.dev)).json(); assert.equal(p.autoTrimIdle, true); assert.equal(p.autoCloseSafe, true); assert.equal(p.ramTargetPercent, 45);
  assert.equal((await get('/agent/v1/care/policy')).statusCode, 401);

  const t0 = new Date(Date.now() - 600_000).toISOString();
  assert.equal((await events(d, [{ kind: 'thermal.heat', at: t0, data: { level: 'warning', tempC: 87, cpuLoad: 64, gate: 'PAUSE', computeRunning: true, topProcesses: [{ name: 'chrome', cpu: 40 }], action: 'optional work paused' } }])).statusCode, 200);
  let th = (await h.db.query(`SELECT * FROM thermal_incidents WHERE device_id=$1`, [d.deviceId])).rows; assert.equal(th.length, 1); assert.equal(th[0].temperature_c, 87); assert.equal(th[0].compute_state, 'running'); assert.equal(th[0].recovered_at, null);
  await events(d, [{ kind: 'thermal.cooling-suspect', data: {} }]); await events(d, [{ kind: 'thermal.recovered', data: { tempC: 70 } }]);
  th = (await h.db.query(`SELECT * FROM thermal_incidents WHERE device_id=$1`, [d.deviceId])).rows; assert.ok(th[0].recovered_at); assert.equal(th[0].cooling_suspected, true);
  await events(d, [{ kind: 'memory.trim', data: { beforePercent: 72, afterPercent: 55, reclaimedMb: 2700, trimmed: [{ name: 'spotify', mb: 600 }] } }, { kind: 'apps.closed', data: { results: [{ name: 'AdobeARM', closed: true }] } }]);
  const future = new Date(Date.now() + 86_400_000 * 30).toISOString(); await events(d, [{ kind: 'battery.sample', at: future, data: { percent: 80, onBattery: true, dischargeWatts: 11.5, fullChargeWh: 29, designWh: 51, healthPercent: 56.9, cycleCount: 412 } }]);
  const bs = (await h.db.query(`SELECT at FROM battery_samples WHERE device_id=$1`, [d.deviceId])).rows; assert.equal(bs.length, 1); assert.ok(new Date(bs[0].at).getTime() <= Date.now() + 1000, 'a clock in the future cannot post-date a record');
  assert.equal((await events(d, [{ kind: 'something.else' }])).statusCode, 400); assert.equal((await post('/agent/v1/care/events', { events: [{ at: 'yesterday', kind: 'memory.trim' }] }, d.dev)).statusCode, 400); assert.equal((await post('/agent/v1/care/events', { events: [] })).statusCode, 401);

  const care = (await get(`/api/v1/devices/${d.deviceId}/care`, a.auth)).json();
  assert.equal(care.thermal.length, 1); assert.equal(care.memory[0].reclaimedMb, 2700); assert.equal(care.battery.hasData, true); assert.equal(care.battery.health, 56.9); assert.equal(care.battery.runtime, null, 'one sample is not a runtime');
  const ov = (await get('/api/v1/care/overview', a.auth)).json();
  assert.equal(ov.heat.events30d, 1); assert.equal(ov.heat.coolingSuspected, 1); assert.equal(ov.memory.reclaimedMb, 2700); assert.equal(ov.memory.trims30d, 1); assert.equal(ov.memory.appCloseAttempts, 1); assert.equal(ov.battery.degraded, 1);
  const other = await mkOrg('Care Other', 'o@careb.test'); assert.equal((await get('/api/v1/care/overview', other.auth)).json().heat.events30d, 0, 'other organizations see nothing');
  assert.equal((await get(`/api/v1/devices/${d.deviceId}/care`, other.auth)).statusCode, 404);
});

test('start-up time is compared before and after the optimization from real boots, and only once a restart has happened', async () => {
  const a = await mkOrg('Boot Org', 'o@boot.test'), d = await enroll(a.auth, 'boot-dev-0001');
  const hp = (history: { at: string; seconds: number }[], extra: object = {}) => put('/agent/v1/health', { ...base, collectedAt: new Date().toISOString(), boot: { lastBootSeconds: history[0].seconds, lastBootAt: history[0].at, history, optimizableStartup: 3, ...extra } }, d.dev);
  const days = new Map<number, string>(); const day = (n: number) => { if (!days.has(n)) days.set(n, new Date(Date.now() - n * 86_400_000).toISOString()); return days.get(n)!; };
  await hp([{ at: day(3), seconds: 96 }, { at: day(5), seconds: 104 }, { at: day(7), seconds: 91 }]);
  assert.equal((await h.db.query(`SELECT count(*)::int n FROM boot_history WHERE device_id=$1`, [d.deviceId])).rows[0].n, 3);
  await hp([{ at: day(3), seconds: 96 }]); assert.equal((await h.db.query(`SELECT count(*)::int n FROM boot_history WHERE device_id=$1`, [d.deviceId])).rows[0].n, 3, 'the same boot is never counted twice');
  assert.equal((await get(`/api/v1/devices/${d.deviceId}/care`, a.auth)).json().bootComparison, null, 'nothing was optimized yet');

  await h.db.query(`INSERT INTO jobs(id,org_id,device_id,batch_id,type,params,status,result,created_at,finished_at,expires_at,timeout_seconds,payload,signature) VALUES (gen_random_uuid(),$1,$2,gen_random_uuid(),'repair.run',$3,'completed',$4,now() - interval '2 days',now() - interval '2 days',now() + interval '1 day',300,'{}','x')`,
    [a.orgId, d.deviceId, JSON.stringify({ recipe: 'startup.optimize' }), JSON.stringify({ applied: true, verified: true })]);
  let bc = (await get(`/api/v1/devices/${d.deviceId}/care`, a.auth)).json().bootComparison; assert.equal(bc.afterSeconds, null); assert.match(bc.note, /next restart/); assert.equal(bc.beforeSeconds, 96, 'median of the boots before the change');
  await hp([{ at: day(1), seconds: 61 }, { at: day(3), seconds: 96 }]);
  bc = (await get(`/api/v1/devices/${d.deviceId}/care`, a.auth)).json().bootComparison; assert.equal(bc.afterSeconds, 61); assert.equal(bc.improvementPercent, 36); assert.equal(bc.restartsMeasured, 1);
  const ov = (await get('/api/v1/care/overview', a.auth)).json(); assert.equal(ov.startup.devicesMeasured, 1); assert.equal(ov.startup.avgSecondsSaved, 35); assert.equal(ov.startup.improved, 1);
});

test('battery diagnosis is requested as a read-only job and its result is ranked', async () => {
  const a = await mkOrg('Bat Org', 'o@bat.test'), d = await enroll(a.auth, 'bat-dev-0001');
  const q = await post(`/api/v1/devices/${d.deviceId}/battery/diagnose`, {}, a.auth); assert.equal(q.statusCode, 202);
  const job = (await h.db.query(`SELECT id, type, params FROM jobs WHERE device_id=$1`, [d.deviceId])).rows[0]; assert.equal(job.type, 'battery.diagnose');
  assert.equal((await post(`/agent/v1/jobs/${job.id}/start`, {}, d.dev)).statusCode, 200);
  assert.equal((await post(`/agent/v1/jobs/${job.id}/result`, { status: 'completed', result: { hasBattery: true, reading: { healthPercent: 62, fullChargeWh: 31, designWh: 50 }, topCpu: [], wakeLocks: [{ kind: 'SYSTEM', type: 'PROCESS', name: 'Teams.exe' }], browsers: [], backgroundApps: [] } }, d.dev)).statusCode, 200);
  await events(d, [{ kind: 'battery.sample', data: { percent: 70, onBattery: true, healthPercent: 62 } }]);
  const care = (await get(`/api/v1/devices/${d.deviceId}/care`, a.auth)).json(); assert.equal(care.battery.causes[0].cause, 'The battery has lost capacity'); assert.ok(care.battery.causes.some((c: any) => /sleeping/.test(c.cause)));
  assert.equal((await post(`/api/v1/devices/${d.deviceId}/battery/diagnose`, {}, {})).statusCode, 401);
});

test('a failing drive triggers one fixed notice on the PC a week, with only evidence lines from Control', async () => {
  const a = await mkOrg('Disk Org', 'o@disk.test'), d = await enroll(a.auth, 'disk-dev-0001');
  const sick = { physicalDisks: [{ name: 'SSD', mediaType: 'SSD', health: 'Unhealthy', sizeBytes: 256e9, isSystem: true }] };
  assert.equal((await put('/agent/v1/health', { ...base, collectedAt: new Date().toISOString() }, d.dev)).statusCode, 200);
  assert.equal((await h.db.query(`SELECT count(*)::int n FROM jobs WHERE device_id=$1 AND type='ui.notify'`, [d.deviceId])).rows[0].n, 0, 'a healthy drive raises nothing');
  for (let i = 0; i < 3; i++) await put('/agent/v1/health', { ...base, ...sick, collectedAt: new Date().toISOString() }, d.dev);
  const jobs = (await h.db.query(`SELECT params, status FROM jobs WHERE device_id=$1 AND type='ui.notify'`, [d.deviceId])).rows;
  assert.equal(jobs.length, 1, 'repeated reports do not repeat the popup'); assert.equal(jobs[0].params.template, 'storage-failing'); assert.match(jobs[0].params.evidence[0], /Unhealthy/); assert.deepEqual(Object.keys(jobs[0].params).sort(), ['evidence', 'template']);
  assert.equal((await post('/api/v1/jobs', { type: 'ui.notify', params: { template: 'custom', evidence: [] }, target: { deviceIds: [d.deviceId] } }, a.auth)).statusCode, 400, 'the text cannot be chosen from outside');
});

test('a failing drive recommendation says what is known about backups, and never claims more than Windows can see', async () => {
  const { backupSentence } = await import('../src/health.js');
  const now = new Date('2026-10-02T12:00:00Z'); const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  assert.match(backupSentence(null, now), /could not be checked/);
  assert.match(backupSentence({ lastWindowsBackupAt: null, newestRestorePointAt: null }, now), /No Windows backup or restore point.*another backup product/);
  assert.match(backupSentence({ lastWindowsBackupAt: ago(18) }, now), /18 hours ago.*safe to plan the replacement/);
  assert.match(backupSentence({ lastWindowsBackupAt: ago(24 * 9), newestRestorePointAt: ago(24 * 6) }, now), /6 days ago: back up now/);
  const sick = score({ physicalDisks: [{ name: 'SSD', mediaType: 'SSD', health: 'Unhealthy', sizeBytes: 256e9, isSystem: true }], backup: { lastWindowsBackupAt: new Date(Date.now() - 18 * 3_600_000).toISOString() } });
  assert.match(code(sick, 'hardware.disk_unhealthy')!.recommendation, /safe to plan the replacement/);
  assert.match(code(score({ physicalDisks: [{ name: 'SSD', mediaType: 'SSD', health: 'Unhealthy', sizeBytes: 256e9, isSystem: true }] }), 'hardware.disk_unhealthy')!.recommendation, /could not be checked/);
});

test('after a physical cooling service the heat records before and after are compared, and nothing is claimed without a service', async () => {
  const a = await mkOrg('Cool Org', 'o@cool.test'), d = await enroll(a.auth, 'cool-dev-0001');
  assert.equal((await get(`/api/v1/devices/${d.deviceId}/care`, a.auth)).json().coolingService, null);
  const ins = (daysAgo: number) => h.db.query(`INSERT INTO thermal_incidents(org_id,device_id,at,level,temperature_c) VALUES ($1,$2,now() - ($3 || ' days')::interval,'warning',88)`, [a.orgId, d.deviceId, String(daysAgo)]);
  for (const n of [29, 25, 20, 14, 9, 3]) await ins(n + 10);                         // six events in the 30 days before the service (service is 10 days ago)
  const r = await post(`/api/v1/devices/${d.deviceId}/service-events`, { serviceType: 'physical cleaning', reason: 'dust in vents', occurredAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), technician: 'Sam' }, a.auth);
  assert.ok([200, 201].includes(r.statusCode), 'service recorded: ' + r.statusCode);
  let c = (await get(`/api/v1/devices/${d.deviceId}/care`, a.auth)).json().coolingService; assert.equal(c.service, 'physical cleaning'); assert.equal(c.heatEventsBefore30d, 6); assert.equal(c.heatEventsSince, 0); assert.equal(c.daysSince, 10); assert.equal(c.daysWithoutHeat, 10);
  await ins(2); c = (await get(`/api/v1/devices/${d.deviceId}/care`, a.auth)).json().coolingService; assert.equal(c.heatEventsSince, 1); assert.equal(c.daysWithoutHeat, 2);
});

test('the real freeze evidence from a laptop becomes named findings: memory exhaustion, the program responsible, shutdown failures, throttling and overlapping security products', () => {
  const resources = { commitPercent: 94, commitUsedMb: 15100, commitLimitMb: 16061, ramTotalMb: 8031,
    topCommit: [{ name: 'Grammarly.Desktop', privateMb: 4861, workingSetMb: 700, category: 'UNKNOWN' }, { name: 'svchost', privateMb: 3000, category: 'SYSTEM_CRITICAL' }, { name: 'chrome', privateMb: 3200, workingSetMb: 900, category: 'NEVER_AUTOCLOSE' }],
    lowVirtualMemory24h: [{ at: '2026-09-30T22:15:06Z', top: [{ name: 'Grammarly.Desktop.exe', mb: 4862 }, { name: 'chrome.exe', mb: 3234 }, { name: 'chrome.exe', mb: 1233 }] }, { at: '2026-09-30T22:09:55Z', top: [{ name: 'Grammarly.Desktop.exe', mb: 4862 }] }],
    failedShutdowns7d: 2, firmwareThrottle24h: 2, securityEngines: [{ name: 'AVG', memoryMb: 275 }, { name: 'Malwarebytes', memoryMb: 309 }, { name: 'Microsoft Defender', memoryMb: 114 }] };
  const r = score({ resources });
  const low = code(r, 'perf.low_virtual_memory')!; assert.equal(low.points, 12); assert.match(low.reason, /ran out of memory 2 times.*Grammarly\.Desktop\.exe \(4\.7 GB\), chrome\.exe/); assert.match(low.recommendation, /8 GB.*16 GB/); assert.equal(low.remedy, 'review');
  const hog = code(r, 'perf.memory_hog')!; assert.match(hog.reason, /^Grammarly\.Desktop is holding 4\.7 GB of memory \(61% of this PC's RAM\)/); assert.match(hog.recommendation, /will not close it for you/);
  assert.match(code(r, 'security.multiple_engines')!.reason, /AVG, Malwarebytes are all running protection and use 584 MB/);
  assert.match(code(r, 'reliability.shutdown_failures')!.reason, /2 times in the last 7 days/); assert.equal(code(r, 'reliability.shutdown_failures')!.points, 10);
  assert.match(code(r, 'perf.firmware_throttle')!.reason, /limited the processor speed 2 times/);
  assert.equal(decideGate([{ code: 'perf.low_virtual_memory', status: 'DETECTED', impact: 'high', remedy: 'review' }]).gate, 'PAUSE', 'no compute while Windows is running out of memory');

  const calm = score({ resources: { commitPercent: 40, ramTotalMb: 16000, topCommit: [{ name: 'chrome', privateMb: 1500 }], lowVirtualMemory24h: [], failedShutdowns7d: 0, firmwareThrottle24h: 1, securityEngines: [{ name: 'Microsoft Defender', memoryMb: 150 }, { name: 'Malwarebytes', memoryMb: 200 }] } });
  for (const c of ['perf.low_virtual_memory', 'perf.memory_hog', 'security.multiple_engines', 'reliability.shutdown_failures', 'perf.firmware_throttle']) assert.equal(code(calm, c), undefined, c + ' must stay quiet on a healthy PC');
  assert.equal(code(score({ resources: { ramTotalMb: 8000, topCommit: [{ name: 'svchost', privateMb: 6000, category: 'SYSTEM_CRITICAL' }] } }), 'perf.memory_hog'), undefined, 'Windows itself is never blamed');
  assert.equal(code(score({}), 'perf.low_virtual_memory'), undefined, 'no data, no finding');
});

test('the start-up manager lists every program with its advice, its measured delay and whether it is on, and enabling or disabling needs approved entries', async () => {
  const { startupManager } = await import('../src/care.js');
  const items = [
    { location: 'HKU\S\Run', name: 'Spotify', enabled: true, cls: 'SAFE_TO_DISABLE', command: 'spotify.exe' }, { location: 'HKU\S\Run', name: 'Claude', enabled: true, cls: 'ASK' },
    { location: 'HKLM\Run', name: 'SecurityHealth', enabled: true, cls: 'KEEP' }, { location: 'HKU\S\Run', name: 'Grammarly', enabled: false, cls: 'SAFE_TO_DISABLE' }];
  const m = startupManager({ startupItems: items, boot: { degrading: [{ name: 'Claude', seconds: 124 }, { name: 'Spotify.exe', seconds: 11.4 }] } });
  assert.deepEqual(m.map(x => x.name), ['Claude', 'Spotify', 'SecurityHealth', 'Grammarly'], 'enabled first, slowest first, turned-off last');
  assert.equal(m[0].delaySeconds, 124); assert.equal(m[1].delaySeconds, 11.4); assert.equal(m[2].delaySeconds, null, 'no measurement is shown as unknown, never as zero'); assert.equal(m[3].enabled, false);
  assert.deepEqual(startupManager(null), []); assert.deepEqual(startupManager({ startupItems: items }).map(x => x.delaySeconds), [null, null, null, null]);

  const a = await mkOrg('Startup Org', 'o@startup.test'), d = await enroll(a.auth, 'startup-dev-0001');
  await put('/agent/v1/health', { ...base, collectedAt: new Date().toISOString(), startupItems: items, boot: { lastBootSeconds: 148, degrading: [{ name: 'Claude', seconds: 124 }] } }, d.dev);
  const dev = (await get(`/api/v1/devices/${d.deviceId}`, a.auth)).json(); assert.equal(dev.startupManager[0].name, 'Claude'); assert.equal(dev.startupManager[0].delaySeconds, 124); assert.equal(dev.startupManager.length, 4);
  const entries = [{ location: 'HKU\S\Run', name: 'Grammarly' }];
  assert.equal((await post('/api/v1/jobs', { type: 'repair.run', params: { recipe: 'startup.enable', approved: true, options: { entries } }, target: { deviceIds: [d.deviceId] } }, a.auth)).statusCode, 201);
  assert.equal((await post('/api/v1/jobs', { type: 'repair.run', params: { recipe: 'startup.enable', approved: true }, target: { deviceIds: [d.deviceId] } }, a.auth)).statusCode, 400, 'entries are required');
  assert.equal((await post('/api/v1/jobs', { type: 'repair.run', params: { recipe: 'startup.enable', options: { entries } }, target: { deviceIds: [d.deviceId] } }, a.auth)).statusCode, 400, 'needs approval');
});

test('a cleanup that frees little explains how much was too new, and the stronger option is approval-only and never part of the automatic safe set', async () => {
  const { CLEAN_CATEGORIES, SAFE_CLEAN_IDS } = await import('../src/catalog.js');
  assert.equal(CLEAN_CATEGORIES['recent-temp'].class, 'REVIEW'); assert.ok(!(SAFE_CLEAN_IDS as readonly string[]).includes('recent-temp'));
  const a = await mkOrg('Clean Org', 'o@clean.test'), d = await enroll(a.auth, 'clean-dev-0001');
  assert.equal((await post('/api/v1/jobs', { type: 'cleanup.run', params: { categories: ['recent-temp'] }, target: { deviceIds: [d.deviceId] } }, a.auth)).statusCode, 400, 'needs approveReview');
  assert.equal((await post('/api/v1/jobs', { type: 'cleanup.run', params: { categories: ['recent-temp'], approveReview: true }, target: { deviceIds: [d.deviceId] } }, a.auth)).statusCode, 201);
  const seed = (result: object) => h.db.query(`INSERT INTO jobs(id,org_id,device_id,batch_id,type,params,status,result,created_at,finished_at,expires_at,timeout_seconds,payload,signature) VALUES (gen_random_uuid(),$1,$2,gen_random_uuid(),'cleanup.run','{}','completed',$3,now(),now(),now() + interval '1 day',300,'{}','x')`, [a.orgId, d.deviceId, JSON.stringify(result)]);
  await seed({ freedBytes: 22 * 1048576, categories: [{ id: 'user-temp', recentBytes: 16 * 1073741824 }, { id: 'windows-temp', recentBytes: 0 }] });
  await seed({ freedBytes: 3 * 1048576, categories: [{ id: 'user-temp', recentBytes: 10 * 1048576 }] });
  await seed({ freedBytes: 16 * 1073741824, categories: [{ id: 'recent-temp', recentBytes: 0 }] });
  const sums = (await get(`/api/v1/jobs?deviceId=${d.deviceId}&type=cleanup.run`, a.auth)).json().jobs.map((j: any) => j.summary).filter(Boolean);
  assert.ok(sums.some((x: string) => /^freed 22 MB; 16384 MB more is too new to delete safely automatically \(use Free more space\)$/.test(x)), 'a small result is explained: ' + sums.join(' | '));
  assert.ok(sums.includes('freed 3 MB'), 'a trivial amount of recent files is not nagged about'); assert.ok(sums.includes('freed 16384 MB'));
});

test('the window on the PC gets this computer\'s whole picture, only its own, in plain language', async () => {
  const a = await mkOrg('Self Org', 'o@self.test'), d = await enroll(a.auth, 'self-dev-0001'), other = await enroll(a.auth, 'self-dev-0002');
  assert.equal((await get('/agent/v1/self')).statusCode, 401);
  const none = (await get('/agent/v1/self', d.dev)).json(); assert.equal(none.hasHealth, false); assert.equal(none.hostname, 'self-dev-0001'); assert.equal(none.autopilotLevel, 'OBSERVE');
  const res = { commitPercent: 94, ramTotalMb: 8031, topCommit: [{ name: 'Grammarly.Desktop', privateMb: 4861, category: 'UNKNOWN' }], lowVirtualMemory24h: [{ at: '2026-09-30T22:15:06Z', top: [{ name: 'Grammarly.Desktop.exe', mb: 4862 }] }], failedShutdowns7d: 2, securityEngines: [] };
  await put('/agent/v1/health', { ...base, collectedAt: new Date().toISOString(), resources: res, firewall: { domain: true, private: true, public: false }, security: { engine: 'Microsoft Defender', engineIsDefender: true, controlledFolderAccess: 'off', hijackingExtensions: [] }, boot: { lastBootSeconds: 148, degrading: [{ name: 'Claude', seconds: 124 }], optimizableStartup: 3 }, care: { thermal: { level: 'normal', cpuTempC: 61, available: true }, memory: { usedPercent: 82, targetPercent: 50, idleTrimmableMb: 600 } } }, d.dev);
  await put('/agent/v1/health', { ...base, collectedAt: new Date().toISOString() }, other.dev);
  await events(d, [{ kind: 'battery.sample', data: { percent: 70, onBattery: true, healthPercent: 86, fullChargeWh: 38.9, designWh: 45 } }, { kind: 'thermal.heat', data: { level: 'warning', tempC: 88, cpuLoad: 50 } }]);
  const v = (await get('/agent/v1/self', d.dev)).json();
  assert.equal(v.hasHealth, true); assert.ok(typeof v.health.overall === 'number'); const codes = v.health.findings.map((f: any) => f.code);
  for (const c of ['perf.low_virtual_memory', 'perf.memory_hog', 'perf.slow_boot', 'perf.ram_idle_waste', 'security.firewall_off', 'security.ransomware_shield_off', 'reliability.shutdown_failures']) assert.ok(codes.includes(c), c);
  assert.deepEqual(v.health.findings.map((f: any) => f.impact).slice(0, 1), ['high']); assert.ok(v.health.findings.every((f: any) => f.reason && f.category && ['safe-fix', 'review', 'manual', 'hardware'].includes(f.remedy)));
  assert.equal(v.health.findings.find((f: any) => f.code === 'perf.ram_idle_waste').fix.recipe, 'memory.trim-idle'); assert.equal(v.health.findings.find((f: any) => f.code === 'perf.low_virtual_memory').fix, null);
  assert.ok(v.protection.controls.length >= 15 && v.protection.controls.every((c: any) => c.title && ['on', 'off', 'unknown', 'na'].includes(c.state))); assert.equal(v.protection.controls.find((c: any) => c.id === 'firewall').state, 'off');
  assert.equal(v.care.battery.healthPercent, 86); assert.equal(v.care.heatEvents30d, 1); assert.equal(v.care.boot.last, 148); assert.equal(v.care.boot.slowest[0].name, 'Claude'); assert.equal(v.care.memory.idleTrimmableMb, 600);
  assert.ok(v.shield && v.shield.state); assert.ok(Array.isArray(v.recent)); assert.ok(!JSON.stringify(v).includes('self-dev-0002'), 'another computer never appears');
  const keys: string[] = []; const walk = (o: any) => { if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) { keys.push(k); walk(x); } }; walk(v);
  assert.deepEqual(keys.filter(k => /secret|password|token|credential/i.test(k)), [], 'no sensitive field is in the view');
});
