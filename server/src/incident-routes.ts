import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { HealthResult, Snapshot } from './health.js';
import { createSystemJob, type JobCtx, type JobSigner } from './jobs.js';
import { attachRepairJob, deviceStory, incidentBenchmark, incidentRow } from './incidents.js';
import { slowPcDiagnosis } from './diagnosis.js';
import { kpis as fleetKpis } from './fleet-intel.js';

/**
 * One root problem, its symptoms underneath. "basis" says how the link was established: 'evidence' when the crash analysis itself tied the
 * crashes to the root cause, 'coincides' when the symptom is present while the root problem is (a co-occurrence, not proof of cause).
 */
export function groupSymptoms(incs: { id: string; code: string; status: string; evidence?: { type: string; value: any }[] }[]) {
  const active = incs.filter(i => i.status !== 'RESOLVED');
  const rootOf = (code: string) => active.find(i => i.code === code);
  const groups = new Map<string, { root: string; symptoms: { id: string; basis: 'evidence' | 'coincides' }[] }>();
  for (const i of active) {
    let rootCode: string | null = null, basis: 'evidence' | 'coincides' = 'coincides';
    const cause = i.evidence?.find(e => e.type === 'TELEMETRY' && e.value?.cause)?.value.cause;
    if (i.code.startsWith('stability.app:')) { if (cause === 'storage-pressure') { rootCode = 'storage.system_low'; basis = 'evidence'; } else if (cause === 'memory-pressure') { rootCode = 'perf.ram_pressure'; basis = 'evidence'; } }
    else if (['updates.search_stuck', 'updates.stale', 'updates.many_pending'].includes(i.code)) rootCode = 'storage.system_low';
    else if (i.code === 'perf.pagefile_pressure') rootCode = 'perf.ram_pressure';
    const root = rootCode ? rootOf(rootCode) : null;
    if (!root || root.id === i.id) continue;
    const g = groups.get(root.id) ?? { root: root.id, symptoms: [] }; g.symptoms.push({ id: i.id, basis }); groups.set(root.id, g);
  }
  return [...groups.values()];
}

