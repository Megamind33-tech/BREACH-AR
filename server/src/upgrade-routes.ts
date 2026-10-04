import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { JobCtx } from './jobs.js';
import { reportForDevice, recordRecommendation } from './upgrade-store.js';
import { buildFleetPlan } from './upgrade/fleet.js';

/** What a customer may see: the validated recommendations and why. The scoring weights, candidate search and internal ranking never leave the server. */
export function registerUpgradeRoutes(app: FastifyInstance, c: JobCtx) {
  const { db } = c;

  app.get('/api/v1/devices/:id/upgrades', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const dev = (await db.query('SELECT id, hostname FROM devices WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL', [id, req.user.org])).rows[0];
    if (!dev) return reply.code(404).send({ error: 'computer not found' });
    const row = (await db.query('SELECT data FROM device_anatomy WHERE device_id=$1', [id])).rows[0];
    if (!row) return { available: false, hostname: dev.hostname, note: 'The hardware has not been read from this computer yet. Upgrade advice needs the full anatomy reading first.' };
    const report: any = await reportForDevice(db, req.user.org, id, row.data);
    const recId = await recordRecommendation(db, req.user.org, id, report);
    const ver = (await db.query(`SELECT id, detected_at, changes, predicted, state, result, completed_at FROM upgrade_verifications WHERE device_id=$1 ORDER BY detected_at DESC LIMIT 5`, [id])).rows;
    const bench = (await db.query(`SELECT purpose, taken_at, metrics, safety FROM upgrade_benchmarks WHERE device_id=$1 ORDER BY taken_at DESC LIMIT 5`, [id])).rows;
    return { available: true, hostname: dev.hostname, report, recommendationRecord: recId, verifications: ver, measurements: bench };
  });

  app.get('/api/v1/devices/:id/upgrades/history', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await db.query('SELECT 1 FROM devices WHERE id=$1 AND org_id=$2', [id, req.user.org])).rowCount) return reply.code(404).send({ error: 'computer not found' });
    const recs = (await db.query('SELECT id, created_at, grade, best, recommendations, replacement, hardware FROM upgrade_recommendations WHERE device_id=$1 ORDER BY created_at DESC LIMIT 50', [id])).rows;
    const ver = (await db.query('SELECT id, detected_at, recommendation_id, changes, predicted, state, result, completed_at FROM upgrade_verifications WHERE device_id=$1 ORDER BY detected_at DESC LIMIT 50', [id])).rows;
    return { recommendations: recs, verifications: ver };
  });

  // The controlled baseline: short, non-destructive measurements that make every prediction checkable afterwards.
  app.post('/api/v1/devices/:id/upgrades/baseline', { preHandler: c.requireRole('technician') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await db.query('SELECT 1 FROM devices WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL', [id, req.user.org])).rowCount) return reply.code(404).send({ error: 'computer not found' });
    const { createSystemJob } = await import('./jobs.js');
    const jobId = await createSystemJob(db, (c as any).signer, { orgId: req.user.org, deviceId: id, type: 'benchmark.upgrade', params: { purpose: 'baseline' }, ttlMinutes: 120, source: { by: req.user.sub, purpose: 'upgrade baseline' } });
    if (!jobId) return reply.code(400).send({ error: 'could not queue the measurement' });
    return reply.code(202).send({ jobId });
  });

  app.get('/api/v1/upgrades/fleet', { preHandler: c.requireRole('viewer') }, async req => {
    const rows = (await db.query(`SELECT d.id, d.hostname, a.data FROM device_anatomy a JOIN devices d ON d.id=a.device_id WHERE a.org_id=$1 AND d.revoked_at IS NULL ORDER BY d.hostname LIMIT 500`, [req.user.org])).rows;
    const items = [];
    for (const r of rows) items.push({ deviceId: r.id as string, hostname: r.hostname as string, anatomy: r.data, report: await reportForDevice(db, req.user.org, r.id, r.data) as Record<string, any> });
    const plan = buildFleetPlan(items);
    const notRead = ((await db.query('SELECT count(*)::int AS n FROM devices WHERE org_id=$1 AND revoked_at IS NULL', [req.user.org])).rows[0]?.n ?? 0) - rows.length;
    return { ...plan, withoutReading: Math.max(0, notRead), computers: items.map(i => ({ deviceId: i.deviceId, hostname: i.hostname, grade: i.report.opportunity.grade, best: i.report.recommendations.find((r: any) => r.id === i.report.best)?.title ?? null, action: i.report.replacement.action })) };
  });

  // Whether verified results from this organization may help other organizations' predictions (hardware facts only, never organization data).
  app.get('/api/v1/upgrades/settings', { preHandler: c.requireRole('viewer') }, async req => ({ shareOutcomes: !!(await db.query('SELECT share_outcomes FROM upgrade_settings WHERE org_id=$1', [req.user.org])).rows[0]?.share_outcomes }));
  app.put('/api/v1/upgrades/settings', { preHandler: c.requireRole('admin') }, async req => {
    const b = z.object({ shareOutcomes: z.boolean() }).strict().parse(req.body);
    await db.query(`INSERT INTO upgrade_settings(org_id,share_outcomes) VALUES ($1,$2) ON CONFLICT (org_id) DO UPDATE SET share_outcomes=EXCLUDED.share_outcomes, updated_at=now()`, [req.user.org, b.shareOutcomes]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'upgrades.share_outcomes', next: { shareOutcomes: b.shareOutcomes } });
    return { saved: true };
  });
}
