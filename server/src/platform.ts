import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import { hashPassword, sha256Hex, verifyPassword } from './security.js';
import { ensureAutopilot } from './autopilot.js';
import { miningAudit } from './mining-reporting.js';
import { checkSecondFactor } from './account.js';

/**
 * The platform side: the operator of this service (our organization) managing the organizations that use it. Separate accounts, separate sign-in and a separate token
 * from every organization's people; an organization's token can never reach these routes, and a platform token can never act inside an organization.
 * Automation (publishing the installer, creating organizations from a script) can still use the platform key.
 */
interface Deps {
  db: Db; platformKey?: string; safeEq: (a: string, b: string) => boolean; onlineWindowSeconds: number;
  audit: (e: { orgId: string | null; actorType: 'user' | 'device' | 'system'; actorId?: string; action: string; targetType?: string; targetId?: string; previous?: unknown; next?: unknown; result?: string; ip?: string }) => Promise<void>;
  loginRateLimitPerMinute?: number;
  jwtSecret?: string;
  /** Called when an organization is suspended or resumed, so this server stops trusting what it remembered about it. */
  invalidate?: (orgId: string) => void;
}

export interface PlatformActor { id: string; email: string | null; via: 'login' | 'key' }
declare module 'fastify' { interface FastifyRequest { platform?: PlatformActor } }

