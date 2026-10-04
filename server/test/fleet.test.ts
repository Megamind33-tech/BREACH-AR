import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { hashPassword } from '../src/security.js';
import { inWindow, isDue, lastWeeklyOccurrence, schedulerTick, validateSettings, type ScheduleT } from '../src/policies.js';
import { offlineSweep } from '../src/alerts.js';
import { csvCell } from '../src/reports.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54331); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const patch = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PATCH', url, payload: payload as any, headers });
const del = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'DELETE', url, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });

async function mkOrg(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function mkUser(orgId: string, email: string, role: string) {
  await h.db.query('INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,$2,$3,$4)', [orgId, email, await hashPassword('another long password'), role]);
  return { authorization: `Bearer ${(await post('/api/v1/auth/login', { email, password: 'another long password' })).json().token}` } as Hdr;
}
async function enroll(auth: Hdr, guid: string, hostname = guid, siteId?: string) {
  const t = await post('/api/v1/enrollment-tokens', siteId ? { siteId } : {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
const GB = 2 ** 30;
const health = (d: { dev: Hdr }, over: object = {}) => h.app.inject({ method: 'PUT', url: '/agent/v1/health', headers: d.dev, payload: { collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }], ...over } });
const openJobs = async (deviceId: string, type?: string) => (await h.db.query(`SELECT type, params, status FROM jobs WHERE device_id=$1 AND status IN ('queued','running') ${type ? 'AND type=$2' : ''}`, type ? [deviceId, type] : [deviceId])).rows;

// ------------------------------------------------------------------------------------------ pure time logic
test('maintenance window: same-day, out-of-window, other day, and windows that wrap past midnight', () => {
  const w = { days: [0], start: '02:00', end: '06:00' };                    // Sundays 02:00-06:00
  assert.ok(inWindow(new Date('2026-10-04T03:00:00Z'), 0, w));              // Sunday 03:00
  assert.ok(!inWindow(new Date('2026-10-04T07:00:00Z'), 0, w));
  assert.ok(!inWindow(new Date('2026-10-05T03:00:00Z'), 0, w));             // Monday
  assert.ok(!inWindow(new Date('2026-10-03T22:00:00Z'), 0, w));
  assert.ok(inWindow(new Date('2026-10-03T22:00:00Z'), 240, w), 'Saturday 22:00 UTC is Sunday 02:00 at UTC+4');
  const wrap = { days: [5], start: '22:00', end: '04:00' };                 // Friday night into Saturday
  assert.ok(inWindow(new Date('2026-10-02T23:00:00Z'), 0, wrap));           // Fri 23:00
  assert.ok(inWindow(new Date('2026-10-03T03:00:00Z'), 0, wrap));           // Sat 03:00 belongs to Friday's window
  assert.ok(!inWindow(new Date('2026-10-03T05:00:00Z'), 0, wrap));
  assert.ok(!inWindow(new Date('2026-10-02T03:00:00Z'), 0, wrap), 'Fri 03:00 belongs to Thursday');
  assert.ok(inWindow(new Date(), 0, undefined), 'no window means always allowed');
});

test('weekly occurrence and due logic (no retroactive runs for a new policy)', () => {
  const sat = new Date('2026-10-03T10:00:00Z');                             // a Saturday
  assert.equal(lastWeeklyOccurrence(sat, 0, [5], '18:00')!.toISOString(), '2026-10-02T18:00:00.000Z');
  assert.equal(lastWeeklyOccurrence(sat, 120, [5], '18:00')!.toISOString(), '2026-10-02T16:00:00.000Z');
  const weekly: ScheduleT = { key: 'w', type: 'health.check', params: {}, weekly: { days: [5], time: '18:00' } };
  const created = new Date('2026-10-03T09:00:00Z');
  assert.ok(!isDue(weekly, null, created, sat, 0), 'the Friday before the policy existed must not fire');
  assert.ok(isDue(weekly, null, created, new Date('2026-10-09T18:01:00Z'), 0));
  assert.ok(!isDue(weekly, new Date('2026-10-09T18:02:00Z'), created, new Date('2026-10-09T19:00:00Z'), 0), 'already ran for this occurrence');
  assert.ok(isDue(weekly, new Date('2026-10-09T18:02:00Z'), created, new Date('2026-10-16T18:30:00Z'), 0), 'next week');
  const every: ScheduleT = { key: 'e', type: 'health.check', params: {}, everyMinutes: 30 };
  assert.ok(isDue(every, null, created, sat, 0));
  assert.ok(!isDue(every, new Date(sat.getTime() - 29 * 60_000), created, sat, 0));
  assert.ok(isDue(every, new Date(sat.getTime() - 30 * 60_000), created, sat, 0));
});

test('policy settings validation: only catalogued jobs with valid params, approvals included', () => {
  const ok = (s: unknown) => validateSettings(s).ok;
  assert.ok(ok({ schedules: [{ key: 'a', type: 'health.check', everyMinutes: 30 }] }));
  assert.ok(!ok({ schedules: [{ key: 'a', type: 'rm.all', everyMinutes: 30 }] }), 'unknown job type');
  assert.ok(!ok({ schedules: [{ key: 'a', type: 'repair.rollback', params: { repairId: '11111111-1111-4111-8111-111111111111' }, everyMinutes: 30 }] }), 'rollback is never scheduled');
  assert.ok(!ok({ schedules: [{ key: 'a', type: 'repair.run', params: { recipe: 'windows.update-reset' }, everyMinutes: 60 }] }), 'review recipe needs approved:true, even in a policy');
  assert.ok(ok({ schedules: [{ key: 'a', type: 'repair.run', params: { recipe: 'windows.update-reset', approved: true }, weekly: { days: [0], time: '03:00' } }] }));
  assert.ok(!ok({ schedules: [{ key: 'a', type: 'health.check', everyMinutes: 30 }, { key: 'a', type: 'inventory.refresh', everyMinutes: 30 }] }), 'duplicate keys');
  assert.ok(!ok({ schedules: [{ key: 'a', type: 'health.check', everyMinutes: 30, weekly: { days: [1], time: '01:00' } }] }), 'both cadences');
  assert.ok(!ok({ schedules: [{ key: 'a', type: 'health.check' }] }), 'no cadence');
  assert.ok(!ok({ schedules: [{ key: 'a', type: 'health.check', everyMinutes: 1 }] }), 'too frequent');
  assert.ok(!ok({ schedules: [{ key: 'A B', type: 'health.check', everyMinutes: 30 }] }));
  assert.ok(!ok({ maintenanceWindow: { days: [7], start: '02:00', end: '06:00' } }));
  assert.ok(!ok({ maintenanceWindow: { days: [1], start: '25:00', end: '06:00' } }));
  assert.ok(!ok({ surprise: true }));
});

test('CSV cells cannot smuggle spreadsheet formulas', () => {
  assert.equal(csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
  assert.equal(csvCell('+1'), "'+1"); assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)"); assert.equal(csvCell('-2'), "'-2");
  assert.equal(csvCell('a,b'), '"a,b"'); assert.equal(csvCell(null), ''); assert.equal(csvCell(42), '42');
});

// ------------------------------------------------------------------------------------------ policies + scheduler
test('policy CRUD is admin-only, validated, audited and tenant-isolated', async () => {
  const a = await mkOrg('Pol Org', 'o@pol.test'), b = await mkOrg('Pol Other', 'o@pol-other.test');
  const tech = await mkUser(a.orgId, 't@pol.test', 'technician');
  const body = { name: 'Baseline', scope: { type: 'org' }, settings: { schedules: [{ key: 'health', type: 'health.check', everyMinutes: 30 }] } };
  assert.equal((await post('/api/v1/policies', body, tech)).statusCode, 403);
  assert.equal((await post('/api/v1/policies', { ...body, settings: { schedules: [{ key: 'x', type: 'nope', everyMinutes: 30 }] } }, a.auth)).statusCode, 400);
  assert.equal((await post('/api/v1/policies', { ...body, scope: { type: 'site', id: '00000000-0000-4000-8000-000000000000' } }, a.auth)).statusCode, 400);
  const created = await post('/api/v1/policies', body, a.auth); assert.equal(created.statusCode, 201);
  assert.equal((await post('/api/v1/policies', body, a.auth)).statusCode, 409, 'duplicate name');
  const id = created.json().id;
  assert.equal((await get('/api/v1/policies', b.auth)).json().policies.length, 0);
  assert.equal((await patch(`/api/v1/policies/${id}`, { enabled: false }, b.auth)).statusCode, 404);
  assert.equal((await del(`/api/v1/policies/${id}`, b.auth)).statusCode, 404);
  assert.equal((await patch(`/api/v1/policies/${id}`, { enabled: false }, a.auth)).json().enabled, false);
  const audit = (await get('/api/v1/audit', a.auth)).json().entries.map((e: any) => e.action);
  assert.ok(audit.includes('policy.create') && audit.includes('policy.update'));
  assert.equal((await get('/api/v1/policy-templates', a.auth)).json().templates.length, 2);
  for (const t of (await get('/api/v1/policy-templates', a.auth)).json().templates) assert.ok(validateSettings(t.settings).ok, `template ${t.id} must be valid`);
  assert.equal((await del(`/api/v1/policies/${id}`, a.auth)).statusCode, 200);
});

test('scheduler: creates signed jobs for in-scope devices only, never piles up, respects cadence, windows and enabled flag', async () => {
  const a = await mkOrg('Sched Org', 'o@sched.test');
  const d1 = await enroll(a.auth, 'sched-dev-0001'), d2 = await enroll(a.auth, 'sched-dev-0002'), d3 = await enroll(a.auth, 'sched-dev-0003');
  await post('/api/v1/devices/assign', { deviceIds: [d1.deviceId, d2.deviceId], addTags: ['finance'] }, a.auth);
  const pol = (await post('/api/v1/policies', { name: 'Finance', scope: { type: 'tag', tag: 'finance' }, settings: { schedules: [{ key: 'health', type: 'health.check', everyMinutes: 30 }] } }, a.auth)).json();
  const t0 = new Date();
  assert.equal(await schedulerTick(h.db, h.signer, t0), 2, 'only the two tagged devices');
  assert.equal((await openJobs(d3.deviceId)).length, 0);
  const job = (await h.db.query(`SELECT payload, signature, created_by FROM jobs WHERE device_id=$1`, [d1.deviceId])).rows[0];
  assert.ok(h.signer.verify(job.payload, job.signature)); assert.equal(job.created_by, null);
  assert.equal(await schedulerTick(h.db, h.signer, new Date(t0.getTime() + 60_000)), 0, 'open job exists');
  await h.db.query(`UPDATE jobs SET status='completed', finished_at=now() WHERE device_id = ANY($1::uuid[])`, [[d1.deviceId, d2.deviceId]]);
  assert.equal(await schedulerTick(h.db, h.signer, new Date(t0.getTime() + 10 * 60_000)), 0, 'not due yet (30 min cadence)');
  assert.equal(await schedulerTick(h.db, h.signer, new Date(t0.getTime() + 31 * 60_000)), 2, 'due again');
  await h.db.query(`UPDATE jobs SET status='completed', finished_at=now() WHERE device_id = ANY($1::uuid[])`, [[d1.deviceId, d2.deviceId]]);
  await patch(`/api/v1/policies/${pol.id}`, { enabled: false }, a.auth);
  assert.equal(await schedulerTick(h.db, h.signer, new Date(t0.getTime() + 120 * 60_000)), 0, 'disabled policy does nothing');
  const audit = (await h.db.query(`SELECT count(*)::int n FROM audit_log WHERE org_id=$1 AND actor_type='system' AND action='job.create'`, [a.orgId])).rows[0].n;
  assert.equal(audit, 4, 'every scheduled job is audited');
});

test('scheduler: weekly schedules fire once per occurrence, maintenance-window schedules wait for the window', async () => {
  const a = await mkOrg('Window Org', 'o@window.test');
  const d = await enroll(a.auth, 'window-dev-0001');
  await post('/api/v1/policies', { name: 'Nightly', scope: { type: 'org' }, settings: {
    schedules: [{ key: 'clean', type: 'repair.run', params: { recipe: 'cleanup.safe' }, weekly: { days: [5], time: '18:00' } }, { key: 'inv', type: 'inventory.refresh', everyMinutes: 60, windowOnly: true }],
    maintenanceWindow: { days: [0], start: '02:00', end: '06:00' } } }, a.auth);
  await h.db.query(`UPDATE policies SET created_at = '2026-09-01T00:00:00Z'`);   // policy has existed for weeks
  const fri = new Date('2026-10-02T18:05:00Z');                                  // Friday just after 18:00
  assert.equal(await schedulerTick(h.db, h.signer, fri), 1);
  assert.equal((await openJobs(d.deviceId))[0].type, 'repair.run');
  await h.db.query(`UPDATE jobs SET status='completed', finished_at=now()`);
  assert.equal(await schedulerTick(h.db, h.signer, new Date('2026-10-02T19:00:00Z')), 0, 'same occurrence never runs twice');
  assert.equal(await schedulerTick(h.db, h.signer, new Date('2026-10-04T03:00:00Z')), 1, 'Sunday 03:00 is inside the window: inventory runs');
  assert.equal((await openJobs(d.deviceId))[0].type, 'inventory.refresh');
});

test('policy auto-repair reacts to health findings once per cooldown, and only where a policy asks for it', async () => {
  const a = await mkOrg('Auto Org', 'o@auto.test');
  const d = await enroll(a.auth, 'auto-dev-0001');
  const sick = { failedServices: [{ name: 'Foo', exitCode: 1 }], volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 4 * GB, isSystem: true }] };
  await health(d, sick);
  assert.equal((await openJobs(d.deviceId)).length, 0, 'no policy, no automatic repair');
  await post('/api/v1/policies', { name: 'Auto', scope: { type: 'org' }, settings: { autoRepair: { failedServices: true, safeCleanup: true } } }, a.auth);
  await health(d, sick);
  const jobs = await openJobs(d.deviceId);
  assert.deepEqual(jobs.map(j => j.type).sort(), ['cleanup.run', 'repair.run']);
  assert.deepEqual(jobs.find(j => j.type === 'repair.run')!.params, { recipe: 'services.restart-failed' });
  assert.ok((jobs.find(j => j.type === 'cleanup.run')!.params.categories as string[]).every(c => !['recycle-bin', 'windows-old'].includes(c)), 'automatic cleanup is SAFE-only');
  await h.db.query(`UPDATE jobs SET status='completed', finished_at=now()`);
  await health(d, sick);
  assert.equal((await openJobs(d.deviceId)).length, 0, 'cooldown prevents a repair loop');
  await health(d, {});   // healthy report: nothing to react to
  assert.equal((await openJobs(d.deviceId)).length, 0);
});

