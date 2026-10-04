import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHarness } from './helpers.js';
import { ensureWorkerId } from '../src/mining-worker-id.js';
import { recordSession, closeSilentSessions, rollupMiningTelemetry, miningAudit, classifyPolicyChange } from '../src/mining-reporting.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54411); });
after(async () => { await h.stop(); });

const PK = { 'x-platform-key': 'platform-key' };
async function orgAndDevice(name: string, register = true) {
  const r = await h.app.inject({ method: 'POST', url: '/api/v1/platform/organizations', payload: { name, ownerEmail: `owner@${name.toLowerCase()}.test`, ownerPassword: 'correct horse battery', autopilot: false }, headers: PK });
  const orgId = r.json().organizationId as string;
  const l = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `owner@${name.toLowerCase()}.test`, password: 'correct horse battery' } });
  const t = await h.app.inject({ method: 'POST', url: '/api/v1/enrollment-tokens', payload: {}, headers: { authorization: `Bearer ${l.json().token}` } });
  const e = await h.app.inject({ method: 'POST', url: '/agent/v1/enroll', payload: { enrollmentToken: t.json().token, machineGuid: 'G-' + randomUUID(), hostname: name + '-PC', agentVersion: '0.1.10' } });
  const dev = { id: e.json().deviceId as string, orgId };
  if (register) await ensureWorkerId(h.db, { countryCode: 'ZM', orgId, orgHint: name, deviceId: dev.id });
  return dev;
}
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

test('a session needs a mining registration and cannot claim impossible times or runtime', async () => {
  const unreg = await orgAndDevice('MRUnreg', false);
  const r0 = await recordSession(h.db, unreg, { sessionId: randomUUID(), startedAt: ago(60), runtimeSeconds: 60, acceptedShares: 0, rejectedShares: 0 });
  assert.equal(r0.ok, false); assert.equal((r0 as any).status, 409);

  const d = await orgAndDevice('MRBounds');
  const future = await recordSession(h.db, d, { sessionId: randomUUID(), startedAt: new Date(Date.now() + 3600_000).toISOString(), runtimeSeconds: 1, acceptedShares: 0, rejectedShares: 0 });
  assert.equal(future.ok, false);
  const backwards = await recordSession(h.db, d, { sessionId: randomUUID(), startedAt: ago(60), stoppedAt: ago(120), runtimeSeconds: 1, acceptedShares: 0, rejectedShares: 0 });
  assert.equal(backwards.ok, false);

  const sid = randomUUID();
  const r = await recordSession(h.db, d, { sessionId: sid, startedAt: ago(100), runtimeSeconds: 99999, averageHashrate: 500, peakHashrate: 400, acceptedShares: 3, rejectedShares: 0 });
  assert.ok(r.ok);
  const row = (await h.db.query('SELECT runtime_seconds, peak_hashrate, worker_id FROM mining_sessions WHERE client_session_id=$1', [sid])).rows[0];
  assert.ok(row.runtime_seconds <= 106, 'runtime is capped at wall-clock time'); assert.equal(row.peak_hashrate, 500, 'peak is never below the average');
  assert.match(row.worker_id, /^ZM-/, 'worker id comes from the server, not the report');
});

