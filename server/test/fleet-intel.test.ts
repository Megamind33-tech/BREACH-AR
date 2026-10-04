import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { detectPatterns, minAffected, type DeviceFacts, type IncidentFacts } from '../src/fleet-intel.js';
import { groupSymptoms } from '../src/incident-routes.js';
import { fixRolloutTick } from '../src/fleet-routes.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54347); });
after(async () => { await h.stop(); });

const dev = (i: number, model: string, site = 'Ndola', os = '26100'): DeviceFacts => ({ id: `d${i}`, hostname: `PC-${i}`, model, manufacturer: 'Dell', osBuild: os, site, department: 'Finance', agentVersion: '0.1.0' });
const inc = (i: number, code: string, o: Partial<IncidentFacts> = {}): IncidentFacts => ({ id: `i${i}-${code}`, deviceId: `d${i}`, code, title: code, status: 'REPAIR_READY', impact: 'high', fix: null, recommendation: null, ...o });

test('pattern detection reports what the affected computers share only when they share it far more than the fleet does', () => {
  // 12 computers: 8 Latitudes and 4 OptiPlexes; the driver problem hits 6 Latitudes only
  const devices = [...Array.from({ length: 8 }, (_, i) => dev(i, 'Latitude 5420')), ...Array.from({ length: 4 }, (_, i) => dev(i + 8, 'OptiPlex 7010'))];
  const incidents = [0, 1, 2, 3, 4, 5].map(i => inc(i, 'drivers.device_error', { driverDevice: 'Realtek Wi-Fi 6' }));
  const p = detectPatterns(devices, incidents);
  assert.equal(p.length, 1); assert.equal(p[0].affected, 6); assert.equal(minAffected(12), 3);
  const model = p[0].factors.find(f => f.factor === 'model')!; assert.equal(model.value, 'Latitude 5420'); assert.equal(model.affectedShare, 1); assert.equal(model.fleetShare, 0.67);
  assert.ok(model.lift >= 1.4 && model.lift < 2, 'the Latitude is common in the fleet too, so the lift is modest');
  assert.ok(p[0].factors.some(f => f.factor === 'driverDevice' && f.value === 'Realtek Wi-Fi 6'));
  assert.match(p[0].explanation, /6 of 12 computers/);

  // "everyone runs the same Windows build" is not a finding
  const uniform = detectPatterns(devices, [0, 1, 2, 3].map(i => inc(i, 'perf.startup_heavy')));
  assert.ok(!uniform[0].factors.some(f => f.factor === 'osBuild'), 'a factor shared by the whole fleet has no lift');

  // strong concentration on a rare model: HIGH confidence
  const rare = [...Array.from({ length: 10 }, (_, i) => dev(i, 'Latitude 5420')), ...Array.from({ length: 6 }, (_, i) => dev(i + 10, 'ThinkPad E14'))];
  const hi = detectPatterns(rare, [10, 11, 12, 13, 14, 15].map(i => inc(i, 'stability.app:outlook.exe', { appVersion: '16.0.1', module: 'mso.dll', cause: 'faulting-module' })));
  assert.equal(hi[0].confidence, 'HIGH'); assert.equal(hi[0].factors[0].factor === 'model' || hi[0].factors[0].lift >= 2, true);

  // too few computers, or resolved incidents, or unrelated codes: no pattern; scattered problem: reported, LOW confidence
  assert.equal(detectPatterns(devices, [0, 1].map(i => inc(i, 'x'))).length, 0);
  assert.equal(detectPatterns(devices, [0, 1, 2, 3].map(i => inc(i, 'x', { status: 'RESOLVED' }))).length, 0);
  const scattered = detectPatterns([...devices.slice(0, 4).map((d, i) => ({ ...d, model: `Model ${i}`, site: `Site ${i}`, osBuild: `b${i}`, department: `Dep ${i}` })), ...devices.slice(4)], [0, 1, 2, 3].map(i => inc(i, 'perf.service_failed')));
  assert.equal(scattered[0].confidence, 'LOW'); assert.match(scattered[0].explanation, /no single shared factor/);
  const fix = { jobType: 'repair.run', params: { recipe: 'office.quick-repair' }, label: 'Repair Office' };
  assert.deepEqual(detectPatterns(devices, [0, 1, 2].map(i => inc(i, 'stability.app:outlook.exe', { fix })))[0].fix, fix);
  assert.equal(detectPatterns(devices, [0, 1, 2].map(i => inc(i, 'stability.app:outlook.exe', { fix: i === 0 ? fix : null })))[0].fix, null, 'no common fix, no bulk repair');
});