// ------------------------------------------------------------------------------------------ alerts
test('alerts open and resolve with the underlying finding; offline devices alert; acknowledge is audited; isolated per org', async () => {
  const a = await mkOrg('Alert Org', 'o@alert.test'), b = await mkOrg('Alert Other', 'o@alert-other.test');
  const d = await enroll(a.auth, 'alert-dev-0001', 'ALERT-PC'); await enroll(b.auth, 'alert-dev-0002');
  await health(d, { volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 3 * GB, isSystem: true }], defender: { antivirusEnabled: false }, avProducts: [] });
  let al = (await get('/api/v1/alerts', a.auth)).json();
  const codes = al.alerts.map((x: any) => x.code);
  assert.ok(codes.includes('storage.system_low') && codes.includes('security.av_off'));
  assert.equal(al.alerts.find((x: any) => x.code === 'security.av_off').severity, 'critical');
  assert.equal(al.alerts.find((x: any) => x.code === 'storage.system_low').severity, 'warning');
  assert.equal(al.alerts[0].severity, 'critical', 'critical first');
  assert.equal((await get('/api/v1/alerts', b.auth)).json().alerts.length, 0);
  const id = al.alerts[0].id;
  assert.equal((await post(`/api/v1/alerts/${id}/ack`, {}, b.auth)).statusCode, 404);
  assert.equal((await post(`/api/v1/alerts/${id}/ack`, {}, a.auth)).statusCode, 200);
  assert.ok((await get('/api/v1/audit', a.auth)).json().entries.some((e: any) => e.action === 'alert.acknowledge'));

  await health(d, { defender: { antivirusEnabled: true, realTimeProtection: true, signatureAgeDays: 0 }, avProducts: ['Windows Defender'] });   // fixed: disk 300 GB free, AV on
  al = (await get('/api/v1/alerts?status=open', a.auth)).json(); assert.equal(al.alerts.length, 0, 'resolved automatically');
  assert.ok((await get('/api/v1/alerts?status=resolved', a.auth)).json().alerts.length >= 2);

  await h.db.query(`UPDATE devices SET last_seen_at = now() - interval '30 minutes' WHERE id=$1`, [d.deviceId]);
  await offlineSweep(h.db, 15);
  assert.ok((await get('/api/v1/alerts', a.auth)).json().alerts.some((x: any) => x.code === 'device.offline' && /ALERT-PC/.test(x.message)));
  await h.app.inject({ method: 'POST', url: '/agent/v1/heartbeat', headers: d.dev, payload: { hostname: 'ALERT-PC', agentVersion: '1', metrics: {} } });
  await offlineSweep(h.db, 15);
  assert.ok(!(await get('/api/v1/alerts', a.auth)).json().alerts.some((x: any) => x.code === 'device.offline'), 'back online resolves it');
  assert.equal((await get('/api/v1/overview', a.auth)).json().alerts.critical ?? 0, 0);
});

