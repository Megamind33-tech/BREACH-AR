import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { hashPassword } from '../src/security.js';
import { compareBenchmarks } from '../src/benchmarks.js';
import { componentsOf, hardwareAgeEstimate } from '../src/passport.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54344); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const patch = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PATCH', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });

async function mkOrg(name: string, email: string, autopilot = false) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function mkUser(orgId: string, email: string, role: string) {
  await h.db.query('INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,$2,$3,$4)', [orgId, email, await hashPassword('another long password'), role]);
  return { authorization: `Bearer ${(await post('/api/v1/auth/login', { email, password: 'another long password' })).json().token}` } as Hdr;
}
async function enroll(auth: Hdr, guid: string, hostname: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
type Dev = Awaited<ReturnType<typeof enroll>>;
const GB = 2 ** 30;
const hw = (over: any = {}) => ({
  manufacturer: 'Dell Inc.', model: 'Latitude 5420', serialNumber: 'SVC1234', baseBoard: { manufacturer: 'Dell', product: '0ABC', serial: 'BRD111' }, biosVersion: '1.20', ramBytes: 8 * GB,
  memoryModules: [{ manufacturer: 'Samsung', partNumber: 'M471A1K43', serial: 'MEM-A', capacityBytes: 8 * GB, speedMhz: 3200, slot: 'DIMM A' }],
  disks: [{ model: 'Samsung SSD 980', serial: 'DISK-1', sizeBytes: 256e9, mediaType: 'SSD', interfaceType: 'NVMe' }], gpus: [{ name: 'Intel Iris Xe', driverVersion: '31.0.101' }], os: { caption: 'Windows 11', build: '26100' },
  ...over,
});
const inventory = (d: Dev, hardware: object) => put('/agent/v1/inventory', { collectedAt: new Date().toISOString(), hardware, software: [{ name: 'App', version: '1' }] }, d.dev);
const putHealth = (d: Dev, over: object = {}) => put('/agent/v1/health', { collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }], ...over }, d.dev);
async function agentRuns(d: Dev, jobId: string, status: 'completed' | 'failed', result?: unknown) {
  assert.equal((await post(`/agent/v1/jobs/${jobId}/start`, {}, d.dev)).statusCode, 200);
  assert.equal((await post(`/agent/v1/jobs/${jobId}/result`, { status, result }, d.dev)).statusCode, 200);
}
const jobsOf = async (deviceId: string, type: string) => (await h.db.query(`SELECT id, status FROM jobs WHERE device_id=$1 AND type=$2 ORDER BY created_at`, [deviceId, type])).rows;

test('parts are identified by serial number; age is an estimate with evidence and confidence, never a claim', () => {
  const c = componentsOf(hw());
  assert.deepEqual(c.map(x => `${x.kind}:${x.identity}`).sort(), ['gpu:Intel Iris Xe', 'memory:MEM-A', 'storage:DISK-1', 'system:BRD111']);
  assert.equal(componentsOf({ memoryModules: [{ serial: '00000000', partNumber: 'P', capacityBytes: 4 * GB, slot: 'A' }] })[0].identity, 'P|4294967296|A', 'a placeholder serial is not an identity');
  const now = new Date('2026-09-30T00:00:00Z');
  assert.equal(hardwareAgeEstimate({ hardware: {}, now }).hardwareAgeConfidence, 'UNKNOWN');
  assert.equal(hardwareAgeEstimate({ hardware: {}, now }).hardwareAgeEstimate, null);
  const bios = hardwareAgeEstimate({ hardware: { biosDate: '2026-06-10T00:00:00Z' }, now });   // e.g. a 2020 laptop with a 2026 BIOS update
  assert.equal(bios.hardwareAgeConfidence, 'UNKNOWN'); assert.equal(bios.hardwareAgeEstimate, null, 'a BIOS date alone never becomes an age'); assert.match(bios.hardwareAgeEvidence[0].detail, /does not date the hardware/);
  const hours = hardwareAgeEstimate({ hardware: {}, powerOnHours: 14382, now }); assert.equal(hours.hardwareAgeConfidence, 'UNKNOWN'); assert.equal(hours.hardwareAgeEstimate, null); assert.equal(hours.systemDriveInServiceYears, 1.6, 'reported as drive running time, not computer age');
  const bought = hardwareAgeEstimate({ hardware: { biosDate: '2021-03-01T00:00:00Z' }, purchaseDate: '2021-09-30', now });
  assert.equal(bought.hardwareAgeConfidence, 'HIGH'); assert.equal(bought.hardwareAgeEstimate, 5); assert.equal(bought.hardwareAgeEvidence[0].weight, 'strong');
  assert.ok(hardwareAgeEstimate({ hardware: { osInstalledAt: '2023-11-18' }, now }).hardwareAgeEvidence.some(e => /reinstalled/.test(e.detail)), 'OS install date is context, not evidence of hardware age');
});

