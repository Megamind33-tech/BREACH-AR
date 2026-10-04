import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { JobCtx } from './jobs.js';
import { buildReport, REFERENCE_PRICE_BOOK, type Context } from './anatomy-engine.js';
import { machineHistory } from './machine-history.js';
import { anatomyHelpers } from './anatomy.js';
import { entitlementsOf, has } from './entitlements.js';
import { scrubIdentifiers } from './certificate-content.js';

/**
 * "My PC": the Windows app reads this PC in full, sends the reading here, and gets back what it means: which parts are wearing out, whether to repair, upgrade or replace and
 * what that costs for a machine of this age, and how the PC has been used. The reading is worked on and returned; it is not stored. Each section is only filled in for
 * a plan that includes it; the others say what would unlock them and show a count so the person knows there is something to see.
 */
export function registerMyPcRoutes(app: FastifyInstance, c: JobCtx) {
  const { db } = c; const helpers = anatomyHelpers(db);

  app.post('/api/v1/my-pc/report', { preHandler: c.requireRole('viewer'), bodyLimit: 8 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = z.object({
      anatomy: z.object({ version: z.number().int().min(1).max(10) }).passthrough(),
      purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), purchaseCost: z.number().min(0).max(1e9).nullable().optional(),
    }).strict().parse(req.body);
    const ent = await entitlementsOf(db, req.user.org); const now = new Date();
    const a = b.anatomy as Record<string, any>;
    const book = (await helpers.priceBookOf(req.user.org)) ?? REFERENCE_PRICE_BOOK;
    const ctx: Context = { purchaseDate: b.purchaseDate ?? null, purchaseCost: b.purchaseCost ?? null, ramPeakPercent: null, cpuAvgPercent: null, now, history: [], coolingEvidence: { throttleEvents: Number(a.diagnostics?.cpu?.thermalThrottleEvents7d ?? 0), maxIdleTempC: null } };
    const r = buildReport(a, ctx, book);
    const watch = r.parts.filter(p => p.risk === 'WATCH').length, urgent = r.parts.filter(p => p.risk === 'HIGH' || p.risk === 'CRITICAL').length;
    const lock = (feature: string) => ({ locked: true as const, feature });

    return scrubIdentifiers({
      generatedAt: now.toISOString(),
      machine: { manufacturer: r.identity.manufacturer, model: r.identity.model, formFactor: r.identity.formFactor, os: a.os?.caption ?? null, cpu: a.cpu?.name ?? null },
      summary: { watch, urgent, parts: r.parts.length },       // always shown, so a free plan can see that there is something to look at
      health: has(ent, 'health.warnings')
        ? { parts: r.parts.map(p => ({ kind: p.kind, label: String(p.label).replace(/\bundefined\b/g, '').replace(/\s{2,}/g, ' ').trim() || p.kind, risk: p.risk, why: p.riskReasons.slice(0, 2), action: p.action, lifespan: p.lifespan, facts: p.facts.filter(f => !/serial|uuid|mac address|asset/i.test(f.label)).slice(0, 7) })), headline: r.headline }
        : lock('health.warnings'),
      advice: has(ent, 'advice.replace')
        ? { age: r.age, lifeStage: r.lifeStage, windows: r.windows, cost: r.cost, priceNote: book.source === 'entered' ? 'your organization price list' : 'Viro typical prices (an estimate, not a quote)' }
        : lock('advice.replace'),
      history: has(ent, 'history.machine') ? machineHistory({ anatomy: a, changes: [], service: [], firstSeenByViro: null, now }) : lock('history.machine'),
    }, a);
  });
}