test('a completed hardware diagnosis raises a critical alert immediately', async () => {
  const a = await mkOrg('HwAlert Org', 'o@hwalert.test');
  const d = await enroll(a.auth, 'hwalert-dev-01');
  await health(d, {});
  const id = (await post('/api/v1/jobs', { type: 'hardware.diagnose', target: { deviceIds: [d.deviceId] } }, a.auth)).json().jobs[0].id;
  await post(`/agent/v1/jobs/${id}/start`, {}, d.dev);
  await post(`/agent/v1/jobs/${id}/result`, { status: 'completed', result: { storage: { disks: [{ model: 'SSD', health: 'Healthy', reliability: { readErrorsUncorrected: 4 } }] } } }, d.dev);
  const al = (await get('/api/v1/alerts', a.auth)).json().alerts;
  assert.ok(al.some((x: any) => x.code === 'hw.storage.uncorrectable' && x.severity === 'critical'));
});

// ------------------------------------------------------------------------------------------ fleet management
test('sites, departments, tags and bulk assignment; filters; isolation', async () => {
  const a = await mkOrg('Fleet Org', 'o@fleet.test'), b = await mkOrg('Fleet Other', 'o@fleet-other.test');
  const hq = (await post('/api/v1/sites', { name: 'HQ' }, a.auth)).json(), br = (await post('/api/v1/sites', { name: 'Branch' }, a.auth)).json();
  const fin = (await post('/api/v1/departments', { siteId: hq.id, name: 'Finance' }, a.auth)).json(), ops = (await post('/api/v1/departments', { siteId: br.id, name: 'Ops' }, a.auth)).json();
  const foreign = (await post('/api/v1/sites', { name: 'Foreign' }, b.auth)).json();
  const d1 = await enroll(a.auth, 'fleet-dev-0001', 'ACC-PC-01'), d2 = await enroll(a.auth, 'fleet-dev-0002', 'ACC-PC-02'), d3 = await enroll(a.auth, 'fleet-dev-0003', 'OPS-PC-01');
  const db_ = await enroll(b.auth, 'fleet-dev-0004', 'OTHER-PC');
  assert.equal((await post('/api/v1/devices/assign', { deviceIds: [d1.deviceId, d2.deviceId], siteId: hq.id, departmentId: fin.id, addTags: ['finance', 'critical'] }, a.auth)).json().updated, 2);
  assert.equal((await post('/api/v1/devices/assign', { deviceIds: [d3.deviceId], siteId: br.id, departmentId: ops.id }, a.auth)).statusCode, 200);
  assert.equal((await post('/api/v1/devices/assign', { deviceIds: [d3.deviceId], siteId: foreign.id }, a.auth)).statusCode, 404, 'other org site');
  assert.equal((await post('/api/v1/devices/assign', { deviceIds: [db_.deviceId], siteId: hq.id }, a.auth)).statusCode, 404, 'other org device');
  assert.equal((await post('/api/v1/devices/assign', { deviceIds: [d3.deviceId], siteId: hq.id, departmentId: ops.id }, a.auth)).statusCode, 400, 'department must belong to the site');
  assert.equal((await post('/api/v1/devices/assign', { deviceIds: [d3.deviceId] }, a.auth)).statusCode, 400, 'nothing to change');
  assert.equal((await post('/api/v1/devices/assign', { deviceIds: [d3.deviceId], addTags: ['bad tag;drop'] }, a.auth)).statusCode, 400);
  const list = async (q: string) => (await get('/api/v1/devices' + q, a.auth)).json().devices.map((d: any) => d.hostname);
  assert.deepEqual(await list(`?siteId=${hq.id}`), ['ACC-PC-01', 'ACC-PC-02']);
  assert.deepEqual(await list(`?departmentId=${ops.id}`), ['OPS-PC-01']);
  assert.deepEqual(await list('?tag=finance'), ['ACC-PC-01', 'ACC-PC-02']);
  assert.deepEqual(await list('?q=ops'), ['OPS-PC-01']);
  assert.deepEqual(await list('?q=%25'), [], 'LIKE wildcards are escaped');
  assert.deepEqual((await get('/api/v1/tags', a.auth)).json().tags, [{ tag: 'critical', devices: 2 }, { tag: 'finance', devices: 2 }]);
  // single-device patch: replace tags, and moving site clears the department
  await patch(`/api/v1/devices/${d1.deviceId}`, { tags: ['finance'] }, a.auth);
  assert.deepEqual((await get(`/api/v1/devices/${d1.deviceId}`, a.auth)).json().tags, ['finance']);
  await patch(`/api/v1/devices/${d1.deviceId}`, { siteId: br.id }, a.auth);
  const moved = (await get(`/api/v1/devices/${d1.deviceId}`, a.auth)).json(); assert.equal(moved.site, 'Branch'); assert.equal(moved.department, null);
  assert.equal((await patch(`/api/v1/sites/${hq.id}`, { name: 'Branch' }, a.auth)).statusCode, 409);
  assert.equal((await patch(`/api/v1/sites/${hq.id}`, { name: 'Head Office' }, a.auth)).json().name, 'Head Office');
  assert.equal((await del(`/api/v1/sites/${foreign.id}`, a.auth)).statusCode, 404);
  assert.equal((await del(`/api/v1/departments/${ops.id}`, a.auth)).statusCode, 200);
  assert.equal((await get(`/api/v1/devices/${d3.deviceId}`, a.auth)).json().department, null, 'devices survive department deletion');
  const audit = (await get('/api/v1/audit/search?action=device.assign', a.auth)).json();
  assert.ok(audit.entries.length >= 4 && audit.entries[0].previous !== undefined, 'previous and new state recorded');
});

