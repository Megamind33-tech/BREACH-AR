import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { classifyCrashes, stabilityFindings, crashesSince, type CrashRec } from '../src/stability.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54345); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });

async function mkOrg(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery' }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function enroll(auth: Hdr, guid: string, hostname: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
type Dev = Awaited<ReturnType<typeof enroll>>;
const GB = 2 ** 30, MIN = 60_000, DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const crash = (app: string, msAgo: number, module = 'vcruntime140.dll', code = 'c0000005'): CrashRec => ({ app, kind: 'crash', appVersion: '16.0.18000.20000', module, moduleVersion: '14.38.33135.0', exceptionCode: code, at: iso(msAgo) });
const OK = { volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }] };
const LOW = { volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 1 * GB, isSystem: true }] };
const health = (d: Dev, crashes: CrashRec[], base: object = OK, changes: object[] = []) =>
  put('/agent/v1/health', { collectedAt: new Date().toISOString(), ...base, stability: { windowDays: 14, crashes, recentChanges: changes } }, d.dev);
async function agentRuns(d: Dev, jobId: string, status: 'completed' | 'failed', result?: unknown) {
  assert.equal((await post(`/agent/v1/jobs/${jobId}/start`, {}, d.dev)).statusCode, 200);
  assert.equal((await post(`/agent/v1/jobs/${jobId}/result`, { status, result }, d.dev)).statusCode, 200);
}
const jobsOf = async (deviceId: string, type: string) => (await h.db.query(`SELECT id, status, params FROM jobs WHERE device_id=$1 AND type=$2 ORDER BY created_at`, [deviceId, type])).rows;
const repairJobs = async (deviceId: string, recipe: string) => (await jobsOf(deviceId, 'repair.run')).filter(j => j.params.recipe === recipe);
const incs = async (a: { auth: Hdr }, d: Dev) => (await get(`/api/v1/devices/${d.deviceId}/incidents`, a.auth)).json().incidents as any[];
const outlook = async (a: { auth: Hdr }, d: Dev) => (await incs(a, d)).find(i => i.code === 'stability.app:outlook.exe');
const FIVE = () => [1, 1.5, 2, 2.5, 3].map(n => crash('outlook.exe', n * DAY));

test('causes are worked out from evidence: disk or memory state at the time, a change just before, a common module; otherwise LOW', () => {
  const hist = (free: number, ram: number, msAgo: number) => ({ at: new Date(Date.now() - msAgo), metrics: { systemFreeBytes: free, ramPercent: ram } });
  const cs = [10, 20, 30, 40].map(m => crash('winword.exe', m * MIN));
  const disk = classifyCrashes('winword.exe', cs, [10, 20, 30, 40].map(m => hist(1 * GB, 50, m * MIN)), []);
  assert.equal(disk.cause, 'storage-pressure'); assert.equal(disk.confidence, 'HIGH'); assert.match(disk.explanation, /4 of 4/);
  const mem = classifyCrashes('winword.exe', cs, [10, 20, 30, 40].map(m => hist(200 * GB, 96, m * MIN)), []);
  assert.equal(mem.cause, 'memory-pressure');
  const mixed = classifyCrashes('winword.exe', cs.map((c, i) => ({ ...c, module: `m${i}.dll` })), [10, 20, 30, 40].map(m => hist(200 * GB, 40, m * MIN)), [{ kind: 'install', name: 'Microsoft 365 Apps', at: iso(2 * DAY) }]);
  assert.equal(mixed.cause, 'recent-change'); assert.equal(mixed.confidence, 'MEDIUM'); assert.match(mixed.explanation, /Microsoft 365 Apps/);
  const unrelated = classifyCrashes('contoso.exe', cs.map((c, i) => ({ ...c, app: 'contoso.exe', module: `m${i}.dll` })), [], [{ kind: 'install', name: 'Adobe Reader', at: iso(2 * DAY) }]);
  assert.equal(unrelated.cause, 'unknown'); assert.equal(unrelated.confidence, 'LOW');
  assert.equal(classifyCrashes('x.exe', cs, [], []).cause, 'faulting-module');
  // no recorded state for the crashes: never claim a disk or memory cause
  assert.equal(classifyCrashes('winword.exe', cs.map((c, i) => ({ ...c, module: `m${i}.dll` })), [hist(1 * GB, 99, 5 * DAY)], []).cause, 'unknown');
});