test('benchmark comparison only reports measured, meaningful differences', () => {
  assert.equal(compareBenchmarks(null, { bootSeconds: 1 }).measured, false);
  const c = compareBenchmarks({ bootSeconds: 150, cpuAvgPercent: 20, ramPercent: 80, startupCount: 26, systemFreeBytes: 7 * GB, diskSyncWriteMs: 5, processCount: 200 },
    { bootSeconds: 70, cpuAvgPercent: 19, ramPercent: 82, startupCount: 13, systemFreeBytes: 40 * GB, diskSyncWriteMs: 9, processCount: 198 });
  const r = Object.fromEntries(c.rows.map(x => [x.metric, x]));
  assert.equal(r.bootSeconds.result, 'improved'); assert.equal(r.bootSeconds.changePercent, -53.3);
  assert.equal(r.cpuAvgPercent.result, 'unchanged', 'within noise'); assert.equal(r.ramPercent.result, 'unchanged');
  assert.equal(r.startupCount.result, 'improved'); assert.equal(r.systemFreeBytes.result, 'improved'); assert.equal(r.diskSyncWriteMs.result, 'worse'); assert.equal(r.processCount.result, 'unchanged');
  assert.deepEqual(c.improved.map(x => x.metric).sort(), ['bootSeconds', 'startupCount', 'systemFreeBytes']);
  assert.equal(compareBenchmarks({ bootSeconds: 100 }, { cpuAvgPercent: 5 }).measured, false, 'metrics missing on one side are not compared');
});