test('revoking a device cuts off its credential immediately and cancels its queued jobs', async () => {
  const a = await mkOrg('Revoke Org', 'o@revoke.test');
  const d = await enroll(a.auth, 'revoke-dev-0001');
  const jid = (await post('/api/v1/jobs', { type: 'health.check', target: { deviceIds: [d.deviceId] } }, a.auth)).json().jobs[0].id;
  assert.equal((await h.app.inject({ method: 'POST', url: '/agent/v1/heartbeat', headers: d.dev, payload: { hostname: 'x', agentVersion: '1', metrics: {} } })).statusCode, 200);
  assert.equal((await del(`/api/v1/devices/${d.deviceId}`, a.auth)).statusCode, 200);
  assert.equal((await h.app.inject({ method: 'POST', url: '/agent/v1/heartbeat', headers: d.dev, payload: { hostname: 'x', agentVersion: '1', metrics: {} } })).statusCode, 401);
  assert.equal((await get(`/api/v1/jobs/${jid}`, a.auth)).json().status, 'cancelled');
  assert.equal((await get('/api/v1/devices', a.auth)).json().total, 0);
  assert.equal((await del(`/api/v1/devices/${d.deviceId}`, a.auth)).statusCode, 404, 'already revoked');
});

test('storage recovery filters by site (regression: missing $ in SQL placeholder)', async () => {
  const a = await mkOrg('Filter Org', 'o@filter.test');
  const site = (await post('/api/v1/sites', { name: 'S1' }, a.auth)).json();
  assert.equal((await get(`/api/v1/storage/recovery?siteId=${site.id}`, a.auth)).statusCode, 200);
});

