import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { JobCtx } from './jobs.js';

/**
 * What Viro achieved, stated as outcomes. Every figure is a count or sum of real records (verified incidents, security incidents, completed jobs,
 * care events). Nothing is estimated; where a figure cannot be known (for example downtime avoided), it is not shown.
 */
export async function monthlyOutcomes(db: Db, orgId: string, days = 30, now = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const one = async (sql: string) => (await db.query(sql, [orgId, since])).rows[0];
  const dev = (await db.query(`SELECT d.id, d.last_seen_at, (SELECT overall FROM device_health_history h WHERE h.device_id=d.id ORDER BY h.id DESC LIMIT 1) AS overall,
                                      EXISTS (SELECT 1 FROM incidents i WHERE i.device_id=d.id AND i.status='HARDWARE_ACTION_REQUIRED') AS hw
                                 FROM devices d WHERE d.org_id=$1 AND d.revoked_at IS NULL`, [orgId])).rows;
  const fresh = (d: any) => d.last_seen_at && now.getTime() - new Date(d.last_seen_at).getTime() <= 3 * 86_400_000;
  const devices = { total: dev.length, healthy: dev.filter(d => fresh(d) && !d.hw && (d.overall == null || d.overall >= 80)).length, needAttention: dev.filter(d => fresh(d) && !d.hw && d.overall != null && d.overall < 80).length, hardwareAction: dev.filter(d => d.hw).length, notReporting: dev.filter(d => !fresh(d)).length };

  const verified = await one(`SELECT count(*)::int n FROM incidents WHERE org_id=$1 AND resolution='viro-repair' AND resolved_at >= $2`);
  const crashes = await one(`SELECT count(*)::int n FROM incidents WHERE org_id=$1 AND code LIKE 'stability.app:%' AND status='RESOLVED' AND resolution='viro-repair' AND resolved_at >= $2`);
  const driverFixed = await one(`SELECT count(*)::int n FROM incidents WHERE org_id=$1 AND code LIKE 'drivers.%' AND status='RESOLVED' AND resolved_at >= $2`);
  const sec = await one(`SELECT count(*) FILTER (WHERE threat_type='malware' AND status IN ('OBSERVING','RESOLVED'))::int malware, count(*) FILTER (WHERE threat_type='ransomware' AND status IN ('OBSERVING','RESOLVED'))::int ransomware,
                                count(*) FILTER (WHERE threat_type='pua' AND status IN ('OBSERVING','RESOLVED'))::int pua, count(*) FILTER (WHERE status NOT IN ('OBSERVING','RESOLVED'))::int open
                           FROM security_incidents WHERE org_id=$1 AND detected_at >= $2`);
  const cleaned = await one(`SELECT COALESCE(sum((result->>'freedBytes')::numeric),0)::float8 b FROM jobs WHERE org_id=$1 AND type='cleanup.run' AND status='completed' AND finished_at >= $2`);
  const failing = await one(`SELECT count(DISTINCT device_id)::int n FROM incidents WHERE org_id=$1 AND code ~ '^hardware\\.disk_(unhealthy|errors|warning)$' AND first_detected >= $2`);
  const upgrades = (await db.query(`SELECT count(DISTINCT device_id)::int n FROM incidents WHERE org_id=$1 AND code IN ('hardware.low_ram','hardware.hdd_system') AND status <> 'RESOLVED'`, [orgId])).rows[0];
  const battery = await one(`SELECT count(*)::int n FROM (SELECT DISTINCT ON (device_id) device_id, health_percent FROM battery_samples WHERE org_id=$1 AND at >= $2 ORDER BY device_id, at DESC) x WHERE health_percent < 70`);
  const heat = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE recovered_at IS NOT NULL)::int recovered FROM thermal_incidents WHERE org_id=$1 AND at >= $2`);
  const mem = await one(`SELECT COALESCE(sum((data->>'reclaimedMb')::numeric),0)::float8 mb, count(*)::int runs FROM care_events WHERE org_id=$1 AND kind='memory.trim' AND at >= $2`);
  const updates = await one(`SELECT COALESCE(sum((result->>'installed')::int),0)::int n FROM jobs WHERE org_id=$1 AND type='updates.install' AND status='completed' AND finished_at >= $2`);
  const autopilot = await one(`SELECT count(DISTINCT i.id)::int n FROM incidents i JOIN incident_actions a ON a.incident_id=i.id AND a.kind='repair' AND a.by='autopilot' WHERE i.org_id=$1 AND i.resolution='viro-repair' AND i.resolved_at >= $2`);
  return {
    periodDays: days, devices,
    verifiedRepairs: verified.n, recurringCrashProblemsStopped: crashes.n, malwareIncidentsRemoved: sec.malware, ransomwareContained: sec.ransomware, unwantedSoftwareRemoved: sec.pua, openSecurityIncidents: sec.open,
    storageRecoveredGb: Math.round(cleaned.b / 1073741824 * 10) / 10, driverIssuesResolved: driverFixed.n, failingDrivesDetected: failing.n, batteryProblemsIdentified: battery.n, thermalEvents: heat.n, thermalEventsRecovered: heat.recovered,
    hardwareUpgradesRecommended: upgrades.n, memoryReclaimedGb: Math.round(mem.mb / 1024 * 10) / 10, windowsUpdatesInstalled: updates.n, fixedByAutopilot: autopilot.n,
  };
}

export interface TimelineItem { at: string; kind: string; title: string; detail?: string }

/** "What Viro did" for one computer: a dated list of real events, newest first. */
export async function deviceTimeline(db: Db, orgId: string, deviceId: string, days = 90, now = new Date()): Promise<TimelineItem[]> {
  const since = new Date(now.getTime() - days * 86_400_000); const out: TimelineItem[] = [];
  for (const r of (await db.query(`SELECT title, status, resolution, first_detected, resolved_at, repaired_at, before_metrics, after_metrics FROM incidents WHERE device_id=$1 AND org_id=$2 AND GREATEST(first_detected, COALESCE(resolved_at, first_detected)) >= $3`, [deviceId, orgId, since])).rows) {
    out.push({ at: r.first_detected, kind: 'problem', title: `Detected: ${r.title}` });
    if (r.resolved_at) out.push({ at: r.resolved_at, kind: 'resolved', title: `${r.resolution === 'viro-repair' ? 'Verified fixed' : 'Cleared'}: ${r.title}`, detail: r.resolution === 'viro-repair' ? 'Checked after the repair and observed without recurrence.' : undefined });
  }
  for (const r of (await db.query(`SELECT threat_name, threat_type, status, detected_at, resolved_at, verification_status FROM security_incidents WHERE device_id=$1 AND org_id=$2 AND detected_at >= $3`, [deviceId, orgId, since])).rows) {
    out.push({ at: r.detected_at, kind: 'security', title: `Threat detected: ${r.threat_name}` });
    if (r.resolved_at) out.push({ at: r.resolved_at, kind: 'security', title: `Security incident resolved: ${r.threat_name}`, detail: 'Fresh scan clean and observed without recurrence.' });
  }
  for (const r of (await db.query(`SELECT type, params, result, finished_at FROM jobs WHERE device_id=$1 AND org_id=$2 AND status='completed' AND finished_at >= $3 AND type IN ('repair.run','cleanup.run','updates.install','driver.install','driver.rollback','security.scan','software.install','software.uninstall')`, [deviceId, orgId, since])).rows) {
    if (r.type === 'repair.run') { if (r.result?.applied && r.result?.verified) out.push({ at: r.finished_at, kind: 'repair', title: `Repaired: ${r.result.title ?? r.params?.recipe}`, detail: r.result.summary }); }
    else if (r.type === 'cleanup.run') { const mb = Math.round((r.result?.freedBytes ?? 0) / 1048576); if (mb > 0) out.push({ at: r.finished_at, kind: 'storage', title: `Recovered ${mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB'} of storage` }); }
    else if (r.type === 'updates.install') { if ((r.result?.installed ?? 0) > 0) out.push({ at: r.finished_at, kind: 'update', title: `Installed ${r.result.installed} Windows update${r.result.installed === 1 ? '' : 's'}` }); }
    else if (r.type === 'driver.install') out.push({ at: r.finished_at, kind: 'driver', title: 'Installed a driver update' });
    else if (r.type === 'driver.rollback') out.push({ at: r.finished_at, kind: 'driver', title: 'Rolled back a driver update' });
    else if (r.type === 'security.scan') out.push({ at: r.finished_at, kind: 'security', title: 'Security scan completed' });
    else out.push({ at: r.finished_at, kind: 'software', title: r.type === 'software.install' ? 'Installed approved software' : 'Removed software' });
  }
  for (const r of (await db.query(`SELECT at, kind, data FROM care_events WHERE device_id=$1 AND org_id=$2 AND at >= $3 AND kind IN ('printer.fix','printer.failing','memory.trim','thermal.heat','apps.closed','ui.heat-notice','ui.battery-notice')`, [deviceId, orgId, since])).rows) {
    const d = r.data ?? {};
    if (r.kind === 'printer.fix') out.push({ at: r.at, kind: 'repair', title: d.verified ? `Fixed printing${d.printer ? ' on ' + d.printer : ''}` : `Tried to fix printing${d.printer ? ' on ' + d.printer : ''}; it is still wrong`, detail: String(d.summary ?? '').slice(0, 300) });
    else if (r.kind === 'printer.failing') out.push({ at: r.at, kind: 'problem', title: `Printing needs attention${d.printer ? ': ' + d.printer : ''}`, detail: String(d.detail ?? '').slice(0, 300) });
    else if (r.kind === 'memory.trim' && (d.reclaimedMb ?? 0) > 0) out.push({ at: r.at, kind: 'memory', title: `Freed ${Math.round(d.reclaimedMb)} MB of memory from idle programs`, detail: `Memory use ${d.beforePercent}% to ${d.afterPercent}%. Nothing was closed.` });
    else if (r.kind === 'thermal.heat') out.push({ at: r.at, kind: 'thermal', title: `Paused background compute: CPU reached ${Math.round(d.tempC ?? 0)}°C`, detail: Array.isArray(d.topProcesses) && d.topProcesses.length ? `Busiest: ${d.topProcesses.slice(0, 3).map((p: any) => p.name).join(', ')}` : undefined });
    else if (r.kind === 'apps.closed') { const n = (d.results ?? []).filter((x: any) => x.closed).length; if (n) out.push({ at: r.at, kind: 'apps', title: `Closed ${n} safe background helper${n === 1 ? '' : 's'}`, detail: (d.results ?? []).filter((x: any) => x.closed).map((x: any) => x.name).join(', ') }); }
    else if (r.kind === 'ui.heat-notice' || r.kind === 'ui.battery-notice') out.push({ at: r.at, kind: 'notice', title: r.kind === 'ui.heat-notice' ? 'Warned the user about heat' : 'Warned the user about battery drain', detail: d.choice ? `They chose: ${d.choice}` : 'No choice was made.' });
  }
  return out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export function registerOutcomeRoutes(app: FastifyInstance, c: JobCtx) {
  app.get('/api/v1/outcomes/month', { preHandler: c.requireRole('viewer') }, async req => monthlyOutcomes(c.db, req.user.org, z.preprocess(v => (v === undefined ? 30 : v), z.coerce.number().int().min(1).max(365)).parse((req.query as any)?.days ?? undefined)));
  app.get('/api/v1/devices/:id/what-viro-did', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await c.db.query('SELECT 1 FROM devices WHERE id=$1 AND org_id=$2', [id, req.user.org])).rowCount) return reply.code(404).send({ error: 'not found' });
    return { items: (await deviceTimeline(c.db, req.user.org, id, z.preprocess(v => (v === undefined ? 90 : v), z.coerce.number().int().min(1).max(365)).parse((req.query as any)?.days ?? undefined))).slice(0, 200) };
  });
}
