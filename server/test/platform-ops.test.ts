import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHarness } from './helpers.js';
import { hashPassword } from '../src/security.js';
import { base32Decode, hotp, stepOf } from '../src/totp.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54441); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const KEY: Hdr = { 'x-platform-key': 'platform-key' };
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, headers: Hdr = {}) => h.app.inject({ method, url, payload: payload as any, headers });
const PW = 'platform operator pw';
const codeFor = (secret: string, off = 0) => hotp(base32Decode(secret), stepOf(Date.now()) + off);

async function operator(email = `op${Math.random().toString(36).slice(2, 8)}@viro.test`) {
  await h.db.query('INSERT INTO platform_users(email,name,password_hash) VALUES ($1,$2,$3)', [email, 'Op', await hashPassword(PW)]);
  const l = await call('POST', '/api/v1/platform/auth/login', { email, password: PW });
  return { email, auth: { authorization: `Bearer ${l.json().token}` } as Hdr };
}
async function mkOrg(name: string, plan = 'standard') {
  const email = `o@${name.toLowerCase().replace(/[^a-z0-9]/g, '')}.test`;
  const r = await call('POST', '/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false, plan }, KEY);
  const l = await call('POST', '/api/v1/auth/login', { email, password: 'correct horse battery' });
  const auth = { authorization: `Bearer ${l.json().token}` } as Hdr;
  const t = await call('POST', '/api/v1/enrollment-tokens', {}, auth);
  const e = await call('POST', '/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: 'G-' + randomUUID(), hostname: name + '-PC', agentVersion: '0.1.9' });
  return { orgId: r.json().organizationId as string, auth, deviceId: e.json().deviceId as string };
}

test('every operator-console data route needs a platform sign-in (or the key) and refuses an organization token', async () => {
  const o = await mkOrg('PoAuth');
  const urls = ['/api/v1/platform/fleet', '/api/v1/platform/devices', '/api/v1/platform/compute', '/api/v1/platform/compute/export.csv', '/api/v1/platform/support', '/api/v1/platform/commercial', '/api/v1/platform/activity', '/api/v1/platform/activity/export.csv', '/api/v1/platform/system', `/api/v1/platform/organizations/${o.orgId}/detail`, '/api/v1/platform/releases'];
  const op = await operator();
  for (const u of urls) {
    assert.equal((await call('GET', u)).statusCode, 401, u + ' anonymous');
    assert.equal((await call('GET', u, undefined, o.auth)).statusCode, 403, u + ' organization token');
    assert.equal((await call('GET', u, undefined, op.auth)).statusCode, 200, u + ' operator');
    assert.equal((await call('GET', u, undefined, KEY)).statusCode, 200, u + ' key');
  }
});

test('fleet overview, device search across organizations, release detail and organization detail report real figures', async () => {
  const a = await mkOrg('PoFleetA'), b = await mkOrg('PoFleetB', 'compute_sponsored'); const op = await operator();
  await h.db.query(`UPDATE devices SET last_seen_at=now() WHERE id=$1`, [a.deviceId]);
  await h.db.query(`INSERT INTO alerts(org_id,device_id,code,severity,message) VALUES ($1,$2,'x','critical','boom')`, [a.orgId, a.deviceId]);
  const fleet = (await call('GET', '/api/v1/platform/fleet', undefined, op.auth)).json();
  assert.ok(fleet.versions.some((v: any) => v.version === '0.1.9' && v.devices >= 2)); assert.ok(fleet.criticalAlerts >= 1);
  assert.equal(fleet.updates30d.successRate, null, 'no update has happened: no rate is invented');
  const all = (await call('GET', '/api/v1/platform/devices?q=pofleet', undefined, op.auth)).json().devices; assert.equal(all.length, 2); assert.ok(all.every((d: any) => d.org_name.startsWith('PoFleet')));
  assert.equal((await call('GET', `/api/v1/platform/devices?q=pofleet&org=${b.orgId}`, undefined, op.auth)).json().devices.length, 1);
  assert.equal((await call('GET', '/api/v1/platform/devices?q=%25', undefined, op.auth)).json().devices.length, 0, 'a percent sign in the search is a literal, not a wildcard');
  const d = (await call('GET', `/api/v1/platform/organizations/${a.orgId}/detail`, undefined, op.auth)).json();
  assert.equal(d.organization.name, 'PoFleetA'); assert.equal(d.devices.length, 1); assert.equal(d.users.total, 1); assert.equal(d.consent, null);
  assert.equal((await call('GET', `/api/v1/platform/organizations/${randomUUID()}/detail`, undefined, op.auth)).statusCode, 404);
  await h.db.query(`INSERT INTO agent_releases(version,sha256,exe_sha256,size_bytes,manifest,signature,file_path,stage,status) VALUES ('9.9.9','a','b',1,'{}','s','f','pilot','active')`);
  await h.db.query(`UPDATE devices SET agent_version='9.9.9' WHERE id=$1`, [a.deviceId]);
  await h.db.query(`INSERT INTO agent_update_events(device_id,org_id,version,status,detail) VALUES ($1,$2,'9.9.9','ok','swapped')`, [a.deviceId, a.orgId]);
  const rel = (await call('GET', '/api/v1/platform/releases/9.9.9/detail', undefined, op.auth)).json();
  assert.equal(rel.running.length, 1); assert.equal(rel.events[0].status, 'ok'); assert.equal(rel.events[0].org_name, 'PoFleetA');
  assert.equal((await call('GET', '/api/v1/platform/releases/1.2.3/detail', undefined, op.auth)).statusCode, 404);
  const f2 = (await call('GET', '/api/v1/platform/fleet', undefined, op.auth)).json();
  assert.equal(f2.updates30d.successRate, 100); assert.ok(f2.releasesInRollout.some((r: any) => r.version === '9.9.9'));
});

test('a signed-in operator can manage releases and engines (not only the key); an organization token cannot', async () => {
  const op = await operator(), o = await mkOrg('PoRel');
  const up = (headers: Hdr) => h.app.inject({ method: 'PATCH', url: '/api/v1/platform/releases/9.9.9', payload: { stage: '10' } as any, headers });
  await h.db.query(`INSERT INTO agent_releases(version,sha256,exe_sha256,size_bytes,manifest,signature,file_path,stage,status) VALUES ('9.9.9','a','b',1,'{}','s','f','pilot','active') ON CONFLICT DO NOTHING`);
  assert.equal((await up(o.auth)).statusCode, 403);
  assert.equal((await up(op.auth)).statusCode, 200);
  assert.equal((await call('PATCH', '/api/v1/platform/releases/9.9.9', { status: 'halted' }, op.auth)).json().status, 'halted');
  assert.equal((await call('POST', '/api/v1/platform/compute-engine/9.9.9/withdraw', {}, o.auth)).statusCode, 403);
  assert.equal((await call('POST', '/api/v1/platform/compute-engine/9.9.9/withdraw', {}, op.auth)).statusCode, 404, 'operator reaches the handler (no such engine)');
});

test('compute fleet: per organization figures, worker registry, no pool reconciliation claimed; CSV neutralises formula cells', async () => {
  const op = await operator(); const s = await mkOrg('=PoCompute', 'compute_sponsored');
  await h.db.query(`INSERT INTO mining_devices(device_id,org_id,worker_id,enabled) VALUES ($1,$2,'ZM-PO-TEST-0001',true)`, [s.deviceId, s.orgId]);
  await h.db.query(`INSERT INTO compute_state(device_id,org_id,state,hash_rate) VALUES ($1,$2,'running',250)`, [s.deviceId, s.orgId]);
  await h.db.query(`INSERT INTO mining_sessions(device_id,org_id,worker_id,client_session_id,started_at,accepted_shares,rejected_shares,runtime_seconds) VALUES ($1,$2,'ZM-PO-TEST-0001',gen_random_uuid(),now(),7,1,600)`, [s.deviceId, s.orgId]);
  await h.db.query(`INSERT INTO compute_usage(device_id,org_id,day,seconds) VALUES ($1,$2,current_date,3600)`, [s.deviceId, s.orgId]);
  const c = (await call('GET', '/api/v1/platform/compute', undefined, op.auth)).json();
  const row = c.orgs.find((x: any) => x.id === s.orgId);
  assert.equal(row.eligible, 1); assert.equal(row.running, 1); assert.equal(row.hash_rate, 250); assert.equal(row.accepted_24h, 7); assert.equal(row.rejected_24h, 1); assert.equal(row.compute_hours_month, 1);
  assert.equal(c.poolReconciliation, null); assert.ok(c.workers.some((w: any) => w.worker_id === 'ZM-PO-TEST-0001')); assert.ok(c.openSessions >= 1);
  const csv = await call('GET', '/api/v1/platform/compute/export.csv', undefined, op.auth);
  assert.match(csv.headers['content-type'] as string, /text\/csv/); assert.match(csv.body, /^organization,plan,/); assert.ok(csv.body.includes("'=PoCompute"), 'a name starting with = is not left as a formula');
  const com = (await call('GET', '/api/v1/platform/commercial', undefined, op.auth)).json();
  const crow = com.organizations.find((x: any) => x.id === s.orgId); assert.equal(crow.plan, 'compute_sponsored'); assert.equal(crow.compute_hours_month, 1); assert.equal(crow.consent, null);
  assert.ok(crow.sponsored_since, 'the plan change is recorded'); assert.match(com.note, /not recorded/);
});

test('activity log: filters by text, action and organization; the export has the same rows', async () => {
  const op = await operator(); const o = await mkOrg('PoAct');
  await call('PATCH', `/api/v1/platform/organizations/${o.orgId}/plan`, { plan: 'compute_sponsored' }, KEY);
  const all = (await call('GET', '/api/v1/platform/activity?limit=500', undefined, op.auth)).json().events;
  assert.ok(all.some((e: any) => e.action === 'organization.plan'));
  assert.deepEqual((await call('GET', `/api/v1/platform/activity?org=${o.orgId}`, undefined, op.auth)).json().events.map((e: any) => e.org_id).filter((x: string) => x !== o.orgId), []);
  const onlyPlan = (await call('GET', '/api/v1/platform/activity?action=organization.plan', undefined, op.auth)).json().events; assert.ok(onlyPlan.length >= 1 && onlyPlan.every((e: any) => e.action === 'organization.plan'));
  assert.equal((await call('GET', '/api/v1/platform/activity?action=bad%27;drop', undefined, op.auth)).statusCode, 400, 'the action filter accepts only plain names');
  const csv = await call('GET', `/api/v1/platform/activity/export.csv?org=${o.orgId}`, undefined, op.auth);
  assert.match(csv.body, /^at,actor_type,actor_id,action,/); assert.ok(csv.body.split('\n').length >= 3);
});

test('support log and Control health report what exists and say null for what is not measured', async () => {
  const op = await operator(); const o = await mkOrg('PoSup');
  const u = (await h.db.query('SELECT id FROM users WHERE org_id=$1', [o.orgId])).rows[0].id;
  await h.db.query(`INSERT INTO support_sessions(org_id,device_id,admin_id,kind,reason,status) VALUES ($1,$2,$3,'terminal','check disk','requested')`, [o.orgId, o.deviceId, u]);
  const sup = (await call('GET', '/api/v1/platform/support', undefined, op.auth)).json();
  assert.ok(sup.sessions.some((s: any) => s.org_name === 'PoSup' && s.reason === 'check disk' && s.hostname === 'PoSup-PC'));
  const sys = (await call('GET', '/api/v1/platform/system', undefined, op.auth)).json();
  assert.ok(sys.database.sizeMb > 0); assert.ok(sys.migrations.n >= 28); assert.equal(typeof sys.jobs.queued, 'number'); assert.equal(sys.errorRate, null); assert.equal(sys.backup, null);
});

test('platform admins can use two-step sign-in; another admin can reset it; a key-only caller cannot manage it', async () => {
  const op = await operator(), other = await operator();
  assert.equal((await call('GET', '/api/v1/platform/account', undefined, KEY)).statusCode, 400);
  assert.equal((await call('POST', '/api/v1/platform/account/mfa/setup', { password: 'nope nope nope' }, op.auth)).statusCode, 403);
  const s = (await call('POST', '/api/v1/platform/account/mfa/setup', { password: PW }, op.auth)).json();
  assert.equal((await call('POST', '/api/v1/platform/account/mfa/enable', { code: '000000' }, op.auth)).statusCode, 400);
  const en = await call('POST', '/api/v1/platform/account/mfa/enable', { code: codeFor(s.secret) }, op.auth); assert.equal(en.statusCode, 200); assert.equal(en.json().recoveryCodes.length, 10);
  const login = (code?: string) => call('POST', '/api/v1/platform/auth/login', { email: op.email, password: PW, ...(code === undefined ? {} : { code }) });
  assert.equal((await login()).json().error, 'mfa_required');
  assert.equal((await login(codeFor(s.secret))).statusCode, 401, 'the code that switched it on cannot be reused');
  assert.equal((await login(codeFor(s.secret, 1))).statusCode, 200);
  assert.equal((await login(en.json().recoveryCodes[0])).statusCode, 200); assert.equal((await login(en.json().recoveryCodes[0])).statusCode, 401, 'a recovery code works once');
  assert.ok((await call('GET', '/api/v1/platform/admins', undefined, other.auth)).json().admins.find((a: any) => a.email === op.email).mfa);
  const id = (await h.db.query('SELECT id FROM platform_users WHERE email=$1', [op.email])).rows[0].id;
  assert.equal((await call('POST', `/api/v1/platform/admins/${id}/mfa-reset`, {}, other.auth)).statusCode, 200);
  assert.equal((await login()).statusCode, 200, 'after a reset the password alone signs in until it is set up again');
  assert.equal((await call('POST', `/api/v1/platform/admins/${randomUUID()}/mfa-reset`, {}, other.auth)).statusCode, 404);
});
