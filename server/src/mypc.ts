import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { JobCtx } from './jobs.js';
import { buildReport, REFERENCE_PRICE_BOOK, type Context } from './anatomy-engine.js';
import { machineHistory } from './machine-history.js';
import { anatomyHelpers } from './anatomy.js';
import { entitlementsOf, has } from './entitlements.js';
import { scrubIdentifiers } from './certificate-content.js';
import type { Mailer } from './mailer.js';
import { lacks } from './entitlements.js';
import { esc } from './certificate-pages.js';

/**
 * "My PC": the Windows app reads this PC in full, sends the reading here, and gets back what it means: which parts are wearing out, whether to repair, upgrade or replace and
 * what that costs for a machine of this age, and how the PC has been used. The reading is worked on and returned; it is not stored. Each section is only filled in for
 * a plan that includes it; the others say what would unlock them and show a count so the person knows there is something to see.
 */
export function registerMyPcRoutes(app: FastifyInstance, c: JobCtx, deps: { mailer: Mailer | null } = { mailer: null }) {
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

  // ---- the weekly care report ---------------------------------------------------------------------------------------------------------------------------
  app.post('/api/v1/my-pc/maintenance-report', { preHandler: c.requireRole('viewer'), config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const why = await lacks(db, req.user.org, 'maintenance.scheduled'); if (why) return reply.code(402).send({ error: why, upgrade: true });
    const snap = z.object({ freeBytes: z.number().min(0), memoryPercent: z.number().min(0).max(100), startupItems: z.number().int().min(0) }).strict();
    const b = z.object({ machine: z.string().max(80).optional(), version: z.string().max(20).optional(), before: snap, after: snap,
      steps: z.array(z.object({ title: z.string().max(120), applied: z.boolean(), verified: z.boolean(), summary: z.string().max(300) }).strict()).max(10) }).strict().parse(req.body);
    const id = (await db.query(`INSERT INTO maintenance_reports(org_id,user_id,machine,version,before,after,steps) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.user.org, req.user.sub, b.machine ?? null, b.version ?? null, JSON.stringify(b.before), JSON.stringify(b.after), JSON.stringify(b.steps)])).rows[0].id;
    const u = (await db.query('SELECT u.email, o.name FROM users u JOIN organizations o ON o.id=u.org_id WHERE u.id=$1', [req.user.sub])).rows[0];
    if (deps.mailer && u) {
      const freed = b.after.freeBytes - b.before.freeBytes, mem = +(b.before.memoryPercent - b.after.memoryPercent).toFixed(1), st = b.before.startupItems - b.after.startupItems;
      const done = b.steps.filter(s => s.applied && s.verified), failed = b.steps.filter(s => s.applied && !s.verified);
      const gb = (n: number) => (n >= 2 ** 30 ? (n / 2 ** 30).toFixed(1) + ' GB' : Math.round(n / 2 ** 20) + ' MB');
      const lines = [freed > 1048576 ? `Freed ${gb(freed)} of space` : null, mem > 0 ? `Memory in use down ${mem} points` : null, st > 0 ? `Turned off ${st} start-up program${st === 1 ? '' : 's'}` : null].filter((x): x is string => !!x);
      const head = done.length ? `Viro fixed ${done.length} thing${done.length === 1 ? '' : 's'} on ${b.machine ?? 'your PC'} this week` : `${b.machine ?? 'Your PC'} needed nothing this week`;
      const text = [`Hello ${u.name},`, '', head + '.', '', ...(lines.length ? lines.map(l => '  - ' + l) : ['  Nothing needed fixing: your PC is in good shape.']), ...(failed.length ? ['', `${failed.length} fix${failed.length === 1 ? '' : 'es'} could not be confirmed and were not counted. Open Viro to see why.`] : []), '', 'Every fix was measured before and after, and can be undone in the Viro window.', '', 'Viro WorkCare'].join('\n');
      const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;color:#14201a"><h2 style="margin:0 0 6px">${esc(head)}</h2><p style="color:#52645a;margin:0 0 14px">Hello ${esc(u.name)}, here is your weekly report.</p>${lines.length ? `<ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p>Nothing needed fixing: your PC is in good shape.</p>'}${failed.length ? `<p style="color:#8a5a0f">${failed.length} fix${failed.length === 1 ? '' : 'es'} could not be confirmed and were not counted. Open Viro to see why.</p>` : ''}<p style="color:#52645a;font-size:13px">Every fix was measured before and after, and can be undone in the Viro window.</p></div>`;
      try { await deps.mailer.send({ to: u.email, purpose: 'weekly-report', subject: head, text, html }); await db.query('UPDATE maintenance_reports SET emailed_at=now() WHERE id=$1', [id]); } catch { /* the report is stored either way */ }
    }
    return reply.code(201).send({ ok: true, id });
  });
}
