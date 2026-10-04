import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyJwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';
import { scoreHealth, shieldOf, SnapshotSchema, type Snapshot, type Trend } from './health.js';
import { PERSONAL_NEVER_TOUCHED } from './catalog.js';
import { analyzeHardware, type HwAnalysis } from './hardware.js';
import { registerPolicyRoutes, reactToHealth } from './policies.js';
import { registerAlertRoutes, refreshAlerts } from './alerts.js';
import { registerWebhookRoutes } from './webhooks.js';
import { registerAutopilotRoutes, ensureAutopilot } from './autopilot.js';
import { registerSummaryRoutes } from './summary.js';
import { registerInstallerRoutes } from './installer.js';
import { syncIncidents, onJobFinished, metricsOf } from './incidents.js';
import { registerIncidentRoutes } from './incident-routes.js';
import { registerBenchmarkRoutes } from './benchmarks.js';
import { registerLifecycleRoutes } from './lifecycle-routes.js';
import { registerProtectionRoutes } from './protection.js';
import { registerOutcomeRoutes } from './outcomes.js';
import { registerSelfRoutes } from './selfview.js';
import { registerCareRoutes, recordBoots, maybeNotifyStorage, startupManager } from './care.js';
import { registerSecurityIncidentRoutes } from './security-incidents.js';
import { registerFleetIntelRoutes } from './fleet-routes.js';
import { recordHardwareReading } from './condition.js';
import { registerHistoryRoutes } from './machine-history.js';
import { registerCertificateRoutes, CertSigner } from './certificate.js';
import { createMailer } from './mailer.js';
import { registerPassportRoutes, ensureBaseline, trackHardware, completeBaseline } from './passport.js';
import { registerFleetRoutes } from './fleet.js';
import { registerReportRoutes } from './reports.js';
import websocket from '@fastify/websocket';
import { registerComputeRoutes } from './compute.js';
import { registerSupportRoutes, pendingSessions } from './support.js';
import { registerReleaseRoutes, offerFor, recordUpdateEvent, evaluateIntegrity } from './agentupdate.js';
import { tmpdir } from 'node:os';
import { registerPatchingRoutes, refreshSoftwareAlerts, afterUpdateInstall } from './patching.js';
import { registerJobRoutes, jobsForHeartbeat, type JobSigner } from './jobs.js';
import { registerPlatformRoutes } from './platform.js';
import { registerPlatformOps } from './platform-ops.js';
import { registerBillingRoutes } from './billing.js';
import { registerSignupRoutes } from './signup.js';
import { registerHelpRoutes } from './help.js';
import { registerMyPcRoutes } from './mypc.js';
import { registerMoveRoutes } from './move.js';
import { registerTwinRoutes } from './twin.js';
import { ensureAnatomy, computeWanted } from './autoprovision.js';
import { registerWakeRoutes, AdapterSchema } from './wake.js';
import { registerAnatomyRoutes } from './anatomy.js';
import { registerUpgradeRoutes } from './upgrade-routes.js';
import { registerAccountRoutes, checkSecondFactor, MFA_ROLES } from './account.js';
import { atLeast, hashPassword, newSecret, sha256Hex, verifyPassword, type Role } from './security.js';

export interface AppConfig {
  db: Db;
  jwtSecret: string;
  platformKey: string;          // authenticates platform-level operator calls (org creation)
  onlineWindowSeconds?: number; // device considered online if seen within this window
  loginRateLimitPerMinute?: number;
  enrollRateLimitPerMinute?: number; // per source IP; a whole office often shares one
  releasesDir?: string;         // where signed agent release packages are stored
  /** Addresses of reverse proxies whose X-Forwarded-For is believed (so rate limits and the audit log see the real visitor). Off by default. */
  trustProxy?: string[] | false;
  requireTrustedSignature?: boolean; // raise a critical alert when an agent binary is unsigned/untrusted (production)
  signer: JobSigner;            // signs jobs; its public key is pinned by agents at enrollment
}

interface UserToken { sub: string; org: string; role: Role; mfaSetup?: boolean }
interface DeviceCtx { id: string; orgId: string }