test('progress is idempotent, shares only go up, a worker stop is final, telemetry stores deltas', async () => {
  const d = await orgAndDevice('MRFlow'); const sid = randomUUID(); const startedAt = ago(300);
  const base = { sessionId: sid, startedAt, workerVersion: '0.1.11', engineVersion: '6.26.0' };
  await recordSession(h.db, d, { ...base, runtimeSeconds: 60, averageHashrate: 900, peakHashrate: 950, acceptedShares: 2, rejectedShares: 0, sample: { hashrate: 900, poolConnected: true, cpuTempC: 61 } });
  await recordSession(h.db, d, { ...base, runtimeSeconds: 120, averageHashrate: 1000, peakHashrate: 1100, acceptedShares: 5, rejectedShares: 1, sample: { hashrate: 1000, poolConnected: true, cpuTempC: 63 } });
  await recordSession(h.db, d, { ...base, runtimeSeconds: 130, acceptedShares: 1, rejectedShares: 0 });       // stale/out-of-order report
  const stop = await recordSession(h.db, d, { ...base, stoppedAt: ago(0), runtimeSeconds: 290, averageHashrate: 1000, peakHashrate: 1100, acceptedShares: 7, rejectedShares: 1, stopReason: 'user returned', sample: null });
  assert.ok(stop.ok && stop.final);
  const again = await recordSession(h.db, d, { ...base, runtimeSeconds: 5000, acceptedShares: 99, rejectedShares: 0 });
  assert.ok(again.ok && again.final);
  const s = (await h.db.query('SELECT * FROM mining_sessions WHERE client_session_id=$1', [sid])).rows;
  assert.equal(s.length, 1);
  assert.equal(s[0].accepted_shares, 7); assert.equal(s[0].rejected_shares, 1); assert.equal(s[0].stop_reason, 'user returned'); assert.equal(s[0].closed_by, 'worker');
  assert.ok(s[0].runtime_seconds <= 306); assert.equal(s[0].engine_version, '6.26.0');
  const t = (await h.db.query('SELECT accepted_delta, rejected_delta FROM mining_telemetry WHERE session_id=$1 ORDER BY at', [s[0].id])).rows;
  assert.deepEqual(t.map(x => [x.accepted_delta, x.rejected_delta]), [[2, 0], [3, 1]]);
});

test('a silent session is closed by the server and a later worker report can still correct it', async () => {
  const d = await orgAndDevice('MRSilent'); const sid = randomUUID();
  await recordSession(h.db, d, { sessionId: sid, startedAt: ago(3600), runtimeSeconds: 60, acceptedShares: 1, rejectedShares: 0 });
  await h.db.query(`UPDATE mining_sessions SET last_report_at=now() - interval '20 minutes' WHERE client_session_id=$1`, [sid]);
  assert.ok(await closeSilentSessions(h.db) >= 1);
  let s = (await h.db.query('SELECT closed_by, stopped_at, stop_reason FROM mining_sessions WHERE client_session_id=$1', [sid])).rows[0];
  assert.equal(s.closed_by, 'server'); assert.ok(s.stopped_at); assert.match(s.stop_reason, /no report/);
  await recordSession(h.db, d, { sessionId: sid, startedAt: ago(3600), stoppedAt: ago(1500), runtimeSeconds: 2000, acceptedShares: 4, rejectedShares: 0, stopReason: 'worker restarted after power loss' });
  s = (await h.db.query('SELECT closed_by, stop_reason, accepted_shares FROM mining_sessions WHERE client_session_id=$1', [sid])).rows[0];
  assert.equal(s.closed_by, 'worker'); assert.equal(s.stop_reason, 'worker restarted after power loss'); assert.equal(s.accepted_shares, 4);
});

