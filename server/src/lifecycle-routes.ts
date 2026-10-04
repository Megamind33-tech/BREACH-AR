import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { HealthResult, Snapshot } from './health.js';
import type { JobCtx } from './jobs.js';
import { CONDITION_RANK, batteryCondition, diskCondition, storageTrend, type Condition, type DiskReading, type StorageTrend } from './condition.js';
import { batteryRecommendation, lifecycleAssessment, ramRecommendation, storageRecommendation, type Recommendation } from './lifecycle.js';
import { hardwareAgeEstimate } from './passport.js';
import { slowPcDiagnosis } from './diagnosis.js';

interface Deps { healthOf: (orgId: string, deviceId: string) => Promise<{ snap: Snapshot; h: HealthResult } | null>; hardwareRawOf: (orgId: string, deviceId: string) => Promise<any | null> }

const worst = (cs: Condition[]): Condition => cs.reduce<Condition>((a, c) => (CONDITION_RANK[c] > CONDITION_RANK[a] ? c : a), 'NOT_MEASURED');

export async function assess(db: Db, deps: Deps, orgId: string, deviceId: string, now = new Date()) {
  const dev = (await db.query('SELECT purchase_date, purchase_cost FROM devices WHERE id=$1 AND org_id=$2', [deviceId, orgId])).rows[0];
  if (!dev) return null;
  const inv = (await db.query('SELECT hardware FROM device_inventory WHERE device_id=$1', [deviceId])).rows[0]?.hardware ?? null;
  const hx = await deps.healthOf(orgId, deviceId);
  const raw = await deps.hardwareRawOf(orgId, deviceId);
  const readings = (await db.query(`SELECT at, storage, battery FROM hardware_readings WHERE device_id=$1 AND at > $2 ORDER BY at`, [deviceId, new Date(now.getTime() - 400 * 86_400_000)])).rows;

  // storage condition per disk, using earlier readings of the same disk to see trends
  const latest = readings[readings.length - 1];
  const currentDisks: DiskReading[] = latest ? (latest.storage as DiskReading[]) : [];
  const storage = currentDisks.map((cur, i) => diskCondition(cur, readings.slice(0, -1).map(r => (r.storage as DiskReading[])[i]).filter(Boolean)));
  const storageOverall = worst(storage.map(s => s.condition));
  const bHist = readings.map(r => ({ at: new Date(r.at), healthPercent: (r.battery as any)?.healthPercent ?? null }));
  const battery = latest?.battery ? batteryCondition({ designCapacityMWh: (latest.battery as any).designCapacityMWh, fullChargeCapacityMWh: (latest.battery as any).fullChargeCapacityMWh, cycleCount: (latest.battery as any).cycles }, bHist.slice(0, -1)) : null;

  // free space trend from health history
  const hist = (await db.query(`SELECT at, overall, metrics FROM device_health_history WHERE device_id=$1 AND at > $2 ORDER BY at`, [deviceId, new Date(now.getTime() - 30 * 86_400_000)])).rows;
  const trend: StorageTrend = storageTrend(hist.map(r => ({ at: new Date(r.at), freeBytes: (r.metrics as any)?.systemFreeBytes ?? null })), undefined, now);
  const oldest = hist[0]?.overall ?? null, newest = hist[hist.length - 1]?.overall ?? null;
  const healthChange30d = oldest != null && newest != null && hist.length >= 3 ? newest - oldest : null;

  // facts about the computer
  const sysDisk = (hx?.snap.physicalDisks ?? []).find(d => d.isSystem) ?? hx?.snap.physicalDisks?.[0];
  const media = String(sysDisk?.mediaType ?? '').toLowerCase();
  const systemDisk: 'SSD' | 'HDD' | 'unknown' = /ssd|nvme/.test(media) ? 'SSD' : /hdd/.test(media) ? 'HDD' : 'unknown';
  const codes = new Set((hx?.h.deductions ?? []).map(d => d.code));
  const constraints = ['hardware.low_ram', 'hardware.hdd_system'].filter(c => codes.has(c)).map(c => (c === 'hardware.low_ram' ? 'low memory' : 'mechanical system disk'));
  const sysVol = hx?.snap.volumes?.find(v => v.isSystem);
  const lowSpace = codes.has('storage.system_low');
  const age = hardwareAgeEstimate({ hardware: inv, purchaseDate: dev.purchase_date, powerOnHours: sysDisk?.powerOnHours ?? null, now });

  const yearAgo = new Date(now.getTime() - 365 * 86_400_000);
  const svc = (await db.query(`SELECT count(*) FILTER (WHERE source IN ('ADMIN','TECHNICIAN'))::int manual, count(*) FILTER (WHERE source='AUTOMATIC')::int auto,
                                      COALESCE(sum(cost),0)::float8 cost, COALESCE(sum(downtime_minutes),0)::int downtime
                                 FROM service_events WHERE device_id=$1 AND status='CONFIRMED' AND occurred_at >= $2`, [deviceId, yearAgo])).rows[0];
  const hwChanges = (await db.query(`SELECT count(*)::int n FROM service_events WHERE device_id=$1 AND status='CONFIRMED' AND source='HARDWARE_CHANGE_DETECTION' AND occurred_at >= $2`, [deviceId, yearAgo])).rows[0].n;
  const inc = (await db.query(`SELECT count(*) FILTER (WHERE status <> 'RESOLVED' AND remedy <> 'hardware' AND impact IN ('high','medium'))::int active,
                                      count(*) FILTER (WHERE status = 'RESOLVED' AND resolution='viro-repair' AND resolved_at >= $2)::int repaired FROM incidents WHERE device_id=$1`, [deviceId, yearAgo])).rows[0];

  const recs: Recommendation[] = [];
  const ram = ramRecommendation(inv, { lowRam: codes.has('hardware.low_ram'), pressure: codes.has('perf.ram_pressure') }); if (ram) recs.push(ram);
  const st = storageRecommendation(inv, sysDisk ? { hdd: systemDisk === 'HDD', sizeBytes: sysDisk.sizeBytes ?? sysVol?.totalBytes ?? null, usedBytes: sysVol ? sysVol.totalBytes - sysVol.freeBytes : null, condition: storage[0]?.condition ?? storageOverall, lowSpace } : null); if (st) recs.push(st);
  const br = batteryRecommendation(inv?.model ?? null, battery); if (br) recs.push(br);

  const lifecycle = lifecycleAssessment({
    ageYears: age.hardwareAgeEstimate, ageConfidence: age.hardwareAgeConfidence, health: hx?.h.overall ?? null, healthChange30d, storage: storageOverall, systemDisk, battery: battery?.condition ?? null,
    hardwareConstraints: constraints, osUnsupported: codes.has('security.os_unsupported'), interventions12m: svc.manual + inc.repaired + hwChanges, downtimeMinutes12m: svc.downtime, serviceCost12m: svc.cost,
    purchaseCost: dev.purchase_cost != null ? Number(dev.purchase_cost) : null, activeSoftwareIncidents: inc.active,
  });
  const limit = hx ? slowPcDiagnosis(hx.h, hx.snap).limit : { softwareLimitReached: false };
  return { storage: { overall: storageOverall, disks: storage, freeSpaceTrend: trend, measured: storage.length > 0, note: storage.length ? null : 'No hardware diagnosis has been read from this computer yet.' }, battery, recommendations: recs, lifecycle, age, hardwareLimit: limit, healthChange30d };
}

