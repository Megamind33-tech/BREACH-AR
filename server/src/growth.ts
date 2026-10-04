import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';

/**
 * Growth counters. The marketing site and the buy page report a handful of anonymous events (a visit, a download, the start of checkout) so the owner can see which
 * announcement brings people. Only a count per day, event and source is kept: no address, no cookie, no identifier, nothing that could be tied to a person.
 */
export const EVENTS = ['visit', 'download_click', 'checkout_start', 'download'] as const;
export type GrowthEvent = typeof EVENTS[number];

const clean = (s: unknown) => String(s ?? '').replace(/[^\w .:@/+-]/g, '').trim().slice(0, 60);

export async function countEvent(db: Db, event: GrowthEvent, source = ''): Promise<void> {
  await db.query(`INSERT INTO site_events(day, event, source, n) VALUES (current_date, $1, $2, 1) ON CONFLICT (day, event, source) DO UPDATE SET n = site_events.n + 1`, [event, clean(source)]);
}

/** The marketing site lives on another address than the console, so only its public counter and plan list may be called from there. */
const SITE_ORIGINS = new Set(['https://workcare.viro3.online', 'https://control.viro3.online']);

export function registerGrowthRoutes(app: FastifyInstance, o: { db: Db }) {
  const { db } = o;
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/v1/public/')) return;
    const origin = String(req.headers.origin ?? '');
    if (SITE_ORIGINS.has(origin)) reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
    if (req.method === 'OPTIONS') return reply.header('access-control-allow-methods', 'GET, POST, OPTIONS').header('access-control-allow-headers', 'content-type').header('access-control-max-age', '86400').code(204).send();
  });

  app.post('/api/v1/public/event', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ event: z.enum(['visit', 'download_click', 'checkout_start']), source: z.string().max(80).optional() }).strict().parse(req.body);
    await countEvent(db, b.event, b.source || 'direct');
    return reply.code(204).send();
  });

  const guard = (app as any).platformGuard as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  app.get('/api/v1/platform/growth', { preHandler: guard }, async req => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    const since = `current_date - ($1::int - 1)`;
    const ev = (await db.query(`SELECT day::text, event, source, n::int FROM site_events WHERE day >= ${since} ORDER BY day`, [days])).rows as { day: string; event: string; source: string; n: number }[];
    const ord = (await db.query(
      `SELECT COALESCE(NULLIF(source->>'source',''), NULLIF(source->>'ref',''), 'direct') AS source, count(*)::int orders, count(*) FILTER (WHERE status='paid')::int paid,
              COALESCE(sum(amount) FILTER (WHERE status='paid'),0)::float8 revenue, max(currency) currency
         FROM billing_orders WHERE created_at >= ${since} GROUP BY 1`, [days])).rows as { source: string; orders: number; paid: number; revenue: number; currency: string }[];
    const totals: Record<string, number> = { visit: 0, download_click: 0, checkout_start: 0, download: 0 };
    const by = new Map<string, { source: string; visit: number; download_click: number; checkout_start: number; orders: number; paid: number; revenue: number }>();
    const row = (s: string) => { let r = by.get(s); if (!r) { r = { source: s, visit: 0, download_click: 0, checkout_start: 0, orders: 0, paid: 0, revenue: 0 }; by.set(s, r); } return r; };
    for (const e of ev) { totals[e.event] = (totals[e.event] ?? 0) + e.n; if (e.event !== 'download') (row(e.source || 'direct') as any)[e.event] += e.n; }
    for (const x of ord) { const r = row(x.source); r.orders += x.orders; r.paid += x.paid; r.revenue += x.revenue; }
    const daily: Record<string, Record<string, number>> = {}; for (const e of ev) { (daily[e.day] ??= {})[e.event] = ((daily[e.day] ??= {})[e.event] ?? 0) + e.n; }
    const orders = ord.reduce((n, x) => n + x.orders, 0), paid = ord.reduce((n, x) => n + x.paid, 0);
    return { days, totals: { ...totals, orders, paid, revenue: ord.reduce((n, x) => n + x.revenue, 0), currency: ord[0]?.currency ?? 'ZMW' }, sources: [...by.values()].sort((a, b) => (b.paid - a.paid) || (b.orders - a.orders) || (b.visit - a.visit)), daily };
  });
}
