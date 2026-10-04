import { z } from 'zod';
import { cpus } from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import { hashPassword, verifyPassword } from './security.js';
import { checkSecondFactor } from './account.js';
import { hashRecovery, newRecoveryCodes, newTotpSecret, openSecret, otpauthUri, sealSecret, verifyTotp } from './totp.js';

/* ------------------------------------------------------------------------------------------------
 * Platform (operator) console data: fleet overview, devices across organizations, release rollout detail, compute fleet and engines,
 * support sessions, commercial status, activity log, the health of Control itself, and two-step sign-in for platform admins.
 * Read-only except for MFA. Nothing here invents numbers: anything not measured is null.
 * ---------------------------------------------------------------------------------------------- */

interface Ctx { db: Db; jwtSecret: string; onlineWindowSeconds: number; audit: (e: any) => Promise<void>; startedAt?: number }

const csvCell = (v: unknown) => { const s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (rows: Record<string, unknown>[], cols: string[]) => [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
/** Spreadsheet programs run a cell that starts with = + - @ as a formula; names from the field must not. */
const safeCell = (v: unknown) => typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
const sanitize = (rows: Record<string, unknown>[]) => rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, safeCell(v)])));

export function registerPlatformOps(app: FastifyInstance, c: Ctx) {
  const { db } = c;
  const guard = (app as any).platformGuard as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  const uuid = z.string().uuid();
  const startedAt = c.startedAt ?? Date.now();
  const online = c.onlineWindowSeconds;
  const actor = (req: FastifyRequest) => req.platform!.via === 'key' ? 'platform:key' : 'platform:' + req.platform!.id;

  // ---------------- fleet overview ----------------
  app.get('/api/v1/platform/fleet', { preHandler: guard }, async () => {
    const versions = (await db.query(`SELECT COALESCE(agent_version,'unknown') version, count(*)::int devices FROM devices WHERE revoked_at IS NULL AND uninstalled_at IS NULL GROUP BY 1 ORDER BY devices DESC`)).rows;
    const ev = (await db.query(`SELECT count(*) FILTER (WHERE status='ok')::int ok, count(*) FILTER (WHERE status='rolled_back')::int rolled_back, count(*) FILTER (WHERE status='failed')::int failed FROM agent_update_events WHERE at > now() - interval '30 days'`)).rows[0];
    const total = ev.ok + ev.rolled_back + ev.failed;
    const crit = (await db.query(`SELECT count(*)::int n FROM alerts WHERE severity='critical' AND resolved_at IS NULL`)).rows[0].n;
    const awaiting = (await db.query(`SELECT count(*)::int n FROM billing_orders WHERE status='submitted'`)).rows[0].n;
    const hours = (await db.query(`SELECT COALESCE(sum(seconds),0)::float8 s FROM compute_usage WHERE day = current_date`)).rows[0].s;
    const rollout = (await db.query(`SELECT version, stage, status FROM agent_releases WHERE status='active' AND stage <> '100' ORDER BY string_to_array(version,'.')::int[] DESC`)).rows;
    return { versions, updates30d: { ...ev, successRate: total ? Math.round(ev.ok / total * 100) : null }, criticalAlerts: crit, ordersAwaiting: awaiting, computeHoursToday: Math.round(hours / 36) / 100, releasesInRollout: rollout };
  });

  // ---------------- devices across organizations ----------------
  app.get('/api/v1/platform/devices', { preHandler: guard }, async req => {
    const q = z.object({ q: z.string().max(80).default(''), version: z.string().max(40).default(''), org: uuid.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
    const like = '%' + q.q.replace(/[\\%_]/g, m => '\\' + m).toLowerCase() + '%';
    const r = await db.query(
      `SELECT d.id, d.hostname, d.org_id, o.name org_name, d.agent_version, d.update_ring, d.last_seen_at, d.enrolled_at, d.os_caption, m.worker_id,
              (d.last_seen_at > now() - make_interval(secs => $1)) AS online
         FROM devices d JOIN organizations o ON o.id=d.org_id LEFT JOIN mining_devices m ON m.device_id=d.id
        WHERE d.revoked_at IS NULL AND d.uninstalled_at IS NULL
          AND ($2='%%' OR lower(d.hostname) LIKE $2 OR lower(o.name) LIKE $2 OR lower(COALESCE(m.worker_id,'')) LIKE $2 OR lower(COALESCE(d.machine_guid,'')) LIKE $2)
          AND ($3='' OR d.agent_version=$3) AND ($4::uuid IS NULL OR d.org_id=$4)
        ORDER BY d.last_seen_at DESC NULLS LAST LIMIT $5`, [online, like, q.version, q.org ?? null, q.limit]);
    return { devices: r.rows };
  });

  // ---------------- one organization in depth ----------------
  app.get('/api/v1/platform/organizations/:id/detail', { preHandler: guard }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const o = (await db.query('SELECT id, name, plan, country_code, created_at, suspended_at, suspended_reason, require_mfa FROM organizations WHERE id=$1', [id])).rows[0];
    if (!o) return reply.code(404).send({ error: 'not found' });
    const devices = (await db.query(
      `SELECT d.id, d.hostname, d.agent_version, d.last_seen_at, (d.last_seen_at > now() - make_interval(secs => $2)) AS online FROM devices d
        WHERE d.org_id=$1 AND d.revoked_at IS NULL AND d.uninstalled_at IS NULL ORDER BY d.hostname LIMIT 200`, [id, online])).rows;
    // The compute policy summary never includes the payout address or pool: only whether and how hard it may run.
    const policy = (await db.query(`SELECT scope_type, (settings->>'enabled')::boolean enabled, settings->>'fallback' fallback, (settings->>'maxCpuPercent')::int max_cpu FROM compute_policies WHERE org_id=$1 ORDER BY scope_type`, [id])).rows;
    const consent = (await db.query('SELECT user_email, wording_version, accepted_at FROM compute_consents WHERE org_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0] ?? null;
    const recent = (await db.query('SELECT at, actor_type, action, result FROM audit_log WHERE org_id=$1 ORDER BY id DESC LIMIT 10', [id])).rows;
    const users = (await db.query('SELECT count(*)::int total, count(*) FILTER (WHERE mfa_enabled_at IS NOT NULL)::int mfa FROM users WHERE org_id=$1', [id])).rows[0];
    return { organization: o, devices, policy, consent, recentActivity: recent, users };
  });

  // ---------------- releases: who runs what, and what happened ----------------
  app.get('/api/v1/platform/releases/:version/detail', { preHandler: guard }, async (req, reply) => {
    const { version } = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).parse(req.params);
    const rel = (await db.query('SELECT version, stage, status, halt_reason, size_bytes, created_at, notes FROM agent_releases WHERE version=$1', [version])).rows[0];
    if (!rel) return reply.code(404).send({ error: 'not found' });
    const running = (await db.query(`SELECT d.id, d.hostname, o.name org_name, d.update_ring, d.last_seen_at FROM devices d JOIN organizations o ON o.id=d.org_id WHERE d.agent_version=$1 AND d.revoked_at IS NULL ORDER BY o.name, d.hostname LIMIT 300`, [version])).rows;
    const events = (await db.query(`SELECT e.at, e.status, e.detail, d.hostname, o.name org_name FROM agent_update_events e JOIN devices d ON d.id=e.device_id JOIN organizations o ON o.id=e.org_id WHERE e.version=$1 ORDER BY e.id DESC LIMIT 100`, [version])).rows;
    return { release: rel, running, events };
  });

  // ---------------- compute fleet and engines ----------------
  const computeRows = async () => (await db.query(
    `SELECT o.id, o.name, o.plan,
            (SELECT count(*)::int FROM mining_devices m WHERE m.org_id=o.id AND m.enabled) eligible,
            (SELECT count(*)::int FROM compute_state s WHERE s.org_id=o.id AND s.state='running' AND s.last_seen_at > now() - interval '5 minutes') running,
            (SELECT COALESCE(sum(s.hash_rate),0)::float8 FROM compute_state s WHERE s.org_id=o.id AND s.state='running' AND s.last_seen_at > now() - interval '5 minutes') hash_rate,
            (SELECT count(*)::int FROM mining_sessions x WHERE x.org_id=o.id AND x.started_at > now() - interval '24 hours') sessions_24h,
            (SELECT COALESCE(sum(accepted_shares),0)::int FROM mining_sessions x WHERE x.org_id=o.id AND x.started_at > now() - interval '24 hours') accepted_24h,
            (SELECT COALESCE(sum(rejected_shares),0)::int FROM mining_sessions x WHERE x.org_id=o.id AND x.started_at > now() - interval '24 hours') rejected_24h,
            (SELECT COALESCE(sum(seconds),0)::float8 FROM compute_usage u WHERE u.org_id=o.id AND u.day >= date_trunc('month', current_date)) month_seconds
       FROM organizations o WHERE o.plan='compute_sponsored' OR EXISTS (SELECT 1 FROM mining_devices m WHERE m.org_id=o.id) ORDER BY o.name`)).rows;
  app.get('/api/v1/platform/compute', { preHandler: guard }, async () => {
    const engines = (await db.query('SELECT version, sha256, size_bytes, status, created_at FROM compute_engines ORDER BY created_at DESC')).rows;
    const orgs = (await computeRows()).map(r => ({ ...r, compute_hours_month: Math.round(r.month_seconds / 36) / 100 }));
    const workers = (await db.query(`SELECT m.worker_id, m.enabled, o.name org_name, d.hostname, s.state, s.hash_rate, s.last_seen_at FROM mining_devices m JOIN devices d ON d.id=m.device_id JOIN organizations o ON o.id=m.org_id LEFT JOIN compute_state s ON s.device_id=m.device_id ORDER BY o.name, d.hostname LIMIT 500`)).rows;
    const live = (await db.query(`SELECT count(*)::int n FROM mining_sessions WHERE stopped_at IS NULL`)).rows[0].n;
    // Reconciliation with the pool is not available: nothing here reads the pool, so no earnings are claimed.
    return { engines, orgs, workers, openSessions: live, poolReconciliation: null };
  });
  app.get('/api/v1/platform/compute/export.csv', { preHandler: guard }, async (req, reply) => {
    const rows = sanitize((await computeRows()).map(r => ({ organization: r.name, plan: r.plan, eligible_pcs: r.eligible, running_now: r.running, hash_rate_hps: r.hash_rate, sessions_24h: r.sessions_24h, accepted_shares_24h: r.accepted_24h, rejected_shares_24h: r.rejected_24h, compute_hours_month: Math.round(r.month_seconds / 36) / 100 })));
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="compute-fleet.csv"')
      .send(toCsv(rows, ['organization', 'plan', 'eligible_pcs', 'running_now', 'hash_rate_hps', 'sessions_24h', 'accepted_shares_24h', 'rejected_shares_24h', 'compute_hours_month']));
  });

  // ---------------- support sessions across organizations ----------------
  app.get('/api/v1/platform/support', { preHandler: guard }, async req => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(300).default(100) }).parse(req.query);
    const r = await db.query(
      `SELECT s.id, s.kind, s.status, s.reason, s.requested_at, s.started_at, s.ended_at, s.ended_reason, o.name org_name, d.hostname, u.email admin_email
         FROM support_sessions s JOIN organizations o ON o.id=s.org_id JOIN devices d ON d.id=s.device_id LEFT JOIN users u ON u.id=s.admin_id ORDER BY s.requested_at DESC LIMIT $1`, [q.limit]);
    const orgs = (await db.query('SELECT count(*) FILTER (WHERE remote_support_enabled)::int enabled, count(*) FILTER (WHERE NOT remote_support_enabled)::int disabled FROM organizations')).rows[0];
    return { sessions: r.rows, organizationsWithSupport: orgs };
  });

  // ---------------- commercial status (no amounts are invented) ----------------
  app.get('/api/v1/platform/commercial', { preHandler: guard }, async () => {
    const r = await db.query(
      `SELECT o.id, o.name, o.plan, o.created_at,
              (SELECT count(*)::int FROM devices d WHERE d.org_id=o.id AND d.revoked_at IS NULL AND d.uninstalled_at IS NULL) devices,
              (SELECT row_to_json(x) FROM (SELECT user_email, wording_version, accepted_at FROM compute_consents k WHERE k.org_id=o.id ORDER BY id DESC LIMIT 1) x) consent,
              (SELECT min(at) FROM mining_audit_log a WHERE a.org_id=o.id AND a.action='plan.change' AND a.next->>'plan'='compute_sponsored') sponsored_since,
              (SELECT COALESCE(sum(seconds),0)::float8 FROM compute_usage u WHERE u.org_id=o.id AND u.day >= date_trunc('month', current_date)) month_seconds
         FROM organizations o ORDER BY o.name`);
    return { organizations: r.rows.map(x => ({ ...x, compute_hours_month: Math.round(x.month_seconds / 36) / 100 })),
      note: 'Revenue-share amounts are not recorded here. Only plan, consent and measured compute time are shown.' };
  });

  // ---------------- activity log with filters and export ----------------
  const activityQuery = async (q: { q: string; action: string; org?: string; limit: number }) => {
    const like = '%' + q.q.replace(/[\\%_]/g, m => '\\' + m).toLowerCase() + '%';
    return (await db.query(
      `SELECT a.id, a.at, a.actor_type, a.actor_id, a.action, a.target_type, a.target_id, a.result, a.org_id, o.name org_name
         FROM audit_log a LEFT JOIN organizations o ON o.id=a.org_id
        WHERE (a.action LIKE 'platform.%' OR a.action LIKE 'release.%' OR a.action LIKE 'compute_engine.%' OR a.action='organization.plan' OR a.action LIKE 'installer.%')
          AND ($1='' OR a.action LIKE $1 || '%') AND ($2::uuid IS NULL OR a.org_id=$2)
          AND ($3='%%' OR lower(COALESCE(a.actor_id,'')) LIKE $3 OR lower(COALESCE(o.name,'')) LIKE $3 OR lower(a.action) LIKE $3 OR lower(COALESCE(a.target_id,'')) LIKE $3)
        ORDER BY a.id DESC LIMIT $4`, [q.action, q.org ?? null, like, q.limit])).rows;
  };
  const activityParams = z.object({ q: z.string().max(80).default(''), action: z.string().max(60).regex(/^[a-z._-]*$/).default(''), org: uuid.optional(), limit: z.coerce.number().int().min(1).max(2000).default(200) });
  app.get('/api/v1/platform/activity', { preHandler: guard }, async req => ({ events: await activityQuery(activityParams.parse(req.query)) }));
  app.get('/api/v1/platform/activity/export.csv', { preHandler: guard }, async (req, reply) => {
    const rows = sanitize(await activityQuery({ ...activityParams.parse(req.query), limit: 2000 }));
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="platform-activity.csv"').send(toCsv(rows, ['at', 'actor_type', 'actor_id', 'action', 'target_type', 'target_id', 'org_name', 'result']));
  });

  // ---------------- the health of Control itself ----------------
  app.get('/api/v1/platform/system', { preHandler: guard }, async () => {
    const one = async (sql: string) => (await db.query(sql)).rows[0];
    const dbInfo = await one(`SELECT pg_database_size(current_database())::float8 bytes, current_setting('server_version') version`);
    const jobs = await one(`SELECT count(*) FILTER (WHERE status='queued')::int queued, count(*) FILTER (WHERE status='running')::int running, count(*) FILTER (WHERE status='failed' AND finished_at > now() - interval '24 hours')::int failed_24h,
                                   COALESCE(extract(epoch FROM now() - min(created_at) FILTER (WHERE status='queued')),0)::float8 oldest_queued_s FROM jobs`);
    const hooks = await one(`SELECT count(*) FILTER (WHERE status='pending')::int pending, count(*) FILTER (WHERE status='failed')::int failed FROM alert_deliveries`).catch(() => null);
    const migrations = await one(`SELECT count(*)::int n, max(name) latest FROM schema_migrations`).catch(() => null);
    const mem = process.memoryUsage();
    return {
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), node: process.version, cpuCores: cpus().length, memoryMb: Math.round(mem.rss / 1048576),
      database: { sizeMb: Math.round(dbInfo.bytes / 1048576), version: dbInfo.version }, migrations, jobs, webhooks: hooks,
      // Not measured by Control: reported as null rather than guessed.
      errorRate: null, backup: null,
    };
  });

  // ---------------- two-step sign-in for platform admins ----------------
  const person = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.platform!.via !== 'login') { reply.code(400).send({ error: 'sign in as a person to manage two-step sign-in' }); return null; }
    return req.platform!.id;
  };
  app.get('/api/v1/platform/account', { preHandler: guard }, async (req, reply) => {
    const id = await person(req, reply); if (!id) return;
    const u = (await db.query('SELECT email, mfa_enabled_at FROM platform_users WHERE id=$1', [id])).rows[0];
    const left = (await db.query('SELECT count(*)::int n FROM platform_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [id])).rows[0].n;
    return { email: u.email, mfa: { enabled: !!u.mfa_enabled_at, recoveryCodesLeft: left } };
  });
  const passwordOk = async (id: string, pw: string) => { const r = await db.query('SELECT password_hash FROM platform_users WHERE id=$1', [id]); return !!r.rows[0] && verifyPassword(pw, r.rows[0].password_hash); };
  app.post('/api/v1/platform/account/mfa/setup', { preHandler: guard }, async (req, reply) => {
    const id = await person(req, reply); if (!id) return; const b = z.object({ password: z.string() }).strict().parse(req.body);
    const u = (await db.query('SELECT email, mfa_enabled_at FROM platform_users WHERE id=$1', [id])).rows[0];
    if (u.mfa_enabled_at) return reply.code(409).send({ error: 'two-step sign-in is already on' });
    if (!(await passwordOk(id, b.password))) return reply.code(403).send({ error: 'the password is not correct' });
    const secret = newTotpSecret();
    await db.query('UPDATE platform_users SET mfa_pending_enc=$2 WHERE id=$1', [id, sealSecret(secret, c.jwtSecret)]);
    return { secret, uri: otpauthUri('Viro Platform', u.email, secret) };
  });
  app.post('/api/v1/platform/account/mfa/enable', { preHandler: guard }, async (req, reply) => {
    const id = await person(req, reply); if (!id) return; const b = z.object({ code: z.string().regex(/^\d{6}$/) }).strict().parse(req.body);
    const u = (await db.query('SELECT mfa_pending_enc, mfa_enabled_at FROM platform_users WHERE id=$1', [id])).rows[0];
    if (u.mfa_enabled_at) return reply.code(409).send({ error: 'two-step sign-in is already on' });
    if (!u.mfa_pending_enc) return reply.code(409).send({ error: 'start the setup first' });
    const step = verifyTotp(openSecret(u.mfa_pending_enc, c.jwtSecret), b.code);
    if (step == null) return reply.code(400).send({ error: 'that code is not right' });
    await db.query('UPDATE platform_users SET mfa_secret_enc=mfa_pending_enc, mfa_pending_enc=NULL, mfa_enabled_at=now(), mfa_last_step=$2, mfa_failed=0, mfa_locked_until=NULL WHERE id=$1', [id, step]);
    const codes = newRecoveryCodes();
    await db.query('DELETE FROM platform_recovery_codes WHERE user_id=$1', [id]);
    for (const code of codes) await db.query('INSERT INTO platform_recovery_codes(user_id, code_hash) VALUES ($1,$2)', [id, hashRecovery(code)]);
    await c.audit({ orgId: null, actorType: 'user', actorId: actor(req), action: 'platform.mfa.enable', targetType: 'platform_admin', targetId: id });
    return { recoveryCodes: codes };
  });
  app.post('/api/v1/platform/account/mfa/disable', { preHandler: guard }, async (req, reply) => {
    const id = await person(req, reply); if (!id) return; const b = z.object({ password: z.string(), code: z.string() }).strict().parse(req.body);
    const u = (await db.query('SELECT mfa_secret_enc, mfa_last_step, mfa_locked_until FROM platform_users WHERE id=$1', [id])).rows[0];
    if (!u.mfa_secret_enc) return reply.code(409).send({ error: 'two-step sign-in is not on' });
    if (!(await passwordOk(id, b.password))) return reply.code(403).send({ error: 'the password is not correct' });
    const f = await checkSecondFactor(db, { id, ...u }, b.code, c.jwtSecret, 'platform');
    if (f !== 'ok') return reply.code(f === 'locked' ? 423 : 403).send({ error: f === 'locked' ? 'too many wrong codes; try again in a few minutes' : 'that code is not right' });
    await db.query('UPDATE platform_users SET mfa_secret_enc=NULL, mfa_pending_enc=NULL, mfa_enabled_at=NULL, mfa_last_step=NULL WHERE id=$1', [id]);
    await db.query('DELETE FROM platform_recovery_codes WHERE user_id=$1', [id]);
    await c.audit({ orgId: null, actorType: 'user', actorId: actor(req), action: 'platform.mfa.disable', targetType: 'platform_admin', targetId: id });
    return { ok: true };
  });
  /** Another admin clears a locked-out admin's two-step sign-in (the person sets it up again). */
  app.post('/api/v1/platform/admins/:id/mfa-reset', { preHandler: guard }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query('UPDATE platform_users SET mfa_secret_enc=NULL, mfa_pending_enc=NULL, mfa_enabled_at=NULL, mfa_last_step=NULL, mfa_failed=0, mfa_locked_until=NULL WHERE id=$1 RETURNING email', [id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'admin not found' });
    await db.query('DELETE FROM platform_recovery_codes WHERE user_id=$1', [id]);
    await c.audit({ orgId: null, actorType: 'user', actorId: actor(req), action: 'platform.mfa.reset', targetType: 'platform_admin', targetId: id, previous: { email: r.rows[0].email } });
    return { ok: true };
  });
}

export { hashPassword };