test('hourly rollup sums share deltas, is idempotent, and only then deletes old raw samples', async () => {
  const d = await orgAndDevice('MRRoll'); const sid = randomUUID();
  const r = await recordSession(h.db, d, { sessionId: sid, startedAt: ago(600), runtimeSeconds: 60, acceptedShares: 0, rejectedShares: 0 });
  assert.ok(r.ok);
  const ins = (at: string, hr: number, acc: number, rej: number) => h.db.query(
    `INSERT INTO mining_telemetry(device_id, org_id, session_id, at, hashrate, cpu_usage_percent, cpu_temp_c, accepted_delta, rejected_delta) VALUES ($1,$2,$3,$4,$5,20,$6,$7,$8)`,
    [d.id, d.orgId, r.id, at, hr, 55 + acc, acc, rej]);
  const oldHour = new Date(Date.now() - 5 * 86_400_000); oldHour.setUTCMinutes(10, 0, 0);
  const prevHour = new Date(Date.now() - 3600_000); prevHour.setUTCMinutes(5, 0, 0);
  await ins(oldHour.toISOString(), 800, 2, 0); await ins(new Date(oldHour.getTime() + 60_000).toISOString(), 1200, 3, 1);
  await ins(prevHour.toISOString(), 1000, 1, 0);
  await ins(new Date().toISOString(), 999, 1, 0);                 // current hour: not rolled up yet
  const first = await rollupMiningTelemetry(h.db, 3); assert.equal(first.deleted, 2, 'only the 5-day-old samples are deleted');
  await rollupMiningTelemetry(h.db, 3);                           // second run must not double count
  const rows = (await h.db.query('SELECT hour, avg_hashrate, max_hashrate, accepted_shares, rejected_shares, samples FROM mining_telemetry_hourly WHERE device_id=$1 ORDER BY hour', [d.id])).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].avg_hashrate, rows[0].max_hashrate, rows[0].accepted_shares, rows[0].rejected_shares, rows[0].samples], [1000, 1200, 5, 1, 2]);
  assert.deepEqual([rows[1].accepted_shares, rows[1].samples], [1, 1]);
  assert.equal(Number((await h.db.query('SELECT count(*) n FROM mining_telemetry WHERE device_id=$1', [d.id])).rows[0].n), 2);
});

test('policy changes are classified; high_risk is set exactly when there is a reason', async () => {
  const addr = '4' + 'A'.repeat(94), addr2 = '8' + 'B'.repeat(94);
  const base = { enabled: false, maxCpuPercent: 30, maxTempC: 70, maxMemoryPercent: 15, allowOnBattery: false, fallback: 'none' };
  assert.deepEqual(classifyPolicyChange(base, { ...base, maxCpuPercent: 20 }), { action: 'policy.update', reasons: [] });
  const en = classifyPolicyChange(base, { ...base, enabled: true, fallback: 'xmrig', pool: { endpoints: [{ host: 'pool.hashvault.pro', port: 443 }], payoutAddress: addr } });
  assert.equal(en.action, 'policy.enable');
  for (const w of ['compute enabled', 'payout address set', 'mining pool changed', 'mining engine selected as the workload']) assert.ok(en.reasons.includes(w), w);
  const on = { ...base, enabled: true, fallback: 'xmrig', pool: { endpoints: [{ host: 'pool.hashvault.pro', port: 443 }], payoutAddress: addr } };
  assert.deepEqual(classifyPolicyChange(on, { ...on, pool: { ...on.pool, payoutAddress: addr2 } }).reasons, ['payout address changed']);
  assert.deepEqual(classifyPolicyChange(on, { ...on, maxCpuPercent: 60 }).reasons, ['CPU limit raised 30% -> 60%']);
  assert.equal(classifyPolicyChange(on, { ...on, enabled: false }).action, 'policy.disable');
  assert.equal(classifyPolicyChange(null, base).action, 'policy.create');

  const d = await orgAndDevice('MRAudit');
  await miningAudit(h.db, { orgId: d.orgId, actorType: 'platform', actorId: 'platform:key', action: 'plan.change', previous: { plan: 'standard' }, next: { plan: 'compute_sponsored' }, reasons: ['organization moved to the sponsored plan'] });
  await miningAudit(h.db, { orgId: d.orgId, actorType: 'system', action: 'device.disable', deviceId: d.id, agentVersion: '0.1.10' });
  const a = (await h.db.query('SELECT action, actor_id, high_risk, reasons, agent_version FROM mining_audit_log WHERE org_id=$1 ORDER BY id', [d.orgId])).rows;
  assert.deepEqual(a.map(x => [x.action, x.actor_id, x.high_risk]), [['plan.change', null, true], ['device.disable', null, false]]);
  assert.equal(a[1].agent_version, '0.1.10');
});
