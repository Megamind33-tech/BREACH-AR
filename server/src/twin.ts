import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { JobCtx } from './jobs.js';
import { createSystemJob } from './jobs.js';
import { analyzeHardware } from './hardware.js';
import { healthGate } from './healthgate.js';
import { hasComputeConsent } from './account.js';
import { miningAudit } from './mining-reporting.js';
import { SCHEMA_VERSION, type DiagnosticFindingT, type SeverityT } from './twin/contracts.js';
import { worst } from './twin/rules.js';
import type { HealthResult } from './health.js';

/* ------------------------------------------------------------------------------------------------
 * WorkCare Mobile API (additive). Authenticated with the existing organization user token. Everything here is a *view* onto data the
 * Desktop agent already reports, expressed in the shared twin contracts, plus a short list of explicit, audited capabilities.
 * There is no endpoint that executes an arbitrary command: each capability maps to one already-existing, signed job type.
 * ---------------------------------------------------------------------------------------------- */

type Deps = { healthOf: (orgId: string, deviceId: string) => Promise<{ snap: any; h: HealthResult } | null>; hardwareRawOf: (orgId: string, deviceId: string) => Promise<any>; onlineWindowSeconds: number };

const CATEGORY_COMPONENT: Record<string, DiagnosticFindingT['component']> = { security: 'security', storage: 'storage', updates: 'windows', performance: 'processor', drivers: 'system', reliability: 'system', hardware: 'system' };
const HW_COMPONENT: Record<string, DiagnosticFindingT['component']> = { storage: 'storage', memory: 'memory', cpu: 'processor', thermal: 'cooling', battery: 'battery', platform: 'system' };

export function freshnessOf(lastSeen: Date | string | null | undefined, onlineWindowSeconds: number, now = Date.now()): 'live' | 'recent' | 'stale' | 'never' {
  if (!lastSeen) return 'never';
  const age = (now - new Date(lastSeen).getTime()) / 1000;
  return age <= onlineWindowSeconds ? 'live' : age <= 3600 ? 'recent' : 'stale';
}

/** Findings for one device, from the analyzers Desktop already uses. Nothing is invented: a hardware finding with no numeric evidence carries its own sentence as the summary. */
export function findingsFor(h: HealthResult | null, hwRaw: any): { findings: DiagnosticFindingT[]; unavailable: { component: string; reason: string }[] } {
  const findings: DiagnosticFindingT[] = [];
  const unavailable: { component: string; reason: string }[] = [];
  if (hwRaw) {
    const a = analyzeHardware(hwRaw);
    for (const f of a.findings) {
      if (f.severity === 'info') continue;
      findings.push({ id: f.code, component: HW_COMPONENT[f.component] ?? 'system', severity: f.severity === 'critical' ? 'critical' : 'attention', title: f.message.length > 100 ? f.message.slice(0, 97) + '...' : f.message, summary: f.message.slice(0, 400),
        evidenceType: f.component === 'thermal' ? 'inferred' : 'measured', evidence: [], recommendedAction: f.recommendation.slice(0, 300) });
    }
    unavailable.push(...a.unavailable.map(u => ({ component: u.component, reason: u.reason })));
  }
  if (h) for (const d of h.deductions) {
    if (d.category === 'hardware') continue;           // covered by the hardware findings above
    const comp = CATEGORY_COMPONENT[d.category] ?? 'system';
    // "critical" is reserved for a disabled protection layer; other high-impact deductions are attention, so the phone does not cry wolf.
    const sev: SeverityT = d.category === 'security' && d.impact === 'high' ? 'critical' : 'attention';
    findings.push({ id: d.code, component: comp, severity: sev, title: d.reason.length > 100 ? d.reason.slice(0, 97) + '...' : d.reason, summary: d.reason.slice(0, 400), evidenceType: 'measured', evidence: [{ name: 'pointsDeducted', value: d.points }], recommendedAction: d.recommendation.slice(0, 300) });
  }
  return { findings, unavailable };
}

export function headlineOf(status: SeverityT, findings: DiagnosticFindingT[]): string {
  if (status === 'healthy') return 'Working normally';
  const top = findings.find(f => f.severity === status) ?? findings[0];
  return top ? top.title : 'Needs attention';
}

