import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { batteryCondition, diskCondition, diskReadingOf, storageTrend, type DiskReading } from '../src/condition.js';
import { batteryRecommendation, lifecycleAssessment, ramRecommendation, storageRecommendation, type LifecycleInput } from '../src/lifecycle.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54346); });
after(async () => { await h.stop(); });

const GB = 2 ** 30, DAY = 86_400_000;
const rd = (o: Partial<DiskReading> = {}): DiskReading => ({ model: 'Samsung SSD 980', mediaType: 'SSD', health: 'Healthy', wearPercent: 5, uncorrectedErrors: 0, mediaErrors: 0, powerOnHours: 9000, temperatureC: 38, spareLeftPercent: 100, criticalWarning: 0, unsafeShutdowns: 3, powerCycles: 500, ...o });

test('drive condition is classified from what the drive reports, never predicts a date, and treats rising errors as critical', () => {
  assert.equal(diskCondition(rd()).condition, 'HEALTHY');
  assert.equal(diskCondition(rd({ wearPercent: 65 })).condition, 'WATCH');
  assert.equal(diskCondition(rd({ wearPercent: 85 })).condition, 'DEGRADED');
  const adv = diskCondition(rd({ wearPercent: 91, uncorrectedErrors: 2 })); assert.equal(adv.condition, 'REPLACEMENT_ADVISED'); assert.match(adv.action, /Verify backups/); assert.match(adv.evidence.join(' '), /2 uncorrectable/);
  assert.equal(diskCondition(rd({ health: 'Unhealthy' })).condition, 'CRITICAL');
  assert.equal(diskCondition(rd({ criticalWarning: 4 })).condition, 'CRITICAL');
  assert.equal(diskCondition(rd({ spareLeftPercent: 5 })).condition, 'CRITICAL');
  const rising = diskCondition(rd({ uncorrectedErrors: 4 }), [rd({ uncorrectedErrors: 0 }), rd({ uncorrectedErrors: 1 })]);
  assert.equal(rising.condition, 'CRITICAL'); assert.equal(rising.trend.uncorrectedErrors, 'increasing');
  assert.equal(diskCondition(rd({ uncorrectedErrors: 4 }), [rd({ uncorrectedErrors: 4 })]).trend.uncorrectedErrors, 'stable');
  assert.equal(diskCondition({ ...rd(), health: null, wearPercent: null, uncorrectedErrors: null, spareLeftPercent: null, criticalWarning: null, powerOnHours: null }).condition, 'NOT_MEASURED', 'no data is not "healthy"');
  assert.equal(diskCondition(rd({ mediaType: 'HDD', powerOnHours: 41_000 })).condition, 'WATCH');
  for (const c of [adv, rising]) assert.ok(!/days|months|will fail|remaining life/i.test(c.action + c.evidence.join(' ')), 'no predicted failure date');
  const flat = diskReadingOf({ model: 'X', mediaType: 'SSD', health: 'Healthy', reliability: { wearPercent: 7, readErrorsUncorrected: 0, writeErrorsUncorrected: 1, powerOnHours: 100 }, nvme: { percentageUsed: 9, availableSparePercent: 98 } });
  assert.equal(flat.wearPercent, 9); assert.equal(flat.uncorrectedErrors, 1); assert.equal(flat.spareLeftPercent, 98);
});

test('battery condition, and no runtime is quoted because none is measured', () => {
  const b = batteryCondition({ designCapacityMWh: 51_000, fullChargeCapacityMWh: 29_000, cycleCount: 610 })!;
  assert.equal(b.healthPercent, 57); assert.equal(b.condition, 'REPLACEMENT_ADVISED'); assert.equal(b.runtime.measured, false); assert.match(b.evidence[0], /57%/);
  assert.equal(batteryCondition({ designCapacityMWh: 51_000, fullChargeCapacityMWh: 45_000 })!.condition, 'HEALTHY');
  assert.equal(batteryCondition({ designCapacityMWh: 51_000, fullChargeCapacityMWh: 20_000 })!.condition, 'CRITICAL');
  assert.equal(batteryCondition(null), null);
  const trend = batteryCondition({ designCapacityMWh: 51_000, fullChargeCapacityMWh: 29_000 }, [{ at: new Date('2026-01-01T00:00:00Z'), healthPercent: 76 }])!;
  assert.equal(trend.trend.healthPercentChange, -19); assert.match(trend.evidence.join(' '), /fallen 19 points/);
});

