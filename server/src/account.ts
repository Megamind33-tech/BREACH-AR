import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { JobCtx } from './jobs.js';
import type { Db } from './db.js';
import { hashPassword, verifyPassword, type Role } from './security.js';
import { hashRecovery, newRecoveryCodes, newTotpSecret, openSecret, otpauthUri, sealSecret, verifyTotp } from './totp.js';

/* ------------------------------------------------------------------------------------------------
 * Organization administration: the people who use the console, their sign-in security (TOTP MFA + recovery codes, optional enforcement),
 * organization settings, and the recorded consent for compute sponsorship. Every change is written to the audit log.
 * ---------------------------------------------------------------------------------------------- */

export const MFA_ROLES: Role[] = ['owner', 'admin', 'technician'];     // the roles an organization can require MFA for
const MAX_FAILS = 5, LOCK_MINUTES = 5;

export const CONSENT = {
  version: '2026-10-01',
  text: [
    'Compute sponsorship lets this organization use the idle processing power of its enrolled PCs.',
    'It runs only when nobody is using the PC, within the CPU, memory and temperature limits the organization sets, and stops at once when a person returns, on battery, during maintenance, or when a health or security problem is found.',
    'The organization chooses the workload and the pool or account that receives the result; the people who use each PC are told, in plain words, the first time it runs.',
    'It can be turned off at any time from the Compute page, and every change to it is recorded in the audit log.',
  ].join('\n\n'),
};
const consentHash = () => createHash('sha256').update(CONSENT.version + '\n' + CONSENT.text).digest('hex');

/** Result of checking a second factor at sign-in. A used recovery code is consumed. */
const FACTOR_TABLES = { org: { users: 'users', codes: 'mfa_recovery_codes' }, platform: { users: 'platform_users', codes: 'platform_recovery_codes' } } as const;
export async function checkSecondFactor(db: Db, u: { id: string; mfa_secret_enc: string; mfa_last_step: string | null; mfa_locked_until: Date | null }, code: string, serverSecret: string, kind: keyof typeof FACTOR_TABLES = 'org'): Promise<'ok' | 'bad' | 'locked'> {
  const T = FACTOR_TABLES[kind];
  if (u.mfa_locked_until && new Date(u.mfa_locked_until).getTime() > Date.now()) return 'locked';
  const fail = async () => {
    const r = await db.query(`UPDATE ${T.users} SET mfa_failed=mfa_failed+1 WHERE id=$1 RETURNING mfa_failed`, [u.id]);
    if (r.rows[0].mfa_failed >= MAX_FAILS) await db.query(`UPDATE ${T.users} SET mfa_failed=0, mfa_locked_until=now() + make_interval(mins => $2::int) WHERE id=$1`, [u.id, LOCK_MINUTES]);
    return 'bad' as const;
  };
  const c = code.trim();
  if (/^\d{6}$/.test(c)) {
    const step = verifyTotp(openSecret(u.mfa_secret_enc, serverSecret), c, Date.now(), u.mfa_last_step == null ? null : Number(u.mfa_last_step));
    if (step == null) return fail();
    // The conditional update makes "use this step once" safe even if two sign-ins race.
    const r = await db.query(`UPDATE ${T.users} SET mfa_last_step=$2, mfa_failed=0 WHERE id=$1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)`, [u.id, step]);
    return r.rowCount ? 'ok' : fail();
  }
  const r = await db.query(`UPDATE ${T.codes} SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL`, [u.id, hashRecovery(c)]);
  if (r.rowCount) { await db.query(`UPDATE ${T.users} SET mfa_failed=0 WHERE id=$1`, [u.id]); return 'ok'; }
  return fail();
}