// ------------------------------------------------------------------------------------------ reports
test('reports: summary numbers, CSV export with formula-injection protection, audited', async () => {
  const a = await mkOrg('Report Org', 'o@report.test'), b = await mkOrg('Report Other', 'o@report-other.test');
  const d = await enroll(a.auth, 'report-dev-0001', '=cmd|calc');
  await enroll(b.auth, 'report-dev-0002', 'B-PC');
  await health(d, { volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 3 * GB, isSystem: true }] });
  const jid = (await post('/api/v1/jobs', { type: 'cleanup.run', params: { categories: ['windows-temp'] }, target: { deviceIds: [d.deviceId] } }, a.auth)).json().jobs[0].id;
  await post(`/agent/v1/jobs/${jid}/start`, {}, d.dev); await post(`/agent/v1/jobs/${jid}/result`, { status: 'completed', result: { freedBytes: 1234 } }, d.dev);
  const s = (await get('/api/v1/reports/summary?days=7', a.auth)).json();
  assert.equal(s.computers, 1); assert.equal(s.storageRecoveredBytes, 1234); assert.ok(s.alerts.open_warning >= 1);
  assert.ok(s.jobs.some((j: any) => j.type === 'cleanup.run' && j.status === 'completed'));
  const csv = await get('/api/v1/reports/devices.csv', a.auth);
  assert.match(csv.headers['content-type'] as string, /text\/csv/);
  assert.ok(csv.body.startsWith('Computer,Site,Department'));
  assert.ok(csv.body.includes(`'=cmd|calc`) && !/\r\n=cmd/.test(csv.body), 'formula neutralised');
  assert.ok(!csv.body.includes('B-PC'), 'other org data never appears');
  assert.equal((await get('/api/v1/reports/jobs.csv', a.auth)).statusCode, 200);
  assert.ok((await get('/api/v1/audit', a.auth)).json().entries.some((e: any) => e.action === 'report.export'));
  assert.equal((await get('/api/v1/reports/summary', b.auth)).json().storageRecoveredBytes, 0);
});