declare module 'fastify' {
  interface FastifyRequest { device?: DeviceCtx }
}
declare module '@fastify/jwt' {
  interface FastifyJWT { payload: UserToken; user: UserToken }
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function buildApp(cfg: AppConfig) {
  const { db } = cfg;
  const onlineWindow = cfg.onlineWindowSeconds ?? 120;
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' && process.env.VIRO_QUIET !== '1', bodyLimit: 8 * 1024 * 1024, trustProxy: cfg.trustProxy ?? false });
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
  await app.register(fastifyJwt, { secret: cfg.jwtSecret, sign: { expiresIn: '12h' } });
  await app.register(fastifyStatic, { root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public'), cacheControl: false, setHeaders: res => res.setHeader('cache-control', 'no-cache') });      // the browser always checks for the newest page files

  async function audit(e: {
    orgId: string | null; actorType: 'user' | 'device' | 'system'; actorId?: string; action: string;
    targetType?: string; targetId?: string; previous?: unknown; next?: unknown; result?: string; ip?: string;
  }) {
    await db.query(
      `INSERT INTO audit_log(org_id,actor_type,actor_id,action,target_type,target_id,previous,next,result,ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.orgId, e.actorType, e.actorId ?? null, e.action, e.targetType ?? null, e.targetId ?? null,
       e.previous === undefined ? null : JSON.stringify(e.previous), e.next === undefined ? null : JSON.stringify(e.next),
       e.result ?? 'ok', e.ip ?? null]);
  }

  async function trendFor(deviceIds: string[]): Promise<Map<string, Trend>> {
    const out = new Map<string, Trend>();
    if (!deviceIds.length) return out;
    const r = await db.query(
      `SELECT device_id, metrics FROM (
         SELECT device_id, metrics, row_number() OVER (PARTITION BY device_id ORDER BY received_at DESC) rn
           FROM device_heartbeats WHERE device_id = ANY($1::uuid[])) t WHERE rn <= 20`, [deviceIds]);
    const by = new Map<string, any[]>();
    for (const row of r.rows) (by.get(row.device_id) ?? by.set(row.device_id, []).get(row.device_id)!).push(row.metrics);
    for (const [id, ms] of by) {
      const cpu = ms.map(m => m.cpuPercent).filter((x: unknown) => typeof x === 'number') as number[];
      const ram = ms.map(m => m.ramPercent).filter((x: unknown) => typeof x === 'number') as number[];
      const avg = (a: number[]) => a.length >= 3 ? a.reduce((x, y) => x + y, 0) / a.length : null;
      out.set(id, { cpuAvg: avg(cpu), ramAvg: avg(ram), ramMax: ram.length ? Math.max(...ram) : null, ramHighShare: ram.length ? ram.filter(x => x >= 90).length / ram.length : null, samples: ram.length });
    }
    return out;
  }

  /** Latest completed hardware.diagnose result per device (raw facts + analysis), scoped to one org. */
  async function latestHardware(orgId: string, deviceIds?: string[]) {
    const r = await db.query(
      `SELECT DISTINCT ON (device_id) device_id, result, finished_at FROM jobs
        WHERE org_id=$1 AND type='hardware.diagnose' AND status='completed' AND result IS NOT NULL ${deviceIds ? 'AND device_id = ANY($2::uuid[])' : ''}
        ORDER BY device_id, finished_at DESC`, deviceIds ? [orgId, deviceIds] : [orgId]);
    return new Map<string, { raw: any; at: string; analysis: HwAnalysis }>(r.rows.map(x => [x.device_id, { raw: x.result, at: x.finished_at, analysis: analyzeHardware(x.result) }]));
  }

  // ---- auth guards -------------------------------------------------------
  const requireRole = (need: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
    try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'unauthenticated' }); }
    if (!req.user.role || !req.user.org) return reply.code(403).send({ error: 'forbidden' });      // a platform operator's token is not an organization token
    if (!atLeast(req.user.role, need)) return reply.code(403).send({ error: 'forbidden' });
    if (await isSuspended(req.user.org)) return reply.code(403).send({ error: 'this organization is suspended; contact the platform' });
    if (await isUserDisabled(req.user.sub)) return reply.code(401).send({ error: 'unauthenticated' });
    if (req.user.mfaSetup && !/^\/api\/v1\/(account|me)\b/.test(req.routeOptions.url ?? '')) return reply.code(403).send({ error: 'mfa_setup_required', message: 'Your organization requires two-step sign-in. Set it up under Account to continue.' });
  };

  const requireDevice = async (req: FastifyRequest, reply: FastifyReply) => {
    const m = /^Bearer ([0-9a-f-]{36})\.(.+)$/.exec(req.headers.authorization ?? '');
    if (!m) return reply.code(401).send({ error: 'unauthenticated' });
    const r = await db.query('SELECT d.id, d.org_id, d.credential_hash, (o.suspended_at IS NOT NULL) AS suspended FROM devices d JOIN organizations o ON o.id=d.org_id WHERE d.id=$1 AND d.revoked_at IS NULL', [m[1]]);
    const row = r.rows[0];
    if (!row || !safeEq(row.credential_hash, sha256Hex(m[2]!))) return reply.code(401).send({ error: 'unauthenticated' });
    if (row.suspended) return reply.code(403).send({ error: 'organization suspended' });
    req.device = { id: row.id, orgId: row.org_id };
  };

  app.get('/healthz', async () => ({ ok: true }));

  // ---- suspension: a suspended organization's people and computers are refused until the platform resumes it ----------------------------
  const suspendedCache = new Map<string, { at: number; suspended: boolean }>();
  const isSuspended = async (orgId: string) => {
    const hit = suspendedCache.get(orgId); if (hit && Date.now() - hit.at < 10_000) return hit.suspended;
    const r = await db.query('SELECT suspended_at FROM organizations WHERE id=$1', [orgId]);
    const v = !!r.rows[0]?.suspended_at; suspendedCache.set(orgId, { at: Date.now(), suspended: v }); return v;
  };

  // A disabled or removed person is refused on their very next request (checked at most every 10 seconds per person).
  const userCache = new Map<string, { at: number; disabled: boolean }>();
  const isUserDisabled = async (id: string) => {
    const hit = userCache.get(id); if (hit && Date.now() - hit.at < 10_000) return hit.disabled;
    const r = await db.query('SELECT disabled_at FROM users WHERE id=$1', [id]);
    const v = !r.rows[0] || !!r.rows[0].disabled_at; userCache.set(id, { at: Date.now(), disabled: v }); return v;
  };

  registerPlatformRoutes(app, { db, jwtSecret: cfg.jwtSecret, platformKey: cfg.platformKey, safeEq, onlineWindowSeconds: onlineWindow, audit, loginRateLimitPerMinute: cfg.loginRateLimitPerMinute, invalidate: id => suspendedCache.delete(id) });

  // ---- administrator auth -------------------------------------------------
  app.post('/api/v1/auth/login', { config: { rateLimit: { max: cfg.loginRateLimitPerMinute ?? 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ email: z.string(), password: z.string(), code: z.string().max(40).nullish() }).parse(req.body);
    const r = await db.query('SELECT u.id, u.org_id, u.role, u.email_verified_at, u.password_hash, u.disabled_at, u.mfa_secret_enc, u.mfa_last_step, u.mfa_locked_until, o.require_mfa, (o.suspended_at IS NOT NULL) AS suspended FROM users u JOIN organizations o ON o.id=u.org_id WHERE u.email=lower($1)', [body.email]);
    const u = r.rows[0];
    const ok = u ? await verifyPassword(body.password, u.password_hash) : (await hashPassword('x'), false);
    if (!ok || u.disabled_at) {
      await audit({ orgId: u?.org_id ?? null, actorType: 'user', actorId: body.email, action: 'auth.login', result: 'denied', ip: req.ip });
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    if (!u.email_verified_at) return reply.code(403).send({ error: 'Confirm your email first: open the link we sent you.', emailNotVerified: true });
    if (u.suspended) { await audit({ orgId: u.org_id, actorType: 'user', actorId: u.id, action: 'auth.login', result: 'denied', ip: req.ip }); return reply.code(403).send({ error: 'this organization is suspended; contact the platform' }); }
    if (u.mfa_secret_enc) {
      if (!body.code) return reply.code(401).send({ error: 'mfa_required', mfa: true });
      const f = await checkSecondFactor(db, u, body.code, cfg.jwtSecret);
      if (f !== 'ok') {
        await audit({ orgId: u.org_id, actorType: 'user', actorId: u.id, action: 'auth.login', result: 'denied', ip: req.ip });
        return reply.code(f === 'locked' ? 423 : 401).send({ error: f === 'locked' ? 'too many wrong codes; try again in a few minutes' : 'that code is not right', mfa: true });
      }
    }
    await db.query('UPDATE users SET last_login_at=now() WHERE id=$1', [u.id]);
    await audit({ orgId: u.org_id, actorType: 'user', actorId: u.id, action: 'auth.login', ip: req.ip });
    const mfaSetup = !u.mfa_secret_enc && u.require_mfa && MFA_ROLES.includes(u.role);
    return { token: app.jwt.sign({ sub: u.id, org: u.org_id, role: u.role, ...(mfaSetup ? { mfaSetup: true } : {}) }), role: u.role, ...(mfaSetup ? { mfaSetupRequired: true } : {}) };
  });

  app.get('/api/v1/me', { preHandler: requireRole('viewer') }, async req => {
    const o = await db.query('SELECT id, name, plan, kind FROM organizations WHERE id=$1', [req.user.org]);
    return { userId: req.user.sub, role: req.user.role, organization: o.rows[0], mfaSetupRequired: !!req.user.mfaSetup };
  });

  // ---- sites / departments ------------------------------------------------
  app.post('/api/v1/sites', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(req.body);
    const r = await db.query('INSERT INTO sites(org_id,name) VALUES ($1,$2) ON CONFLICT (org_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id,name', [req.user.org, name]);
    await audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'site.create', targetType: 'site', targetId: r.rows[0].id, next: { name } });
    return reply.code(201).send(r.rows[0]);
  });
  app.post('/api/v1/departments', { preHandler: requireRole('admin') }, async (req, reply) => {
    const b = z.object({ siteId: z.string().uuid(), name: z.string().min(1).max(120) }).parse(req.body);
    const site = await db.query('SELECT 1 FROM sites WHERE id=$1 AND org_id=$2', [b.siteId, req.user.org]);
    if (!site.rowCount) return reply.code(404).send({ error: 'site not found' });
    const r = await db.query('INSERT INTO departments(org_id,site_id,name) VALUES ($1,$2,$3) ON CONFLICT (site_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id,name,site_id', [req.user.org, b.siteId, b.name]);
    await audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'department.create', targetType: 'department', targetId: r.rows[0].id, next: b });
    return reply.code(201).send(r.rows[0]);
  });
  app.get('/api/v1/sites', { preHandler: requireRole('viewer') }, async req => {
    const s = await db.query('SELECT id,name FROM sites WHERE org_id=$1 ORDER BY name', [req.user.org]);
    const d = await db.query('SELECT id,name,site_id FROM departments WHERE org_id=$1 ORDER BY name', [req.user.org]);
    return { sites: s.rows.map(x => ({ ...x, departments: d.rows.filter(y => y.site_id === x.id) })) };
  });

  // ---- enrollment tokens --------------------------------------------------
  app.post('/api/v1/enrollment-tokens', { preHandler: requireRole('admin') }, async (req, reply) => {
    const b = z.object({
      siteId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(),
      maxUses: z.number().int().min(1).max(100000).default(1000), ttlHours: z.number().int().min(1).max(24 * 90).default(72),
    }).parse(req.body ?? {});
    if (b.siteId && !(await db.query('SELECT 1 FROM sites WHERE id=$1 AND org_id=$2', [b.siteId, req.user.org])).rowCount) return reply.code(404).send({ error: 'site not found' });
    if (b.departmentId && !(await db.query('SELECT 1 FROM departments WHERE id=$1 AND org_id=$2', [b.departmentId, req.user.org])).rowCount) return reply.code(404).send({ error: 'department not found' });
    const secret = newSecret('vet');
    const r = await db.query(
      `INSERT INTO enrollment_tokens(org_id,token_hash,site_id,department_id,max_uses,expires_at,created_by)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6), $7) RETURNING id, expires_at`,
      [req.user.org, sha256Hex(secret), b.siteId ?? null, b.departmentId ?? null, b.maxUses, b.ttlHours, req.user.sub]);
    await audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'enrollment_token.create', targetType: 'enrollment_token', targetId: r.rows[0].id, next: { ...b } });
    return reply.code(201).send({ id: r.rows[0].id, token: secret, expiresAt: r.rows[0].expires_at });
  });

  // ---- device list / detail ----------------------------------------------
  const statusOf = (lastSeen: Date | null) =>
    !lastSeen ? 'offline' : (Date.now() - new Date(lastSeen).getTime()) / 1000 <= onlineWindow ? 'online' : 'offline';

  /** Devices of one org with computed health, hardware verdict and open-alert count. Filters are optional. */
  async function listDevices(orgId: string, f: { siteId?: string; departmentId?: string; tag?: string; q?: string } = {}) {
    const vals: unknown[] = [orgId]; let where = '';
    if (f.siteId) { vals.push(f.siteId); where += ` AND d.site_id=$${vals.length}`; }
    if (f.departmentId) { vals.push(f.departmentId); where += ` AND d.department_id=$${vals.length}`; }
    if (f.tag) { vals.push(f.tag); where += ` AND $${vals.length} = ANY(d.tags)`; }
    if (f.q) { vals.push('%' + f.q.replace(/[%_]/g, m => '\\' + m) + '%'); where += ` AND (d.hostname ILIKE $${vals.length} OR d.logged_in_user ILIKE $${vals.length})`; }
    const r = await db.query(
      `SELECT d.id, d.hostname, d.logged_in_user, d.ip_address, d.os_caption, d.os_build, d.agent_version, d.last_seen_at,
              d.uptime_seconds, d.tags, d.site_id, d.department_id, s.name AS site, dep.name AS department,
              i.hardware->>'cpu' AS cpu, (i.hardware->>'ramBytes')::bigint AS ram_bytes,
              (SELECT count(*)::int FROM alerts a WHERE a.device_id=d.id AND a.resolved_at IS NULL) AS open_alerts
         FROM devices d
         LEFT JOIN sites s ON s.id=d.site_id LEFT JOIN departments dep ON dep.id=d.department_id
         LEFT JOIN device_inventory i ON i.device_id=d.id
        WHERE d.org_id=$1 AND d.revoked_at IS NULL${where} ORDER BY d.hostname`, vals);
    const hs = await db.query('SELECT device_id, snapshot FROM device_health WHERE org_id=$1', [orgId]);
    const snaps = new Map<string, Snapshot>(hs.rows.map(x => [x.device_id, x.snapshot]));
    const trends = await trendFor([...snaps.keys()]);
    const hws = await latestHardware(orgId);
    return r.rows.map(d => {
      const snap = snaps.get(d.id), hw = hws.get(d.id);
      const h = snap ? scoreHealth(snap, trends.get(d.id), hw?.analysis) : null;
      return { ...d, status: statusOf(d.last_seen_at), health_score: h?.overall ?? null, health_status: h?.status ?? null, hardware_verdict: hw?.analysis.verdict ?? null };
    });
  }

  app.get('/api/v1/devices', { preHandler: requireRole('viewer') }, async req => {
    const f = z.object({ siteId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(), tag: z.string().max(60).optional(), q: z.string().max(100).optional(),
      status: z.enum(['online', 'offline']).optional(), health: z.enum(['healthy', 'attention', 'critical']).optional() }).parse(req.query);
    let devices = await listDevices(req.user.org, f);
    if (f.status) devices = devices.filter(d => d.status === f.status);
    if (f.health) devices = devices.filter(d => d.health_status === f.health);
    return { total: devices.length, online: devices.filter(d => d.status === 'online').length, devices };
  });

  app.get('/api/v1/devices/:id', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const d = await db.query(
      `SELECT d.*, s.name AS site, dep.name AS department, o.name AS organization
         FROM devices d JOIN organizations o ON o.id=d.org_id
         LEFT JOIN sites s ON s.id=d.site_id LEFT JOIN departments dep ON dep.id=d.department_id
        WHERE d.id=$1 AND d.org_id=$2`, [id, req.user.org]);
    if (!d.rowCount) return reply.code(404).send({ error: 'not found' });
    const { credential_hash, ...device } = d.rows[0];
    const inv = await db.query('SELECT hardware, software, collected_at FROM device_inventory WHERE device_id=$1', [id]);
    const hb = await db.query('SELECT received_at, metrics FROM device_heartbeats WHERE device_id=$1 ORDER BY received_at DESC LIMIT 60', [id]);
    const hs = await db.query('SELECT snapshot, collected_at FROM device_health WHERE device_id=$1', [id]);
    const trend = (await trendFor([id])).get(id);
    const hwd = (await latestHardware(req.user.org, [id])).get(id) ?? null;
    const health = hs.rows[0] ? { collectedAt: hs.rows[0].collected_at, ...scoreHealth(hs.rows[0].snapshot, trend, hwd?.analysis) } : null;
    const hist = await db.query('SELECT at, overall FROM device_health_history WHERE device_id=$1 ORDER BY at DESC LIMIT 100', [id]);
    return { ...device, status: statusOf(device.last_seen_at), inventory: inv.rows[0] ?? null, recentHeartbeats: hb.rows, health, healthHistory: hist.rows, startupItems: hs.rows[0]?.snapshot?.startup ?? [], startupManager: startupManager(hs.rows[0]?.snapshot), hardwareDiagnosis: hwd ? { collectedAt: hwd.at, ...hwd.analysis, raw: hwd.raw } : null };
  });

  app.get('/api/v1/audit', { preHandler: requireRole('admin') }, async req => {
    const r = await db.query('SELECT id,at,actor_type,actor_id,action,target_type,target_id,previous,next,result FROM audit_log WHERE org_id=$1 ORDER BY id DESC LIMIT 200', [req.user.org]);
    return { entries: r.rows };
  });

  // ---- agent channel ------------------------------------------------------
  app.post('/agent/v1/enroll', { config: { rateLimit: { max: cfg.enrollRateLimitPerMinute ?? 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({
      enrollmentToken: z.string().min(10), machineGuid: z.string().min(8).max(100),
      hostname: z.string().min(1).max(255), agentVersion: z.string().max(40),
    }).parse(req.body);
    const client = await db.connect();
    let released = false;
    try {
      await client.query('BEGIN');
      const t = await client.query(
        `UPDATE enrollment_tokens SET uses = uses + 1
          WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() AND uses < max_uses
      RETURNING org_id, site_id, department_id`, [sha256Hex(b.enrollmentToken)]);
      if (!t.rowCount) { await client.query('ROLLBACK'); return reply.code(401).send({ error: 'invalid or expired enrollment token' }); }
      const { org_id: orgId, site_id, department_id } = t.rows[0];
      const secret = newSecret('vds');
      const dev = await client.query(
        `INSERT INTO devices(org_id,site_id,department_id,hostname,machine_guid,credential_hash,agent_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (org_id,machine_guid) DO UPDATE
            SET credential_hash=EXCLUDED.credential_hash, hostname=EXCLUDED.hostname, agent_version=EXCLUDED.agent_version,
                revoked_at=NULL, uninstalled_at=NULL, site_id=COALESCE(EXCLUDED.site_id, devices.site_id), department_id=COALESCE(EXCLUDED.department_id, devices.department_id)
      RETURNING id`, [orgId, site_id, department_id, b.hostname, b.machineGuid, sha256Hex(secret), b.agentVersion]);
      await client.query('COMMIT');
      client.release(); released = true;   // audit() needs its own connection; holding this one would deadlock a mass enrollment
      await audit({ orgId, actorType: 'device', actorId: dev.rows[0].id, action: 'device.enroll', targetType: 'device', targetId: dev.rows[0].id, next: { hostname: b.hostname }, ip: req.ip });
      return reply.code(201).send({ deviceId: dev.rows[0].id, deviceSecret: secret, heartbeatIntervalSeconds: 30, jobSigningPublicKey: cfg.signer.publicKeySpkiBase64, organizationId: orgId });
    } catch (e) { if (!released) await client.query('ROLLBACK'); throw e; } finally { if (!released) client.release(); }
  });

  const Metrics = z.object({
    cpuPercent: z.number().min(0).max(100).nullable().optional(),
    ramPercent: z.number().min(0).max(100).nullable().optional(),
    systemDiskFreeBytes: z.number().nonnegative().nullable().optional(),
    systemDiskTotalBytes: z.number().nonnegative().nullable().optional(),
    userIdleSeconds: z.number().nonnegative().nullable().optional(),
    onBattery: z.boolean().nullable().optional(),
  }).passthrough();

  app.post('/agent/v1/heartbeat', { preHandler: requireDevice }, async (req) => {
    const b = z.object({
      hostname: z.string().max(255), agentVersion: z.string().max(40), loggedInUser: z.string().max(255).nullable().optional(),
      ipAddress: z.string().max(64).nullable().optional(), osCaption: z.string().max(200).nullable().optional(),
      osBuild: z.string().max(40).nullable().optional(), uptimeSeconds: z.number().int().nonnegative().nullable().optional(),
      metrics: Metrics, observedAt: z.string().datetime().nullish(), network: z.array(AdapterSchema).max(8).optional(),
      integrity: z.object({ exeSha256: z.string().max(64).optional(), signed: z.boolean().optional(), signatureTrusted: z.boolean().optional(), signer: z.string().max(200).nullish(), serviceOk: z.boolean().nullish(), serviceIssue: z.string().max(300).nullish(), dataDirProtected: z.boolean().nullish(), installedPath: z.string().max(300).nullish() }).nullish(),
      updateResult: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), status: z.enum(['ok', 'rolled_back', 'failed']), detail: z.string().max(400).nullish() }).nullish(),
    }).parse(req.body);
    const { id, orgId } = req.device!;
    // The address this PC reaches the internet from (PCs behind one router share it) and its adapters: what Wake-on-LAN needs to find a helper on the same network.
    await db.query('UPDATE devices SET public_ip=$2, network=COALESCE($3::jsonb, network), network_at=CASE WHEN $3::jsonb IS NULL THEN network_at ELSE now() END WHERE id=$1', [id, req.ip, b.network ? JSON.stringify(b.network) : null]);
    await db.query(
      `UPDATE devices SET hostname=$3, agent_version=$4, logged_in_user=$5, ip_address=$6, os_caption=$7, os_build=$8,
              uptime_seconds=$9, last_seen_at=now() WHERE id=$1 AND org_id=$2`,
      [id, orgId, b.hostname, b.agentVersion, b.loggedInUser ?? null, b.ipAddress ?? null, b.osCaption ?? null, b.osBuild ?? null, b.uptimeSeconds ?? null]);
    // Replayed (queued-while-offline) samples keep their original time, but never from the future or older than 24h.
    const observed = b.observedAt ? new Date(b.observedAt).getTime() : NaN;
    const at = Number.isFinite(observed) && observed <= Date.now() && observed > Date.now() - 86_400_000 ? new Date(observed) : new Date();
    await db.query('INSERT INTO device_heartbeats(org_id,device_id,received_at,metrics) VALUES ($1,$2,$3,$4)', [orgId, id, at, JSON.stringify(b.metrics)]);
    if (b.uptimeSeconds != null) await db.query(`UPDATE alerts SET resolved_at=now() WHERE device_id=$1 AND code='device.restart_pending' AND resolved_at IS NULL AND first_seen_at < now() - make_interval(secs => $2)`, [id, b.uptimeSeconds]);
    // Bounded history: keep the newest 2880 samples (~1 day at 30s).
    await db.query('DELETE FROM device_heartbeats WHERE device_id=$1 AND id < (SELECT COALESCE(MIN(id),0) FROM (SELECT id FROM device_heartbeats WHERE device_id=$1 ORDER BY id DESC LIMIT 2880) t)', [id]);
    if (b.integrity) await db.query('UPDATE devices SET integrity=$2, integrity_at=now() WHERE id=$1', [id, JSON.stringify(b.integrity)]);
    if (b.updateResult) await recordUpdateEvent(db, orgId, id, { ...b.updateResult, detail: b.updateResult.detail ?? undefined });
    await evaluateIntegrity(db, orgId, id, b.agentVersion, b.integrity ?? undefined, cfg.requireTrustedSignature ?? false);
    const ring = (await db.query('SELECT update_ring FROM devices WHERE id=$1', [id])).rows[0]?.update_ring ?? 'stable';
    const update = await offerFor(db, { id, agentVersion: b.agentVersion, ring });
    const sessions = await pendingSessions(db, orgId, id);
    await ensureAnatomy(db, cfg.signer, orgId, id, b.agentVersion).catch(() => false);   // every PC, new or old, gets its anatomy without anyone asking
    const compute = await computeWanted(db, orgId).catch(() => ({ install: false }));
    return { ok: true, serverTime: new Date().toISOString(), update, sessions, compute, pollSeconds: sessions.length ? 3 : 30, ...(await jobsForHeartbeat(db, orgId, id)) };
  });

  app.put('/agent/v1/inventory', { preHandler: requireDevice }, async (req) => {
    const b = z.object({
      collectedAt: z.string().datetime(), hardware: z.record(z.string(), z.unknown()),
      software: z.array(z.object({ name: z.string(), version: z.string().nullish(), publisher: z.string().nullish(), installDate: z.string().nullish(), sizeBytes: z.number().int().min(0).nullish(), key: z.string().max(200).nullish(), hive: z.enum(['HKLM', 'HKLM32', 'HKCU']).nullish(), kind: z.enum(['msi', 'other']).nullish(), hidden: z.boolean().nullish() })).max(5000),
    }).parse(req.body);
    const { id, orgId } = req.device!;
    await db.query(
      `INSERT INTO device_inventory(device_id,org_id,hardware,software,collected_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (device_id) DO UPDATE SET hardware=EXCLUDED.hardware, software=EXCLUDED.software, collected_at=EXCLUDED.collected_at, received_at=now()`,
      [id, orgId, JSON.stringify(b.hardware), JSON.stringify(b.software), b.collectedAt]);
    await refreshSoftwareAlerts(db, orgId, id);
    await ensureBaseline(db, orgId, id, b.hardware, b.software.length);
    await trackHardware(db, orgId, id, b.hardware);
    return { ok: true };
  });

  app.put('/agent/v1/health', { preHandler: requireDevice }, async (req) => {
    const snap = SnapshotSchema.parse(req.body);
    const { id, orgId } = req.device!;
    await db.query(
      `INSERT INTO device_health(device_id,org_id,snapshot,collected_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (device_id) DO UPDATE SET snapshot=EXCLUDED.snapshot, collected_at=EXCLUDED.collected_at, received_at=now()`,
      [id, orgId, JSON.stringify(snap), snap.collectedAt]);
    const h = scoreHealth(snap, (await trendFor([id])).get(id), (await latestHardware(orgId, [id])).get(id)?.analysis);
    await db.query('INSERT INTO device_health_history(device_id,org_id,overall,categories,metrics) VALUES ($1,$2,$3,$4,$5)', [id, orgId, h.overall, JSON.stringify(h.categories), JSON.stringify(metricsOf(snap, h))]);
    await db.query('DELETE FROM device_health_history WHERE device_id=$1 AND id < (SELECT COALESCE(MIN(id),0) FROM (SELECT id FROM device_health_history WHERE device_id=$1 ORDER BY id DESC LIMIT 500) t)', [id]);
    await refreshAlerts(db, orgId, id, h);
    await recordBoots(db, orgId, id, snap);
    await maybeNotifyStorage(db, cfg.signer, orgId, id, h.deductions);
    await syncIncidents(db, orgId, id, snap, h);
    await completeBaseline(db, id, snap.startup ? snap.startup.length : null, h.overall);
    const fixes = new Map(h.deductions.filter(x => x.remedy === 'safe-fix' && x.fix).map(x => [x.code, x.fix!] as const));
    for (const r of (await db.query(`SELECT code, fix FROM incidents WHERE device_id=$1 AND status='REPAIR_READY' AND fix IS NOT NULL`, [id])).rows) fixes.set(r.code, r.fix);   // includes stability incidents
    await reactToHealth(db, cfg.signer, orgId, id, new Set(h.deductions.map(x => x.code)), new Date(), fixes);
    return { ok: true, overall: h.overall };
  });

  app.get('/api/v1/overview', { preHandler: requireRole('viewer') }, async req => {
    const dev = await db.query('SELECT id, last_seen_at FROM devices WHERE org_id=$1 AND revoked_at IS NULL', [req.user.org]);
    const hs = await db.query('SELECT device_id, snapshot FROM device_health WHERE org_id=$1', [req.user.org]);
    const snaps = new Map<string, Snapshot>(hs.rows.map(x => [x.device_id, x.snapshot]));
    const trends = await trendFor([...snaps.keys()]);
    const hws = await latestHardware(req.user.org);
    const counts = { healthy: 0, attention: 0, critical: 0, unassessed: 0 };
    const issues = new Map<string, { code: string; devices: number; example: string }>();
    let sum = 0, scored = 0, protectedN = 0, needSecurity = 0;
    for (const d of dev.rows) {
      const snap = snaps.get(d.id);
      if (!snap) { counts.unassessed++; continue; }
      const h = scoreHealth(snap, trends.get(d.id), hws.get(d.id)?.analysis);
      counts[h.status]++; sum += h.overall; scored++;
      if (h.categories.security >= 80) protectedN++; else needSecurity++;
      for (const x of h.deductions) { const i = issues.get(x.code) ?? { code: x.code, devices: 0, example: x.reason }; i.devices++; issues.set(x.code, i); }
    }
    const today = await db.query(
      `SELECT type, result FROM jobs WHERE org_id=$1 AND status='completed' AND finished_at >= date_trunc('day', now()) AND type IN ('repair.run','repair.fix-safe','cleanup.run')`, [req.user.org]);
    let resolved = 0, freed = 0;
    for (const j of today.rows) {
      const r = j.result as any; if (!r) continue;
      if (j.type === 'repair.run') { if (r.applied && r.verified === true) resolved++; freed += r.after?.freedBytes ?? 0; }
      else if (j.type === 'repair.fix-safe') { resolved += r.fixedCount ?? 0; for (const x of r.repairs ?? []) freed += x.after?.freedBytes ?? 0; }
      else if (j.type === 'cleanup.run') freed += r.freedBytes ?? 0;
    }
    return {
      today: { problemsResolved: resolved, storageRecoveredBytes: freed },
      alerts: Object.fromEntries((await db.query("SELECT severity, count(*)::int n FROM alerts WHERE org_id=$1 AND resolved_at IS NULL GROUP BY severity", [req.user.org])).rows.map(x => [x.severity, x.n])),
      alertsUnacknowledged: Object.fromEntries((await db.query("SELECT severity, count(*)::int n FROM alerts WHERE org_id=$1 AND resolved_at IS NULL AND acknowledged_at IS NULL GROUP BY severity", [req.user.org])).rows.map(x => [x.severity, x.n])),
      computers: dev.rowCount, online: dev.rows.filter(d => statusOf(d.last_seen_at) === 'online').length, ...counts,
      averageHealth: scored ? Math.round(sum / scored) : null,
      security: { protected: protectedN, needAttention: needSecurity },
      topIssues: [...issues.values()].sort((a, b) => b.devices - a.devices).slice(0, 8),
    };
  });

  /** Re-score one device from stored data (after a hardware diagnosis etc.) and refresh its alerts. */
  async function recompute(orgId: string, deviceId: string) {
    const hs = await db.query('SELECT snapshot FROM device_health WHERE device_id=$1', [deviceId]);
    if (!hs.rowCount) return;
    const h = scoreHealth(hs.rows[0].snapshot, (await trendFor([deviceId])).get(deviceId), (await latestHardware(orgId, [deviceId])).get(deviceId)?.analysis);
    await refreshAlerts(db, orgId, deviceId, h);
    await syncIncidents(db, orgId, deviceId, hs.rows[0].snapshot, h);
  }
  const healthOf = async (orgId: string, deviceId: string) => { const hs = await db.query('SELECT snapshot FROM device_health WHERE device_id=$1', [deviceId]); if (!hs.rowCount) return null; const snap = hs.rows[0].snapshot; return { snap, h: scoreHealth(snap, (await trendFor([deviceId])).get(deviceId), (await latestHardware(orgId, [deviceId])).get(deviceId)?.analysis) }; };
  const hardwareRawOf = async (orgId: string, deviceId: string) => (await latestHardware(orgId, [deviceId])).get(deviceId)?.raw ?? null;
  const jobCtx = { db, signer: cfg.signer, requireRole, requireDevice, audit, atLeast, afterJob: async (orgId: string, deviceId: string, type: string, status: string, result?: unknown, jobId?: string) => { if (jobId) await onJobFinished(db, cfg.signer, orgId, deviceId, jobId, type, status, result); if (type === 'hardware.diagnose' && status === 'completed') await recordHardwareReading(db, orgId, deviceId, result);
    if (type === 'hardware.diagnose' || type === 'health.check') await recompute(orgId, deviceId); if (type === 'updates.install' && status === 'completed') await afterUpdateInstall(db, cfg.signer, orgId, deviceId, result); } };
  registerReleaseRoutes(app, { db, signer: cfg.signer, platformKey: cfg.platformKey, releasesDir: cfg.releasesDir ?? join(tmpdir(), 'viro-releases'), requireDevice, safeEq, audit });
  registerInstallerRoutes(app, jobCtx, { platformGuard: (app as any).platformGuard, releasesDir: cfg.releasesDir ?? join(tmpdir(), 'viro-releases'), platformKey: cfg.platformKey, safeEq });
  /** A clean uninstall tells Control, so a device that just disappears can be told apart from one that was removed on purpose. */
  app.post('/agent/v1/goodbye', { preHandler: requireDevice }, async (req) => {
    const { id, orgId } = req.device!;
    await db.query('UPDATE devices SET revoked_at=now(), uninstalled_at=now() WHERE id=$1', [id]);
    await db.query(`UPDATE jobs SET status='cancelled', finished_at=now(), error='agent was uninstalled' WHERE device_id=$1 AND status IN ('queued','running')`, [id]);
    await db.query(`UPDATE alerts SET resolved_at=now() WHERE device_id=$1 AND resolved_at IS NULL`, [id]);
    await audit({ orgId, actorType: 'device', actorId: id, action: 'device.uninstalled', targetType: 'device', targetId: id, ip: req.ip });
    return { ok: true };
  });
  (app as any).platformKeyOk = (k: string) => !!cfg.platformKey && safeEq(k, cfg.platformKey);
  registerTwinRoutes(app, jobCtx, { healthOf, hardwareRawOf, onlineWindowSeconds: onlineWindow });
  registerBillingRoutes(app, jobCtx);
  registerPlatformOps(app, { db, jwtSecret: cfg.jwtSecret, onlineWindowSeconds: onlineWindow, audit });
  registerAccountRoutes(app, { ...jobCtx, jwtSecret: cfg.jwtSecret, invalidateUser: id => userCache.delete(id) });
  registerJobRoutes(app, jobCtx);
  registerComputeRoutes(app, { ...jobCtx, onlineWindowSeconds: onlineWindow, releasesDir: cfg.releasesDir ?? join(tmpdir(), 'viro-releases') });
  registerSupportRoutes(app, jobCtx);
  registerPolicyRoutes(app, jobCtx);
  registerAlertRoutes(app, jobCtx);
  registerWebhookRoutes(app, jobCtx);
  registerAutopilotRoutes(app, jobCtx);
  registerSummaryRoutes(app, jobCtx);
  registerBenchmarkRoutes(app, jobCtx);
  registerFleetIntelRoutes(app, { ...jobCtx, signer: cfg.signer });
  registerLifecycleRoutes(app, jobCtx, { healthOf, hardwareRawOf });
  registerProtectionRoutes(app, { ...jobCtx, signer: cfg.signer });
  registerOutcomeRoutes(app, jobCtx);
  registerCareRoutes(app, { ...jobCtx, signer: cfg.signer });
  registerSelfRoutes(app, jobCtx, { healthOf });
  registerSecurityIncidentRoutes(app, { ...jobCtx, signer: cfg.signer });
  registerPassportRoutes(app, jobCtx);
  registerHistoryRoutes(app, jobCtx);
  const mailer = createMailer(db); app.decorate('mailer', mailer);
  registerMyPcRoutes(app, jobCtx);
  registerMoveRoutes(app, jobCtx, { dir: process.env.MOVE_DIR || join(tmpdir(), 'viro-move') });
  registerHelpRoutes(app, jobCtx, { mailer, inbox: process.env.HELP_INBOX || undefined });
  registerSignupRoutes(app, jobCtx, { mailer, baseUrl: process.env.PUBLIC_BASE_URL || 'https://control.viro3.online' });
  registerCertificateRoutes(app, jobCtx, { mailer, signer: CertSigner.load(), baseUrl: process.env.PUBLIC_BASE_URL || 'https://control.viro3.online' });
  registerIncidentRoutes(app, { ...jobCtx, signer: cfg.signer }, { healthOf });
  registerFleetRoutes(app, jobCtx);
  registerWakeRoutes(app, jobCtx as any, onlineWindow);
  registerAnatomyRoutes(app, jobCtx as any);
  registerUpgradeRoutes(app, jobCtx as any);
  registerPatchingRoutes(app, jobCtx);
  registerReportRoutes(app, jobCtx, orgId => listDevices(orgId));

  /** Fleet storage recovery: latest completed cleanup.preview per device, summed by category. Optional site/department filter. */
  app.get('/api/v1/storage/recovery', { preHandler: requireRole('viewer') }, async (req) => {
    const f = z.object({ siteId: z.string().uuid().optional(), departmentId: z.string().uuid().optional() }).parse(req.query);
    const vals: unknown[] = [req.user.org]; let extra = '';
    if (f.siteId) { vals.push(f.siteId); extra += ` AND d.site_id=$${vals.length}`; }
    if (f.departmentId) { vals.push(f.departmentId); extra += ` AND d.department_id=$${vals.length}`; }
    const r = await db.query(
      `SELECT DISTINCT ON (j.device_id) j.device_id, d.hostname, j.result, j.finished_at
         FROM jobs j JOIN devices d ON d.id=j.device_id
        WHERE j.org_id=$1 AND j.type='cleanup.preview' AND j.status='completed' AND j.result IS NOT NULL AND d.revoked_at IS NULL${extra}
        ORDER BY j.device_id, j.finished_at DESC`, vals);
    const totalDevices = (await db.query(`SELECT count(*)::int n FROM devices d WHERE d.org_id=$1 AND d.revoked_at IS NULL${extra}`, vals)).rows[0].n;
    const cats = new Map<string, { id: string; title: string; class: string; bytes: number; devices: number }>();
    const perDevice: { deviceId: string; hostname: string; safeBytes: number; reviewBytes: number; scannedAt: string }[] = [];
    let safe = 0, review = 0;
    for (const row of r.rows) {
      const res = row.result as any; let s = 0, rv = 0;
      for (const c of res?.categories ?? []) {
        const e = cats.get(c.id) ?? { id: c.id, title: c.title, class: c.class, bytes: 0, devices: 0 };
        e.bytes += c.bytesFound ?? 0; if ((c.bytesFound ?? 0) > 0) e.devices++; cats.set(c.id, e);
        if (c.class === 'SAFE') s += c.bytesFound ?? 0; else rv += c.bytesFound ?? 0;
      }
      safe += s; review += rv; perDevice.push({ deviceId: row.device_id, hostname: row.hostname, safeBytes: s, reviewBytes: rv, scannedAt: row.finished_at });
    }
    return {
      devicesScanned: r.rowCount, devicesTotal: totalDevices, safeBytes: safe, reviewBytes: review,
      categories: [...cats.values()].sort((x, y) => y.bytes - x.bytes),
      topDevices: perDevice.sort((x, y) => y.safeBytes - x.safeBytes).slice(0, 10),
      personalDataNeverTouched: PERSONAL_NEVER_TOUCHED,
    };
  });

  /** Viro Shield fleet view: every assessed computer's protection state with the reasons. */
  app.get('/api/v1/security/overview', { preHandler: requireRole('viewer') }, async req => {
    const rows = await listDevices(req.user.org);
    const hs = await db.query('SELECT device_id, snapshot FROM device_health WHERE org_id=$1', [req.user.org]);
    const snaps = new Map<string, Snapshot>(hs.rows.map(x => [x.device_id, x.snapshot]));
    const out = { protected: 0, attention: 0, atRisk: 0, unknown: 0, activeThreats: 0 };
    const engines: Record<string, number> = {};
    const devices: any[] = [];
    for (const d of rows) {
      const snap = snaps.get(d.id);
      if (!snap) { out.unknown++; continue; }
      const sh = shieldOf(snap);
      if (sh.state === 'protected') out.protected++; else if (sh.state === 'attention') out.attention++; else if (sh.state === 'at-risk') out.atRisk++; else out.unknown++;
      out.activeThreats += sh.threats;
      engines[sh.engine ?? 'none'] = (engines[sh.engine ?? 'none'] ?? 0) + 1;
      devices.push({ id: d.id, hostname: d.hostname, state: sh.state, engine: sh.engine, reasons: sh.reasons, threats: sh.threats, signatureAgeDays: sh.signatureAgeDays, lastScanAt: sh.lastScanAt, firewall: sh.firewall });
    }
    const rank: Record<string, number> = { 'at-risk': 0, attention: 1, unknown: 2, protected: 3 };
    return { ...out, unassessed: rows.length - snaps.size, engines, devices: devices.sort((x, y) => rank[x.state] - rank[y.state] || x.hostname.localeCompare(y.hostname)) };
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err?.name === 'ZodError') return reply.code(400).send({ error: 'invalid request', details: err.issues });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });

  return app;
}