test('free-space trend: growth per day and a projected date only when the data supports it; a cleanup starts a new segment', () => {
  const now = new Date('2026-09-30T00:00:00Z');
  const pts = (vals: number[]) => vals.map((v, i) => ({ at: new Date(now.getTime() - (vals.length - 1 - i) * DAY), freeBytes: v * GB }));
  const falling = storageTrend(pts([56, 53.7, 51.4, 49.1, 46.8, 44.5, 42.2, 39.9, 37.6, 35.3, 33]), undefined, now);
  assert.equal(falling.measured, true); assert.equal(falling.confidence, 'HIGH'); assert.ok(Math.abs(falling.growthBytesPerDay! / GB + 2.3) < 0.05);
  const days = (new Date(falling.projectedBelowThresholdAt!).getTime() - now.getTime()) / DAY; assert.ok(days > 9 && days < 11, `about 10 days to 10 GB, got ${days}`);
  assert.match(falling.note, /2\.3 GB per day/);
  const afterCleanup = storageTrend(pts([20, 19, 18, 17, 16, 60, 60.1, 59.9]), undefined, now);
  assert.equal(afterCleanup.measured, false, 'recovered space is not a trend; too few points since the cleanup');
  assert.equal(storageTrend(pts([50, 50, 50.1, 49.9, 50, 50.1, 50]), undefined, now).projectedBelowThresholdAt, null);
  assert.equal(storageTrend(pts([50, 40, 30]), undefined, now).measured, false);
});

test('hardware recommendations are compatible-by-evidence, list what could not be verified, and never claim unknown maximums', () => {
  const mod = (o: any = {}) => ({ manufacturer: 'Samsung', partNumber: 'M471', serial: 'S1', capacityBytes: 8 * GB, speedMhz: 3200, memoryType: 26, formFactor: 12, slot: 'A', ...o });
  const full = ramRecommendation({ ramBytes: 8 * GB, memoryModules: [mod()], memoryArray: { slots: 2, maxCapacityBytes: 32 * GB } }, { lowRam: false, pressure: true })!;
  assert.equal(full.compatibility.confidence, 'HIGH'); assert.equal(full.recommended, 'Add 1 × 8 GB DDR4 SODIMM 3200 MHz'); assert.match(full.expectedConfiguration!, /16 GB total/); assert.deepEqual(full.compatibility.unknowns, []);
  const noMax = ramRecommendation({ ramBytes: 8 * GB, memoryModules: [mod()], memoryArray: { slots: 2, maxCapacityBytes: null } }, { lowRam: true, pressure: false })!;
  assert.equal(noMax.compatibility.confidence, 'MEDIUM'); assert.match(noMax.compatibility.unknowns.join(' '), /maximum supported memory could not be verified/); assert.match(noMax.verification, /Technician verification required/);
  const fullSlots = ramRecommendation({ ramBytes: 8 * GB, memoryModules: [mod(), mod({ serial: 'S2', slot: 'B' })], memoryArray: { slots: 2, maxCapacityBytes: 32 * GB } }, { lowRam: true, pressure: false })!;
  assert.match(fullSlots.recommended, /Replace the 2 installed modules/);
  const exceeds = ramRecommendation({ ramBytes: 16 * GB, memoryModules: [mod({ capacityBytes: 16 * GB })], memoryArray: { slots: 2, maxCapacityBytes: 24 * GB } }, { lowRam: false, pressure: true })!;
  assert.match(exceeds.recommended, /exceed the firmware maximum/);
  const soldered = ramRecommendation({ ramBytes: 4 * GB, memoryModules: [] }, { lowRam: true, pressure: false })!; assert.equal(soldered.compatibility.confidence, 'LOW'); assert.match(soldered.compatibility.unknowns[0], /soldered/);
  const unknownType = ramRecommendation({ ramBytes: 8 * GB, memoryModules: [mod({ memoryType: 0, formFactor: 0 })] }, { lowRam: true, pressure: false })!; assert.equal(unknownType.compatibility.confidence, 'LOW');
  assert.equal(ramRecommendation({ ramBytes: 16 * GB, memoryModules: [mod()] }, { lowRam: false, pressure: false }), null, 'no recommendation without a measured need');

  const hdd = storageRecommendation({ disks: [{ model: 'WDC WD5000LPCX' }], storageBus: [{ busType: 11, sizeBytes: 500e9 }] }, { hdd: true, sizeBytes: 500e9, usedBytes: 200 * GB, condition: 'HEALTHY', lowSpace: false })!;
  assert.match(hdd.recommended, /512 GB SATA SSD|1 TB SATA SSD/); assert.equal(hdd.compatibility.confidence, 'MEDIUM'); assert.match(hdd.compatibility.unknowns.join(' '), /form factor/); assert.match(hdd.verification, /Technician verification required/);
  assert.equal(storageRecommendation({ disks: [{ model: 'Disk' }] }, { hdd: true, sizeBytes: 500e9, usedBytes: 100 * GB, condition: 'HEALTHY', lowSpace: false })!.compatibility.confidence, 'LOW', 'interface unknown');
  assert.equal(storageRecommendation({}, { hdd: false, sizeBytes: 500e9, usedBytes: 100 * GB, condition: 'HEALTHY', lowSpace: false }), null);
  assert.equal(batteryRecommendation('Latitude 5420', { condition: 'HEALTHY', healthPercent: 90, cycles: 100 }), null);
  assert.match(batteryRecommendation('Latitude 5420', { condition: 'REPLACEMENT_ADVISED', healthPercent: 57, cycles: 610 })!.recommended, /Latitude 5420/);
});