test('unacknowledged alerts are counted apart from open ones, and acknowledge-all clears them (audited, per organization, overview agrees)', async () => {
  const a = await mkOrg('Ack Org', 'o@ack.test'), b = await mkOrg('Ack Other', 'o@ack-other.test');
  const d = await enroll(a.auth, 'ack-dev-0001', 'ACK-PC'); const e = await enroll(b.auth, 'ack-dev-0002', 'OTHER-PC');
  const sick = { volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 3 * GB, isSystem: true }], defender: { antivirusEnabled: false }, avProducts: [] };
  await health(d, sick); await health(e, sick);
  let al = (await get('/api/v1/alerts', a.auth)).json();
  assert.equal(al.alerts.length, 2); assert.deepEqual(al.unacknowledged, { critical: 1, warning: 1 }, 'both are new');
  let ov = (await get('/api/v1/overview', a.auth)).json(); assert.deepEqual(ov.alertsUnacknowledged, { critical: 1, warning: 1 });
  // one acknowledged: still open (the fault exists) but no longer unacknowledged
  const first = al.alerts.find((x: any) => x.severity === 'warning').id;
  assert.equal((await post(`/api/v1/alerts/${first}/ack`, {}, a.auth)).statusCode, 200);
  al = (await get('/api/v1/alerts', a.auth)).json();
  assert.deepEqual(al.open, { critical: 1, warning: 1 }); assert.deepEqual(al.unacknowledged, { critical: 1, warning: 0 });
  // acknowledge all: only this organization's alerts, only technicians and above, audited with the count
  assert.equal((await post('/api/v1/alerts/ack-all', {}, {})).statusCode, 401);
  const r = await post('/api/v1/alerts/ack-all', {}, a.auth); assert.equal(r.statusCode, 200); assert.equal(r.json().acknowledged, 1, 'only the one that was still unacknowledged');
  assert.equal((await post('/api/v1/alerts/ack-all', {}, a.auth)).json().acknowledged, 0, 'nothing left to acknowledge');
  al = (await get('/api/v1/alerts', a.auth)).json(); assert.deepEqual(al.open, { critical: 1, warning: 1 }, 'acknowledging never hides a real fault'); assert.deepEqual(al.unacknowledged, { critical: 0, warning: 0 });
  assert.deepEqual((await get('/api/v1/alerts', b.auth)).json().unacknowledged, { critical: 1, warning: 1 }, 'the other organization is untouched');
  assert.ok((await get('/api/v1/audit', a.auth)).json().entries.some((x: any) => x.action === 'alert.acknowledge_all'));
  ov = (await get('/api/v1/overview', a.auth)).json(); assert.deepEqual(ov.alertsUnacknowledged, {}, 'nothing unacknowledged: no severity is listed');
});