test('one root problem, its symptoms underneath; evidence-linked or merely coinciding, and said so', () => {
  const g = groupSymptoms([
    { id: 'root', code: 'storage.system_low', status: 'REPAIRING' },
    { id: 'a', code: 'stability.app:outlook.exe', status: 'REPAIR_READY', evidence: [{ type: 'TELEMETRY', value: { cause: 'storage-pressure' } }] },
    { id: 'b', code: 'updates.search_stuck', status: 'DETECTED' },
    { id: 'c', code: 'stability.app:winword.exe', status: 'REPAIR_READY', evidence: [{ type: 'TELEMETRY', value: { cause: 'faulting-module' } }] },
    { id: 'd', code: 'updates.stale', status: 'RESOLVED' },
  ]);
  assert.equal(g.length, 1); assert.equal(g[0].root, 'root');
  assert.deepEqual(g[0].symptoms.map(s => `${s.id}:${s.basis}`).sort(), ['a:evidence', 'b:coincides']);
  assert.deepEqual(groupSymptoms([{ id: 'a', code: 'updates.search_stuck', status: 'DETECTED' }]), [], 'no root problem, no grouping');
});

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });
async function mkOrg(name: string, email: string, autopilot = true) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function enroll(auth: Hdr, guid: string, hostname: string, siteId?: string) {
  const t = await post('/api/v1/enrollment-tokens', siteId ? { siteId } : {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
type Dev = Awaited<ReturnType<typeof enroll>>;
const GB = 2 ** 30, DAY = 86_400_000;
const crash = (msAgo: number) => ({ app: 'outlook.exe', kind: 'crash', appVersion: '16.0.18000', module: 'mso.dll', moduleVersion: '16.0', exceptionCode: 'c0000005', at: new Date(Date.now() - msAgo).toISOString() });
const FIVE = () => [1, 1.5, 2, 2.5, 3].map(n => crash(n * DAY));
const inventory = (d: Dev, model: string) => put('/agent/v1/inventory', { collectedAt: new Date().toISOString(), hardware: { manufacturer: 'Dell', model }, software: [] }, d.dev);
const beat = (d: Dev, name: string) => post('/agent/v1/heartbeat', { hostname: name, agentVersion: '0.1.0', metrics: {} }, d.dev);
const health = (d: Dev, crashes: object[] = FIVE()) => put('/agent/v1/health', { collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }], stability: { windowDays: 14, crashes, recentChanges: [] } }, d.dev);
async function agentRuns(d: Dev, jobId: string, status: 'completed' | 'failed', result?: unknown) {
  assert.equal((await post(`/agent/v1/jobs/${jobId}/start`, {}, d.dev)).statusCode, 200);
  assert.equal((await post(`/agent/v1/jobs/${jobId}/result`, { status, result }, d.dev)).statusCode, 200);
}
const officeJob = async (d: Dev) => (await h.db.query(`SELECT id, status FROM jobs WHERE device_id=$1 AND type='repair.run' AND params->>'recipe'='office.quick-repair' ORDER BY created_at DESC`, [d.deviceId])).rows;

test('a fleet-wide Outlook problem is found, repaired on one computer, then a pilot, then everyone, each step verified by the symptom being gone; a failing pilot halts and flags it', async () => {
  const a = await mkOrg('Fleet Org', 'o@fleet.test', false);          // manual: nothing repairs until the administrator starts the rollout
  const site = (await post('/api/v1/sites', { name: 'Ndola branch' }, a.auth)).json();
  const names = Array.from({ length: 10 }, (_, i) => `NDOLA-${String(i + 1).padStart(2, '0')}`);
  const devs: Dev[] = [];
  for (const [i, n] of names.entries()) { const d = await enroll(a.auth, `fleet-dev-${String(i).padStart(4, '0')}`, n, site.id); devs.push(d); await inventory(d, i < 7 ? 'OptiPlex 7010' : 'Latitude 5420'); await beat(d, n); }
  for (const d of devs.slice(0, 7)) await health(d);                   // 7 OptiPlexes crash Outlook
  for (const d of devs.slice(7)) await health(d, []);

  const pats = (await get('/api/v1/fleet/patterns', a.auth)).json().patterns;
  const p = pats.find((x: any) => x.code === 'stability.app:outlook.exe'); assert.ok(p, JSON.stringify(pats.map((x: any) => x.code)));
  assert.equal(p.affected, 7); assert.equal(p.fleetSize, 10); assert.ok(p.factors.some((f: any) => f.factor === 'model' && f.value === 'OptiPlex 7010')); assert.equal(p.fix.params.recipe, 'office.quick-repair'); assert.equal(p.status, 'DETECTED');
  const bd = (await get('/api/v1/fleet/breakdown?by=model', a.auth)).json().groups; assert.equal(bd[0].group, 'OptiPlex 7010'); assert.equal(bd[0].withProblems, 7); assert.equal(bd[0].devices, 7);
  assert.equal((await get('/api/v1/fleet/breakdown?by=site', a.auth)).json().groups[0].group, 'Ndola branch');
  assert.equal((await post(`/api/v1/fleet/patterns/${p.id}/remediate`, {}, {})).statusCode, 401);

  // stage 1: exactly one computer is repaired first
  const r = await post(`/api/v1/fleet/patterns/${p.id}/remediate`, {}, a.auth); assert.equal(r.statusCode, 201);
  const rid = r.json().id;
  let ro = (await get(`/api/v1/fix-rollouts/${rid}`, a.auth)).json(); assert.equal(ro.stage, 'test'); assert.equal(ro.devices.length, 1);
  assert.equal((await post(`/api/v1/fleet/patterns/${p.id}/remediate`, {}, a.auth)).statusCode, 409, 'one rollout at a time');
  assert.equal((await post(`/api/v1/fix-rollouts/${rid}/advance`, { stage: 'pilot' }, a.auth)).statusCode, 409, 'the test computer is not verified yet');
  const testDev = devs.find(d => d.deviceId === ro.devices[0].device_id)!;
  await agentRuns(testDev, (await officeJob(testDev))[0].id, 'completed', { summary: 'Repaired and verified: ok', applied: true, verified: true });
  await fixRolloutTick(h.db, h.signer);
  assert.equal((await get(`/api/v1/fix-rollouts/${rid}`, a.auth)).json().devices[0].status, 'installed', 'the repair ran, but that is not verification');
  await health(testDev);                                                  // none of the crashes happened after the repair
  await fixRolloutTick(h.db, h.signer);
  assert.equal((await get(`/api/v1/fix-rollouts/${rid}`, a.auth)).json().devices[0].status, 'verified');

  // stage 2: a pilot of the rest (min 2), started by the administrator
  const adv = await post(`/api/v1/fix-rollouts/${rid}/advance`, { stage: 'pilot' }, a.auth); assert.equal(adv.statusCode, 200); assert.equal(adv.json().devices, 2);
  ro = (await get(`/api/v1/fix-rollouts/${rid}`, a.auth)).json(); const pilot = ro.devices.filter((x: any) => x.stage === 'pilot').map((x: any) => devs.find(d => d.deviceId === x.device_id)!);
  assert.equal((await post(`/api/v1/fix-rollouts/${rid}/advance`, { stage: 'fleet' }, a.auth)).statusCode, 409, 'the pilot is not verified yet');

  // pilot computer 1 is fixed; pilot computer 2 still crashes after the repair: the whole rollout halts and nothing else is touched
  await agentRuns(pilot[0], (await officeJob(pilot[0]))[0].id, 'completed', { summary: 'Repaired and verified: ok' });
  await agentRuns(pilot[1], (await officeJob(pilot[1]))[0].id, 'completed', { summary: 'Repaired and verified: ok' });
  await health(pilot[0]); await health(pilot[1], [...FIVE(), crash(-30_000)]);       // a new crash on the second computer after its repair
  await fixRolloutTick(h.db, h.signer);
  await health(pilot[1], [...FIVE(), crash(-30_000), crash(-40_000)]);
  await fixRolloutTick(h.db, h.signer);
  ro = (await get(`/api/v1/fix-rollouts/${rid}`, a.auth)).json();
  assert.equal(ro.status, 'halted', JSON.stringify(ro)); assert.match(ro.haltReason, /did not fix/);
  assert.equal(ro.devices.filter((x: any) => x.status === 'verified').length, 2);
  const untouched = devs.slice(0, 7).filter(d => ![testDev, ...pilot].some(x => x.deviceId === d.deviceId));
  for (const d of untouched) assert.equal((await officeJob(d)).length, 0, 'the rest of the fleet never received the repair');
  assert.equal((await get('/api/v1/fleet/patterns', a.auth)).json().patterns.find((x: any) => x.code === 'stability.app:outlook.exe').status, 'FLAGGED');
  assert.equal((await post(`/api/v1/fix-rollouts/${rid}/advance`, { stage: 'fleet' }, a.auth)).statusCode, 409, 'a halted rollout never advances');
  assert.ok((await get('/api/v1/audit', a.auth)).json().entries.some((e: any) => e.action === 'fix_rollout.start'));
  const other = await mkOrg('Fleet Other', 'o@fleet-other.test'); assert.deepEqual((await get('/api/v1/fleet/patterns', other.auth)).json().patterns, []); assert.equal((await get(`/api/v1/fix-rollouts/${rid}`, other.auth)).statusCode, 404);
});

test('with Autopilot a verified stage widens by itself, a fully verified fleet completes the rollout, and the KPIs come only from recorded events', async () => {
  const a = await mkOrg('Fleet Auto', 'o@fleetauto.test');
  const devs: Dev[] = [];
  for (let i = 0; i < 4; i++) { const d = await enroll(a.auth, `fauto-dev-000${i}`, `AUTO-${i}`); devs.push(d); await inventory(d, 'OptiPlex 7010'); await beat(d, `AUTO-${i}`); }
  for (const d of devs.slice(0, 3)) await health(d);
  // Autopilot's own Level-2 repair already started on the three affected computers; move them back to "ready" so the fleet rollout owns the repair
  await h.db.query(`UPDATE jobs SET status='cancelled', finished_at=now(), error='test' WHERE device_id = ANY($1::uuid[]) AND type='repair.run' AND status='queued'`, [devs.map(d => d.deviceId)]);
  await h.db.query(`UPDATE incidents SET status='REPAIR_READY' WHERE org_id=$1 AND code='stability.app:outlook.exe'`, [a.orgId]);
  const p = (await get('/api/v1/fleet/patterns', a.auth)).json().patterns[0]; assert.equal(p.affected, 3);
  const rid = (await post(`/api/v1/fleet/patterns/${p.id}/remediate`, {}, a.auth)).json().id;
  const step = async () => { await fixRolloutTick(h.db, h.signer); return (await get(`/api/v1/fix-rollouts/${rid}`, a.auth)).json(); };
  const repairAndVerify = async (ds: Dev[]) => { for (const d of ds) { await agentRuns(d, (await officeJob(d))[0].id, 'completed', { summary: 'Repaired and verified: ok' }); } for (const d of ds) await health(d); };
  let ro = await step(); const first = devs.find(d => d.deviceId === ro.devices[0].device_id)!;
  await repairAndVerify([first]); ro = await step();
  assert.equal(ro.stage, 'pilot', 'Autopilot advanced the verified test stage to the pilot on its own');
  const pilotDevs = ro.devices.filter((x: any) => x.stage === 'pilot').map((x: any) => devs.find(d => d.deviceId === x.device_id)!);
  await repairAndVerify(pilotDevs); ro = await step();
  assert.ok(ro.status === 'completed' || ro.stage === 'fleet', JSON.stringify(ro));
  ro = await step(); assert.equal(ro.status, 'completed');
  assert.equal((await get('/api/v1/fleet/patterns', a.auth)).json().patterns.find((x: any) => x.code === 'stability.app:outlook.exe')?.status ?? 'REMEDIATED', 'REMEDIATED');
  assert.ok((await h.db.query(`SELECT 1 FROM audit_log WHERE org_id=$1 AND action='fix_rollout.advance' AND next->>'by'='autopilot'`, [a.orgId])).rowCount);

  // KPIs: no denominators, no invented numbers
  const empty = await mkOrg('Fleet Empty', 'o@fleetempty.test');
  const k0 = (await get('/api/v1/outcomes', empty.auth)).json().kpis; assert.equal(k0.verifiedFixRate, null); assert.equal(k0.recurrenceRate, null); assert.equal(k0.meanTimeToHealthHours, null); assert.equal(k0.automaticResolutionRate, null);
  await h.db.query(`UPDATE incidents SET status='RESOLVED', resolution='viro-repair', resolved_at=now(), first_detected = now() - interval '5 hours' WHERE org_id=$1 AND repaired_at IS NOT NULL`, [a.orgId]);
  const k = (await get('/api/v1/outcomes', a.auth)).json().kpis;
  assert.ok(k.repairAttempts >= 3 && k.verifiedFixes >= 3); assert.equal(k.verifiedFixRate, 100); assert.ok(k.meanTimeToHealthHours >= 4.9 && k.meanTimeToHealthHours <= 5.2); assert.equal(k.recurrenceRate, 0);
});
