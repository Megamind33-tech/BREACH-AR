import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { JobCtx } from './jobs.js';

/**
 * Service Passport: the permanent record of a computer. It only states what was measured or recorded; hardware age is an estimate with
 * its evidence and a confidence, never a claim; physical repairs Viro could not see are never invented.
 */
export const PHYSICAL_SERVICE_TYPES = ['physical cleaning', 'thermal paste replacement', 'RAM upgrade', 'SSD/HDD replacement', 'battery replacement', 'fan replacement', 'keyboard replacement', 'screen replacement', 'motherboard repair'];
export const SERVICE_TYPES = [...PHYSICAL_SERVICE_TYPES, 'OS reinstall', 'major software repair', 'BIOS update', 'driver remediation', 'security remediation', 'storage cleanup', 'GPU change', 'other'] as const;

interface Component { kind: 'storage' | 'memory' | 'gpu' | 'system'; identity: string; label: string; details: Record<string, unknown> }

/** The replaceable parts a hardware inventory describes. Identity is the serial number when there is one. */
export function componentsOf(hw: any): Component[] {
  const out: Component[] = [];
  for (const d of hw?.disks ?? []) {
    if (!d?.model) continue;
    out.push({ kind: 'storage', identity: String(d.serial ?? `${d.model}|${d.sizeBytes ?? ''}`), label: `${d.model}${d.sizeBytes ? ` ${Math.round(d.sizeBytes / 1e9)} GB` : ''}`, details: d });
  }
  for (const m of hw?.memoryModules ?? []) {
    const cap = m?.capacityBytes ? Math.round(m.capacityBytes / 2 ** 30) : null;
    const id = m?.serial && !/^0+$|^none$|^unknown$/i.test(String(m.serial)) ? String(m.serial) : `${m?.partNumber ?? m?.manufacturer ?? 'module'}|${m?.capacityBytes ?? ''}|${m?.slot ?? ''}`;
    out.push({ kind: 'memory', identity: id, label: `${cap ?? '?'} GB ${m?.manufacturer ?? ''} ${m?.partNumber ?? ''}`.replace(/\s+/g, ' ').trim(), details: m });
  }
  for (const g of hw?.gpus ?? []) if (g?.name) out.push({ kind: 'gpu', identity: String(g.name), label: String(g.name), details: g });
  if (hw?.baseBoard?.serial || hw?.serialNumber) out.push({ kind: 'system', identity: String(hw?.baseBoard?.serial ?? hw.serialNumber), label: `${hw?.manufacturer ?? ''} ${hw?.model ?? ''}`.trim() || 'System board', details: { baseBoard: hw?.baseBoard ?? null, serialNumber: hw?.serialNumber ?? null } });
  return out;
}

const SERVICE_FOR_KIND: Record<string, string> = { storage: 'SSD/HDD replacement', memory: 'RAM upgrade', gpu: 'GPU change', system: 'motherboard repair' };

/**
 * Compares the parts reported now with the parts on record. New parts are recorded; a part that disappeared while another of the same kind
 * appeared is proposed as a replacement service event that an administrator must confirm. History is never overwritten.
 */