test('only unstable applications become findings; crashes before a repair never count against it', () => {
  const snap: any = { stability: { crashes: [...FIVE(), ...[1, 2].map(n => crash('notepad.exe', n * DAY)), ...[10, 11, 12, 13, 14].map(n => crash('old.exe', n * DAY))] } };
  const f = stabilityFindings(snap, [], new Map());
  assert.deepEqual(f.map(x => x.app), ['outlook.exe'], 'two crashes and crashes older than 7 days are not incidents');
  assert.equal(f[0].deduction.impact, 'high'); assert.equal(f[0].deduction.fix?.params.recipe, 'office.quick-repair'); assert.equal(f[0].deduction.code, 'stability.app:outlook.exe');
  const repairedAt = new Date(Date.now() - 2.2 * DAY);   // three of the five crashes happened after this repair
  assert.equal(crashesSince(snap, 'stability.app:outlook.exe', repairedAt), 3);
  const since = new Map([['stability.app:outlook.exe', { repairedAt, inObservation: true }]]);
  assert.equal(stabilityFindings(snap, [], since).length, 1, 'one crash after the repair, while observing, is a recurrence');
  assert.equal(stabilityFindings({ stability: { crashes: FIVE().filter(c => new Date(c.at) < repairedAt) } } as any, [], since).length, 0, 'nothing after the repair: the symptom is gone');
  const resolved = new Map([['stability.app:outlook.exe', { repairedAt, inObservation: false }]]);
  assert.equal(stabilityFindings({ stability: { crashes: [crash('outlook.exe', 60_000 - 3_600_000 * 0)] } } as any, [], new Map([['stability.app:outlook.exe', { repairedAt: new Date(Date.now() - DAY), inObservation: false }]])).length, 0, 'one crash after a resolved repair is noise');
  assert.equal(stabilityFindings({ stability: { crashes: [crash('outlook.exe', 60_000), crash('outlook.exe', 120_000)] } } as any, [], resolved.set('stability.app:outlook.exe', { repairedAt: new Date(Date.now() - DAY), inObservation: false })).length, 1);
});

test('crash before, Viro repair, no crash after: detected with evidence, repaired, verified, observed, resolved; deferred while Office is open; reopened on recurrence', async () => {
  const a = await mkOrg('Stab Org', 'o@stab.test');
  const d = await enroll(a.auth, 'stab-dev-0001', 'HR-PC-12');
  await health(d, FIVE());

  // detected as one incident with the evidence Windows recorded, a cause and a supported repair; Autopilot starts it
  let inc = await outlook(a, d);
  assert.ok(inc, 'incident created'); assert.equal(inc.title, 'Outlook keeps crashing'); assert.equal(inc.category, 'reliability'); assert.equal(inc.impact, 'high');
  assert.equal(inc.status, 'REPAIRING'); assert.equal(inc.confidence, 'MEDIUM'); assert.match(inc.rootCause, /5 times/); assert.match(inc.rootCause, /vcruntime140\.dll/);
  const log = inc.evidence.find((e: any) => e.type === 'EVENT_LOG'); assert.equal(log.value.total, 5); assert.equal(log.value.crashes[0].exceptionCode, 'c0000005'); assert.equal(log.value.crashes[0].module, 'vcruntime140.dll');
  assert.equal(inc.beforeMetrics.crashesInWindow, 5);
  assert.equal((await repairJobs(d.deviceId, 'office.quick-repair')).length, 1);

  // Office is open on the PC: the repair is deferred, nothing changed, the problem stays open and is retried at the next report
  await agentRuns(d, (await repairJobs(d.deviceId, 'office.quick-repair'))[0].id, 'completed', { deferred: true, report: { summary: 'Deferred: Office is open (outlook). Viro does not close applications.' } });
  inc = await outlook(a, d); assert.equal(inc.status, 'REPAIR_READY'); assert.ok(inc.evidence.some((e: any) => e.type === 'COMMAND_OUTPUT' && e.value.deferred));
  await health(d, FIVE());
  assert.equal((await repairJobs(d.deviceId, 'office.quick-repair')).length, 2, 'retried');
  assert.equal((await outlook(a, d)).status, 'REPAIRING');

  // the repair runs: that is not a resolution
  await agentRuns(d, (await repairJobs(d.deviceId, 'office.quick-repair'))[1].id, 'completed', { summary: 'Repaired and verified: Quick Repair finished', applied: true, verified: true });
  inc = await outlook(a, d); assert.equal(inc.status, 'VERIFYING'); assert.equal(inc.resolvedAt, null);

  // next report: none of the crashes happened after the repair, so the symptom is gone; now it is observed for a week
  await health(d, FIVE());
  inc = await outlook(a, d);
  assert.equal(inc.status, 'OBSERVING'); assert.equal(inc.verification.symptomGone, true); assert.equal(inc.afterMetrics.crashesSinceRepair, 0);
  assert.ok(new Date(inc.observationUntil).getTime() - new Date(inc.repairedAt).getTime() >= 7 * DAY - 60_000, 'a 7-day observation window');
  await health(d, FIVE()); assert.equal((await outlook(a, d)).status, 'OBSERVING', 'still inside the window');

  // window passes with no new crash: resolved, with measured before/after and a service record
  await h.db.query(`UPDATE incidents SET observation_until = now() - interval '1 minute' WHERE id=$1`, [inc.id]);
  await health(d, FIVE());
  inc = await outlook(a, d); assert.equal(inc.status, 'RESOLVED'); assert.equal(inc.resolution, 'viro-repair');
  assert.equal(inc.beforeMetrics.crashesInWindow, 5); assert.equal(inc.afterMetrics.crashesSinceRepair, 0);
  assert.equal((await h.db.query(`SELECT count(*)::int n FROM service_events WHERE device_id=$1 AND source='AUTOMATIC' AND service_type='major software repair'`, [d.deviceId])).rows[0].n, 1);

  // one new crash after a resolved repair is noise; two are a recurrence and the same incident reopens
  await health(d, [...FIVE(), crash('outlook.exe', 30_000 * -1)]);
  assert.equal((await outlook(a, d)).status, 'RESOLVED');
  await health(d, [...FIVE(), crash('outlook.exe', -30_000), crash('outlook.exe', -60_000)]);
  inc = await outlook(a, d); assert.notEqual(inc.status, 'RESOLVED'); assert.equal(inc.recurrenceCount, 1); assert.ok(inc.evidence.some((e: any) => e.type === 'RECURRENCE'));
  assert.equal((await h.db.query(`SELECT count(*)::int n FROM incidents WHERE device_id=$1 AND code='stability.app:outlook.exe'`, [d.deviceId])).rows[0].n, 1, 'reopened, not duplicated');
});

