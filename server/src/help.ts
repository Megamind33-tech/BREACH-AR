import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JobCtx } from './jobs.js';
import type { Mailer } from './mailer.js';
import { lacks } from './entitlements.js';
import { esc } from './certificate-pages.js';

/**
 * Ask a technician. The person writes what is wrong and chooses whether to share a short summary of their PC and a phone number. The Viro team sees the request in the
 * operator console and replies; the reply is emailed to the person and kept with the request. Nothing about the PC is sent unless the person ticked the box.
 */
export function registerHelpRoutes(app: FastifyInstance, c: JobCtx, deps: { mailer: Mailer | null; inbox?: string }) {
  const { db } = c; const { mailer } = deps;
  const guard = (app as any).platformGuard as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  const uuid = z.string().uuid();
  const actor = (req: FastifyRequest) => (req.platform!.via === 'key' ? 'platform:key' : 'platform:' + req.platform!.id);

  app.post('/api/v1/help/requests', { preHandler: c.requireRole('viewer'), config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const why = await lacks(db, req.user.org, 'help.technician'); if (why) return reply.code(402).send({ error: why, upgrade: true });
    const b = z.object({
      subject: z.string().trim().min(3).max(120), message: z.string().trim().min(10).max(4000), contact: z.string().trim().max(40).optional(),
      details: z.object({ machine: z.string().max(120).optional(), windows: z.string().max(120).optional(), freeGb: z.number().optional(), memoryPercent: z.number().optional(), issues: z.array(z.string().max(200)).max(10).optional() }).strict().optional(),
    }).strict().parse(req.body);
    const r = await db.query(`INSERT INTO help_requests(org_id,user_id,subject,message,contact,details) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [req.user.org, req.user.sub, b.subject, b.message, b.contact ?? null, b.details ? JSON.stringify(b.details) : null]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'help.request', targetType: 'help_request', targetId: r.rows[0].id } as any);
    if (mailer && deps.inbox) { try { await mailer.send({ to: deps.inbox, purpose: 'help-request', subject: `Help request: ${b.subject}`, text: `A new help request is waiting in the operator console.\n\n${b.subject}\n\n${b.message.slice(0, 600)}` }); } catch { /* it is in the console either way */ } }
    return reply.code(201).send({ id: r.rows[0].id, status: 'open', message: 'Thank you. A technician will reply by email, usually within one working day.' });
  });

  app.get('/api/v1/help/requests', { preHandler: c.requireRole('viewer') }, async req => ({
    requests: (await db.query(`SELECT id, subject, message, status, created_at, answered_at, reply FROM help_requests WHERE org_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 30`, [req.user.org, req.user.sub])).rows,
  }));

  // ---- the team side ------------------------------------------------------------------------------------------------------------------------------
  app.get('/api/v1/platform/help', { preHandler: guard }, async req => {
    const q = z.object({ status: z.enum(['open', 'answered', 'closed']).optional() }).parse(req.query);
    return { requests: (await db.query(
      `SELECT h.id, h.subject, h.message, h.contact, h.details, h.status, h.created_at, h.answered_at, h.answered_by, h.reply, o.name AS organization, o.kind, u.email
         FROM help_requests h JOIN organizations o ON o.id=h.org_id JOIN users u ON u.id=h.user_id WHERE ($1::text IS NULL OR h.status=$1) ORDER BY (h.status='open') DESC, h.created_at DESC LIMIT 200`, [q.status ?? null])).rows };
  });

  app.post('/api/v1/platform/help/:id/reply', { preHandler: guard }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params); const b = z.object({ reply: z.string().trim().min(3).max(4000), close: z.boolean().default(false) }).strict().parse(req.body);
    const h = (await db.query(`SELECT h.subject, h.org_id, u.email, o.name FROM help_requests h JOIN users u ON u.id=h.user_id JOIN organizations o ON o.id=h.org_id WHERE h.id=$1`, [id])).rows[0];
    if (!h) return reply.code(404).send({ error: 'request not found' });
    if (!mailer) return reply.code(503).send({ error: 'Email is not set up, so the reply cannot be sent.' });
    await mailer.send({ to: h.email, purpose: 'help-reply', subject: `Re: ${h.subject}`,
      text: `Hello ${h.name},\n\n${b.reply}\n\nViro WorkCare support`, html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;color:#14201a"><p>Hello ${esc(h.name)},</p><p style="white-space:pre-wrap">${esc(b.reply)}</p><p style="color:#52645a;font-size:13px">Viro WorkCare support. Reply to this email if you need more help.</p></div>` });
    await db.query(`UPDATE help_requests SET status=$2, reply=$3, answered_at=now(), answered_by=$4 WHERE id=$1`, [id, b.close ? 'closed' : 'answered', b.reply, actor(req)]);
    await c.audit({ orgId: h.org_id, actorType: 'user', actorId: actor(req), action: 'platform.help.reply', targetType: 'help_request', targetId: id, ip: req.ip } as any);
    return { ok: true };
  });

  app.post('/api/v1/platform/help/:id/close', { preHandler: guard }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query(`UPDATE help_requests SET status='closed' WHERE id=$1 RETURNING org_id`, [id]);
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: 'request not found' });
  });
}