test('the service passport records a baseline, notices replaced hardware without rewriting history, and keeps service events', async () => {
  const a = await mkOrg('Pass Org', 'o@pass.test'), b = await mkOrg('Pass Other', 'o@pass-other.test');
  const tech = await mkUser(a.orgId, 't@pass.test', 'technician'), viewer = await mkUser(a.orgId, 'v@pass.test', 'viewer');
  const d = await enroll(a.auth, 'pass-dev-0001', 'FIN-PC-04');
  await inventory(d, hw()); await putHealth(d);

  let p = (await get(`/api/v1/devices/${d.deviceId}/passport`, a.auth)).json();
  assert.ok(p.identity, JSON.stringify(p)); assert.equal(p.identity.model, 'Latitude 5420'); assert.equal(p.identity.serialNumber, 'SVC1234'); assert.equal(p.device.hostname, 'FIN-PC-04');
  assert.ok(p.baseline && p.baseline.healthOverall != null, 'baseline stored with the first health score'); assert.equal(p.baseline.softwareCount, 1);
  assert.equal(p.age.hardwareAgeConfidence, 'UNKNOWN'); assert.equal(p.counts.pendingConfirmation, 0, 'first sight is a baseline, not a change');
  assert.equal((await get(`/api/v1/devices/${d.deviceId}/passport`, b.auth)).statusCode, 404);
  await inventory(d, hw({ biosDate: '2021-03-01T00:00:00Z' }));
  assert.equal((await get(`/api/v1/devices/${d.deviceId}/passport`, a.auth)).json().baseline.softwareCount, 1, 'the baseline is never overwritten');

  // purchase date: admin only, raises confidence to HIGH
  assert.equal((await patch(`/api/v1/devices/${d.deviceId}/purchase`, { purchaseDate: '2021-09-30', purchaseCost: 1200 }, tech)).statusCode, 403);
  assert.equal((await patch(`/api/v1/devices/${d.deviceId}/purchase`, { purchaseDate: '2021-09-30', purchaseCost: 1200 }, a.auth)).statusCode, 200);
  p = (await get(`/api/v1/devices/${d.deviceId}/passport`, a.auth)).json(); assert.equal(p.age.hardwareAgeConfidence, 'HIGH'); assert.ok(p.age.hardwareAgeEvidence.some((e: any) => e.source === 'Recorded purchase date'));

  // the SSD is replaced and a RAM module is added
  await inventory(d, hw({ biosDate: '2021-03-01T00:00:00Z', disks: [{ model: 'Kingston NV2', serial: 'DISK-2', sizeBytes: 512e9, mediaType: 'SSD', interfaceType: 'NVMe' }],
    memoryModules: [{ manufacturer: 'Samsung', partNumber: 'M471A1K43', serial: 'MEM-A', capacityBytes: 8 * GB, slot: 'DIMM A' }, { manufacturer: 'Kingston', partNumber: 'KVR32', serial: 'MEM-B', capacityBytes: 8 * GB, slot: 'DIMM B' }] }));
  const ev = (await get(`/api/v1/devices/${d.deviceId}/service-events`, a.auth)).json().events;
  const ssd = ev.find((e: any) => e.service_type === 'SSD/HDD replacement'), ram = ev.find((e: any) => e.service_type === 'RAM upgrade');
  assert.ok(ssd && ram, JSON.stringify(ev.map((e: any) => e.service_type)));
  assert.equal(ssd.status, 'PENDING_CONFIRMATION'); assert.equal(ssd.source, 'HARDWARE_CHANGE_DETECTION'); assert.equal(ssd.old_part_serial, 'DISK-1'); assert.equal(ssd.new_part_serial, 'DISK-2');
  const comps = (await h.db.query(`SELECT identity, removed_at FROM hardware_components WHERE device_id=$1 AND kind='storage' ORDER BY identity`, [d.deviceId])).rows;
  assert.equal(comps.length, 2); assert.ok(comps[0].removed_at && !comps[1].removed_at, 'the old disk stays on record, marked removed');
  assert.equal((await get(`/api/v1/devices/${d.deviceId}/passport`, a.auth)).json().counts.pendingConfirmation, 2);
  const again = (await get(`/api/v1/devices/${d.deviceId}/service-events`, a.auth)).json().events.length;
  await inventory(d, hw({ biosDate: '2021-03-01T00:00:00Z', disks: [{ model: 'Kingston NV2', serial: 'DISK-2', sizeBytes: 512e9 }], memoryModules: [{ serial: 'MEM-A', capacityBytes: 8 * GB, slot: 'DIMM A', partNumber: 'M471A1K43' }, { serial: 'MEM-B', capacityBytes: 8 * GB, slot: 'DIMM B', partNumber: 'KVR32' }] }));
  assert.equal((await get(`/api/v1/devices/${d.deviceId}/service-events`, a.auth)).json().events.length, again, 'no duplicate proposals');

  // an administrator decides; a technician cannot
  assert.equal((await patch(`/api/v1/service-events/${ssd.id}`, { decision: 'confirm' }, tech)).statusCode, 403);
  assert.equal((await patch(`/api/v1/service-events/${ssd.id}`, { decision: 'confirm', cost: 95, technician: 'J. Banda' }, a.auth)).statusCode, 200);
  assert.equal((await patch(`/api/v1/service-events/${ram.id}`, { decision: 'dismiss' }, a.auth)).statusCode, 200);
  assert.equal((await patch(`/api/v1/service-events/${ssd.id}`, { decision: 'confirm' }, a.auth)).statusCode, 404, 'already decided');
  p = (await get(`/api/v1/devices/${d.deviceId}/passport`, a.auth)).json(); assert.equal(p.counts.componentsReplaced, 1); assert.equal(p.counts.pendingConfirmation, 0);

  // manual service history: technician can add, viewer cannot, types are validated, the entry is audited
  assert.equal((await post(`/api/v1/devices/${d.deviceId}/service-events`, { serviceType: 'physical cleaning' }, viewer)).statusCode, 403);
  assert.equal((await post(`/api/v1/devices/${d.deviceId}/service-events`, { serviceType: 'time travel' }, tech)).statusCode, 400);
  assert.equal((await post(`/api/v1/devices/${d.deviceId}/service-events`, { serviceType: 'physical cleaning', reason: 'Fan noise and heat', technician: 'J. Banda', cost: 40, downtimeMinutes: 45, parts: ['compressed air'] }, tech)).statusCode, 201);
  assert.equal((await post(`/api/v1/devices/${d.deviceId}/service-events`, { serviceType: 'battery replacement' }, b.auth)).statusCode, 404);
  p = (await get(`/api/v1/devices/${d.deviceId}/passport`, a.auth)).json(); assert.equal(p.counts.manualInterventions, 1, 'the technician entry; the detected SSD change is counted as a replaced part'); assert.equal(p.counts.physicalServices, 2, 'cleaning + SSD replacement');
  const tl = (await get(`/api/v1/devices/${d.deviceId}/timeline`, a.auth)).json().timeline; assert.ok(tl.some((x: any) => /physical cleaning/.test(x.text)) && tl.some((x: any) => /SSD\/HDD replacement/.test(x.text)));
  assert.ok((await get('/api/v1/audit', a.auth)).json().entries.some((e: any) => e.action === 'service_event.create'));
});

