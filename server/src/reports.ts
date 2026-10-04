import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { JobCtx } from './jobs.js';

/** CSV cells beginning with = + - @ are executed as formulas by spreadsheets; neutralise them. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export function registerReportRoutes(app: FastifyInstance, c: JobCtx, deviceRows: (orgId: string) => Promise<any[]>) {
  const { db } = c;

  app.get('/api/v1/reports/summary', { preHandler: c.requireRole('viewer') }, async req => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    const org = req.user.org;
    const jobs = await db.query(`SELECT type, status, count(*)::int n FROM jobs WHERE org_id=$1 AND created_at >= now() - make_interval(days => $2) GROUP BY type, status ORDER BY type`, [org, days]);
    const repairs = await db.query(`SELECT type, result FROM jobs WHERE org_id=$1 AND status='completed' AND finished_at >= now() - make_interval(days => $2) AND type IN ('repair.run','repair.fix-safe','cleanup.run')`, [org, days]);
    let resolved = 0, freed = 0;
    for (const j of repairs.rows) { const r = j.result as any; if (!r) continue;
      if (j.type === 'repair.run') { if (r.applied && r.verified === true) resolved++; freed += r.after?.freedBytes ?? 0; }
      else if (j.type === 'repair.fix-safe') { resolved += r.fixedCount ?? 0; for (const x of r.repairs ?? []) freed += x.after?.freedBytes ?? 0; }
      else freed += r.freedBytes ?? 0; }
    const alerts = await db.query(`SELECT count(*) FILTER (WHERE first_seen_at >= now() - make_interval(days => $2))::int opened, count(*) FILTER (WHERE resolved_at >= now() - make_interval(days => $2))::int resolved,
                                          count(*) FILTER (WHERE resolved_at IS NULL AND severity='critical')::int open_critical, count(*) FILTER (WHERE resolved_at IS NULL AND severity='warning')::int open_warning FROM alerts WHERE org_id=$1`, [org, days]);
    const rows = await deviceRows(org);
    const hw = rows.filter(r => r.hardware_verdict === 'critical' || r.hardware_verdict === 'warning').map(r => ({ deviceId: r.id, hostname: r.hostname, verdict: r.hardware_verdict }));
    const dist = { healthy: 0, attention: 0, critical: 0, unassessed: 0 } as Record<string, number>;
    for (const r of rows) dist[r.health_status ?? 'unassessed']++;
    const scored = rows.filter(r => r.health_score != null);
    const stale = rows.filter(r => !r.last_seen_at || Date.now() - new Date(r.last_seen_at).getTime() > 7 * 86400_000).map(r => ({ deviceId: r.id, hostname: r.hostname, lastSeenAt: r.last_seen_at }));
    return {
      periodDays: days, computers: rows.length, distribution: dist,
      averageHealth: scored.length ? Math.round(scored.reduce((a, r) => a + r.health_score, 0) / scored.length) : null,
      jobs: jobs.rows, problemsResolved: resolved, storageRecoveredBytes: freed, alerts: alerts.rows[0],
      hardwareAttention: hw, notSeenIn7Days: stale,
    };
  });

  app.get('/api/v1/reports/devices.csv', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const rows = await deviceRows(req.user.org);
    const csv = toCsv(['Computer', 'Site', 'Department', 'User', 'Health', 'Status', 'Hardware', 'OS', 'CPU', 'RAM GB', 'Agent', 'Last seen', 'Open alerts', 'Tags'],
      rows.map(r => [r.hostname, r.site, r.department, r.logged_in_user, r.health_score, r.health_status, r.hardware_verdict, r.os_caption, r.cpu, r.ram_bytes ? (Number(r.ram_bytes) / 2 ** 30).toFixed(1) : '', r.agent_version, r.last_seen_at?.toISOString?.() ?? r.last_seen_at, r.open_alerts, (r.tags ?? []).join(';')]));
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'report.export', targetType: 'report', targetId: 'devices.csv' });
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="viro-computers.csv"').send(csv);
  });

  app.get('/api/v1/reports/jobs.csv', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const r = await db.query(`SELECT j.created_at, d.hostname, j.type, j.status, j.finished_at, j.error FROM jobs j JOIN devices d ON d.id=j.device_id WHERE j.org_id=$1 ORDER BY j.created_at DESC LIMIT 10000`, [req.user.org]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'report.export', targetType: 'report', targetId: 'jobs.csv' });
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="viro-jobs.csv"')
      .send(toCsv(['Created', 'Computer', 'Job', 'Status', 'Finished', 'Error'], r.rows.map(x => [x.created_at.toISOString(), x.hostname, x.type, x.status, x.finished_at?.toISOString() ?? '', x.error])));
  });
}