test('lifecycle: old but healthy is KEPT; expensive and unstable is REPLACED; single parts are upgraded or repaired; no remaining life is invented', () => {
  const base: LifecycleInput = { ageYears: 6.5, ageConfidence: 'HIGH', health: 88, healthChange30d: 1, storage: 'HEALTHY', systemDisk: 'SSD', battery: 'HEALTHY', hardwareConstraints: [], osUnsupported: false, interventions12m: 1, downtimeMinutes12m: 30, serviceCost12m: 40, purchaseCost: 1200, activeSoftwareIncidents: 0 };
  const keep = lifecycleAssessment(base); assert.equal(keep.action, 'KEEP'); assert.equal(keep.condition, 'AGING BUT SERVICEABLE'); assert.match(keep.reasons.join(' '), /SSD/); assert.equal(keep.confidence, 'HIGH');
  const replace = lifecycleAssessment({ ...base, ageYears: 5.2, health: 48, storage: 'REPLACEMENT_ADVISED', battery: 'REPLACEMENT_ADVISED', interventions12m: 8, downtimeMinutes12m: 1100, serviceCost12m: 800 });
  assert.equal(replace.action, 'REPLACE'); assert.equal(replace.condition, 'REPLACEMENT ADVISED'); assert.ok(replace.reasons.length >= 4); assert.match(replace.reasons.join(' '), /8 interventions/); assert.match(replace.reasons.join(' '), /67% of the purchase cost/);
  assert.equal(lifecycleAssessment({ ...base, ageYears: 2, battery: 'REPLACEMENT_ADVISED' }).action, 'REPAIR');
  assert.equal(lifecycleAssessment({ ...base, ageYears: 3, systemDisk: 'HDD', hardwareConstraints: ['mechanical system disk'] }).action, 'UPGRADE');
  assert.equal(lifecycleAssessment({ ...base, activeSoftwareIncidents: 2 }).action, 'MAINTAIN');
  assert.equal(lifecycleAssessment({ ...base, healthChange30d: -12 }).action, 'MONITOR');
  assert.equal(lifecycleAssessment({ ...base, ageYears: null, ageConfidence: 'UNKNOWN', storage: 'NOT_MEASURED', health: null }).confidence, 'LOW');
  for (const x of [keep, replace]) assert.match(x.note, /does not predict/); assert.ok(!/remaining life|will fail|fail(ure)? (date|in)/i.test(JSON.stringify([keep, replace].map(x => ({ ...x, note: '' })))), 'the only mention of failure is the disclaimer');
  // a young computer with a failing drive is repaired, an old one with several problems is replaced: age alone never decides
  assert.equal(lifecycleAssessment({ ...base, ageYears: 1.5, storage: 'REPLACEMENT_ADVISED' }).action, 'REPAIR');
  assert.equal(lifecycleAssessment({ ...base, ageYears: 9, health: 90 }).action, 'KEEP', 'age alone is never a reason to replace');
});

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const patch = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PATCH', url, payload: payload as any, headers });
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
type Dev = Awaited<ReturnType<typeof enroll>>;
const health = (d: Dev, over: object = {}) => put('/agent/v1/health', { collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }], ...over }, d.dev);
const inventory = (d: Dev, hardware: object) => put('/agent/v1/inventory', { collectedAt: new Date().toISOString(), hardware, software: [] }, d.dev);
async function diagnose(a: { auth: Hdr }, d: Dev, result: object) {
  const id = (await post('/api/v1/jobs', { type: 'hardware.diagnose', target: { deviceIds: [d.deviceId] } }, a.auth)).json().jobs[0].id;
  assert.equal((await post(`/agent/v1/jobs/${id}/start`, {}, d.dev)).statusCode, 200);
  assert.equal((await post(`/agent/v1/jobs/${id}/result`, { status: 'completed', result }, d.dev)).statusCode, 200);
}
const nvme = (over: any = {}) => ({ model: 'Samsung SSD 980 512GB', health: 'Healthy', mediaType: 'SSD', reliability: { readErrorsUncorrected: 0, writeErrorsUncorrected: 0, powerOnHours: 9000 }, nvme: { percentageUsed: 12, availableSparePercent: 100, criticalWarning: 0, mediaErrors: 0 }, ...over });
const mod = (o: any = {}) => ({ manufacturer: 'Samsung', partNumber: 'M471', serial: 'S1', capacityBytes: 16 * GB, speedMhz: 3200, memoryType: 26, formFactor: 12, slot: 'A', ...o });
const YEARS = (y: number) => new Date(Date.now() - y * 365.25 * DAY).toISOString().slice(0, 10);

