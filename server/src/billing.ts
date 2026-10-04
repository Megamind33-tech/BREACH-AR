import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JobCtx } from './jobs.js';

/**
 * Billing for people who pay by mobile money, bank transfer or cash.
 * No money is taken by this server. A customer places an order, is told how to pay with a unique reference, and says they have paid. An operator then confirms
 * the payment against what actually arrived, and only that activates the subscription. Plans stay invisible until the owner has set a price and switched them on,
 * so nothing is ever sold at a price nobody chose.
 */
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const newReference = () => 'VBL-' + Array.from(randomBytes(6), b => REF_ALPHABET[b % REF_ALPHABET.length]).join('');

/** One period later; a subscription that is still running is extended from its end, never shortened. */
export function nextPeriodEnd(period: 'month' | 'year' | 'once', currentEnd: Date | null, now: Date): Date | null {
  if (period === 'once') return null;
  const start = currentEnd && currentEnd > now ? currentEnd : now;
  const d = new Date(start.getTime());
  if (period === 'month') d.setUTCMonth(d.getUTCMonth() + 1); else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

export type PlaceResult = { ok: true; body: Record<string, unknown> } | { ok: false; code: number; error: string };
/** Places an order for a plan: the amount is worked out here from the plan's price, never taken from the customer. Used by the first purchase and by later orders. */
export async function placeOrder(db: JobCtx['db'], audit: JobCtx['audit'], o: { orgId: string; userId: string; planCode: string; quantity: number; methodId: string; source?: Record<string, string> | null }): Promise<PlaceResult> {
  const plan = (await db.query(`SELECT code, name, price, currency, period, per FROM billing_plans WHERE code=$1 AND active`, [o.planCode])).rows[0];
  if (!plan) return { ok: false, code: 404, error: 'that plan is not available' };
  const method = (await db.query(`SELECT id, kind, label, instructions, details, currency FROM payment_methods WHERE id=$1 AND active`, [o.methodId])).rows[0];
  if (!method) return { ok: false, code: 404, error: 'that payment method is not available' };
  if (method.currency && method.currency !== plan.currency) return { ok: false, code: 400, error: `${method.label} takes ${method.currency}, but this plan is priced in ${plan.currency}` };
  const quantity = plan.per === 'pc' || plan.per === 'certificate' ? o.quantity : 1;
  const amount = Math.round(Number(plan.price) * quantity * 100) / 100;
  let ref = newReference();
  for (let i = 0; i < 5; i++) { if (!(await db.query('SELECT 1 FROM billing_orders WHERE reference=$1', [ref])).rowCount) break; ref = newReference(); }
  const r = await db.query(`INSERT INTO billing_orders(org_id,created_by,plan_code,quantity,amount,currency,method_id,method_kind,reference,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [o.orgId, o.userId, plan.code, quantity, amount, plan.currency, method.id, method.kind, ref, o.source && Object.keys(o.source).length ? JSON.stringify(o.source) : null]);
  await audit({ orgId: o.orgId, actorType: 'user', actorId: o.userId, action: 'billing.order', targetType: 'billing_order', targetId: r.rows[0].id, next: { plan: plan.code, quantity, amount, method: method.kind, reference: ref } });
  return { ok: true, body: {
    id: r.rows[0].id, reference: ref, status: 'pending', plan: plan.name, quantity, amount, currency: plan.currency,
    pay: { method: method.label, kind: method.kind, instructions: method.instructions, details: method.details, useReference: ref },
    next: 'Pay the amount exactly, quote the reference, then tell us you have paid. The plan starts when Viro confirms the payment.',
  } };
}

export function registerBillingRoutes(app: FastifyInstance, c: JobCtx, deps: { alertTo?: string; mailer?: () => { send(m: { to: string; subject: string; text: string; purpose: string }): Promise<void> } | null; baseUrl?: string } = {}) {
  const { db } = c;
  const guard = (app as any).platformGuard as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  const uuid = z.string().uuid();
  const actor = (req: FastifyRequest) => (req.platform!.via === 'key' ? 'platform:key' : 'platform:' + req.platform!.id);
  const pAudit = (req: FastifyRequest, orgId: string | null, action: string, targetId: string, next?: unknown) =>
    c.audit({ orgId, actorType: 'user', actorId: actor(req), action: 'platform.billing.' + action, targetType: 'billing_order', targetId, next, ip: req.ip } as any);

  // ---- public: what is on sale (for the website) --------------------------------------------------------------------------------------------------------
  app.get('/api/v1/public/plans', async (_req, reply) => {
    const plans = (await db.query(`SELECT code, name, audience, price, currency, period, per, description, features FROM billing_plans WHERE active ORDER BY sort, price`)).rows.map(p => ({ ...p, price: Number(p.price) }));
    const methods = (await db.query(`SELECT id, kind, label, currency FROM payment_methods WHERE active ORDER BY sort, label`)).rows;
    return reply.header('cache-control', 'public, max-age=300').header('access-control-allow-origin', '*').send({ plans, methods, paymentKinds: [...new Set(methods.map(m => m.kind as string))] });
  });

  // ---- the customer's side ------------------------------------------------------------------------------------------------------------------------
  app.get('/api/v1/billing', { preHandler: c.requireRole('viewer') }, async req => {
    const plans = (await db.query(`SELECT code, name, audience, price, currency, period, per, description, features FROM billing_plans WHERE active ORDER BY sort, price`)).rows
      .map(p => ({ ...p, price: Number(p.price) }));
    const methods = (await db.query(`SELECT id, kind, label, currency FROM payment_methods WHERE active ORDER BY sort, label`)).rows;
    const sub = (await db.query(`SELECT s.plan_code, p.name, s.quantity, s.current_period_end FROM subscriptions s JOIN billing_plans p ON p.code=s.plan_code WHERE s.org_id=$1`, [req.user.org])).rows[0] ?? null;
    const orders = (await db.query(`SELECT id, plan_code, quantity, amount, currency, method_kind, reference, status, created_at, paid_at, reject_reason FROM billing_orders WHERE org_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.user.org])).rows
      .map(o => ({ ...o, amount: Number(o.amount) }));
    const now = Date.now();
    return {
      subscription: sub ? { plan: sub.plan_code, name: sub.name, quantity: sub.quantity, validUntil: sub.current_period_end, active: !sub.current_period_end || new Date(sub.current_period_end).getTime() > now } : null,
      plans, methods, orders,
      note: plans.length ? null : 'Paid plans have not been announced yet. Everything in the free plan keeps working.',
    };
  });

  app.post('/api/v1/billing/orders', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const b = z.object({ planCode: z.string().min(2).max(40), quantity: z.number().int().min(1).max(5000), methodId: uuid }).strict().parse(req.body);
    const r = await placeOrder(db, c.audit, { orgId: req.user.org, userId: req.user.sub, ...b });
    return r.ok ? reply.code(201).send(r.body) : reply.code(r.code).send({ error: r.error });
  });

  app.post('/api/v1/billing/orders/:id/paid', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ payerName: z.string().min(2).max(120), payerPhone: z.string().max(40).optional(), transactionId: z.string().min(2).max(80), note: z.string().max(500).optional() }).strict().parse(req.body);
    const r = await db.query(`UPDATE billing_orders SET status='submitted', submitted_at=now(), payer_name=$3, payer_phone=$4, payer_txn=$5, note=$6 WHERE id=$1 AND org_id=$2 AND status IN ('pending','submitted') RETURNING reference`,
      [id, req.user.org, b.payerName, b.payerPhone ?? null, b.transactionId, b.note ?? null]);
    if (!r.rowCount) return reply.code(404).send({ error: 'order not found, or it is already settled' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'billing.paid_claim', targetType: 'billing_order', targetId: id, next: { reference: r.rows[0].reference } });
    // Tell the owner at once: a customer who has paid should not wait for someone to notice. A failed email never stops the customer's claim from being recorded.
    const m = deps.mailer?.();
    if (m && deps.alertTo) {
      try {
        const o = (await db.query(`SELECT o.reference, o.plan_code, o.quantity, o.amount, o.currency, o.method_kind, o.source, g.name AS org FROM billing_orders o JOIN organizations g ON g.id=o.org_id WHERE o.id=$1`, [id])).rows[0];
        const src = o?.source ? [o.source.source, o.source.campaign, o.source.ref].filter(Boolean).join(', ') : 'direct';
        await m.send({ to: deps.alertTo, purpose: 'order-alert', subject: `Payment to confirm: ${o.reference} (${o.currency} ${Number(o.amount).toLocaleString('en-US')})`,
          text: `A customer says they have paid.\n\nReference: ${o.reference}\nCustomer: ${o.org}\nPlan: ${o.plan_code} x ${o.quantity}\nAmount: ${o.currency} ${Number(o.amount).toLocaleString('en-US')} by ${String(o.method_kind).replace('_', ' ')}\nPaid by: ${b.payerName}${b.payerPhone ? ', ' + b.payerPhone : ''}\nTransaction ID: ${b.transactionId}\nCame from: ${src}\n\nCheck that the money has arrived in the account, then confirm it here:\n${deps.baseUrl ?? ''}/platform.html\n(Billing, then "Money received".)\n` });
      } catch { /* the order is already recorded and shows in Billing */ }
    }
    return { status: 'submitted', message: 'Thank you. Viro will confirm your payment and start the plan, usually within one working day.' };
  });

  app.post('/api/v1/billing/orders/:id/cancel', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query(`UPDATE billing_orders SET status='cancelled' WHERE id=$1 AND org_id=$2 AND status='pending'`, [id, req.user.org]);
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: 'only an order that has not been paid can be cancelled' });
  });

  // ---- Viro's side (platform operators) ------------------------------------------------------------------------------------------------------------
  app.get('/api/v1/platform/billing', { preHandler: guard }, async req => {
    const q = z.object({ status: z.enum(['pending', 'submitted', 'paid', 'cancelled', 'rejected']).optional() }).parse(req.query);
    const orders = (await db.query(
      `SELECT o.id, o.org_id, g.name AS organization, o.plan_code, o.quantity, o.amount, o.currency, o.method_kind, o.reference, o.status, o.payer_name, o.payer_phone, o.payer_txn, o.note, o.source, o.created_at, o.submitted_at, o.paid_at, o.reject_reason
         FROM billing_orders o JOIN organizations g ON g.id=o.org_id WHERE ($1::text IS NULL OR o.status=$1) ORDER BY (o.status='submitted') DESC, o.created_at DESC LIMIT 200`, [q.status ?? null])).rows.map(o => ({ ...o, amount: Number(o.amount) }));
    const plans = (await db.query(`SELECT * FROM billing_plans ORDER BY sort, price`)).rows.map(p => ({ ...p, price: Number(p.price) }));
    const methods = (await db.query(`SELECT * FROM payment_methods ORDER BY sort, label`)).rows;
    const subs = (await db.query(`SELECT s.org_id, g.name AS organization, s.plan_code, s.quantity, s.current_period_end FROM subscriptions s JOIN organizations g ON g.id=s.org_id ORDER BY g.name`)).rows;
    return { orders, plans, methods, subscriptions: subs };
  });

  app.post('/api/v1/platform/billing/orders/:id/confirm', { preHandler: guard }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const o = (await db.query(`SELECT o.*, p.period, p.per FROM billing_orders o JOIN billing_plans p ON p.code=o.plan_code WHERE o.id=$1`, [id])).rows[0];
    if (!o) return reply.code(404).send({ error: 'order not found' });
    if (o.status === 'paid') return reply.code(409).send({ error: 'this order is already confirmed' });
    if (!['pending', 'submitted'].includes(o.status)) return reply.code(409).send({ error: `this order is ${o.status}` });
    const now = new Date();
    const cur = (await db.query('SELECT current_period_end, plan_code, quantity FROM subscriptions WHERE org_id=$1', [o.org_id])).rows[0];
    const end = nextPeriodEnd(o.period, cur && cur.plan_code === o.plan_code && cur.current_period_end ? new Date(cur.current_period_end) : null, now);
    const qty = cur && cur.plan_code === o.plan_code ? Math.max(cur.quantity, o.quantity) : o.quantity;
    await db.query(`UPDATE billing_orders SET status='paid', paid_at=$2, confirmed_by=$3 WHERE id=$1`, [id, now, actor(req)]);
    await db.query(`INSERT INTO subscriptions(org_id,plan_code,quantity,current_period_end) VALUES ($1,$2,$3,$4)
                    ON CONFLICT (org_id) DO UPDATE SET plan_code=EXCLUDED.plan_code, quantity=EXCLUDED.quantity, current_period_end=EXCLUDED.current_period_end, updated_at=now()`, [o.org_id, o.plan_code, o.per === 'certificate' ? (cur?.quantity ?? 0) + o.quantity : qty, end]);
    await pAudit(req, o.org_id, 'confirm', id, { reference: o.reference, amount: Number(o.amount), currency: o.currency, validUntil: end });
    return { status: 'paid', validUntil: end };
  });

  app.post('/api/v1/platform/billing/orders/:id/reject', { preHandler: guard }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params); const b = z.object({ reason: z.string().min(3).max(300) }).strict().parse(req.body);
    const r = await db.query(`UPDATE billing_orders SET status='rejected', reject_reason=$2, confirmed_by=$3 WHERE id=$1 AND status IN ('pending','submitted') RETURNING org_id`, [id, b.reason, actor(req)]);
    if (!r.rowCount) return reply.code(404).send({ error: 'order not found or already settled' });
    await pAudit(req, r.rows[0].org_id, 'reject', id, { reason: b.reason });
    return { ok: true };
  });

  app.put('/api/v1/platform/billing/plans/:code', { preHandler: guard }, async (req, reply) => {
    const { code } = z.object({ code: z.string().regex(/^[a-z0-9-]{2,40}$/) }).parse(req.params);
    const b = z.object({
      name: z.string().min(2).max(80), audience: z.enum(['person', 'business', 'shop']), price: z.number().min(0).max(1e9), currency: z.string().regex(/^[A-Z]{3}$/),
      period: z.enum(['month', 'year', 'once']), per: z.enum(['pc', 'certificate', 'account']).default('pc'), description: z.string().max(400).optional(), features: z.array(z.string().max(160)).max(20).default([]), active: z.boolean().default(false), sort: z.number().int().min(0).max(1000).default(100), moveQuotaGb: z.number().min(0).max(5000).default(5), entitlements: z.array(z.string().max(60)).max(40).default([]),
    }).strict().parse(req.body);
    await db.query(`INSERT INTO billing_plans(code,name,audience,price,currency,period,per,description,features,active,sort,move_quota_gb,entitlements) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, audience=EXCLUDED.audience, price=EXCLUDED.price, currency=EXCLUDED.currency, period=EXCLUDED.period, per=EXCLUDED.per, description=EXCLUDED.description, features=EXCLUDED.features, active=EXCLUDED.active, sort=EXCLUDED.sort, move_quota_gb=EXCLUDED.move_quota_gb, entitlements=EXCLUDED.entitlements, updated_at=now()`,
      [code, b.name, b.audience, b.price, b.currency, b.period, b.per, b.description ?? null, JSON.stringify(b.features), b.active, b.sort, b.moveQuotaGb, JSON.stringify(b.entitlements)]);
    await c.audit({ orgId: null, actorType: 'user', actorId: actor(req), action: 'platform.billing.plan', targetType: 'billing_plan', targetId: code, next: b, ip: req.ip } as any);
    return reply.code(200).send({ ok: true });
  });

  app.post('/api/v1/platform/billing/methods', { preHandler: guard }, async (req, reply) => {
    const b = z.object({
      id: uuid.optional(), kind: z.enum(['mobile_money', 'bank', 'cash']), label: z.string().min(2).max(80), instructions: z.string().min(5).max(800),
      details: z.record(z.string(), z.string().max(200)).default({}), currency: z.string().regex(/^[A-Z]{3}$/).optional(), active: z.boolean().default(true), sort: z.number().int().min(0).max(1000).default(100),
    }).strict().parse(req.body);
    const r = b.id
      ? await db.query(`UPDATE payment_methods SET kind=$2,label=$3,instructions=$4,details=$5,currency=$6,active=$7,sort=$8 WHERE id=$1 RETURNING id`, [b.id, b.kind, b.label, b.instructions, JSON.stringify(b.details), b.currency ?? null, b.active, b.sort])
      : await db.query(`INSERT INTO payment_methods(kind,label,instructions,details,currency,active,sort) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [b.kind, b.label, b.instructions, JSON.stringify(b.details), b.currency ?? null, b.active, b.sort]);
    if (!r.rowCount) return reply.code(404).send({ error: 'payment method not found' });
    await c.audit({ orgId: null, actorType: 'user', actorId: actor(req), action: 'platform.billing.method', targetType: 'payment_method', targetId: r.rows[0].id, next: { kind: b.kind, label: b.label, active: b.active }, ip: req.ip } as any);
    return reply.code(b.id ? 200 : 201).send({ id: r.rows[0].id });
  });
}