export function registerLifecycleRoutes(app: FastifyInstance, c: JobCtx, deps: Deps) {
  const { db } = c;
  const uuid = z.string().uuid();
  const part = (k: 'storage' | 'battery' | 'recommendations' | 'lifecycle') => async (req: any, reply: any) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const a = await assess(db, deps, req.user.org, id); if (!a) return reply.code(404).send({ error: 'not found' });
    return k === 'lifecycle' ? { ...a.lifecycle, age: a.age, hardwareLimit: a.hardwareLimit } : k === 'recommendations' ? { recommendations: a.recommendations, hardwareLimit: a.hardwareLimit } : k === 'storage' ? { ...a.storage, battery: a.battery } : a.battery;
  };
  app.get('/api/v1/devices/:id/condition', { preHandler: c.requireRole('viewer') }, part('storage'));
  app.get('/api/v1/devices/:id/recommendations', { preHandler: c.requireRole('viewer') }, part('recommendations'));
  app.get('/api/v1/devices/:id/lifecycle', { preHandler: c.requireRole('viewer') }, part('lifecycle'));

  app.get('/api/v1/devices/:id/trends', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z.object({ days: z.coerce.number().int().min(1).max(400).default(90) }).parse(req.query);
    if (!(await db.query('SELECT 1 FROM devices WHERE id=$1 AND org_id=$2', [id, req.user.org])).rowCount) return reply.code(404).send({ error: 'not found' });
    const rows = (await db.query(`SELECT at, overall, metrics FROM device_health_history WHERE device_id=$1 AND at > now() - make_interval(days => $2) ORDER BY at`, [id, q.days])).rows;
    const at = (days: number) => { const t = Date.now() - days * 86_400_000; return rows.find(r => new Date(r.at).getTime() >= t) ?? null; };
    const last = rows[rows.length - 1] ?? null;
    const delta = (days: number, key: (r: any) => number | null) => { const a = at(days), b = last; const x = a ? key(a) : null, y = b ? key(b) : null; return x != null && y != null && a && a !== b ? { from: x, to: y, change: y - x } : null; };
    const series = rows.filter((_, i) => rows.length <= 200 || i % Math.ceil(rows.length / 200) === 0).map(r => ({ at: r.at, health: r.overall, freeBytes: r.metrics?.systemFreeBytes ?? null, ramPercent: r.metrics?.ramPercent ?? null }));
    return { days: q.days, points: series, deltas: { d7: { health: delta(7, r => r.overall), freeBytes: delta(7, r => r.metrics?.systemFreeBytes ?? null) }, d30: { health: delta(30, r => r.overall), freeBytes: delta(30, r => r.metrics?.systemFreeBytes ?? null) }, d90: { health: delta(90, r => r.overall), freeBytes: delta(90, r => r.metrics?.systemFreeBytes ?? null) } }, measured: rows.length > 0 };
  });

  /** Fleet view: which computers to keep, upgrade, repair, watch or replace, each with its reasons. */
  app.get('/api/v1/lifecycle', { preHandler: c.requireRole('viewer') }, async req => {
    const devs = (await db.query(`SELECT d.id, d.hostname FROM devices d WHERE d.org_id=$1 AND d.revoked_at IS NULL ORDER BY d.hostname LIMIT 300`, [req.user.org])).rows;
    const counts: Record<string, number> = { KEEP: 0, MAINTAIN: 0, UPGRADE: 0, REPAIR: 0, MONITOR: 0, REPLACE: 0 };
    const items: { deviceId: string; hostname: string; action: string; condition: string; reasons: string[]; confidence: string; recommendations: string[] }[] = [];
    for (const d of devs) {
      const a = await assess(db, deps, req.user.org, d.id); if (!a) continue;
      counts[a.lifecycle.action]++;
      items.push({ deviceId: d.id, hostname: d.hostname, action: a.lifecycle.action, condition: a.lifecycle.condition, reasons: a.lifecycle.reasons.slice(0, 4), confidence: a.lifecycle.confidence, recommendations: a.recommendations.map(r => r.title) });
    }
    items.sort((x, y) => ['REPLACE', 'REPAIR', 'UPGRADE', 'MONITOR', 'MAINTAIN', 'KEEP'].indexOf(x.action) - ['REPLACE', 'REPAIR', 'UPGRADE', 'MONITOR', 'MAINTAIN', 'KEEP'].indexOf(y.action));
    return { devices: items.length, counts, items };
  });
}
