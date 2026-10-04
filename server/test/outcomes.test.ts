import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54353); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });
async function mkOrg(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function enroll(auth: Hdr, guid: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname: guid, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
let n = 0;
const incident = (org: string, dev: string, code: string, o: { status?: string; resolution?: string | null; resolvedAgo?: number | null; title?: string } = {}) =>
  h.db.query(`INSERT INTO incidents(org_id,device_id,code,category,impact,title,root_cause,confidence,status,remedy,first_detected,resolved_at,resolution) VALUES ($1,$2,$3,'performance','medium',$4,'x','HIGH',$5,'safe-fix',$6,$7,$8)`,
    [org, dev, code, o.title ?? 'A problem ' + n++, o.status ?? 'RESOLVED', ago((o.resolvedAgo ?? 2) + 1), o.resolvedAgo == null && o.status && o.status !== 'RESOLVED' ? null : ago(o.resolvedAgo ?? 2), o.resolution === undefined ? 'viro-repair' : o.resolution]);
const job = (org: string, dev: string, type: string, params: object, result: object, daysAgo = 2) =>
  h.db.query(`INSERT INTO jobs(id,org_id,device_id,batch_id,type,params,status,result,created_at,finished_at,expires_at,timeout_seconds,payload,signature) VALUES (gen_random_uuid(),$1,$2,gen_random_uuid(),$3,$4,'completed',$5,$6,$6,now() + interval '1 day',300,'{}','x')`, [org, dev, type, JSON.stringify(params), JSON.stringify(result), ago(daysAgo)]);

test('the monthly outcomes are sums of real records and nothing else, and other organizations never appear', async () => {
  const a = await mkOrg('Outcome Org', 'o@out.test'), b = await mkOrg('Outcome Other', 'o@outb.test');
  const d1 = await enroll(a.auth, 'out-dev-0001'), d2 = await enroll(a.auth, 'out-dev-0002'), o1 = await enroll(b.auth, 'out-dev-0003');
  const emptyRes = await get("/api/v1/outcomes/month", a.auth); if (emptyRes.statusCode !== 200) console.log("STATUS", emptyRes.statusCode, emptyRes.body); const empty = emptyRes.json();
  assert.equal(empty.verifiedRepairs, 0); assert.equal(empty.storageRecoveredGb, 0); assert.equal(empty.malwareIncidentsRemoved, 0); assert.equal(empty.devices.total, 2);
  assert.ok(!('downtimeAvoidedHours' in empty), 'an estimate that is not a record is not shown');

  await incident(a.orgId, d1.deviceId, 'perf.service_failed'); await incident(a.orgId, d1.deviceId, 'stability.app:outlook.exe'); await incident(a.orgId, d2.deviceId, 'drivers.errors');
  await incident(a.orgId, d2.deviceId, 'perf.ram_pressure', { resolution: 'self-cleared' });                       // cleared by itself: not a Viro repair
  await incident(a.orgId, d2.deviceId, 'storage.system_low', { status: 'DETECTED', resolvedAgo: null, resolution: null });   // still open: not counted
  await incident(o1.deviceId && b.orgId, o1.deviceId, 'perf.service_failed');                                       // another org
  await incident(a.orgId, d1.deviceId, 'hardware.disk_unhealthy', { status: 'HARDWARE_ACTION_REQUIRED', resolvedAgo: null, resolution: null }); await incident(a.orgId, d2.deviceId, 'hardware.hdd_system', { status: 'HARDWARE_ACTION_REQUIRED', resolvedAgo: null, resolution: null });
  const si = (name: string, type: string, status: string, dev: string, org = a.orgId) => h.db.query(`INSERT INTO security_incidents(org_id,device_id,threat_type,threat_name,severity,detected_at,status) VALUES ($1,$2,$3,$4,'severe',$5,$6)`, [org, dev, type, name, ago(3), status]);
  await si('Trojan:A', 'malware', 'RESOLVED', d1.deviceId); await si('Trojan:B', 'malware', 'OBSERVING', d1.deviceId); await si('Trojan:C', 'malware', 'REPAIR_READY', d2.deviceId); await si('Ransom:A', 'ransomware', 'RESOLVED', d2.deviceId); await si('PUA:A', 'pua', 'RESOLVED', d2.deviceId); await si('Trojan:X', 'malware', 'RESOLVED', o1.deviceId, b.orgId);
  await job(a.orgId, d1.deviceId, 'cleanup.run', { categories: ['temp'] }, { freedBytes: 12.5 * 1073741824 }); await job(a.orgId, d2.deviceId, 'cleanup.run', { categories: ['temp'] }, { freedBytes: 0.25 * 1073741824 }); await job(b.orgId, o1.deviceId, 'cleanup.run', { categories: ['temp'] }, { freedBytes: 999 * 1073741824 });
  await job(a.orgId, d1.deviceId, 'updates.install', { scope: 'security' }, { installed: 3 }); await job(a.orgId, d1.deviceId, 'cleanup.run', { categories: ['temp'] }, { freedBytes: 50 * 1073741824 }, 60);   // older than the period
  await h.db.query(`INSERT INTO thermal_incidents(org_id,device_id,at,level,temperature_c,recovered_at) VALUES ($1,$2,$3,'warning',88,$4), ($1,$2,$3,'critical',97,NULL)`, [a.orgId, d1.deviceId, ago(1), ago(1)]);
  await h.db.query(`INSERT INTO care_events(org_id,device_id,at,kind,data) VALUES ($1,$2,now(),'memory.trim',$3), ($1,$2,now(),'memory.trim',$4)`, [a.orgId, d1.deviceId, JSON.stringify({ reclaimedMb: 1024 }), JSON.stringify({ reclaimedMb: 1536 })]);
  await h.db.query(`INSERT INTO battery_samples(device_id,org_id,at,percent,on_battery,health_percent) VALUES ($1,$2,now(),50,true,58), ($3,$2,now(),60,true,92)`, [d1.deviceId, a.orgId, d2.deviceId]);

  const o = (await get('/api/v1/outcomes/month', a.auth)).json();
  assert.equal(o.verifiedRepairs, 3, 'only repairs Viro verified, not self-cleared or open ones'); assert.equal(o.recurringCrashProblemsStopped, 1); assert.equal(o.driverIssuesResolved, 1);
  assert.equal(o.malwareIncidentsRemoved, 2, 'verified clean (observing or resolved) and only this organization'); assert.equal(o.ransomwareContained, 1); assert.equal(o.unwantedSoftwareRemoved, 1); assert.equal(o.openSecurityIncidents, 1);
  assert.equal(o.storageRecoveredGb, 12.8); assert.equal(o.windowsUpdatesInstalled, 3); assert.equal(o.failingDrivesDetected, 1); assert.equal(o.hardwareUpgradesRecommended, 1);
  assert.equal(o.thermalEvents, 2); assert.equal(o.thermalEventsRecovered, 1); assert.equal(o.memoryReclaimedGb, 2.5); assert.equal(o.batteryProblemsIdentified, 1); assert.equal(o.devices.hardwareAction, 2);
  assert.equal((await get('/api/v1/outcomes/month?days=90', a.auth)).json().storageRecoveredGb, 62.8, 'the period is honoured');
  assert.equal((await get('/api/v1/outcomes/month', b.auth)).json().malwareIncidentsRemoved, 1); assert.equal((await get('/api/v1/outcomes/month', {})).statusCode, 401);
});

test('the device timeline lists what Viro actually did, newest first, in plain words', async () => {
  const a = await mkOrg('Timeline Org', 'o@tl.test'), d = await enroll(a.auth, 'tl-dev-0001'), other = await mkOrg('Timeline Other', 'o@tlb.test');
  await incident(a.orgId, d.deviceId, 'perf.service_failed', { title: 'A Windows service has stopped', resolvedAgo: 5 });
  await h.db.query(`INSERT INTO security_incidents(org_id,device_id,threat_type,threat_name,severity,detected_at,status,resolved_at) VALUES ($1,$2,'malware','Trojan:Win32/Fake','severe',$3,'RESOLVED',$4)`, [a.orgId, d.deviceId, ago(20), ago(18)]);
  await job(a.orgId, d.deviceId, 'repair.run', { recipe: 'windows.sfc' }, { applied: true, verified: true, title: 'System File Checker', summary: 'Repaired and verified: 4 files restored' }, 10);
  await job(a.orgId, d.deviceId, 'repair.run', { recipe: 'dns.flush' }, { applied: true, verified: false, title: 'Flush DNS' }, 9);      // not verified: not claimed
  await job(a.orgId, d.deviceId, 'cleanup.run', { categories: ['temp'] }, { freedBytes: 22.8 * 1073741824 }, 12);
  await h.db.query(`INSERT INTO care_events(org_id,device_id,at,kind,data) VALUES ($1,$2,$3,'thermal.heat',$4), ($1,$2,$5,'memory.trim',$6), ($1,$2,$7,'ui.heat-notice',$8), ($1,$2,$9,'apps.closed',$10)`,
    [a.orgId, d.deviceId, ago(1), JSON.stringify({ tempC: 87, topProcesses: [{ name: 'chrome' }, { name: 'teams' }] }), ago(2), JSON.stringify({ reclaimedMb: 2100, beforePercent: 72, afterPercent: 51 }), ago(1), JSON.stringify({ choice: 'later' }), ago(3), JSON.stringify({ results: [{ name: 'AdobeARM', closed: true }, { name: 'x', closed: false }] })]);
  const tl = (await get(`/api/v1/devices/${d.deviceId}/what-viro-did`, a.auth)).json().items as { at: string; kind: string; title: string; detail?: string }[];
  const titles = tl.map(x => x.title);
  for (const t of ['Verified fixed: A Windows service has stopped', 'Security incident resolved: Trojan:Win32/Fake', 'Repaired: System File Checker', 'Recovered 22.8 GB of storage', 'Paused background compute: CPU reached 87°C', 'Freed 2100 MB of memory from idle programs', 'Closed 1 safe background helper', 'Warned the user about heat']) assert.ok(titles.includes(t), t);
  assert.ok(!titles.some(t => /Flush DNS|DNS/.test(t)), 'a repair that was not verified is not claimed');
  assert.deepEqual(tl.map(x => new Date(x.at).getTime()), [...tl.map(x => new Date(x.at).getTime())].sort((x, y) => y - x), 'newest first');
  assert.equal(tl.find(x => x.title.startsWith('Warned'))!.detail, 'They chose: later'); assert.match(tl.find(x => x.title.startsWith('Freed'))!.detail!, /72% to 51%.*Nothing was closed/);
  assert.equal((await get(`/api/v1/devices/${d.deviceId}/what-viro-did`, other.auth)).statusCode, 404); assert.equal((await get(`/api/v1/devices/${d.deviceId}/what-viro-did?days=1`, a.auth)).json().items.filter((x: any) => /Verified fixed/.test(x.title)).length, 0, 'the window is honoured');
});