export function registerTwinRoutes(app: FastifyInstance, c: JobCtx, d: Deps) {
  const { db } = c;
  const viewer = c.requireRole('viewer'), tech = c.requireRole('technician'), admin = c.requireRole('admin');
  const uuid = z.string().uuid();
  const envelope = (deviceId: string) => ({ schemaVersion: SCHEMA_VERSION, deviceId, timestamp: new Date().toISOString(), source: 'server' as const });
  const own = async (org: string, id: string) => (await db.query('SELECT d.id, d.hostname, d.last_seen_at, d.os_caption, m.worker_id FROM devices d LEFT JOIN mining_devices m ON m.device_id=d.id WHERE d.id=$1 AND d.org_id=$2 AND d.revoked_at IS NULL', [id, org])).rows[0];

  app.get('/api/v1/twin/devices', { preHandler: viewer }, async req => {
    const rows = (await db.query('SELECT d.id, d.hostname, d.last_seen_at, inv.hardware FROM devices d LEFT JOIN device_inventory inv ON inv.device_id=d.id WHERE d.org_id=$1 AND d.revoked_at IS NULL AND d.uninstalled_at IS NULL ORDER BY d.hostname', [req.user.org])).rows;
    const devices = [];
    for (const r of rows) {
      const hh = await d.healthOf(req.user.org, r.id);
      const hw = await d.hardwareRawOf(req.user.org, r.id);
      const { findings } = findingsFor(hh?.h ?? null, hw);
      const status: SeverityT = hh ? (worst(findings) === 'critical' ? 'critical' : hh.h.status === 'critical' ? 'critical' : hh.h.status === 'attention' || findings.length ? 'attention' : 'healthy') : 'healthy';
      const fresh = freshnessOf(r.last_seen_at, d.onlineWindowSeconds);
      devices.push({ ...envelope(r.id), kind: 'pc' as const, name: r.hostname, model: [r.hardware?.manufacturer, r.hardware?.model].filter(Boolean).join(' ') || null, status,
        headline: hh ? headlineOf(status, findings) : 'Waiting for the first health report', lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null, freshness: fresh, isThisDevice: false });
    }
    return { devices };
  });

  app.get('/api/v1/twin/devices/:id', { preHandler: viewer }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const dev = await own(req.user.org, id); if (!dev) return reply.code(404).send({ error: 'not found' });
    const hh = await d.healthOf(req.user.org, id), hw = await d.hardwareRawOf(req.user.org, id);
    const inv = (await db.query('SELECT hardware FROM device_inventory WHERE device_id=$1', [id])).rows[0]?.hardware ?? null;
    const { findings, unavailable } = findingsFor(hh?.h ?? null, hw);
    const status: SeverityT = hh ? (findings.some(f => f.severity === 'critical') || hh.h.status === 'critical' ? 'critical' : hh.h.status === 'attention' || findings.length ? 'attention' : 'healthy') : 'healthy';
    const comp = (component: DiagnosticFindingT['component'], label: string, detail: string | null, have: boolean) => {
      const own = findings.filter(f => f.component === component);
      const un = unavailable.find(u => u.component.toLowerCase().includes(component === 'processor' ? 'cpu' : component));
      return { component, label, detail, status: !have && !own.length ? ('unavailable' as const) : worst(own), unavailableReason: !have && !own.length ? (un?.reason ?? 'Not reported by this device yet') : null, findingIds: own.map(f => f.id) };
    };
    const disks = (inv?.disks ?? []) as any[], gb = (b: number) => Math.round(b / 1073741824);
    const components = [
      comp('processor', 'Processor', inv?.cpu ?? null, !!inv?.cpu), comp('memory', 'Memory', inv?.ramBytes ? `${gb(inv.ramBytes)} GB` : null, !!inv?.ramBytes),
      comp('storage', 'Storage', disks.length ? disks.map(x => `${x.model ?? 'Drive'} ${x.sizeBytes ? gb(x.sizeBytes) + ' GB' : ''}`.trim()).join(', ') : null, disks.length > 0),
      comp('battery', 'Battery', null, !!hw?.battery), comp('graphics', 'Graphics', (inv?.gpus ?? []).map((g: any) => g.name).filter(Boolean).join(', ') || null, (inv?.gpus ?? []).length > 0),
      comp('cooling', 'Cooling', null, !!hw?.thermal), comp('windows', 'Windows', dev.os_caption ?? null, !!dev.os_caption), comp('security', 'Security', null, !!hh?.snap?.security),
    ];
    return { ...envelope(id), status, headline: hh ? headlineOf(status, findings) : 'Waiting for the first health report', components, findings,
      notMeasured: [...(hh?.h.notMeasured ?? []), ...unavailable.map(u => `${u.component}: ${u.reason}`)].slice(0, 40), lastSeenAt: dev.last_seen_at ? new Date(dev.last_seen_at).toISOString() : null, freshness: freshnessOf(dev.last_seen_at, d.onlineWindowSeconds) };
  });

  app.get('/api/v1/twin/alerts', { preHandler: viewer }, async req => {
    const r = (await db.query(`SELECT a.id, a.device_id, a.severity, a.message, a.first_seen_at, a.resolved_at, d.hostname FROM alerts a JOIN devices d ON d.id=a.device_id WHERE a.org_id=$1 AND a.resolved_at IS NULL ORDER BY (a.severity='critical') DESC, a.first_seen_at DESC LIMIT 100`, [req.user.org])).rows;
    return { alerts: r.map(a => ({ ...envelope(a.device_id), id: String(a.id), severity: a.severity === 'critical' ? 'critical' : 'attention', title: `${a.hostname}: ${a.message.slice(0, 80)}`, summary: a.message.slice(0, 400), openedAt: new Date(a.first_seen_at).toISOString(), resolvedAt: null })) };
  });

  /** A passport is only ever made of rows that exist: enrolment, the baseline, confirmed service records and verified repairs. */
  app.get('/api/v1/twin/devices/:id/passport', { preHandler: viewer }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const dev = (await db.query('SELECT enrolled_at FROM devices WHERE id=$1 AND org_id=$2', [id, req.user.org])).rows[0]; if (!dev) return reply.code(404).send({ error: 'not found' });
    const ev: any[] = [{ ...envelope(id), id: 'enrolled', at: new Date(dev.enrolled_at).toISOString(), kind: 'enrolled', title: 'WorkCare installed', detail: null, origin: 'agent' }];
    const base = (await db.query('SELECT taken_at, health_overall FROM device_baselines WHERE device_id=$1', [id])).rows[0];
    if (base) ev.push({ ...envelope(id), id: 'baseline', at: new Date(base.taken_at).toISOString(), kind: 'baseline', title: 'Baseline recorded', detail: base.health_overall != null ? `Health ${base.health_overall} out of 100 at the start.` : null, origin: 'agent' });
    for (const s of (await db.query(`SELECT id, occurred_at, service_type, reason, notes FROM service_events WHERE device_id=$1 AND status='CONFIRMED' ORDER BY occurred_at DESC LIMIT 100`, [id])).rows)
      ev.push({ ...envelope(id), id: 'svc-' + s.id, at: new Date(s.occurred_at).toISOString(), kind: 'service', title: s.service_type, detail: (s.reason ?? s.notes ?? null)?.slice(0, 300) ?? null, origin: 'service_record' });
    for (const i of (await db.query(`SELECT id, title, resolved_at FROM incidents WHERE device_id=$1 AND status='RESOLVED' AND resolution='viro-repair' AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 50`, [id])).rows)
      ev.push({ ...envelope(id), id: 'inc-' + i.id, at: new Date(i.resolved_at).toISOString(), kind: 'repair', title: `Repair verified: ${i.title}`.slice(0, 120), detail: null, origin: 'repair_verification' });
    return { events: ev.sort((a, b) => b.at.localeCompare(a.at)) };
  });

  // ---------------- compute: view, pause, resume ----------------
  async function computeStatus(org: string, id: string, role: string) {
    const o = (await db.query('SELECT plan FROM organizations WHERE id=$1', [org])).rows[0];
    const m = (await db.query('SELECT enabled, (paused_until IS NOT NULL AND paused_until > now()) AS paused, paused_until FROM mining_devices WHERE device_id=$1', [id])).rows[0];
    const s = (await db.query('SELECT state, reason, cpu_cap_percent, cpu_temp_c FROM compute_state WHERE device_id=$1', [id])).rows[0];
    const gate = await healthGate(db, id); const consent = await hasComputeConsent(db, org);
    const enabled = o.plan === 'compute_sponsored' && !!m?.enabled; const paused = !!m?.paused;
    const isAdmin = c.atLeast(role as any, 'admin');
    return { ...envelope(id), available: !!m && o.plan === 'compute_sponsored', enabledByPolicy: enabled, state: paused ? 'paused-from-phone' : s?.state ?? null, reason: paused ? `Paused from WorkCare Mobile until ${new Date(m.paused_until).toISOString()}` : s?.reason ?? null,
      cpuCapPercent: s?.cpu_cap_percent ?? null, cpuTempC: s?.cpu_temp_c ?? null, gate: gate.gate, consentRecorded: consent, canPause: isAdmin && enabled && !paused, canResume: isAdmin && paused };
  }
  app.get('/api/v1/twin/devices/:id/compute', { preHandler: viewer }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await own(req.user.org, id))) return reply.code(404).send({ error: 'not found' });
    return computeStatus(req.user.org, id, req.user.role);
  });
  app.post('/api/v1/twin/devices/:id/compute/pause', { preHandler: admin }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params); const b = z.object({ minutes: z.number().int().min(5).max(1440).default(240) }).strict().parse(req.body ?? {});
    if (!(await own(req.user.org, id))) return reply.code(404).send({ error: 'not found' });
    const st = await computeStatus(req.user.org, id, req.user.role);
    if (!st.enabledByPolicy) return reply.code(409).send({ error: 'compute is not enabled on this device, so there is nothing to pause' });
    await db.query(`UPDATE mining_devices SET paused_until = now() + make_interval(mins => $2::int), paused_by=$3 WHERE device_id=$1`, [id, b.minutes, req.user.sub]);
    await miningAudit(db, { orgId: req.user.org, actorType: 'user', actorId: req.user.sub, actorLabel: 'WorkCare Mobile', action: 'device.pause', deviceId: id, next: { minutes: b.minutes } });
    return computeStatus(req.user.org, id, req.user.role);
  });
  app.post('/api/v1/twin/devices/:id/compute/resume', { preHandler: admin }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await own(req.user.org, id))) return reply.code(404).send({ error: 'not found' });
    const st = await computeStatus(req.user.org, id, req.user.role);
    if (!st.canResume) return reply.code(409).send({ error: 'compute is not paused from the phone. Resume only clears a pause; it cannot switch compute on.' });
    await db.query('UPDATE mining_devices SET paused_until=NULL, paused_by=NULL WHERE device_id=$1', [id]);
    await miningAudit(db, { orgId: req.user.org, actorType: 'user', actorId: req.user.sub, actorLabel: 'WorkCare Mobile', action: 'device.resume', deviceId: id });
    return computeStatus(req.user.org, id, req.user.role);
  });

  // ---------------- explicit capabilities (no generic "execute") ----------------
  const CAPS = {
    RUN_QUICK_SCAN: { job: () => ({ type: 'health.check', params: {} }), role: 'technician', disruptive: false },
    RUN_APPROVED_TEST: { job: (p: { test: 'hardware' | 'memory' }) => ({ type: p.test === 'memory' ? 'memory.analyze' : 'hardware.diagnose', params: {} }), role: 'technician', disruptive: false },
    RUN_APPROVED_MAINTENANCE_ACTION: { job: (p: { action: 'cleanup_scan' | 'cleanup' | 'updates_scan' }) => p.action === 'cleanup' ? { type: 'cleanup.run', params: { categories: ['windows-temp', 'user-temp', 'crash-dumps', 'update-leftovers', 'browser-cache', 'thumbnail-cache', 'old-logs'] } } : p.action === 'updates_scan' ? { type: 'updates.scan', params: {} } : { type: 'cleanup.preview', params: {} }, role: 'admin', disruptive: (p: { action: string }) => p.action === 'cleanup' },
  } as const;
  const capBody = z.discriminatedUnion('capability', [
    z.object({ capability: z.literal('RUN_QUICK_SCAN') }).strict(),
    z.object({ capability: z.literal('RUN_APPROVED_TEST'), test: z.enum(['hardware', 'memory']) }).strict(),
    z.object({ capability: z.literal('RUN_APPROVED_MAINTENANCE_ACTION'), action: z.enum(['cleanup_scan', 'cleanup', 'updates_scan']), confirm: z.boolean().optional() }).strict(),
  ]);
  app.post('/api/v1/twin/devices/:id/commands', { preHandler: tech }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = capBody.parse(req.body);
    const cap = CAPS[b.capability];
    if (!c.atLeast(req.user.role, cap.role as any)) return reply.code(403).send({ error: `${b.capability} needs the ${cap.role} role` });
    const dev = await own(req.user.org, id); if (!dev) return reply.code(404).send({ error: 'not found' });
    const disruptive = typeof cap.disruptive === 'function' ? cap.disruptive(b as any) : cap.disruptive;
    if (disruptive && !(b as any).confirm) return reply.code(409).send({ error: 'confirmation_required', message: 'This action changes the computer. Send confirm: true after the person has approved it.' });
    const spec = (cap.job as any)(b);
    const jobId = await createSystemJob(db, c.signer, { orgId: req.user.org, deviceId: id, type: spec.type, params: spec.params, ttlMinutes: 60, source: { via: 'workcare-mobile', capability: b.capability, userId: req.user.sub } });
    if (!jobId) return reply.code(400).send({ error: 'that action is not available' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'twin.command', targetType: 'device', targetId: id, next: { capability: b.capability, jobId } });
    return reply.code(202).send({ ok: true, jobId, capability: b.capability });
  });
  app.get('/api/v1/twin/capabilities', { preHandler: viewer }, async () => ({ capabilities: ['GET_DEVICE_HEALTH', 'RUN_QUICK_SCAN', 'RUN_APPROVED_TEST', 'GET_ALERTS', 'GET_MACHINE_PASSPORT', 'PAUSE_COMPUTE', 'RESUME_COMPUTE', 'GET_COMPUTE_STATUS', 'RUN_APPROVED_MAINTENANCE_ACTION'], schemaVersion: SCHEMA_VERSION }));
}