test('benchmarks: first is the baseline, repairs get a measured before/after, and nothing is claimed that was not measured', async () => {
  const a = await mkOrg('Bench Org', 'o@bench.test', true);
  const d = await enroll(a.auth, 'bench-dev-0001', 'SLOW-PC');
  const runBench = async (metrics: object) => {
    const id = (await post('/api/v1/jobs', { type: 'benchmark.run', target: { deviceIds: [d.deviceId] } }, a.auth)).json().jobs[0].id;
    await agentRuns(d, id, 'completed', { metrics, errors: [] });
  };
  await runBench({ bootSeconds: 194, cpuAvgPercent: 21, ramPercent: 84, startupCount: 26, systemFreeBytes: 3 * GB, diskSyncWriteMs: 8, processCount: 210 });
  let bm = (await get(`/api/v1/devices/${d.deviceId}/benchmarks`, a.auth)).json();
  assert.equal(bm.baseline.kind, 'baseline'); assert.equal(bm.measurements, 1); assert.equal(bm.sinceBaseline, null, 'one measurement cannot be compared');

  // a real repair: low disk -> Autopilot cleanup -> job "succeeds" -> an after-benchmark is requested
  await putHealth(d, { volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 3 * GB, isSystem: true }] });
  await agentRuns(d, (await jobsOf(d.deviceId, 'cleanup.run'))[0].id, 'completed', { freedBytes: 290 * GB });
  const benchJob = (await jobsOf(d.deviceId, 'benchmark.run')).find(j => j.status === 'queued'); assert.ok(benchJob, 'an after-repair benchmark was queued');
  let inc = (await get(`/api/v1/devices/${d.deviceId}/incidents`, a.auth)).json().incidents.find((i: any) => i.code === 'storage.system_low');
  assert.equal(inc.benchmark.measured, false, 'nothing is claimed before the after-benchmark arrives');
  await agentRuns(d, benchJob!.id, 'completed', { metrics: { bootSeconds: 88, cpuAvgPercent: 20, ramPercent: 60, startupCount: 26, systemFreeBytes: 293 * GB, diskSyncWriteMs: 4, processCount: 205 }, errors: [] });
  inc = (await get(`/api/v1/devices/${d.deviceId}/incidents`, a.auth)).json().incidents.find((i: any) => i.code === 'storage.system_low');
  assert.equal(inc.benchmark.measured, true);
  const imp = Object.fromEntries(inc.benchmark.improved.map((x: any) => [x.metric, x]));
  assert.equal(imp.bootSeconds.before, 194); assert.equal(imp.bootSeconds.after, 88); assert.ok(imp.systemFreeBytes && imp.ramPercent && imp.diskSyncWriteMs);
  assert.ok(!imp.startupCount && !imp.cpuAvgPercent, 'unchanged metrics are not presented as improvements');
  bm = (await get(`/api/v1/devices/${d.deviceId}/benchmarks`, a.auth)).json();
  assert.equal(bm.measurements, 2); assert.equal(bm.latest.kind, 'after'); assert.ok(bm.sinceBaseline.improved.length >= 4);
});