export async function trackHardware(db: Db, orgId: string, deviceId: string, hw: any, now = new Date()): Promise<{ proposed: number; first: boolean }> {
  const comps = componentsOf(hw);
  if (!comps.length) return { proposed: 0, first: false };
  const known = (await db.query(`SELECT id, kind, identity, label, removed_at FROM hardware_components WHERE device_id=$1`, [deviceId])).rows;
  const first = known.length === 0;
  const seen = new Set(comps.map(c => `${c.kind}|${c.identity}`));
  const added: Component[] = [];
  for (const c of comps) {
    const ex = known.find(k => k.kind === c.kind && k.identity === c.identity);
    if (ex) await db.query(`UPDATE hardware_components SET last_seen=$2, removed_at=NULL, details=$3, label=$4 WHERE id=$1`, [ex.id, now, JSON.stringify(c.details), c.label]);
    else { await db.query(`INSERT INTO hardware_components(org_id,device_id,kind,identity,label,details,first_seen,last_seen) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, [orgId, deviceId, c.kind, c.identity, c.label, JSON.stringify(c.details), now]); added.push(c); }
  }
  const removed = known.filter(k => !k.removed_at && !seen.has(`${k.kind}|${k.identity}`));
  for (const r of removed) await db.query(`UPDATE hardware_components SET removed_at=$2 WHERE id=$1`, [r.id, now]);
  if (first) return { proposed: 0, first: true };
  let proposed = 0;
  for (const c of added) {
    const gone = removed.find(r => r.kind === c.kind);
    // A part was added without one leaving (RAM upgrade, extra disk) or in place of another (replacement): either way, ask a person.
    const type = SERVICE_FOR_KIND[c.kind] ?? 'other';
    await db.query(
      `INSERT INTO service_events(org_id,device_id,occurred_at,source,service_type,reason,old_part_serial,new_part_serial,notes,evidence,status)
       VALUES ($1,$2,$3,'HARDWARE_CHANGE_DETECTION',$4,$5,$6,$7,$8,$9,'PENDING_CONFIRMATION')`,
      [orgId, deviceId, now, type, gone ? `${c.kind} part replaced` : `${c.kind} part added`, gone?.identity ?? null, c.identity,
        gone ? `${gone.label} was replaced by ${c.label}. Confirm to record this in the service history.` : `${c.label} was added. Confirm to record this in the service history.`,
        JSON.stringify({ kind: c.kind, removed: gone?.label ?? null, added: c.label })]);
    proposed++;
  }
  for (const r of removed) if (!added.some(a => a.kind === r.kind)) {
    await db.query(
      `INSERT INTO service_events(org_id,device_id,occurred_at,source,service_type,reason,old_part_serial,notes,evidence,status) VALUES ($1,$2,$3,'HARDWARE_CHANGE_DETECTION',$4,$5,$6,$7,$8,'PENDING_CONFIRMATION')`,
      [orgId, deviceId, now, SERVICE_FOR_KIND[r.kind] ?? 'other', `${r.kind} part no longer present`, r.identity, `${r.label} is no longer reported. Confirm to record it in the service history.`, JSON.stringify({ kind: r.kind, removed: r.label })]);
    proposed++;
  }
  return { proposed, first: false };
}

export async function ensureBaseline(db: Db, orgId: string, deviceId: string, hardware: unknown, softwareCount: number): Promise<void> {
  const health = (await db.query('SELECT snapshot FROM device_health WHERE device_id=$1', [deviceId])).rows[0]?.snapshot;
  const overall = (await db.query('SELECT overall FROM device_health_history WHERE device_id=$1 ORDER BY id ASC LIMIT 1', [deviceId])).rows[0]?.overall ?? null;
  await db.query(
    `INSERT INTO device_baselines(device_id,org_id,hardware,software_count,startup_count,health_overall) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (device_id) DO NOTHING`,
    [deviceId, orgId, JSON.stringify(hardware), softwareCount, health?.startup?.length ?? null, overall]);
}

/** Completes the baseline with the first health assessment when the inventory arrived first. */
export async function completeBaseline(db: Db, deviceId: string, startupCount: number | null, overall: number): Promise<void> {
  await db.query(`UPDATE device_baselines SET startup_count=COALESCE(startup_count,$2), health_overall=COALESCE(health_overall,$3) WHERE device_id=$1`, [deviceId, startupCount, overall]);
}

export interface AgeEvidence { source: string; detail: string; weight: 'strong' | 'medium' | 'weak' }
/**
 * Hardware age is only ever an estimate. A recorded purchase date is strong evidence; the BIOS release date and the drive's power-on time
 * are supporting evidence and each has limits (a BIOS can be updated; a drive can be replaced). Precision is capped at half a year.
 */
export function hardwareAgeEstimate(o: { hardware: any; purchaseDate?: string | Date | null; powerOnHours?: number | null; now?: Date }) {
  const now = o.now ?? new Date();
  const years = (d: Date) => (now.getTime() - d.getTime()) / (365.25 * 86_400_000);
  const half = (y: number) => Math.round(y * 2) / 2;
  const evidence: AgeEvidence[] = [];
  let estimate: number | null = null; let confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN' = 'UNKNOWN';
  if (o.purchaseDate) {
    const d = new Date(o.purchaseDate);
    if (!Number.isNaN(d.getTime())) { estimate = half(years(d)); confidence = 'HIGH'; evidence.push({ source: 'Recorded purchase date', detail: `Purchased ${d.toISOString().slice(0, 10)} (entered by an administrator)`, weight: 'strong' }); }
  }
  // Weak evidence is shown but never turned into an estimate: a BIOS can be updated years after the computer was made (a 2020 laptop
  // reporting a 2026 BIOS is common), and a drive's power-on time restarts when the drive is replaced.
  const bios = o.hardware?.biosDate ? new Date(o.hardware.biosDate) : null;
  if (bios && !Number.isNaN(bios.getTime())) evidence.push({ source: 'BIOS release date', detail: `The installed BIOS was released ${bios.toISOString().slice(0, 7)}. A BIOS can be updated long after a computer is made, so this does not date the hardware.`, weight: 'weak' });
  let driveYears: number | null = null;
  if (o.powerOnHours != null && o.powerOnHours > 0) {
    driveYears = Math.round((o.powerOnHours / 8760) * 10) / 10;
    evidence.push({ source: 'System drive power-on time', detail: `${Math.round(o.powerOnHours).toLocaleString('en-US')} hours powered on (about ${driveYears} years of running time). A replaced drive resets this, so it does not date the computer.`, weight: 'weak' });
  }
  if (o.hardware?.osInstalledAt) evidence.push({ source: 'Windows installation date', detail: `Windows was installed ${String(o.hardware.osInstalledAt).slice(0, 10)}. This says nothing reliable about hardware age (Windows can be reinstalled).`, weight: 'weak' });
  return { hardwareAgeEstimate: estimate, hardwareAgeConfidence: confidence, hardwareAgeEvidence: evidence, systemDriveInServiceYears: driveYears, note: estimate === null ? 'Not enough evidence to estimate hardware age. Enter the purchase date to record it.' : 'An estimate, not a fact: see the evidence.' };
}

export function registerPassportRoutes(app: FastifyInstance, c: JobCtx) {
  const { db } = c;
  const uuid = z.string().uuid();
  const own = async (org: string, id: string) => (await db.query('SELECT id, hostname, enrolled_at AS created_at, purchase_date, purchase_cost FROM devices WHERE id=$1 AND org_id=$2', [id, org])).rows[0];

  app.get('/api/v1/devices/:id/passport', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const dev = await own(req.user.org, id); if (!dev) return reply.code(404).send({ error: 'not found' });
    const inv = (await db.query('SELECT hardware, software, collected_at FROM device_inventory WHERE device_id=$1', [id])).rows[0];
    const hw = inv?.hardware ?? null;
    const base = (await db.query('SELECT * FROM device_baselines WHERE device_id=$1', [id])).rows[0] ?? null;
    const health = (await db.query('SELECT overall FROM device_health_history WHERE device_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0]?.overall ?? null;
    const snap = (await db.query('SELECT snapshot FROM device_health WHERE device_id=$1', [id])).rows[0]?.snapshot;
    const sysDisk = (snap?.physicalDisks ?? []).find((d: any) => d.isSystem) ?? snap?.physicalDisks?.[0];
    const counts = (await db.query(
      `SELECT (SELECT count(*)::int FROM incidents WHERE device_id=$1 AND status='RESOLVED' AND resolution='viro-repair') AS repairs,
              (SELECT count(*)::int FROM incidents WHERE device_id=$1 AND status <> 'RESOLVED') AS open,
              (SELECT count(*)::int FROM service_events WHERE device_id=$1 AND status='CONFIRMED' AND source IN ('ADMIN','TECHNICIAN')) AS manual,
              (SELECT count(*)::int FROM service_events WHERE device_id=$1 AND status='CONFIRMED' AND service_type = ANY($2::text[])) AS physical,
              (SELECT count(*)::int FROM service_events WHERE device_id=$1 AND status='CONFIRMED' AND source='HARDWARE_CHANGE_DETECTION') AS replaced,
              (SELECT count(*)::int FROM service_events WHERE device_id=$1 AND status='PENDING_CONFIRMATION') AS pending`, [id, PHYSICAL_SERVICE_TYPES])).rows[0];
    const top = (await db.query(`SELECT title, recommendation, status FROM incidents WHERE device_id=$1 AND status <> 'RESOLVED' ORDER BY (impact='high') DESC, points DESC LIMIT 1`, [id])).rows[0] ?? null;
    return {
      device: { id, hostname: dev.hostname, firstSeenByViro: dev.created_at },
      identity: hw ? { manufacturer: hw.manufacturer ?? null, model: hw.model ?? null, serialNumber: hw.serialNumber ?? null, baseBoard: hw.baseBoard ?? null, biosVersion: hw.biosVersion ?? null, biosDate: hw.biosDate ?? null,
        os: hw.os ?? null, osInstalledAt: hw.osInstalledAt ?? null, cpu: hw.cpu ?? null, ramBytes: hw.ramBytes ?? null, memoryModules: hw.memoryModules ?? [], disks: hw.disks ?? [], gpus: hw.gpus ?? [] } : null,
      age: hardwareAgeEstimate({ hardware: hw, purchaseDate: dev.purchase_date, powerOnHours: sysDisk?.powerOnHours ?? null }),
      purchase: { date: dev.purchase_date, cost: dev.purchase_cost },
      baseline: base ? { takenAt: base.taken_at, healthOverall: base.health_overall, startupCount: base.startup_count, softwareCount: base.software_count, metrics: base.metrics } : null,
      currentHealth: health,
      counts: { autopilotRepairs: counts.repairs, openIncidents: counts.open, manualInterventions: counts.manual, physicalServices: counts.physical, componentsReplaced: counts.replaced, pendingConfirmation: counts.pending },
      currentRecommendation: top ? { title: top.title, recommendation: top.recommendation, status: top.status } : null,
    };
  });

  app.patch('/api/v1/devices/:id/purchase', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), purchaseCost: z.number().min(0).max(1e9).nullable().optional() }).strict().parse(req.body);
    if (!(await own(req.user.org, id))) return reply.code(404).send({ error: 'not found' });
    await db.query(`UPDATE devices SET purchase_date=CASE WHEN $2::boolean THEN $3::date ELSE purchase_date END, purchase_cost=CASE WHEN $4::boolean THEN $5::numeric ELSE purchase_cost END WHERE id=$1`,
      [id, 'purchaseDate' in b, b.purchaseDate ?? null, 'purchaseCost' in b, b.purchaseCost ?? null]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'device.purchase_info', targetType: 'device', targetId: id, next: b });
    return { ok: true };
  });

  app.get('/api/v1/devices/:id/service-events', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await own(req.user.org, id))) return reply.code(404).send({ error: 'not found' });
    const r = await db.query(`SELECT id, occurred_at, source, service_type, reason, technician, parts, old_part_serial, new_part_serial, notes, cost, downtime_minutes, evidence, incident_id, status FROM service_events WHERE device_id=$1 AND status <> 'DISMISSED' ORDER BY occurred_at DESC LIMIT 200`, [id]);
    return { events: r.rows, types: SERVICE_TYPES };
  });

  app.post('/api/v1/devices/:id/service-events', { preHandler: c.requireRole('technician') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      serviceType: z.enum(SERVICE_TYPES), reason: z.string().max(500).optional(), technician: z.string().max(120).optional(), occurredAt: z.string().datetime().optional(),
      parts: z.array(z.string().max(200)).max(20).default([]), oldPartSerial: z.string().max(120).optional(), newPartSerial: z.string().max(120).optional(), notes: z.string().max(2000).optional(),
      cost: z.number().min(0).max(1e9).optional(), downtimeMinutes: z.number().int().min(0).max(1e6).optional(),
    }).strict().parse(req.body);
    if (!(await own(req.user.org, id))) return reply.code(404).send({ error: 'not found' });
    const source = c.atLeast(req.user.role, 'admin') ? 'ADMIN' : 'TECHNICIAN';
    const r = await db.query(
      `INSERT INTO service_events(org_id,device_id,occurred_at,source,service_type,reason,technician,parts,old_part_serial,new_part_serial,notes,cost,downtime_minutes,created_by)
       VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [req.user.org, id, b.occurredAt ?? null, source, b.serviceType, b.reason ?? null, b.technician ?? null, JSON.stringify(b.parts), b.oldPartSerial ?? null, b.newPartSerial ?? null, b.notes ?? null, b.cost ?? null, b.downtimeMinutes ?? null, req.user.sub]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'service_event.create', targetType: 'device', targetId: id, next: { ...b, id: r.rows[0].id } });
    return reply.code(201).send({ id: r.rows[0].id });
  });

  /** An administrator confirms (keeps) or dismisses a hardware change Viro detected. */
  app.patch('/api/v1/service-events/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ decision: z.enum(['confirm', 'dismiss']), notes: z.string().max(2000).optional(), cost: z.number().min(0).max(1e9).optional(), technician: z.string().max(120).optional() }).strict().parse(req.body);
    const r = await db.query(
      `UPDATE service_events SET status=$3, notes=COALESCE($4, notes), cost=COALESCE($5, cost), technician=COALESCE($6, technician) WHERE id=$1 AND org_id=$2 AND status='PENDING_CONFIRMATION' RETURNING device_id`,
      [id, req.user.org, b.decision === 'confirm' ? 'CONFIRMED' : 'DISMISSED', b.notes ?? null, b.cost ?? null, b.technician ?? null]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found or already decided' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: `service_event.${b.decision}`, targetType: 'service_event', targetId: id });
    return { ok: true };
  });

  /** "What Viro has done for you": one chronological story per device, built only from recorded incidents and service events. */
  app.get('/api/v1/devices/:id/timeline', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await own(req.user.org, id))) return reply.code(404).send({ error: 'not found' });
    const inc = (await db.query(`SELECT id, title, status, first_detected, repaired_at, resolved_at, resolution, recurrence_count, before_metrics, after_metrics FROM incidents WHERE device_id=$1`, [id])).rows;
    const ev = (await db.query(`SELECT id, occurred_at, source, service_type, reason, status FROM service_events WHERE device_id=$1 AND status <> 'DISMISSED'`, [id])).rows;
    const items: { at: string; kind: string; text: string; incidentId?: string }[] = [];
    for (const i of inc) {
      items.push({ at: i.first_detected, kind: 'detected', text: `Detected: ${i.title}`, incidentId: i.id });
      if (i.repaired_at) items.push({ at: i.repaired_at, kind: 'repaired', text: `Repair ran: ${i.title}`, incidentId: i.id });
      if (i.resolved_at) items.push({ at: i.resolved_at, kind: 'resolved', text: i.resolution === 'viro-repair' ? `Verified resolved: ${i.title}` : `Cleared without a Viro repair: ${i.title}`, incidentId: i.id });
    }
    for (const e of ev) items.push({ at: e.occurred_at, kind: 'service', text: `${e.status === 'PENDING_CONFIRMATION' ? 'Awaiting confirmation: ' : ''}${e.service_type}${e.reason ? ` (${e.reason})` : ''}` });
    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return { timeline: items.slice(0, 200) };
  });
}
