import { z } from 'zod';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { healthGate } from './healthgate.js';
import { ensureWorkerId } from './mining-worker-id.js';
import { hasComputeConsent } from './account.js';
import { SessionReport, recordSession, miningAudit, classifyPolicyChange } from './mining-reporting.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import type { JobCtx } from './jobs.js';

/* ------------------------------------------------------------------------------------------------
 * Compute sponsorship (control plane). Organizations on the "compute_sponsored" plan set a resource policy; each PC's separate
 * Compute Worker fetches its signed policy, obeys it, and reports state and compute time. Nothing here can affect the PC itself:
 * commercial status is only ever shown to administrators and used for billing decisions.
 * The mining engine (XMRig) link: the operator publishes an engine build; the signed policy names its SHA-256, the pool and the PUBLIC payout
 * address; PCs download it from here and refuse it if the checksum differs. Wallet private keys can never be stored.
 * ---------------------------------------------------------------------------------------------- */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** Public Monero address only (standard 95 chars / integrated 106). Private keys and seed phrases can never be stored: they do not match. */
export const XMR_ADDRESS = /^[48][0-9A-Za-z]{94}([0-9A-Za-z]{11})?$/;

export const ComputeSettings = z.object({
  enabled: z.boolean().default(false),
  maxCpuPercent: z.number().int().min(5).max(90).default(30),
  startAfterIdleMinutes: z.number().int().min(1).max(240).default(10),
  windows: z.array(z.object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: hhmm, end: hhmm }).strict()).max(14).optional(),
  allowOnBattery: z.boolean().default(false),
  maxTempC: z.number().int().min(40).max(95).default(70),
  maxMemoryPercent: z.number().int().min(5).max(50).default(15),
  pauseOnFullscreen: z.boolean().default(true),
  fallback: z.enum(['none', 'selftest', 'xmrig']).default('none'),
  pool: z.object({
    endpoints: z.array(z.object({ host: z.string().min(3).max(120).regex(/^[A-Za-z0-9.-]+$/), port: z.number().int().min(1).max(65535), tls: z.boolean().default(true) }).strict()).max(3),
    payoutAddress: z.string().regex(XMR_ADDRESS, 'payoutAddress must be a public Monero address; wallet private keys are never accepted').optional(),
  }).strict().optional(),
}).strict();
export type ComputeSettingsT = z.infer<typeof ComputeSettings>;

const HEARTBEAT_MAX_SECONDS = 3600;

export type Compliance = 'ok' | 'grace' | 'review' | 'standard-required';
/** Days a PC has been online while its Compute Worker stayed silent, mapped to the commercial state. */
export function complianceOf(unavailableDays: number): Compliance { return unavailableDays <= 0.5 ? 'ok' : unavailableDays <= 7 ? 'grace' : unavailableDays <= 14 ? 'review' : 'standard-required'; }
const RANK: Record<Compliance, number> = { ok: 0, grace: 1, review: 2, 'standard-required': 3 };

