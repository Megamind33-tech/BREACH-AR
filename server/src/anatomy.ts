import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { JobCtx } from './jobs.js';
import type { Db } from './db.js';
import { onHardwareChanged } from './upgrade-store.js';
import { recordHardwareReading } from './condition.js';
import { REFERENCE_PRICE_BOOK, buildReport, componentIds, diffAnatomy, type Context, type PriceBook } from './anatomy-engine.js';

/** Computer anatomy: collected by the agent, stored with its history, and turned into the report an owner reads. */
const PriceBookSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/), labourPerHour: z.number().min(0).max(100000),
  items: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.number().min(0).max(1_000_000)).refine(o => Object.keys(o).length <= 40, 'too many items'),
  newPc: z.record(z.string().regex(/^[a-z-]{1,20}$/), z.number().min(0).max(10_000_000)),
}).strict();

/** Reads shared by the anatomy report and the upgrade engine: the organization's price book, and the usage and thermal evidence for a computer. */
export function anatomyHelpers(db: Db) {
  async function priceBookOf(orgId: string): Promise<PriceBook | null> {
    const r = (await db.query('SELECT currency, source, labour_per_hour, items, new_pc FROM price_book WHERE org_id=$1', [orgId])).rows[0];
    return r ? { currency: r.currency, source: r.source, labourPerHour: Number(r.labour_per_hour), items: r.items, newPc: r.new_pc } : null;
  }

  async function contextFor(orgId: string, deviceId: string, a: any, now = new Date()): Promise<Context> {
    const dev = (await db.query('SELECT purchase_date, purchase_cost FROM devices WHERE id=$1 AND org_id=$2', [deviceId, orgId])).rows[0] ?? {};
    const hb = (await db.query(`SELECT max((metrics->>'ramPercent')::float) ram, avg((metrics->>'cpuPercent')::float) cpu FROM device_heartbeats WHERE device_id=$1`, [deviceId])).rows[0] ?? {};
    const hist = (await db.query(`SELECT at, (battery->>'healthPercent')::float AS hp FROM hardware_readings WHERE device_id=$1 AND battery IS NOT NULL ORDER BY at`, [deviceId])).rows;
    const zones: number[] = (a?.diagnostics?.thermal?.zones ?? []).map((z: any) => z.tempC).filter((x: unknown) => typeof x === 'number');
    return { purchaseDate: dev.purchase_date ? new Date(dev.purchase_date).toISOString().slice(0, 10) : null, purchaseCost: dev.purchase_cost != null ? Number(dev.purchase_cost) : null,
      ramPeakPercent: hb.ram ?? null, cpuAvgPercent: hb.cpu ?? null, now, history: hist.map((h: any) => ({ at: new Date(h.at), healthPercent: h.hp })),
      coolingEvidence: { throttleEvents: Number(a?.diagnostics?.cpu?.thermalThrottleEvents7d ?? 0), maxIdleTempC: zones.length ? Math.max(...zones) : null } };
  }

  return { priceBookOf, contextFor };
}