export function registerIncidentRoutes(app: FastifyInstance, c: JobCtx & { signer: JobSigner }, o: { healthOf: (orgId: string, deviceId: string) => Promise<{ snap: Snapshot; h: HealthResult } | null> }) {
  const { db } = c;
  const uuid = z.string().uuid();
  const owns = async (org: string, deviceId: string) => (await db.query('SELECT 1 FROM devices WHERE id=$1 AND org_id=$2', [deviceId, org])).rowCount;

  app.get('/api/v1/incidents', { preHandler: c.requireRole('viewer') }, async req => {
    const f = z.object({ status: z.enum(['active', 'resolved', 'all']).default('active'), deviceId: uuid.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const w = ['i.org_id=$1']; const v: unknown[] = [req.user.org];
    if (f.status === 'active') w.push(`i.status <> 'RESOLVED'`); else if (f.status === 'resolved') w.push(`i.status = 'RESOLVED'`);
    if (f.deviceId) { v.push(f.deviceId); w.push(`i.device_id=$${v.length}`); }
    v.push(f.limit);
    const r = await db.query(`SELECT i.*, d.hostname FROM incidents i JOIN devices d ON d.id=i.device_id WHERE ${w.join(' AND ')} ORDER BY (i.impact='high') DESC, i.last_detected DESC LIMIT $${v.length}`, v);
    return { incidents: r.rows.map(x => ({ ...incidentRow(x), hostname: x.hostname })) };
  });

  app.get('/api/v1/devices/:id/incidents', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await owns(req.user.org, id))) return reply.code(404).send({ error: 'not found' });
    const rows = (await db.query(`SELECT * FROM incidents WHERE device_id=$1 AND (status <> 'RESOLVED' OR resolved_at > now() - interval '90 days') ORDER BY (status='RESOLVED'), first_detected DESC LIMIT 60`, [id])).rows;
    const ids = rows.map(r => r.id);
    const ev = ids.length ? (await db.query(`SELECT incident_id, type, source, observed_at, value, note FROM incident_evidence WHERE incident_id = ANY($1::uuid[]) ORDER BY observed_at`, [ids])).rows : [];
    const ac = ids.length ? (await db.query(`SELECT a.incident_id, a.kind, a.by, a.created_at, a.finished_at, a.outcome, a.job_id FROM incident_actions a WHERE a.incident_id = ANY($1::uuid[]) ORDER BY a.created_at`, [ids])).rows : [];
    const out = [];
    for (const r of rows) out.push({ ...incidentRow(r), evidence: ev.filter(e => e.incident_id === r.id).slice(-12), actions: ac.filter(a => a.incident_id === r.id), benchmark: await incidentBenchmark(db, r) });
    return { story: await deviceStory(db, req.user.org, id), incidents: out, groups: groupSymptoms(out) };
  });

  app.get('/api/v1/devices/:id/diagnosis', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await owns(req.user.org, id))) return reply.code(404).send({ error: 'not found' });
    const x = await o.healthOf(req.user.org, id);
    if (!x) return reply.code(409).send({ error: 'no health data has been reported yet' });
    return slowPcDiagnosis(x.h, x.snap);
  });

  /**
   * Outcomes: what Viro verifiably did, counted from incident and service records only. Nothing here is estimated; things Viro cannot
   * measure (such as downtime avoided) are deliberately not reported.
   */
  app.get('/api/v1/outcomes', { preHandler: c.requireRole('viewer') }, async req => {
    const days = z.coerce.number().int().min(1).max(365).default(30).parse((req.query as any)?.days);
    const since = new Date(Date.now() - days * 86_400_000);
    const org = req.user.org;
    const one = async (sql: string, args: unknown[] = []) => (await db.query(sql, [org, since, ...args])).rows[0];
    const fixed = await one(`SELECT count(*)::int n FROM incidents WHERE org_id=$1 AND status='RESOLVED' AND resolution='viro-repair' AND resolved_at >= $2`);
    const crashes = await one(`SELECT count(*)::int n FROM incidents WHERE org_id=$1 AND status='RESOLVED' AND resolution='viro-repair' AND resolved_at >= $2 AND code LIKE 'reliability.%'`);
    const drivers = await one(`SELECT count(*)::int n FROM incidents WHERE org_id=$1 AND status='RESOLVED' AND resolution='viro-repair' AND resolved_at >= $2 AND code LIKE 'drivers.%'`);
    const windowsRepairs = await one(`SELECT count(*)::int n FROM incidents WHERE org_id=$1 AND status='RESOLVED' AND resolution='viro-repair' AND resolved_at >= $2 AND code LIKE 'updates.%'`);
    const storage = await one(`SELECT COALESCE(sum(GREATEST(0, (after_metrics->>'systemFreeBytes')::numeric - (before_metrics->>'systemFreeBytes')::numeric)),0)::float8 bytes
                                   FROM incidents WHERE org_id=$1 AND status='RESOLVED' AND resolution='viro-repair' AND resolved_at >= $2 AND code LIKE 'storage.%'`);
    const attempts = await one(`SELECT count(*)::int n FROM incidents WHERE org_id=$1 AND repaired_at >= $2`);
    const reopened = await one(`SELECT count(*)::int n FROM incidents WHERE org_id=$1 AND recurrence_count > 0 AND last_detected >= $2`);
    const drives = await one(`SELECT count(DISTINCT device_id)::int n FROM incidents WHERE org_id=$1 AND first_detected >= $2 AND (code LIKE 'hardware.disk%' OR code LIKE 'hw.disk%')`);
    const now = (await db.query(`SELECT count(*) FILTER (WHERE status='HARDWARE_ACTION_REQUIRED')::int hw, count(DISTINCT device_id) FILTER (WHERE impact IN ('high','medium'))::int attention,
                                        count(*) FILTER (WHERE status IN ('OBSERVING','VERIFYING','REPAIRING'))::int inprogress FROM incidents WHERE org_id=$1 AND status <> 'RESOLVED'`, [org])).rows[0];
    const devs = (await db.query('SELECT count(*)::int n FROM devices WHERE org_id=$1 AND revoked_at IS NULL', [org])).rows[0].n;
    return {
      periodDays: days, devices: devs,
      now: { needAttention: now.attention, hardwareAction: now.hw, repairsInProgress: now.inprogress, healthy: Math.max(0, devs - now.attention) },
      verifiedFixes: fixed.n, recurringCrashesStopped: crashes.n, driversStabilized: drivers.n, windowsRepairs: windowsRepairs.n, storageRecoveredBytes: Math.round(storage.bytes),
      failingDrivesDetected: drives.n, repairAttempts: attempts.n, reopenedIncidents: reopened.n,
      verifiedFixRate: attempts.n ? Math.round((fixed.n / attempts.n) * 100) : null,
      kpis: await fleetKpis(db, org, since),
    };
  });

  /** Fix an incident now. Safe fixes need technician rights; anything that needs judgement needs an administrator. */
  app.post('/api/v1/incidents/:id/fix', { preHandler: c.requireRole('technician') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const inc = (await db.query(`SELECT * FROM incidents WHERE id=$1 AND org_id=$2`, [id, req.user.org])).rows[0];
    if (!inc) return reply.code(404).send({ error: 'not found' });
    if (!inc.fix) return reply.code(409).send({ error: inc.remedy === 'hardware' ? 'This needs a physical repair; software cannot fix it.' : 'Viro has no automatic fix for this; follow the recommendation.' });
    if (!['REPAIR_READY', 'ADMIN_APPROVAL_REQUIRED', 'UNRESOLVED', 'IMPROVED'].includes(inc.status)) return reply.code(409).send({ error: `This incident is ${String(inc.status).toLowerCase().replace(/_/g, ' ')}; it cannot be repaired right now.` });
    if (inc.safety_level >= 3 && !c.atLeast(req.user.role, 'admin')) return reply.code(403).send({ error: 'An administrator must approve this repair.' });
    const jobId = await createSystemJob(db, c.signer, { orgId: req.user.org, deviceId: inc.device_id, type: inc.fix.jobType, params: inc.fix.params, ttlMinutes: 6 * 60, source: { incidentId: id, by: 'user', userId: req.user.sub } });
    if (!jobId) return reply.code(500).send({ error: 'the repair job could not be created' });
    await attachRepairJob(db, inc.device_id, inc.code, jobId, 'user');
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'incident.fix', targetType: 'incident', targetId: id, previous: { status: inc.status }, next: { status: 'REPAIRING', jobId, recipe: inc.fix } });
    return reply.code(202).send({ ok: true, jobId });
  });
}
