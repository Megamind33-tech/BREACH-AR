import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { HealthResult } from './health.js';
import type { JobCtx } from './jobs.js';

/**
 * Alerts are derived state, never hand-entered: an alert is open exactly while the underlying finding is present.
 * High-impact health findings raise alerts (critical for security/hardware, warning otherwise); a device that stops
 * reporting raises a warning. Alerts resolve themselves when the finding disappears.
 */
export async function refreshAlerts(db: Db, orgId: string, deviceId: string, h: HealthResult): Promise<void> {
  const desired = new Map<string, { severity: 'critical' | 'warning'; message: string }>();
  for (const d of h.deductions) {
    if (d.impact !== 'high') continue;
    desired.set(d.code, { severity: d.category === 'security' || d.category === 'hardware' ? 'critical' : 'warning', message: d.reason });
  }
  for (const [code, a] of desired)
    await db.query(
      `INSERT INTO alerts(org_id,device_id,code,severity,message) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (device_id, code) WHERE resolved_at IS NULL DO UPDATE SET last_seen_at=now(), severity=EXCLUDED.severity, message=EXCLUDED.message`,
      [orgId, deviceId, code, a.severity, a.message]);
  await db.query(`UPDATE alerts SET resolved_at=now() WHERE device_id=$1 AND resolved_at IS NULL AND code NOT LIKE 'device.%' AND NOT (code = ANY($2::text[]))`, [deviceId, [...desired.keys()]]);
}

/** Devices silent for longer than the threshold raise 'device.offline'; it resolves when they report again. */
export async function offlineSweep(db: Db, thresholdMinutes = 15): Promise<void> {
  await db.query(
    `INSERT INTO alerts(org_id,device_id,code,severity,message)
     SELECT org_id, id, 'device.offline', 'warning', 'No contact from ' || hostname || ' for ' || GREATEST(1, (extract(epoch FROM now() - last_seen_at) / 60)::int) || ' minutes'
       FROM devices WHERE revoked_at IS NULL AND last_seen_at IS NOT NULL AND last_seen_at < now() - make_interval(mins => $1)
     ON CONFLICT (device_id, code) WHERE resolved_at IS NULL DO UPDATE SET last_seen_at=now(), message=EXCLUDED.message`, [thresholdMinutes]);
  await db.query(
    `UPDATE alerts a SET resolved_at=now() FROM devices d
      WHERE a.device_id=d.id AND a.code='device.offline' AND a.resolved_at IS NULL
        AND (d.revoked_at IS NOT NULL OR d.last_seen_at >= now() - make_interval(mins => $1))`, [thresholdMinutes]);
}

export function registerAlertRoutes(app: FastifyInstance, c: JobCtx) {
  const { db } = c;
  app.get('/api/v1/alerts', { preHandler: c.requireRole('viewer') }, async req => {
    const f = z.object({ status: z.enum(['open', 'resolved', 'all']).default('open'), deviceId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const w = ['a.org_id=$1']; const v: unknown[] = [req.user.org];
    if (f.status === 'open') w.push('a.resolved_at IS NULL'); else if (f.status === 'resolved') w.push('a.resolved_at IS NOT NULL');
    if (f.deviceId) { v.push(f.deviceId); w.push(`a.device_id=$${v.length}`); }
    v.push(f.limit);
    const r = await db.query(
      `SELECT a.id, a.device_id, d.hostname, a.code, a.severity, a.message, a.first_seen_at, a.last_seen_at, a.resolved_at, a.acknowledged_at
         FROM alerts a JOIN devices d ON d.id=a.device_id WHERE ${w.join(' AND ')}
        ORDER BY (a.severity='critical') DESC, a.last_seen_at DESC LIMIT $${v.length}`, v);
    const counts = await db.query(`SELECT severity, count(*)::int n, (count(*) FILTER (WHERE acknowledged_at IS NULL))::int unack FROM alerts WHERE org_id=$1 AND resolved_at IS NULL GROUP BY severity`, [req.user.org]);
    // `open` counts every unresolved alert; `unacknowledged` only those nobody has taken responsibility for yet (what a badge should show).
    return { alerts: r.rows, open: Object.fromEntries(counts.rows.map(x => [x.severity, x.n])), unacknowledged: Object.fromEntries(counts.rows.map(x => [x.severity, x.unack])) };
  });

  /** Acknowledge everything currently open in one step. Alerts raised later are new and stay unacknowledged. */
  app.post('/api/v1/alerts/ack-all', { preHandler: c.requireRole('technician') }, async req => {
    const r = await db.query(`UPDATE alerts SET acknowledged_at=now(), acknowledged_by=$2 WHERE org_id=$1 AND resolved_at IS NULL AND acknowledged_at IS NULL RETURNING id`, [req.user.org, req.user.sub]);
    if (r.rowCount) await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'alert.acknowledge_all', targetType: 'organization', targetId: req.user.org, next: { count: r.rowCount } });
    return { ok: true, acknowledged: r.rowCount };
  });

  app.post('/api/v1/alerts/:id/ack', { preHandler: c.requireRole('technician') }, async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const r = await db.query(`UPDATE alerts SET acknowledged_at=now(), acknowledged_by=$3 WHERE id=$1 AND org_id=$2 AND resolved_at IS NULL RETURNING id`, [id, req.user.org, req.user.sub]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found or already resolved' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'alert.acknowledge', targetType: 'alert', targetId: String(id) });
    return { ok: true };
  });
}