export function registerComputeRoutes(app: FastifyInstance, c: JobCtx & { onlineWindowSeconds: number; releasesDir?: string }) {
  const { db } = c;
  const engineDir = join(c.releasesDir ?? join(process.cwd(), 'data', 'releases'), 'engine');
  const uuid = z.string().uuid();

  /** Effective settings for a device: department override > site override > organization default. Disabled unless the org plan is sponsored. */
  async function effective(orgId: string, deviceId: string): Promise<{ settings: ComputeSettingsT | null; version: number; utcOffsetMinutes: number }> {
    const o = await db.query('SELECT plan, utc_offset_minutes FROM organizations WHERE id=$1', [orgId]);
    const rows = await db.query(
      `SELECT p.scope_type, p.settings, p.updated_at FROM compute_policies p JOIN devices d ON d.id=$2 AND d.org_id=p.org_id
        WHERE p.org_id=$1 AND (p.scope_type='org' OR (p.scope_type='site' AND p.scope_id=d.site_id) OR (p.scope_type='department' AND p.scope_id=d.department_id))`, [orgId, deviceId]);
    const pick = ['department', 'site', 'org'].map(t => rows.rows.find(r => r.scope_type === t)).find(Boolean);
    const version = rows.rowCount ? Math.floor(Math.max(...rows.rows.map(r => new Date(r.updated_at).getTime())) / 1000) + (o.rows[0].plan === 'compute_sponsored' ? 1 : 0) : 0;
    return { settings: o.rows[0].plan === 'compute_sponsored' && pick ? pick.settings : null, version, utcOffsetMinutes: o.rows[0].utc_offset_minutes };
  }

  /** The readable, immutable, server-generated worker id this device's engine presents to the pool (COUNTRY-ORG-SITE-DEVICE). Issued once and cached in mining_devices. */
  async function workerIdFor(orgId: string, deviceId: string): Promise<string> {
    const r = (await db.query(
      `SELECT o.country_code, o.name AS org_name, s.name AS site_name FROM organizations o LEFT JOIN devices d ON d.id=$2 LEFT JOIN sites s ON s.id=d.site_id WHERE o.id=$1`, [orgId, deviceId])).rows[0];
    return ensureWorkerId(db, { countryCode: r?.country_code ?? 'XX', orgId, orgHint: r?.org_name ?? null, siteHint: r?.site_name ?? null, deviceId });
  }

  // ---------------- agent side ----------------
  /** The newest active engine build, in the shape the worker expects. */
  async function activeEngine() {
    const r = (await db.query(`SELECT version, sha256, size_bytes FROM compute_engines WHERE status='active' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    return r ? { version: r.version as string, sha256: r.sha256 as string, size: Number(r.size_bytes) } : null;
  }

  // Publish an engine build (platform operator only): the raw xmrig.exe. Its checksum is computed here and travels in the signed policy.
  const platformOnly = (req: FastifyRequest, reply: FastifyReply) => (app as any).platformGuard(req, reply);      // the platform key or a signed-in platform admin
  app.put('/api/v1/platform/compute-engine', { preHandler: platformOnly, bodyLimit: 120 * 1024 * 1024 }, async (req, reply) => {
    const q = z.object({ version: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/) }).parse(req.query);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 100_000 || body.length > 100_000_000 || body[0] !== 0x4d || body[1] !== 0x5a) return reply.code(400).send({ error: 'the body must be a Windows executable (xmrig.exe), sent as application/octet-stream' });
    if ((await db.query('SELECT 1 FROM compute_engines WHERE version=$1', [q.version])).rowCount) return reply.code(409).send({ error: 'that engine version already exists (builds are immutable)' });
    await mkdir(engineDir, { recursive: true });
    const path = join(engineDir, `${q.version}.exe`), sha = createHash('sha256').update(body).digest('hex');
    await writeFile(path + '.part', body); await rename(path + '.part', path);
    await db.query('INSERT INTO compute_engines(version,sha256,size_bytes,file_path) VALUES ($1,$2,$3,$4)', [q.version, sha, body.length, path]);
    await c.audit({ orgId: null, actorType: 'system', action: 'compute_engine.publish', targetType: 'compute_engine', targetId: q.version, next: { sha256: sha, size: body.length } });
    return reply.code(201).send({ version: q.version, sha256: sha, size: body.length });
  });
  app.post('/api/v1/platform/compute-engine/:version/withdraw', { preHandler: platformOnly }, async (req, reply) => {
    const { version } = z.object({ version: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/) }).parse(req.params);
    const r = await db.query(`UPDATE compute_engines SET status='withdrawn' WHERE version=$1 RETURNING version`, [version]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    await c.audit({ orgId: null, actorType: 'system', action: 'compute_engine.withdraw', targetType: 'compute_engine', targetId: version });
    return { ok: true };
  });
  app.get('/agent/v1/compute/engine/:version', { preHandler: c.requireDevice }, async (req, reply) => {
    const { version } = z.object({ version: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/) }).parse(req.params);
    const r = (await db.query(`SELECT sha256, size_bytes, file_path FROM compute_engines WHERE version=$1 AND status='active'`, [version])).rows[0];
    if (!r) return reply.code(404).send({ error: 'no such engine' });
    return reply.header('content-type', 'application/octet-stream').header('content-length', String(r.size_bytes)).header('x-sha256', r.sha256).send(createReadStream(r.file_path));
  });

  app.get('/agent/v1/compute/policy', { preHandler: c.requireDevice }, async (req) => {
    const { id, orgId } = req.device!;
    const e = await effective(orgId, id);
    const workerId = await workerIdFor(orgId, id);
    const wasEnabled = (await db.query('SELECT enabled FROM mining_devices WHERE device_id=$1', [id])).rows[0]?.enabled ?? false;
    await db.query(`UPDATE mining_devices SET enabled=$2, authorization_status=$3, last_seen_at=now() WHERE device_id=$1`,
      [id, !!e.settings?.enabled, e.settings?.enabled ? 'authorized' : 'pending']);
    if (wasEnabled !== !!e.settings?.enabled) {
      const ver = (await db.query('SELECT worker_version FROM compute_state WHERE device_id=$1', [id])).rows[0]?.worker_version ?? null;
      await miningAudit(db, { orgId, actorType: 'system', actorLabel: 'policy fetch', action: e.settings?.enabled ? 'device.enable' : 'device.disable', deviceId: id,
        previous: { enabled: wasEnabled }, next: { enabled: !!e.settings?.enabled }, agentVersion: ver, reasons: e.settings?.enabled ? ['mining enabled on this PC'] : [] });
    }
    const s = e.settings;
    // A pause requested from WorkCare Mobile only ever turns compute off for this PC, for a bounded time.
    const paused = (await db.query('SELECT (paused_until IS NOT NULL AND paused_until > now()) AS p FROM mining_devices WHERE device_id=$1', [id])).rows[0]?.p === true;
    const policy = {
      version: e.version, enabled: !!s?.enabled && !paused, maxCpuPercent: s?.maxCpuPercent ?? 30, startAfterIdleMinutes: s?.startAfterIdleMinutes ?? 10, windows: s?.windows ?? null,
      allowOnBattery: s?.allowOnBattery ?? false, maxTempC: s?.maxTempC ?? 70, maxMemoryPercent: s?.maxMemoryPercent ?? 15, pauseOnFullscreen: s?.pauseOnFullscreen ?? true,
      utcOffsetMinutes: e.utcOffsetMinutes, fallback: s?.fallback ?? 'none', workerId, pool: s?.pool ?? null,
      engine: s?.enabled && !paused && s.fallback === 'xmrig' ? await activeEngine() : null,
      validUntil: new Date(Date.now() + 48 * 3600_000).toISOString(),      // a policy the PC cannot refresh stops being honoured after two days
    };
    const text = JSON.stringify(policy);
    return { policy: text, signature: c.signer.sign(text), workerId };
  });

  /** One report per engine run (start, progress, stop). Idempotent by the worker's session id; see mining-reporting.ts for the bounds. */
  app.post('/agent/v1/compute/session', { preHandler: c.requireDevice }, async (req, reply) => {
    const p = SessionReport.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid session report', issues: p.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
    const r = await recordSession(db, { id: req.device!.id, orgId: req.device!.orgId }, p.data);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return { ok: true, final: r.final };
  });

  app.post('/agent/v1/compute/heartbeat', { preHandler: c.requireDevice }, async (req) => {
    const b = z.object({
      state: z.string().max(40), reason: z.string().max(300).nullish(), cpuCapPercent: z.number().min(0).max(100).nullish(), computeSeconds: z.number().min(0).max(HEARTBEAT_MAX_SECONDS).default(0),
      hashRate: z.number().min(0).nullish(), workerVersion: z.string().max(40).nullish(), policyVersion: z.number().int().nullish(), userIdleSeconds: z.number().nullish(),
      integrity: z.record(z.string(), z.unknown()).nullish(), thermal: z.enum(['normal', 'warm', 'warning', 'critical']).nullish(), cpuTempC: z.number().min(0).max(150).nullish(),
    }).parse(req.body);
    const { id, orgId } = req.device!;
    // Compute time cannot exceed real elapsed time since the previous report (plus slack): a tampered worker cannot inflate its numbers.
    const prev = (await db.query('SELECT last_seen_at FROM compute_state WHERE device_id=$1', [id])).rows[0];
    const elapsed = prev ? (Date.now() - new Date(prev.last_seen_at).getTime()) / 1000 : 60;
    const seconds = b.state === 'running' || b.computeSeconds > 0 ? Math.min(b.computeSeconds, elapsed * 1.1 + 5) : 0;
    await db.query(
      `INSERT INTO compute_state(device_id,org_id,state,reason,cpu_cap_percent,hash_rate,worker_version,policy_version,user_idle_seconds,integrity,thermal,cpu_temp_c)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (device_id) DO UPDATE SET state=EXCLUDED.state, reason=EXCLUDED.reason, cpu_cap_percent=EXCLUDED.cpu_cap_percent, hash_rate=EXCLUDED.hash_rate, worker_version=EXCLUDED.worker_version,
         policy_version=EXCLUDED.policy_version, user_idle_seconds=EXCLUDED.user_idle_seconds, integrity=EXCLUDED.integrity, thermal=EXCLUDED.thermal, cpu_temp_c=EXCLUDED.cpu_temp_c, last_seen_at=now()`,
      [id, orgId, b.state, b.reason ?? null, b.cpuCapPercent ?? null, b.hashRate ?? null, b.workerVersion ?? null, b.policyVersion ?? null, b.userIdleSeconds ?? null, b.integrity ? JSON.stringify(b.integrity) : null, b.thermal ?? null, b.cpuTempC ?? null]);
    if (seconds > 0) await db.query(`INSERT INTO compute_usage(device_id,org_id,day,seconds) VALUES ($1,$2,current_date,$3) ON CONFLICT (device_id,day) DO UPDATE SET seconds = compute_usage.seconds + EXCLUDED.seconds`, [id, orgId, seconds]);
    // The Health Engine decides whether this computer may compute at all right now (ALLOW / THROTTLE / PAUSE / BLOCK).
    return { ok: true, health: await healthGate(db, id) };
  });

  // ---------------- admin side ----------------
  app.get('/api/v1/compute/policy', { preHandler: c.requireRole('viewer') }, async req => {
    const org = await db.query('SELECT plan FROM organizations WHERE id=$1', [req.user.org]);
    const rows = await db.query('SELECT id, scope_type, scope_id, settings, updated_at FROM compute_policies WHERE org_id=$1 ORDER BY scope_type, updated_at', [req.user.org]);
    return { plan: org.rows[0].plan, policies: rows.rows, defaults: ComputeSettings.parse({}) };
  });

  app.put('/api/v1/compute/policy', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const b = z.object({ scope: z.object({ type: z.enum(['org', 'site', 'department']), id: uuid.optional() }).strict(), settings: ComputeSettings }).strict().parse(req.body);
    if (b.scope.type !== 'org') {
      if (!b.scope.id) return reply.code(400).send({ error: `${b.scope.type} scope needs an id` });
      const t = b.scope.type === 'site' ? 'sites' : 'departments';
      if (!(await db.query(`SELECT 1 FROM ${t} WHERE id=$1 AND org_id=$2`, [b.scope.id, req.user.org])).rowCount) return reply.code(404).send({ error: `${b.scope.type} not found` });
    }
    if (b.settings.enabled && b.settings.fallback === 'xmrig' && !(b.settings.pool?.endpoints.length && b.settings.pool.payoutAddress)) return reply.code(400).send({ error: 'the mining engine needs a pool endpoint and a public Monero payout address' });
    if (b.settings.enabled && b.settings.fallback === 'xmrig' && !(await hasComputeConsent(db, req.user.org))) return reply.code(409).send({ error: 'consent_required', message: 'An owner must first accept the compute sponsorship terms (Settings, Compute consent).' });
    const prev = (await db.query(`SELECT settings FROM compute_policies WHERE org_id=$1 AND scope_type=$2 AND COALESCE(scope_id,'00000000-0000-0000-0000-000000000000'::uuid)=COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid)`, [req.user.org, b.scope.type, b.scope.id ?? null])).rows[0]?.settings ?? null;
    await db.query(
      `INSERT INTO compute_policies(org_id,scope_type,scope_id,settings,updated_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET settings=EXCLUDED.settings, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [req.user.org, b.scope.type, b.scope.id ?? null, JSON.stringify(b.settings), req.user.sub]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'compute.policy.update', targetType: b.scope.type, targetId: b.scope.id ?? req.user.org, previous: prev, next: b.settings });
    const cls = classifyPolicyChange(prev, b.settings);
    await miningAudit(db, { orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: cls.action, previous: prev, next: b.settings, reasons: cls.reasons });
    return { ok: true };
  });

  app.delete('/api/v1/compute/policy/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query('DELETE FROM compute_policies WHERE id=$1 AND org_id=$2 RETURNING scope_type, settings', [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'compute.policy.delete', targetType: 'compute_policy', targetId: id, previous: r.rows[0].settings });
    await miningAudit(db, { orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'policy.delete', previous: r.rows[0].settings, next: null });
    return { ok: true };
  });

  /** The sponsorship dashboard: how many PCs are eligible, contributing, blocked by the user, or offline, and how much compute was delivered. */
  app.get('/api/v1/compute/overview', { preHandler: c.requireRole('viewer') }, async req => {
    const org = (await db.query('SELECT plan FROM organizations WHERE id=$1', [req.user.org])).rows[0];
    const devs = await db.query(
      `SELECT d.id, d.hostname, d.last_seen_at, d.site_id, d.department_id, s.state, s.reason, s.cpu_cap_percent, s.hash_rate, s.last_seen_at AS worker_seen, s.first_seen_at, s.worker_version
         FROM devices d LEFT JOIN compute_state s ON s.device_id=d.id WHERE d.org_id=$1 AND d.revoked_at IS NULL`, [req.user.org]);
    const window = c.onlineWindowSeconds * 1000, workerWindow = 5 * 60_000;
    let eligible = 0, contributing = 0, userActive = 0, offline = 0, hashRate = 0, capMax = 0; const paused: Record<string, number> = {};
    const rows: any[] = [];
    for (const d of devs.rows) {
      const e = await effective(req.user.org, d.id);
      const isEligible = !!e.settings?.enabled;
      if (isEligible) eligible++;
      const agentOnline = d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() <= window;
      const workerFresh = d.worker_seen && Date.now() - new Date(d.worker_seen).getTime() <= workerWindow;
      let status = 'not-eligible';
      if (isEligible) {
        if (!agentOnline || !workerFresh) { status = agentOnline ? 'worker-silent' : 'offline'; offline++; }
        else if (d.state === 'running') { status = 'contributing'; contributing++; hashRate += d.hash_rate ?? 0; }
        else if (d.state === 'user-active') { status = 'user-active'; userActive++; }
        else if (d.state === 'pool-unreachable') { status = 'pool-unreachable'; paused[d.state] = (paused[d.state] ?? 0) + 1; }   // running, but blocked from reaching the pool: worth a distinct, visible state
        else { status = 'paused'; paused[d.state] = (paused[d.state] ?? 0) + 1; }
        capMax = Math.max(capMax, e.settings!.maxCpuPercent);
      }
      rows.push({ deviceId: d.id, hostname: d.hostname, status, state: d.state, reason: d.reason, workerVersion: d.worker_version, lastSeen: d.worker_seen });
    }
    const usage = (await db.query(`SELECT COALESCE(sum(seconds) FILTER (WHERE day = current_date),0) AS today, COALESCE(sum(seconds) FILTER (WHERE day >= date_trunc('month', current_date)),0) AS month FROM compute_usage WHERE org_id=$1`, [req.user.org])).rows[0];
    return {
      plan: org.plan, status: eligible ? 'ACTIVE' : 'INACTIVE', eligible, contributing, userActive, offline, paused, hashRateHps: contributing ? hashRate : null,
      computeHoursToday: Math.round(usage.today / 36) / 100, computeHoursThisMonth: Math.round(usage.month / 36) / 100, maxCpuPercent: capMax || null,
      note: 'Hash rate stays empty until the mining engine is connected.', devices: rows.sort((a, b) => a.hostname.localeCompare(b.hostname)),
    };
  });

  /** Mining proof, read side. Everything is scoped to the caller's organization. */
  app.get('/api/v1/compute/sessions', { preHandler: c.requireRole('viewer') }, async req => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), deviceId: uuid.optional() }).parse(req.query);
    const rows = (await db.query(
      `SELECT s.id, s.device_id, d.hostname, s.worker_id, s.started_at, s.stopped_at, s.runtime_seconds, s.average_hashrate, s.peak_hashrate, s.accepted_shares, s.rejected_shares,
              s.stop_reason, s.closed_by, s.engine_version, s.agent_version, s.last_report_at
         FROM mining_sessions s JOIN devices d ON d.id=s.device_id WHERE s.org_id=$1 AND ($3::uuid IS NULL OR s.device_id=$3) ORDER BY s.started_at DESC LIMIT $2`, [req.user.org, q.limit, q.deviceId ?? null])).rows;
    const t = (await db.query(
      `SELECT count(*)::int sessions, COALESCE(sum(runtime_seconds),0) runtime_seconds, COALESCE(sum(accepted_shares),0)::int accepted, COALESCE(sum(rejected_shares),0)::int rejected,
              count(*) FILTER (WHERE stopped_at IS NULL)::int running FROM mining_sessions WHERE org_id=$1`, [req.user.org])).rows[0];
    return { sessions: rows, totals: t };
  });
  app.get('/api/v1/compute/telemetry', { preHandler: c.requireRole('viewer') }, async req => {
    const q = z.object({ hours: z.coerce.number().int().min(1).max(720).default(48), deviceId: uuid.optional() }).parse(req.query);
    const rows = (await db.query(
      `SELECT device_id, hour, avg_hashrate, max_hashrate, avg_cpu_percent, max_cpu_temp_c, accepted_shares, rejected_shares, samples FROM mining_telemetry_hourly
        WHERE org_id=$1 AND hour >= now() - make_interval(hours => $2::int) AND ($3::uuid IS NULL OR device_id=$3) ORDER BY hour DESC LIMIT 5000`, [req.user.org, q.hours, q.deviceId ?? null])).rows;
    return { hourly: rows };
  });
  app.get('/api/v1/compute/mining-audit', { preHandler: c.requireRole('viewer') }, async req => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), highRiskOnly: z.enum(['true', 'false']).default('false') }).parse(req.query);
    const rows = (await db.query(
      `SELECT id, at, actor_type, actor_id, actor_label, action, device_id, high_risk, reasons, previous, next, agent_version FROM mining_audit_log
        WHERE org_id=$1 AND (NOT $3::boolean OR high_risk) ORDER BY id DESC LIMIT $2`, [req.user.org, q.limit, q.highRiskOnly === 'true'])).rows;
    return { entries: rows };
  });

  /** Commercial compliance. Purely informational: it never changes anything on a PC. */
  app.get('/api/v1/compute/compliance', { preHandler: c.requireRole('viewer') }, async req => {
    const org = (await db.query('SELECT plan FROM organizations WHERE id=$1', [req.user.org])).rows[0];
    const devs = await db.query(
      `SELECT d.id, d.hostname, d.last_seen_at, d.enrolled_at, s.last_seen_at AS worker_seen FROM devices d LEFT JOIN compute_state s ON s.device_id=d.id WHERE d.org_id=$1 AND d.revoked_at IS NULL`, [req.user.org]);
    const per: any[] = []; const counts: Record<Compliance, number> = { ok: 0, grace: 0, review: 0, 'standard-required': 0 }; let eligibleN = 0;
    for (const d of devs.rows) {
      const e = await effective(req.user.org, d.id);
      if (!e.settings?.enabled) continue; eligibleN++;
      const agentOnline = d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() <= c.onlineWindowSeconds * 1000;
      const since = d.worker_seen ? new Date(d.worker_seen) : new Date(d.enrolled_at);
      const days = agentOnline ? (Date.now() - since.getTime()) / 86_400_000 : 0;      // an offline PC is not a compliance problem: it is just offline
      const state = complianceOf(days); counts[state]++;
      per.push({ deviceId: d.id, hostname: d.hostname, state, unavailableDays: Math.round(days * 10) / 10 });
    }
    const threshold = Math.max(1, Math.ceil(eligibleN * 0.1));
    // The organization is in the worst state that at least 10% of its eligible PCs have reached (a single stray PC does not change the plan).
    const atLeast = (s: Compliance) => per.filter(p => RANK[p.state as Compliance] >= RANK[s]).length;
    let overall: Compliance = 'ok';
    for (const s of ['standard-required', 'review', 'grace'] as Compliance[]) if (atLeast(s) >= threshold) { overall = s; break; }
    return {
      plan: org.plan, billingState: org.plan === 'compute_sponsored' ? (overall === 'standard-required' ? 'STANDARD PLAN REQUIRED' : overall === 'review' ? 'SPONSORSHIP REVIEW' : overall === 'grace' ? 'GRACE PERIOD' : 'COMPUTE SPONSORED') : 'STANDARD',
      overall, counts, devices: per.sort((a, b) => RANK[b.state as Compliance] - RANK[a.state as Compliance]),
      guarantee: 'Sponsorship status never changes anything on a PC: no data is touched, Windows is not affected, and nothing is locked.',
    };
  });

  /** Platform operator: set the commercial plan of an organization. */
  const platform = platformOnly;
  app.patch('/api/v1/platform/organizations/:id/plan', { preHandler: platform }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params); const { plan } = z.object({ plan: z.enum(['standard', 'compute_sponsored']) }).strict().parse(req.body);
    const before = (await db.query('SELECT plan FROM organizations WHERE id=$1', [id])).rows[0]?.plan ?? null;
    const r = await db.query('UPDATE organizations SET plan=$2 WHERE id=$1 RETURNING id', [id, plan]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    await c.audit({ orgId: id, actorType: 'system', action: 'organization.plan', targetType: 'organization', targetId: id, previous: { plan: before }, next: { plan } });
    await miningAudit(db, { orgId: id, actorType: 'platform', actorLabel: 'platform operator', action: 'plan.change', previous: { plan: before }, next: { plan },
      reasons: plan === 'compute_sponsored' && before !== 'compute_sponsored' ? ['organization moved to the compute_sponsored plan'] : [] });
    return { ok: true };
  });
}