export function registerAnatomyRoutes(app: FastifyInstance, c: JobCtx) {
  const { db } = c;

  const fingerprintOf = (a: any) => createHash('sha256').update(JSON.stringify([componentIds(a).map(x => `${x.kind}|${x.id}`).sort(), a.os?.build, a.bios?.version, a.bios?.releaseDate, a.cpu?.name])).digest('hex');

  // The agent reports its anatomy about once a day, and when asked.
  app.post('/agent/v1/anatomy', { preHandler: c.requireDevice, bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const a = z.object({ version: z.number().int().min(1).max(10), collectedAt: z.string().datetime({ offset: true }) }).passthrough().parse(req.body) as any;
    const { id, orgId } = req.device!;
    const prev = (await db.query('SELECT data FROM device_anatomy WHERE device_id=$1', [id])).rows[0]?.data ?? null;
    await db.query(`INSERT INTO device_anatomy(device_id,org_id,data,collected_at) VALUES ($1,$2,$3,$4)
                    ON CONFLICT (device_id) DO UPDATE SET data=EXCLUDED.data, collected_at=EXCLUDED.collected_at, received_at=now()`, [id, orgId, JSON.stringify(a), a.collectedAt]);
    const fp = fingerprintOf(a); const last = (await db.query('SELECT fingerprint FROM anatomy_history WHERE device_id=$1 ORDER BY collected_at DESC LIMIT 1', [id])).rows[0];
    let changes = 0;
    if (!last || last.fingerprint !== fp) {
      await db.query('INSERT INTO anatomy_history(device_id,org_id,collected_at,fingerprint,data) VALUES ($1,$2,$3,$4,$5)', [id, orgId, a.collectedAt, fp, JSON.stringify(a)]);
      const changesNow = diffAnatomy(prev, a);
      await onHardwareChanged(db, orgId, id, changesNow, async () => { const { createSystemJob } = await import('./jobs.js'); return createSystemJob(db, (c as any).signer, { orgId, deviceId: id, type: 'benchmark.upgrade', params: { purpose: 'after' }, ttlMinutes: 24 * 60, source: { purpose: 'after a hardware change' } }); }).catch(() => null);
      for (const ch of changesNow) { await db.query('INSERT INTO anatomy_changes(device_id,org_id,kind,change,label,before,after) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, orgId, ch.kind, ch.change, ch.label, ch.before ? JSON.stringify(ch.before) : null, ch.after ? JSON.stringify(ch.after) : null]); changes++; }
    }
    if (a.diagnostics) await recordHardwareReading(db, orgId, id, a.diagnostics);      // the same readings feed the drive and battery trends
    try { await (c as any).afterAnatomy?.(orgId, id); } catch { /* issuing a certificate must never fail the report */ }
    return reply.code(201).send({ stored: true, changes });
  });

  const { priceBookOf, contextFor } = anatomyHelpers(db);

  app.get('/api/v1/devices/:id/anatomy', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const dev = (await db.query('SELECT id, hostname FROM devices WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL', [id, req.user.org])).rows[0];
    if (!dev) return reply.code(404).send({ error: 'computer not found' });
    const row = (await db.query('SELECT data, collected_at FROM device_anatomy WHERE device_id=$1', [id])).rows[0];
    if (!row) return { available: false, hostname: dev.hostname, note: 'The full anatomy has not been collected from this computer yet. It is collected automatically within a day of the newest Viro version being installed, or now with "Collect now".' };
    const ctx = await contextFor(req.user.org, id, row.data); const book = await priceBookOf(req.user.org);
    const changes = (await db.query('SELECT detected_at, kind, change, label FROM anatomy_changes WHERE device_id=$1 ORDER BY detected_at DESC LIMIT 100', [id])).rows;
    const service = (await db.query(`SELECT occurred_at, service_type, reason, technician, notes, cost, source FROM service_events WHERE device_id=$1 AND status='CONFIRMED' ORDER BY occurred_at DESC LIMIT 100`, [id])).rows;
    const report = buildReport(row.data, ctx, book);
    return { available: true, hostname: dev.hostname, report, changes, service, priceBook: book, raw: row.data };
  });

  app.post('/api/v1/devices/:id/anatomy/collect', { preHandler: c.requireRole('technician') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await db.query('SELECT 1 FROM devices WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL', [id, req.user.org])).rowCount) return reply.code(404).send({ error: 'computer not found' });
    const { createSystemJob } = await import('./jobs.js');
    const jobId = await createSystemJob(db, (c as any).signer, { orgId: req.user.org, deviceId: id, type: 'anatomy.collect', params: {}, ttlMinutes: 30, source: { by: req.user.sub } });
    return reply.code(202).send({ jobId });
  });

  // ---- the price book ------------------------------------------------------------------------------------------------------------------
  app.get('/api/v1/price-book', { preHandler: c.requireRole('viewer') }, async req => ({ priceBook: await priceBookOf(req.user.org), reference: REFERENCE_PRICE_BOOK }));
  app.put('/api/v1/price-book', { preHandler: c.requireRole('admin') }, async req => {
    const b = PriceBookSchema.parse(req.body);
    await db.query(`INSERT INTO price_book(org_id,currency,source,labour_per_hour,items,new_pc,updated_by) VALUES ($1,$2,'entered',$3,$4,$5,$6)
                    ON CONFLICT (org_id) DO UPDATE SET currency=EXCLUDED.currency, source='entered', labour_per_hour=EXCLUDED.labour_per_hour, items=EXCLUDED.items, new_pc=EXCLUDED.new_pc, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [req.user.org, b.currency, b.labourPerHour, JSON.stringify(b.items), JSON.stringify(b.newPc), req.user.sub]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'price_book.update', next: { currency: b.currency } });
    return { saved: true };
  });
  app.post('/api/v1/price-book/reference', { preHandler: c.requireRole('admin') }, async req => {
    const r = REFERENCE_PRICE_BOOK;
    await db.query(`INSERT INTO price_book(org_id,currency,source,labour_per_hour,items,new_pc,updated_by) VALUES ($1,$2,'reference',$3,$4,$5,$6)
                    ON CONFLICT (org_id) DO UPDATE SET currency=EXCLUDED.currency, source='reference', labour_per_hour=EXCLUDED.labour_per_hour, items=EXCLUDED.items, new_pc=EXCLUDED.new_pc, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [req.user.org, r.currency, r.labourPerHour, JSON.stringify(r.items), JSON.stringify(r.newPc), req.user.sub]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'price_book.reference' });
    return { saved: true };
  });

  // ---- the whole fleet in one table ---------------------------------------------------------------------------------------------------------
  app.get('/api/v1/anatomy/fleet', { preHandler: c.requireRole('viewer') }, async req => {
    const rows = (await db.query(`SELECT d.id, d.hostname, a.data FROM device_anatomy a JOIN devices d ON d.id=a.device_id WHERE a.org_id=$1 AND d.revoked_at IS NULL ORDER BY d.hostname`, [req.user.org])).rows;
    const book = await priceBookOf(req.user.org); const out = [];
    for (const r of rows) {
      const rep = buildReport(r.data, await contextFor(req.user.org, r.id, r.data), book);
      out.push({ id: r.id, hostname: r.hostname, model: [rep.identity.manufacturer, rep.identity.model].filter(Boolean).join(' '), formFactor: rep.identity.formFactor, ageYears: rep.age.ageYears, ageConfidence: rep.age.confidence, stage: rep.lifeStage.stage,
        worst: rep.parts.reduce((w: string, p: any) => ({ UNKNOWN: -1, LOW: 0, WATCH: 1, HIGH: 2, CRITICAL: 3 } as any)[p.risk] > ({ UNKNOWN: -1, LOW: 0, WATCH: 1, HIGH: 2, CRITICAL: 3 } as any)[w] ? p.risk : w, 'LOW'),
        windows11Ready: rep.windows.windows11Ready, decision: (rep.cost as any).decision ?? null, repairTotal: (rep.cost as any).repairTotal ?? null, headline: rep.headline.slice(0, 2).map((h: any) => `${h.part}: ${h.why}`) });
    }
    return { currency: book?.currency ?? null, computers: out };
  });
}
