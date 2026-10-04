import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { JobCtx } from './jobs.js';
import type { Mailer } from './mailer.js';
import { hashPassword } from './security.js';
import { ensureAutopilot } from './autopilot.js';
import { entitlementsOf, FEATURES } from './entitlements.js';
import { esc } from './certificate-pages.js';
import { moveQuotaBytes } from './move.js';
import { placeOrder } from './billing.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const VERIFY_HOURS = 48;

/**
 * Personal accounts. Anyone can create one (a one-person organization), but nothing happens until the email address is confirmed by following a link Viro emails to it.
 * Asking again for an address that already has an account gives the same answer as a new one, so the form cannot be used to find out who has an account.
 */
export function registerSignupRoutes(app: FastifyInstance, c: JobCtx, deps: { mailer: Mailer | null; baseUrl: string; limitPerMinute?: number }) {
  const { db } = c; const { mailer, baseUrl } = deps; const limit = deps.limitPerMinute ?? 5;
  const generic = { status: 'check_your_email', message: 'If this address can be used, we have sent a link to confirm it. It is valid for 48 hours.' };

  async function sendLink(userId: string, email: string, name: string, order?: Record<string, any>) {
    const token = randomBytes(24).toString('base64url');
    await db.query('INSERT INTO email_verifications(token_hash,user_id,expires_at) VALUES ($1,$2,now() + interval \'' + VERIFY_HOURS + ' hours\')', [sha(token), userId]);
    const link = `${baseUrl}/verify-email?token=${token}`;
    const pay = order ? `\n\nYour order ${order.reference}: pay ${order.currency} ${order.amount} by ${order.pay?.method}. ${order.pay?.instructions} ${Object.entries(order.pay?.details ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ')}\nQuote ${order.reference} when you pay. Your plan starts when we confirm the money has arrived.` : '';
    const payHtml = order ? `<div style="margin:14px 0;padding:12px 14px;border:1px solid #d5ddd8;background:#fafcfb"><b>Your order ${esc(order.reference)}</b><br>Pay ${esc(order.currency)} ${esc(order.amount)} by ${esc(order.pay?.method)}. ${esc(order.pay?.instructions)}<br>${esc(Object.entries(order.pay?.details ?? {}).map(([k, v]) => `${k}: ${v}`).join(', '))}<br>Quote <b>${esc(order.reference)}</b> when you pay. Your plan starts when we confirm the money has arrived.</div>` : '';
    await mailer!.send({
      to: email, purpose: 'verify-email', subject: 'Confirm your Viro WorkCare account',
      text: `Hello ${name},\n\nConfirm your email address to finish creating your Viro WorkCare account:\n${link}\n\nThe link works for ${VERIFY_HOURS} hours. If you did not ask for this, ignore this email and nothing will happen.${pay}\n\nViro WorkCare`,
      html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;color:#14201a"><h2>Confirm your email</h2><p>Hello ${esc(name)}, confirm your email address to finish creating your Viro WorkCare account.</p>${payHtml}<p><a href="${esc(link)}" style="background:#1f9d5c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Confirm my email</a></p><p style="color:#52645a;font-size:13px">The link works for ${VERIFY_HOURS} hours. If you did not ask for this, ignore this email and nothing will happen.</p></div>`,
    });
  }

  /**
   * The first purchase. An account only comes into being together with an order for a paid plan: nobody can sign up just to have an account. The free tools in the
   * Windows app need no account at all. The account can sign in once its email is confirmed, but it has no paid features until an operator confirms the payment,
   * and an account that never pays is removed after 14 days.
   */
  app.post('/api/v1/checkout', { config: { rateLimit: { max: limit, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!mailer) return reply.code(503).send({ error: 'Buying is not open yet.' });
    const b = z.object({ name: z.string().trim().min(2).max(80), email: z.string().email().max(200), password: z.string().min(10).max(200), acceptTerms: z.literal(true),
      planCode: z.string().min(2).max(40), quantity: z.number().int().min(1).max(50).default(1), methodId: z.string().uuid(),
      // which campaign link or website brought this buyer: short plain text only, never anything personal
      source: z.object({ source: z.string().max(60), medium: z.string().max(60), campaign: z.string().max(80), content: z.string().max(80), ref: z.string().max(80) }).partial().strict().optional() }).strict().parse(req.body);
    const source: Record<string, string> = {}; for (const [k, v] of Object.entries(b.source ?? {})) { const t = String(v ?? '').replace(/[^\w .:@/+-]/g, '').trim().slice(0, 80); if (t) source[k] = t; }
    const plan = (await db.query(`SELECT 1 FROM billing_plans WHERE code=$1 AND active AND audience IN ('person','shop')`, [b.planCode])).rowCount;
    const method = (await db.query(`SELECT 1 FROM payment_methods WHERE id=$1 AND active`, [b.methodId])).rowCount;
    if (!plan || !method) return reply.code(404).send({ error: 'That plan or way of paying is not available.' });
    if ((await db.query('SELECT 1 FROM users WHERE email=lower($1)', [b.email])).rowCount) return reply.code(409).send({ error: 'There is already an account for this email. Sign in, then choose Plan and payments to buy.' });
    const client = await db.connect(); let orgId = '', userId = '';
    try {
      await client.query('BEGIN');
      orgId = (await client.query(`INSERT INTO organizations(name,kind) VALUES ($1,'personal') RETURNING id`, [b.name])).rows[0].id;
      userId = (await client.query(`INSERT INTO users(org_id,email,password_hash,role,email_verified_at) VALUES ($1,lower($2),$3,'owner',NULL) RETURNING id`, [orgId, b.email, await hashPassword(b.password)])).rows[0].id;
      await client.query('COMMIT');
    } catch (e: any) { await client.query('ROLLBACK'); if (e.code === '23505') return reply.code(409).send({ error: 'There is already an account for this email. Sign in, then choose Plan and payments to buy.' }); throw e; }
    finally { client.release(); }
    const placed = await placeOrder(db, c.audit, { orgId, userId, planCode: b.planCode, quantity: b.quantity, methodId: b.methodId, source });
    if (!placed.ok) { await db.query('DELETE FROM organizations WHERE id=$1', [orgId]); return reply.code(placed.code).send({ error: placed.error }); }
    await ensureAutopilot(db, orgId, { id: userId }).catch(() => { });
    await c.audit({ orgId, actorType: 'user', actorId: userId, action: 'checkout', targetType: 'organization', targetId: orgId, ip: req.ip } as any);
    try { await sendLink(userId, b.email, b.name, placed.body); } catch { /* the person can ask for another link; the order is shown on screen */ }
    return reply.code(201).send({ ...placed.body, message: 'Your order is placed. We have sent a link to confirm your email: open it, then sign in to tell us when you have paid.' });
  });

  app.post('/api/v1/signup/resend', { config: { rateLimit: { max: limit, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!mailer) return reply.code(503).send({ error: 'Sign-up is not open yet.' });
    const b = z.object({ email: z.string().email().max(200) }).strict().parse(req.body);
    const u = (await db.query(`SELECT u.id, o.name FROM users u JOIN organizations o ON o.id=u.org_id WHERE u.email=lower($1) AND u.email_verified_at IS NULL`, [b.email])).rows[0];
    if (u) { try { await sendLink(u.id, b.email, u.name); } catch { /* same answer either way */ } }
    return reply.code(202).send(generic);
  });

  async function verify(token: string): Promise<boolean> {
    const r = await db.query(`UPDATE email_verifications SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`, [sha(token)]);
    if (!r.rowCount) return false;
    await db.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at, now()) WHERE id=$1', [r.rows[0].user_id]);
    return true;
  }
  app.post('/api/v1/signup/verify', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ token: z.string().min(20).max(80) }).strict().parse(req.body);
    return (await verify(b.token)) ? { ok: true } : reply.code(400).send({ error: 'This link is not valid any more. Ask for a new one.' });
  });
  app.get('/verify-email', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const t = String((req.query as any)?.token ?? '');
    const ok = t.length >= 20 && t.length <= 80 && (await verify(t));
    return reply.type('text/html; charset=utf-8').header('referrer-policy', 'no-referrer').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Viro WorkCare</title><meta name="robots" content="noindex"></head><body style="margin:0;background:#f3f7f4;font:16px/1.5 Segoe UI,system-ui,sans-serif;color:#14201a"><div style="max-width:480px;margin:12vh auto;padding:28px;background:#fff;border:1px solid #dfe8e2;border-radius:14px"><img src="/logo.png" width="40" height="40" alt="" style="border-radius:9px"><h2 style="margin:14px 0 6px">${ok ? 'Your email is confirmed' : 'This link is not valid any more'}</h2><p style="color:#52645a">${ok ? 'You can now sign in to Viro WorkCare.' : 'It may have expired or been used already. Sign in and ask for a new link.'}</p><p><a href="/" style="background:#1f9d5c;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Go to sign in</a></p></div></body></html>`);
  });

  // ---- what this person can use (the same answer the Windows app caches) -------------------------------------------------------------------------------------
  app.get('/api/v1/entitlements', { preHandler: c.requireRole('viewer') }, async req => {
    const e = await entitlementsOf(db, req.user.org);
    return { ...e, moveQuotaBytes: await moveQuotaBytes(db, req.user.org), catalog: FEATURES };
  });
}

/** Personal accounts exist for people who are buying. One that has not paid within 14 days is removed, with everything under it. */
export async function sweepUnpaidAccounts(db: JobCtx['db']): Promise<number> {
  const r = await db.query(`DELETE FROM organizations o WHERE o.kind='personal' AND o.created_at < now() - interval '14 days'
      AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.org_id=o.id) AND NOT EXISTS (SELECT 1 FROM billing_orders b WHERE b.org_id=o.id AND b.status='paid')`);
  return r.rowCount ?? 0;
}