export function registerPlatformRoutes(app: FastifyInstance, d: Deps) {
  const { db, audit } = d;

  /** Accepts a platform operator's token, or the platform key (for scripts). An organization's token is refused. */
  const platformGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    const key = String(req.headers['x-platform-key'] ?? '');
    if (key) {
      if (d.platformKey && d.safeEq(key, d.platformKey)) { req.platform = { id: 'key', email: null, via: 'key' }; return; }
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'unauthenticated' }); }
    const t = req.user as unknown as { sub: string; platform?: boolean };
    if (t.platform !== true) return reply.code(403).send({ error: 'forbidden' });
    const u = (await db.query('SELECT id, email FROM platform_users WHERE id=$1 AND disabled_at IS NULL', [t.sub])).rows[0];
    if (!u) return reply.code(401).send({ error: 'unauthenticated' });
    req.platform = { id: u.id, email: u.email, via: 'login' };
  };
  (app as any).platformGuard = platformGuard;
  const actor = (req: FastifyRequest) => req.platform!.via === 'key' ? 'platform:key' : 'platform:' + req.platform!.id;
  const log = (req: FastifyRequest, orgId: string | null, action: string, targetId?: string, next?: unknown, previous?: unknown) =>
    audit({ orgId, actorType: 'user', actorId: actor(req), action: 'platform.' + action, targetType: 'organization', targetId, next, previous, ip: req.ip });

  // ---- sign-in -----------------------------------------------------------------------------------------------------------
  app.post('/api/v1/platform/auth/login', { config: { rateLimit: { max: d.loginRateLimitPerMinute ?? 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ email: z.string(), password: z.string(), code: z.string().max(40).nullish() }).parse(req.body);
    const u = (await db.query('SELECT id, name, password_hash, mfa_secret_enc, mfa_last_step, mfa_locked_until FROM platform_users WHERE email=lower($1) AND disabled_at IS NULL', [b.email])).rows[0];
    const ok = u ? await verifyPassword(b.password, u.password_hash) : (await hashPassword('x'), false);
    if (!ok) { await audit({ orgId: null, actorType: 'user', actorId: 'platform:' + b.email.toLowerCase(), action: 'platform.auth.login', result: 'denied', ip: req.ip }); return reply.code(401).send({ error: 'invalid credentials' }); }
    if (u.mfa_secret_enc) {
      if (!b.code) return reply.code(401).send({ error: 'mfa_required', mfa: true });
      const f = await checkSecondFactor(db, u, b.code, d.jwtSecret ?? '', 'platform');
      if (f !== 'ok') { await audit({ orgId: null, actorType: 'user', actorId: 'platform:' + u.id, action: 'platform.auth.login', result: 'denied', ip: req.ip }); return reply.code(f === 'locked' ? 423 : 401).send({ error: f === 'locked' ? 'too many wrong codes; try again in a few minutes' : 'that code is not right', mfa: true }); }
    }
    await db.query('UPDATE platform_users SET last_login_at=now() WHERE id=$1', [u.id]);
    await audit({ orgId: null, actorType: 'user', actorId: 'platform:' + u.id, action: 'platform.auth.login', ip: req.ip });
    return { token: (app as any).jwt.sign({ sub: u.id, platform: true }, { expiresIn: '8h' }), name: u.name };
  });

  app.get('/api/v1/platform/me', { preHandler: platformGuard }, async req => ({ via: req.platform!.via, email: req.platform!.email }));

  // ---- overview ----------------------------------------------------------------------------------------------------------
  app.get('/api/v1/platform/overview', { preHandler: platformGuard }, async () => {
    const o = (await db.query(`SELECT count(*)::int total, count(*) FILTER (WHERE suspended_at IS NULL)::int active, count(*) FILTER (WHERE suspended_at IS NOT NULL)::int suspended FROM organizations`)).rows[0];
    const dv = (await db.query(`SELECT count(*)::int total, count(*) FILTER (WHERE last_seen_at > now() - make_interval(secs => $1))::int online FROM devices WHERE revoked_at IS NULL AND uninstalled_at IS NULL`, [d.onlineWindowSeconds])).rows[0];
    const users = (await db.query('SELECT count(*)::int n FROM users')).rows[0].n;
    const recent = (await db.query(`SELECT count(*)::int n FROM organizations WHERE created_at > now() - interval '30 days'`)).rows[0].n;
    return { organizations: o, devices: dv, organizationAdmins: users, newOrganizations30d: recent };
  });

  // ---- organizations -----------------------------------------------------------------------------------------------------
  app.get('/api/v1/platform/organizations', { preHandler: platformGuard }, async () => {
    const r = await db.query(
      `SELECT o.id, o.name, o.plan, o.created_at, o.suspended_at, o.suspended_reason,
              (SELECT count(*)::int FROM devices d WHERE d.org_id=o.id AND d.revoked_at IS NULL AND d.uninstalled_at IS NULL) devices,
              (SELECT count(*)::int FROM devices d WHERE d.org_id=o.id AND d.revoked_at IS NULL AND d.uninstalled_at IS NULL AND d.last_seen_at > now() - make_interval(secs => $1)) online,
              (SELECT count(*)::int FROM users u WHERE u.org_id=o.id) users,
              (SELECT u.email FROM users u WHERE u.org_id=o.id AND u.role='owner' ORDER BY u.created_at LIMIT 1) owner_email,
              (SELECT max(a.at) FROM audit_log a WHERE a.org_id=o.id AND a.action='auth.login' AND a.result='ok') last_admin_login
         FROM organizations o ORDER BY o.created_at DESC`, [d.onlineWindowSeconds]);
    return { organizations: r.rows };
  });

  app.post('/api/v1/platform/organizations', { preHandler: platformGuard }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(120), ownerEmail: z.string().email(), ownerPassword: z.string().min(12).max(200),
      plan: z.enum(['standard', 'compute_sponsored']).default('standard'), autopilot: z.boolean().default(true),
    }).parse(req.body);
    const client = await db.connect(); let released = false;
    try {
      await client.query('BEGIN');
      const org = await client.query('INSERT INTO organizations(name,plan) VALUES ($1,$2) RETURNING id', [body.name, body.plan]);
      const orgId = org.rows[0].id as string;
      const u = await client.query('INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,lower($2),$3,\'owner\') RETURNING id', [orgId, body.ownerEmail, await hashPassword(body.ownerPassword)]);
      await client.query('COMMIT'); client.release(); released = true;
      if (body.autopilot) await ensureAutopilot(db, orgId, { id: u.rows[0].id });
      await log(req, orgId, 'organization.create', orgId, { name: body.name, plan: body.plan, owner: body.ownerEmail.toLowerCase() });
      if (body.plan === 'compute_sponsored') await miningAudit(db, { orgId, actorType: 'platform', actorLabel: 'platform operator', action: 'plan.change', previous: null, next: { plan: body.plan }, reasons: ['organization created on the compute_sponsored plan'] });
      return reply.code(201).send({ organizationId: orgId, ownerUserId: u.rows[0].id });
    } catch (e: any) {
      if (!released) await client.query('ROLLBACK');
      if (e.code === '23505') return reply.code(409).send({ error: 'that email is already registered' });
      throw e;
    } finally { if (!released) client.release(); }
  });

  const orgParam = z.object({ id: z.string().uuid() });
  const orgOr404 = async (id: string) => (await db.query('SELECT id, name, suspended_at FROM organizations WHERE id=$1', [id])).rows[0] as { id: string; name: string; suspended_at: Date | null } | undefined;

  app.post('/api/v1/platform/organizations/:id/suspend', { preHandler: platformGuard }, async (req, reply) => {
    const { id } = orgParam.parse(req.params); const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(req.body);
    if (!await orgOr404(id)) return reply.code(404).send({ error: 'organization not found' });
    await db.query('UPDATE organizations SET suspended_at=now(), suspended_reason=$2 WHERE id=$1 AND suspended_at IS NULL', [id, reason]);
    d.invalidate?.(id); await log(req, id, 'organization.suspend', id, { reason });
    return { suspended: true };
  });
  app.post('/api/v1/platform/organizations/:id/resume', { preHandler: platformGuard }, async (req, reply) => {
    const { id } = orgParam.parse(req.params);
    if (!await orgOr404(id)) return reply.code(404).send({ error: 'organization not found' });
    await db.query('UPDATE organizations SET suspended_at=NULL, suspended_reason=NULL WHERE id=$1', [id]);
    d.invalidate?.(id); await log(req, id, 'organization.resume', id);
    return { suspended: false };
  });

  // The people who run one organization (owners, admins, technicians, viewers). The platform can add the first owner back or reset a locked-out admin; it cannot read passwords.
  app.get('/api/v1/platform/organizations/:id/users', { preHandler: platformGuard }, async (req, reply) => {
    const { id } = orgParam.parse(req.params); if (!await orgOr404(id)) return reply.code(404).send({ error: 'organization not found' });
    return { users: (await db.query('SELECT id, email, role, created_at FROM users WHERE org_id=$1 ORDER BY created_at', [id])).rows };
  });
  app.post('/api/v1/platform/organizations/:id/users', { preHandler: platformGuard }, async (req, reply) => {
    const { id } = orgParam.parse(req.params); if (!await orgOr404(id)) return reply.code(404).send({ error: 'organization not found' });
    const b = z.object({ email: z.string().email(), password: z.string().min(12).max(200), role: z.enum(['owner', 'admin', 'technician', 'viewer']).default('admin') }).parse(req.body);
    try {
      const u = await db.query('INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,lower($2),$3,$4) RETURNING id', [id, b.email, await hashPassword(b.password), b.role]);
      await log(req, id, 'organization.user.create', u.rows[0].id, { email: b.email.toLowerCase(), role: b.role });
      return reply.code(201).send({ userId: u.rows[0].id });
    } catch (e: any) { if (e.code === '23505') return reply.code(409).send({ error: 'that email is already registered' }); throw e; }
  });
  app.post('/api/v1/platform/organizations/:id/users/:uid/reset-password', { preHandler: platformGuard }, async (req, reply) => {
    const { id, uid } = z.object({ id: z.string().uuid(), uid: z.string().uuid() }).parse(req.params); const { password } = z.object({ password: z.string().min(12).max(200) }).parse(req.body);
    const r = await db.query('UPDATE users SET password_hash=$3 WHERE id=$2 AND org_id=$1 RETURNING email', [id, uid, await hashPassword(password)]);
    if (!r.rowCount) return reply.code(404).send({ error: 'user not found in that organization' });
    await log(req, id, 'organization.user.reset-password', uid, { email: r.rows[0].email });
    return { reset: true };
  });

  // ---- platform operators (the second tier of "our admins") ----------------------------------------------------------------
  app.get('/api/v1/platform/admins', { preHandler: platformGuard }, async () => ({ admins: (await db.query('SELECT id, email, name, disabled_at, created_at, last_login_at, (mfa_enabled_at IS NOT NULL) AS mfa FROM platform_users ORDER BY created_at')).rows }));
  app.post('/api/v1/platform/admins', { preHandler: platformGuard }, async (req, reply) => {
    const b = z.object({ email: z.string().email(), name: z.string().max(120).default(''), password: z.string().min(12).max(200) }).parse(req.body);
    try {
      const r = await db.query('INSERT INTO platform_users(email,name,password_hash) VALUES (lower($1),$2,$3) RETURNING id', [b.email, b.name, await hashPassword(b.password)]);
      await log(req, null, 'admin.create', r.rows[0].id, { email: b.email.toLowerCase() });
      return reply.code(201).send({ adminId: r.rows[0].id });
    } catch (e: any) { if (e.code === '23505') return reply.code(409).send({ error: 'that email is already a platform admin' }); throw e; }
  });
  app.post('/api/v1/platform/admins/:id/disable', { preHandler: platformGuard }, async (req, reply) => {
    const { id } = orgParam.parse(req.params);
    if (req.platform!.id === id) return reply.code(409).send({ error: 'you cannot disable your own account' });
    const left = (await db.query('SELECT count(*)::int n FROM platform_users WHERE disabled_at IS NULL AND id<>$1', [id])).rows[0].n;
    if (left < 1) return reply.code(409).send({ error: 'at least one platform admin must stay active' });
    const r = await db.query('UPDATE platform_users SET disabled_at=now() WHERE id=$1 AND disabled_at IS NULL RETURNING email', [id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'admin not found or already disabled' });
    await log(req, null, 'admin.disable', id, { email: r.rows[0].email });
    return { disabled: true };
  });
  app.post('/api/v1/platform/admins/:id/enable', { preHandler: platformGuard }, async (req, reply) => {
    const { id } = orgParam.parse(req.params);
    const r = await db.query('UPDATE platform_users SET disabled_at=NULL WHERE id=$1 RETURNING email', [id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'admin not found' });
    await log(req, null, 'admin.enable', id, { email: r.rows[0].email });
    return { disabled: false };
  });

  // ---- what the platform did ---------------------------------------------------------------------------------------------
  app.get('/api/v1/platform/audit', { preHandler: platformGuard }, async req => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const r = await db.query(`SELECT a.id, a.at, a.actor_id, a.action, a.target_id, a.next, a.result, a.org_id, o.name org_name FROM audit_log a LEFT JOIN organizations o ON o.id=a.org_id WHERE a.action LIKE 'platform.%' ORDER BY a.id DESC LIMIT $1`, [q.limit]);
    return { events: r.rows };
  });
}

/** Creates the first platform administrator from the environment when none exists, so a fresh server can be signed into. */
export async function ensureFirstPlatformAdmin(db: Db, email?: string, password?: string): Promise<'created' | 'exists' | 'skipped'> {
  if ((await db.query('SELECT 1 FROM platform_users LIMIT 1')).rowCount) return 'exists';
  if (!email || !password) return 'skipped';
  if (password.length < 12) throw new Error('PLATFORM_ADMIN_PASSWORD must be at least 12 characters');
  await db.query('INSERT INTO platform_users(email,name,password_hash) VALUES (lower($1),$2,$3) ON CONFLICT DO NOTHING', [email, 'Platform admin', await hashPassword(password)]);
  return 'created';
}
void sha256Hex;