test('one fleet, two very different computers: the old healthy one is kept, the expensive unstable one is replaced, with the reasons; a 4 GB one is offered a compatible RAM upgrade', async () => {
  const a = await mkOrg('Life Org', 'o@life.test');
  const old = await enroll(a.auth, 'life-dev-0001', 'OLD-OK'), bad = await enroll(a.auth, 'life-dev-0002', 'BAD-PC'), small = await enroll(a.auth, 'life-dev-0003', 'SMALL-PC');

  // old but healthy: SSD, 16 GB, low intervention count, bought 6.5 years ago
  await inventory(old, { manufacturer: 'Dell', model: 'OptiPlex 7040', memoryModules: [mod()], ramBytes: 16 * GB });
  await health(old, { physicalDisks: [{ name: 'SSD', mediaType: 'SSD', health: 'Healthy', sizeBytes: 512e9, isSystem: true }] });
  await diagnose(a, old, { storage: { disks: [nvme()] }, battery: { designCapacityMWh: 51000, fullChargeCapacityMWh: 47000, cycleCount: 210 } });
  assert.equal((await patch(`/api/v1/devices/${old.deviceId}/purchase`, { purchaseDate: YEARS(6.5), purchaseCost: 1200 }, a.auth)).statusCode, 200);
  const lo = (await get(`/api/v1/devices/${old.deviceId}/lifecycle`, a.auth)).json();
  assert.equal(lo.action, 'KEEP'); assert.equal(lo.condition, 'AGING BUT SERVICEABLE'); assert.ok(lo.reasons.length >= 2); assert.equal(lo.age.hardwareAgeConfidence, 'HIGH');
  assert.deepEqual((await get(`/api/v1/devices/${old.deviceId}/recommendations`, a.auth)).json().recommendations, [], 'nothing to buy for a healthy computer');
  const co = (await get(`/api/v1/devices/${old.deviceId}/condition`, a.auth)).json(); assert.equal(co.overall, 'HEALTHY'); assert.equal(co.disks[0].condition, 'HEALTHY'); assert.equal(co.battery.condition, 'HEALTHY');

  // expensive and unstable: the drive is failing (errors increase between two readings), the battery is worn, many interventions, costs
  await inventory(bad, { manufacturer: 'HP', model: 'EliteBook 840', memoryModules: [mod()], ramBytes: 16 * GB });
  await health(bad, { physicalDisks: [{ name: 'SSD', mediaType: 'SSD', health: 'Warning', sizeBytes: 256e9, isSystem: true }], volumes: [{ name: 'C:', totalBytes: 256 * GB, freeBytes: 5 * GB, isSystem: true }] });
  await diagnose(a, bad, { storage: { disks: [nvme({ reliability: { readErrorsUncorrected: 0, writeErrorsUncorrected: 0 } })] }, battery: { designCapacityMWh: 51000, fullChargeCapacityMWh: 22000, cycleCount: 980 } });
  await diagnose(a, bad, { storage: { disks: [nvme({ health: 'Warning', reliability: { readErrorsUncorrected: 4, writeErrorsUncorrected: 0 }, nvme: { percentageUsed: 93, availableSparePercent: 40, criticalWarning: 0, mediaErrors: 0 } })] }, battery: { designCapacityMWh: 51000, fullChargeCapacityMWh: 22000, cycleCount: 980 } });
  await patch(`/api/v1/devices/${bad.deviceId}/purchase`, { purchaseDate: YEARS(5.2), purchaseCost: 1200 }, a.auth);
  for (let i = 0; i < 7; i++) assert.equal((await post(`/api/v1/devices/${bad.deviceId}/service-events`, { serviceType: i % 2 ? 'battery replacement' : 'major software repair', cost: 110, downtimeMinutes: 150 }, a.auth)).statusCode, 201);
  const cb = (await get(`/api/v1/devices/${bad.deviceId}/condition`, a.auth)).json();
  assert.equal(cb.disks[0].condition, 'CRITICAL'); assert.equal(cb.disks[0].trend.uncorrectedErrors, 'increasing'); assert.equal(cb.battery.condition, 'CRITICAL', 'under 50% of design capacity is worn out'); assert.equal(cb.battery.healthPercent, 43);
  const lb = (await get(`/api/v1/devices/${bad.deviceId}/lifecycle`, a.auth)).json();
  assert.equal(lb.action, 'REPLACE'); assert.equal(lb.condition, 'REPLACEMENT ADVISED'); assert.match(lb.reasons.join(' '), /interventions/); assert.equal(lb.cost.downtimeHours12m, 17.5); assert.equal(lb.cost.serviceCost12m, 770);
  const rb = (await get(`/api/v1/devices/${bad.deviceId}/recommendations`, a.auth)).json().recommendations;
  assert.ok(rb.some((r: any) => r.kind === 'battery') && rb.some((r: any) => r.kind === 'storage'));

  // 4 GB, one slot free: RAM upgrade with evidence and confidence
  await inventory(small, { manufacturer: 'Lenovo', model: 'ThinkPad E14', ramBytes: 4 * GB, memoryModules: [mod({ capacityBytes: 4 * GB })], memoryArray: { slots: 2, maxCapacityBytes: 32 * GB }, disks: [{ model: 'WD Blue', sizeBytes: 1e12 }] });
  await health(small, { memory: { totalBytes: 4 * GB, availableBytes: 0.4 * GB }, perf: { ramPercent: 95 } });
  const rs = (await get(`/api/v1/devices/${small.deviceId}/recommendations`, a.auth)).json();
  const ram = rs.recommendations.find((r: any) => r.kind === 'ram'); assert.ok(ram, JSON.stringify(rs));
  assert.equal(ram.compatibility.confidence, 'HIGH'); assert.match(ram.recommended, /Add 1 × 4 GB DDR4 SODIMM 3200 MHz/); assert.match(ram.expectedConfiguration, /8 GB total/); assert.ok(ram.compatibility.evidence.length >= 4);

  // fleet: replace first, keep last
  const fleet = (await get('/api/v1/lifecycle', a.auth)).json();
  assert.equal(fleet.devices, 3); assert.equal(fleet.counts.REPLACE, 1); assert.equal(fleet.counts.KEEP >= 1, true); assert.equal(fleet.items[0].hostname, 'BAD-PC'); assert.equal(fleet.items[0].action, 'REPLACE');
  // isolation and trends
  const b = await mkOrg('Life Other', 'o@life-other.test');
  assert.equal((await get(`/api/v1/devices/${old.deviceId}/lifecycle`, b.auth)).statusCode, 404); assert.equal((await get('/api/v1/lifecycle', b.auth)).json().devices, 0);
  const tr = (await get(`/api/v1/devices/${old.deviceId}/trends?days=90`, a.auth)).json(); assert.equal(tr.measured, true); assert.ok(tr.points.length >= 1);
});