export function registerAccountRoutes(app: FastifyInstance, c: JobCtx & { jwtSecret: string; invalidateUser: (id: string) => void }) {
  const { db, audit, atLeast } = c;
  const viewer = c.requireRole('viewer'), admin = c.requireRole('admin'), owner = c.requireRole('owner');
  const roleEnum = z.enum(['owner', 'admin', 'technician', 'viewer']);
  const uuid = z.string().uuid();
  const me = (req: any) => ({ orgId: req.user.org as string, id: req.user.sub as string, role: req.user.role as Role });

  async function mustBeYou(userId: string, password: string): Promise<boolean> {
    const r = await db.query('SELECT password_hash FROM users WHERE id=$1', [userId]);
    return !!r.rows[0] && verifyPassword(password, r.rows[0].password_hash);
  }
  async function issueRecovery(userId: string): Promise<string[]> {
    const codes = newRecoveryCodes();
    await db.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
    for (const code of codes) await db.query('INSERT INTO mfa_recovery_codes(user_id, code_hash) VALUES ($1,$2)', [userId, hashRecovery(code)]);
    return codes;
  }

  // ---------------- my account ----------------
  app.get('/api/v1/account', { preHandler: viewer }, async req => {
    const { id, orgId } = me(req);
    const u = (await db.query('SELECT email, role, mfa_enabled_at, last_login_at FROM users WHERE id=$1', [id])).rows[0];
    const rem = (await db.query('SELECT count(*)::int n FROM mfa_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [id])).rows[0].n;
    const o = (await db.query('SELECT require_mfa FROM organizations WHERE id=$1', [orgId])).rows[0];
    return { email: u.email, role: u.role, lastLoginAt: u.last_login_at, mfa: { enabled: !!u.mfa_enabled_at, enabledAt: u.mfa_enabled_at, recoveryCodesLeft: rem }, orgRequiresMfa: o.require_mfa && MFA_ROLES.includes(u.role), mfaSetupRequired: !!(req.user as any).mfaSetup };
  });

  app.post('/api/v1/account/password', { preHandler: viewer }, async (req, reply) => {
    const b = z.object({ current: z.string(), next: z.string().min(12).max(200) }).strict().parse(req.body); const { id, orgId } = me(req);
    if (!(await mustBeYou(id, b.current))) return reply.code(403).send({ error: 'the current password is not correct' });
    await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [id, await hashPassword(b.next)]);
    await audit({ orgId, actorType: 'user', actorId: id, action: 'user.password', targetType: 'user', targetId: id });
    return { ok: true };
  });

  app.post('/api/v1/account/mfa/setup', { preHandler: viewer }, async (req, reply) => {
    const b = z.object({ password: z.string() }).strict().parse(req.body); const { id } = me(req);
    const u = (await db.query('SELECT email, mfa_enabled_at FROM users WHERE id=$1', [id])).rows[0];
    if (u.mfa_enabled_at) return reply.code(409).send({ error: 'two-step sign-in is already on' });
    if (!(await mustBeYou(id, b.password))) return reply.code(403).send({ error: 'the password is not correct' });
    const secret = newTotpSecret();
    await db.query('UPDATE users SET mfa_pending_enc=$2 WHERE id=$1', [id, sealSecret(secret, c.jwtSecret)]);
    return { secret, uri: otpauthUri('Viro WorkCare', u.email, secret) };
  });

  app.post('/api/v1/account/mfa/enable', { preHandler: viewer }, async (req, reply) => {
    const b = z.object({ code: z.string().regex(/^\d{6}$/, 'enter the 6-digit code from your authenticator app') }).strict().parse(req.body); const { id, orgId, role } = me(req);
    const u = (await db.query('SELECT mfa_pending_enc, mfa_enabled_at FROM users WHERE id=$1', [id])).rows[0];
    if (u.mfa_enabled_at) return reply.code(409).send({ error: 'two-step sign-in is already on' });
    if (!u.mfa_pending_enc) return reply.code(409).send({ error: 'start the setup first' });
    const step = verifyTotp(openSecret(u.mfa_pending_enc, c.jwtSecret), b.code);
    if (step == null) return reply.code(400).send({ error: 'that code is not right; check the time on your phone and try the next code' });
    await db.query('UPDATE users SET mfa_secret_enc=mfa_pending_enc, mfa_pending_enc=NULL, mfa_enabled_at=now(), mfa_last_step=$2, mfa_failed=0, mfa_locked_until=NULL WHERE id=$1', [id, step]);
    const codes = await issueRecovery(id);
    await audit({ orgId, actorType: 'user', actorId: id, action: 'user.mfa.enable', targetType: 'user', targetId: id });
    // Signing in again is not needed: a fresh token without the "set up MFA first" limit replaces the old one.
    return { recoveryCodes: codes, token: app.jwt.sign({ sub: id, org: orgId, role }) };
  });

  app.post('/api/v1/account/mfa/disable', { preHandler: viewer }, async (req, reply) => {
    const b = z.object({ password: z.string(), code: z.string() }).strict().parse(req.body); const { id, orgId, role } = me(req);
    const u = (await db.query('SELECT mfa_secret_enc, mfa_last_step, mfa_locked_until FROM users WHERE id=$1', [id])).rows[0];
    if (!u.mfa_secret_enc) return reply.code(409).send({ error: 'two-step sign-in is not on' });
    if ((await db.query('SELECT require_mfa FROM organizations WHERE id=$1', [orgId])).rows[0].require_mfa && MFA_ROLES.includes(role)) return reply.code(409).send({ error: 'your organization requires two-step sign-in for your role' });
    if (!(await mustBeYou(id, b.password))) return reply.code(403).send({ error: 'the password is not correct' });
    const f = await checkSecondFactor(db, { id, ...u }, b.code, c.jwtSecret);
    if (f !== 'ok') return reply.code(f === 'locked' ? 423 : 403).send({ error: f === 'locked' ? 'too many wrong codes; try again in a few minutes' : 'that code is not right' });
    await db.query('UPDATE users SET mfa_secret_enc=NULL, mfa_pending_enc=NULL, mfa_enabled_at=NULL, mfa_last_step=NULL WHERE id=$1', [id]);
    await db.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [id]);
    await audit({ orgId, actorType: 'user', actorId: id, action: 'user.mfa.disable', targetType: 'user', targetId: id });
    return { ok: true };
  });

  app.post('/api/v1/account/mfa/recovery-codes', { preHandler: viewer }, async (req, reply) => {
    const b = z.object({ password: z.string(), code: z.string() }).strict().parse(req.body); const { id, orgId } = me(req);
    const u = (await db.query('SELECT mfa_secret_enc, mfa_last_step, mfa_locked_until FROM users WHERE id=$1', [id])).rows[0];
    if (!u.mfa_secret_enc) return reply.code(409).send({ error: 'two-step sign-in is not on' });
    if (!(await mustBeYou(id, b.password))) return reply.code(403).send({ error: 'the password is not correct' });
    const f = await checkSecondFactor(db, { id, ...u }, b.code, c.jwtSecret);
    if (f !== 'ok') return reply.code(f === 'locked' ? 423 : 403).send({ error: f === 'locked' ? 'too many wrong codes; try again in a few minutes' : 'that code is not right' });
    const codes = await issueRecovery(id);
    await audit({ orgId, actorType: 'user', actorId: id, action: 'user.mfa.recovery-codes', targetType: 'user', targetId: id });
    return { recoveryCodes: codes };
  });

  // ---------------- people ----------------
  app.get('/api/v1/users', { preHandler: admin }, async req => {
    const r = await db.query(
      `SELECT id, email, role, created_at, disabled_at, last_login_at, (mfa_enabled_at IS NOT NULL) AS mfa FROM users WHERE org_id=$1 ORDER BY created_at`, [me(req).orgId]);
    const o = (await db.query('SELECT require_mfa FROM organizations WHERE id=$1', [me(req).orgId])).rows[0];
    return { users: r.rows, requireMfa: o.require_mfa };
  });

  app.post('/api/v1/users', { preHandler: admin }, async (req, reply) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(12).max(200), role: roleEnum }).parse(req.body);
    const m = me(req);
    if (!atLeast(m.role, b.role)) return reply.code(403).send({ error: 'you cannot create someone with more access than you have' });
    try {
      const r = await db.query('INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,lower($2),$3,$4) RETURNING id', [m.orgId, b.email, await hashPassword(b.password), b.role]);
      await audit({ orgId: m.orgId, actorType: 'user', actorId: m.id, action: 'user.create', targetType: 'user', targetId: r.rows[0].id, next: { email: b.email.toLowerCase(), role: b.role } });
      return reply.code(201).send({ userId: r.rows[0].id });
    } catch (e: any) { if (e.code === '23505') return reply.code(409).send({ error: 'that email is already registered' }); throw e; }
  });

  /** Another person in this organization, who must not have more access than the caller. */
  async function target(req: any, reply: any) {
    const { id } = z.object({ id: uuid }).parse(req.params); const m = me(req);
    const t = (await db.query('SELECT id, role, email, disabled_at FROM users WHERE id=$1 AND org_id=$2', [id, m.orgId])).rows[0];
    if (!t) { reply.code(404).send({ error: 'user not found' }); return null; }
    if (!atLeast(m.role, t.role)) { reply.code(403).send({ error: 'you cannot change someone with more access than you have' }); return null; }
    return t as { id: string; role: Role; email: string; disabled_at: string | null };
  }
  const otherOwners = async (orgId: string, exceptId: string) => (await db.query("SELECT count(*)::int n FROM users WHERE org_id=$1 AND role='owner' AND disabled_at IS NULL AND id<>$2", [orgId, exceptId])).rows[0].n;

  app.patch('/api/v1/users/:id', { preHandler: admin }, async (req, reply) => {
    const b = z.object({ role: roleEnum.optional(), disabled: z.boolean().optional() }).strict().refine(x => x.role !== undefined || x.disabled !== undefined, 'nothing to change').parse(req.body);
    const t = await target(req, reply); if (!t) return; const m = me(req);
    if (b.role && !atLeast(m.role, b.role)) return reply.code(403).send({ error: 'you cannot change someone with more access than you have' });
    if (b.disabled !== undefined && t.id === m.id) return reply.code(409).send({ error: 'you cannot disable yourself' });
    const losesOwner = t.role === 'owner' && ((b.role && b.role !== 'owner') || b.disabled === true);
    if (losesOwner && (await otherOwners(m.orgId, t.id)) < 1) return reply.code(409).send({ error: 'an organization needs at least one owner' });
    if (b.role) await db.query('UPDATE users SET role=$3 WHERE id=$1 AND org_id=$2', [t.id, m.orgId, b.role]);
    if (b.disabled !== undefined) await db.query('UPDATE users SET disabled_at=$3 WHERE id=$1 AND org_id=$2', [t.id, m.orgId, b.disabled ? new Date() : null]);
    c.invalidateUser(t.id);
    if (b.role) await audit({ orgId: m.orgId, actorType: 'user', actorId: m.id, action: 'user.role', targetType: 'user', targetId: t.id, previous: { role: t.role }, next: { role: b.role } });
    if (b.disabled !== undefined) await audit({ orgId: m.orgId, actorType: 'user', actorId: m.id, action: b.disabled ? 'user.disable' : 'user.enable', targetType: 'user', targetId: t.id, previous: { email: t.email } });
    return { role: b.role ?? t.role, disabled: b.disabled ?? !!t.disabled_at };
  });

  app.delete('/api/v1/users/:id', { preHandler: admin }, async (req, reply) => {
    const m = me(req); const { id } = z.object({ id: uuid }).parse(req.params);
    if (id === m.id) return reply.code(409).send({ error: 'you cannot remove yourself' });
    const t = await target(req, reply); if (!t) return;
    if (t.role === 'owner' && (await otherOwners(m.orgId, t.id)) < 1) return reply.code(409).send({ error: 'an organization needs at least one owner' });
    await db.query('DELETE FROM users WHERE id=$1 AND org_id=$2', [t.id, m.orgId]);
    c.invalidateUser(t.id);
    await audit({ orgId: m.orgId, actorType: 'user', actorId: m.id, action: 'user.remove', targetType: 'user', targetId: t.id, previous: { email: t.email, role: t.role } });
    return { removed: true };
  });

  app.post('/api/v1/users/:id/password', { preHandler: admin }, async (req, reply) => {
    const b = z.object({ password: z.string().min(12).max(200) }).strict().parse(req.body);
    const t = await target(req, reply); if (!t) return; const m = me(req);
    await db.query('UPDATE users SET password_hash=$3 WHERE id=$1 AND org_id=$2', [t.id, m.orgId, await hashPassword(b.password)]);
    await audit({ orgId: m.orgId, actorType: 'user', actorId: m.id, action: 'user.password-reset', targetType: 'user', targetId: t.id, previous: { email: t.email } });
    return { ok: true };
  });

  /** For someone who lost their phone and their recovery codes. The person must set MFA up again. */
  app.post('/api/v1/users/:id/mfa-reset', { preHandler: admin }, async (req, reply) => {
    const t = await target(req, reply); if (!t) return; const m = me(req);
    await db.query('UPDATE users SET mfa_secret_enc=NULL, mfa_pending_enc=NULL, mfa_enabled_at=NULL, mfa_last_step=NULL, mfa_failed=0, mfa_locked_until=NULL WHERE id=$1', [t.id]);
    await db.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [t.id]);
    await audit({ orgId: m.orgId, actorType: 'user', actorId: m.id, action: 'user.mfa.reset', targetType: 'user', targetId: t.id, previous: { email: t.email } });
    return { ok: true };
  });

  // ---------------- organization settings ----------------
  const settingsOf = async (orgId: string) => {
    const o = (await db.query('SELECT name, plan, country_code, utc_offset_minutes, require_mfa, notification_emails FROM organizations WHERE id=$1', [orgId])).rows[0];
    return { name: o.name, plan: o.plan, countryCode: o.country_code, utcOffsetMinutes: o.utc_offset_minutes, requireMfa: o.require_mfa, notificationEmails: o.notification_emails as string[] };
  };
  app.get('/api/v1/org/settings', { preHandler: viewer }, async req => settingsOf(me(req).orgId));
  app.put('/api/v1/org/settings', { preHandler: admin }, async (req, reply) => {
    const b = z.object({
      name: z.string().trim().min(1).max(120), countryCode: z.string().regex(/^[A-Z]{2}$/, 'use a two-letter country code, for example ZM'),
      utcOffsetMinutes: z.number().int().min(-720).max(840), requireMfa: z.boolean(), notificationEmails: z.array(z.string().email()).max(10),
    }).strict().parse(req.body);
    const m = me(req); const prev = await settingsOf(m.orgId);
    if (b.requireMfa !== prev.requireMfa && m.role !== 'owner') return reply.code(403).send({ error: 'only an owner can change the two-step sign-in requirement' });
    await db.query('UPDATE organizations SET name=$2, country_code=$3, utc_offset_minutes=$4, require_mfa=$5, notification_emails=$6 WHERE id=$1',
      [m.orgId, b.name, b.countryCode, b.utcOffsetMinutes, b.requireMfa, [...new Set(b.notificationEmails.map(e => e.toLowerCase()))]]);
    await audit({ orgId: m.orgId, actorType: 'user', actorId: m.id, action: 'org.settings', targetType: 'organization', targetId: m.orgId, previous: prev, next: b });
    return settingsOf(m.orgId);
  });

  // ---------------- consent for compute sponsorship ----------------
  app.get('/api/v1/compute/consent', { preHandler: viewer }, async req => {
    const rows = (await db.query('SELECT id, user_email, wording_version, accepted_at FROM compute_consents WHERE org_id=$1 ORDER BY id DESC LIMIT 20', [me(req).orgId])).rows;
    const cur = rows.find(r => r.wording_version === CONSENT.version) ?? null;
    return { wording: CONSENT, accepted: !!cur, current: cur, history: rows };
  });
  app.post('/api/v1/compute/consent', { preHandler: owner }, async (req) => {
    const m = me(req);
    const u = (await db.query('SELECT email FROM users WHERE id=$1', [m.id])).rows[0];
    const at = new Date().toISOString();
    const record = JSON.stringify({ org: m.orgId, user: m.id, email: u.email, version: CONSENT.version, sha256: consentHash(), at });
    await db.query('INSERT INTO compute_consents(org_id,user_id,user_email,wording_version,wording_sha256,accepted_at,signature) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [m.orgId, m.id, u.email, CONSENT.version, consentHash(), at, c.signer.sign(record)]);
    await audit({ orgId: m.orgId, actorType: 'user', actorId: m.id, action: 'compute.consent', targetType: 'organization', targetId: m.orgId, next: { version: CONSENT.version } });
    return { accepted: true, version: CONSENT.version, at };
  });
}

/** True when this organization has recorded consent to the current wording (required before the mining workload can be enabled). */
export async function hasComputeConsent(db: Db, orgId: string): Promise<boolean> {
  return !!(await db.query('SELECT 1 FROM compute_consents WHERE org_id=$1 AND wording_version=$2 LIMIT 1', [orgId, CONSENT.version])).rowCount;
}