test('a crash after the repair while observing is a recurrence: the repair is not counted as a success', async () => {
  const a = await mkOrg('Stab Recur', 'o@stabrecur.test');
  const d = await enroll(a.auth, 'stab-dev-0002', 'RECUR-PC');
  await health(d, FIVE());
  await agentRuns(d, (await repairJobs(d.deviceId, 'office.quick-repair'))[0].id, 'completed', { summary: 'Repaired and verified: ok', applied: true, verified: true });
  await health(d, FIVE()); assert.equal((await outlook(a, d)).status, 'OBSERVING');
  await health(d, [...FIVE(), crash('outlook.exe', -30_000)]);
  const inc = await outlook(a, d);
  assert.ok(['IMPROVED', 'UNRESOLVED'].includes(inc.status), inc.status); assert.equal(inc.recurrenceCount, 1); assert.equal(inc.afterMetrics.crashesSinceRepair, 1);
  assert.ok(inc.evidence.some((e: any) => e.type === 'VERIFICATION' && e.value.symptomPresent === true));
  assert.equal(inc.resolvedAt, null);
});

test('crashes caused by a full disk are tied to it, not to the application, and Office is not "repaired" for them; unsupported applications get an honest answer', async () => {
  const a = await mkOrg('Stab Cause', 'o@stabcause.test');
  const d = await enroll(a.auth, 'stab-dev-0003', 'FULL-PC');
  await health(d, [], LOW);                                                            // history point: disk nearly full now
  await health(d, [10, 20, 30, 40].map(m => crash('winword.exe', m * MIN, `m${m}.dll`)), LOW);
  const inc = (await incs(a, d)).find(i => i.code === 'stability.app:winword.exe');
  assert.ok(inc); assert.equal(inc.confidence, 'HIGH'); assert.equal(inc.status, 'ROOT_CAUSE_CONFIRMED'); assert.match(inc.rootCause, /less than 2 GB free/);
  assert.ok(inc.evidence.some((e: any) => e.type === 'TELEMETRY' && e.value.cause === 'storage-pressure'));
  assert.equal((await repairJobs(d.deviceId, 'office.quick-repair')).length, 0, 'no application repair for a disk problem');
  assert.ok((await incs(a, d)).some(i => i.code === 'storage.system_low'), 'the real cause has its own incident');

  const d2 = await enroll(a.auth, 'stab-dev-0004', 'CONTOSO-PC');
  await health(d2, [1, 2, 3, 4].map(n => crash('contoso.exe', n * DAY, `m${n}.dll`)));
  const c = (await incs(a, d2)).find(i => i.code === 'stability.app:contoso.exe');
  assert.equal(c.confidence, 'LOW'); assert.equal(c.status, 'USER_ACTION_REQUIRED'); assert.match(c.recommendation, /no automatic repair for contoso\.exe/i);
  assert.equal((await jobsOf(d2.deviceId, 'repair.run')).length, 0);

  const d3 = await enroll(a.auth, 'stab-dev-0005', 'QUIET-PC');
  await health(d3, [...[1, 2].map(n => crash('outlook.exe', n * DAY)), ...[10, 11, 12, 13, 14].map(n => crash('old.exe', n * DAY))]);
  assert.equal((await incs(a, d3)).filter(i => i.code.startsWith('stability.')).length, 0);
});
