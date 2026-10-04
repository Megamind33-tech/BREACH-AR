import type { Db } from './db.js';

/**
 * Component condition from what the hardware itself reports (SMART, NVMe health log, battery capacity), tracked over time.
 * Viro never predicts a failure date. It classifies condition, shows the evidence, and says what to do (verify backups, plan replacement).
 */
export type Condition = 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'REPLACEMENT_ADVISED' | 'CRITICAL' | 'NOT_MEASURED';
export const CONDITION_RANK: Record<Condition, number> = { NOT_MEASURED: -1, HEALTHY: 0, WATCH: 1, DEGRADED: 2, REPLACEMENT_ADVISED: 3, CRITICAL: 4 };
const worse = (a: Condition, b: Condition) => (CONDITION_RANK[b] > CONDITION_RANK[a] ? b : a);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface DiskReading { model: string; mediaType: string | null; health: string | null; wearPercent: number | null; uncorrectedErrors: number | null; mediaErrors: number | null; powerOnHours: number | null; temperatureC: number | null; spareLeftPercent: number | null; criticalWarning: number | null; unsafeShutdowns: number | null; powerCycles: number | null; isSystem?: boolean }

/** Flattens one entry of the hardware diagnosis (storage.disks[]) into the values Viro tracks. */
export function diskReadingOf(d: any): DiskReading {
  const rel = d?.reliability ?? {}, nv = d?.nvme ?? {};
  const unc = (n(rel.readErrorsUncorrected) ?? 0) + (n(rel.writeErrorsUncorrected) ?? 0);
  const hasErrs = n(rel.readErrorsUncorrected) != null || n(rel.writeErrorsUncorrected) != null;
  return {
    model: String(d?.model ?? `Disk ${d?.index ?? '?'}`), mediaType: d?.mediaType ?? null, health: d?.health ?? null,
    wearPercent: n(nv.percentageUsed) ?? n(rel.wearPercent), uncorrectedErrors: hasErrs ? unc : null, mediaErrors: n(nv.mediaErrors),
    powerOnHours: n(nv.powerOnHours) ?? n(rel.powerOnHours), temperatureC: n(nv.temperatureC) ?? n(rel.temperatureC),
    spareLeftPercent: n(nv.availableSparePercent), criticalWarning: n(nv.criticalWarning), unsafeShutdowns: n(nv.unsafeShutdowns) ?? n(rel.unsafeShutdowns), powerCycles: n(nv.powerCycles),
  };
}

export interface DiskCondition { model: string; mediaType: string | null; condition: Condition; evidence: string[]; action: string; readings: DiskReading; trend: { uncorrectedErrors: 'increasing' | 'stable' | 'unknown'; wearPercentPerMonth: number | null } }

/** `previous` are older readings of the same disk (oldest first), used only to see whether errors are increasing. */
export function diskCondition(cur: DiskReading, previous: DiskReading[] = []): DiskCondition {
  const ev: string[] = []; let c: Condition = 'HEALTHY';
  const bump = (cond: Condition, why: string) => { c = worse(c, cond); ev.push(why); };
  const measured = cur.health != null || cur.wearPercent != null || cur.uncorrectedErrors != null || cur.spareLeftPercent != null || cur.criticalWarning != null || cur.powerOnHours != null;
  if (!measured) return { model: cur.model, mediaType: cur.mediaType, condition: 'NOT_MEASURED', evidence: ['This drive does not report health data to Windows.'], action: 'No health data is available; rely on backups and the SMART tools of the drive vendor.', readings: cur, trend: { uncorrectedErrors: 'unknown', wearPercentPerMonth: null } };
  if (cur.health === 'Unhealthy') bump('CRITICAL', 'Windows reports the drive as Unhealthy.');
  else if (cur.health === 'Warning') bump('DEGRADED', 'Windows reports a health warning for the drive.');
  if (cur.criticalWarning) bump('CRITICAL', `The drive controller raised a critical warning (flags ${cur.criticalWarning}).`);
  if (cur.wearPercent != null) {
    if (cur.wearPercent >= 100) bump('CRITICAL', `${cur.wearPercent}% of the rated write endurance is used.`);
    else if (cur.wearPercent >= 90) bump('REPLACEMENT_ADVISED', `${cur.wearPercent}% of the rated write endurance is used.`);
    else if (cur.wearPercent >= 80) bump('DEGRADED', `${cur.wearPercent}% of the rated write endurance is used.`);
    else if (cur.wearPercent >= 60) bump('WATCH', `${cur.wearPercent}% of the rated write endurance is used.`);
  }
  if (cur.spareLeftPercent != null) { if (cur.spareLeftPercent < 10) bump('CRITICAL', `Only ${cur.spareLeftPercent}% spare capacity is left.`); else if (cur.spareLeftPercent < 30) bump('DEGRADED', `Spare capacity is down to ${cur.spareLeftPercent}%.`); }
  const errs = (cur.uncorrectedErrors ?? 0) + (cur.mediaErrors ?? 0);
  if (errs > 0) bump('REPLACEMENT_ADVISED', `${errs} uncorrectable or media error${errs === 1 ? '' : 's'} recorded by the drive.`);
  const prevErr = previous.map(p => p.uncorrectedErrors).filter((v): v is number => v != null);
  const errTrend: DiskCondition['trend']['uncorrectedErrors'] = cur.uncorrectedErrors == null || prevErr.length === 0 ? 'unknown' : cur.uncorrectedErrors > Math.min(...prevErr) ? 'increasing' : 'stable';
  if (errTrend === 'increasing') bump('CRITICAL', `The number of uncorrectable errors has increased since ${prevErr.length} earlier reading${prevErr.length === 1 ? '' : 's'}.`);
  const rotating = /hdd|unspecified/i.test(cur.mediaType ?? '') || cur.mediaType == null ? /hdd/i.test(cur.mediaType ?? '') : false;
  if (cur.powerOnHours != null && rotating && cur.powerOnHours > 30_000) bump('WATCH', `A mechanical drive with ${cur.powerOnHours.toLocaleString('en-US')} hours powered on is old for its type.`);
  if (cur.temperatureC != null && cur.temperatureC >= 70) bump('WATCH', `The drive reads ${cur.temperatureC} °C.`);
  if (cur.unsafeShutdowns != null && cur.unsafeShutdowns >= 50) bump('WATCH', `${cur.unsafeShutdowns} unsafe shutdowns recorded.`);
  if (!ev.length) ev.push('No warning, error or wear indicator on the readings Viro could take.');
  const first = previous.find(p => p.wearPercent != null), pm = first && cur.wearPercent != null ? null : null;
  void pm;
  const action = ({
    HEALTHY: 'No action needed.', WATCH: 'Keep watching. Make sure backups are current.', DEGRADED: 'Verify that backups are current and plan a replacement.',
    REPLACEMENT_ADVISED: 'Verify backups, then schedule replacement of the drive. Software cannot fix a drive that is wearing out or reporting errors.',
    CRITICAL: 'Back up now and replace the drive as soon as possible.', NOT_MEASURED: '',
  } as Record<Condition, string>)[c];
  return { model: cur.model, mediaType: cur.mediaType, condition: c, evidence: ev, action, readings: cur, trend: { uncorrectedErrors: errTrend, wearPercentPerMonth: null } };
}

export interface BatteryCondition { condition: Condition; healthPercent: number | null; designMWh: number | null; fullChargeMWh: number | null; cycles: number | null; evidence: string[]; action: string; runtime: { measured: false; note: string }; trend: { healthPercentChange: number | null; since: string | null } }

export function batteryCondition(b: any, history: { at: Date; healthPercent: number | null }[] = []): BatteryCondition | null {
  if (!b) return null;
  const design = n(b.designCapacityMWh), full = n(b.fullChargeCapacityMWh), cycles = n(b.cycleCount);
  const pct = design && full ? Math.round((100 * full) / design) : null;
  const ev: string[] = []; let c: Condition = 'NOT_MEASURED';
  if (pct != null) {
    ev.push(`The battery holds ${pct}% of its design capacity (${Math.round((full ?? 0) / 1000)} Wh of ${Math.round((design ?? 0) / 1000)} Wh).`);
    c = pct >= 80 ? 'HEALTHY' : pct >= 65 ? 'WATCH' : pct >= 50 ? 'REPLACEMENT_ADVISED' : 'CRITICAL';
  } else if (cycles != null) { ev.push(`${cycles} charge cycles recorded; capacity could not be read.`); c = cycles > 800 ? 'WATCH' : 'NOT_MEASURED'; }
  if (cycles != null && pct != null) ev.push(`${cycles} charge cycles recorded.`);
  const past = history.filter(h => h.healthPercent != null);
  const oldest = past[0];
  const change = pct != null && oldest ? pct - (oldest.healthPercent as number) : null;
  if (change != null && change <= -5) ev.push(`Capacity has fallen ${Math.abs(change)} points since ${oldest!.at.toISOString().slice(0, 10)}.`);
  const action = ({ HEALTHY: 'No action needed.', WATCH: 'Battery is ageing. No action yet.', DEGRADED: 'Plan a battery replacement.', REPLACEMENT_ADVISED: 'Replace the battery. Software cannot restore lost capacity.', CRITICAL: 'Replace the battery now; it can no longer hold a useful charge.', NOT_MEASURED: 'Battery capacity could not be read.' } as Record<Condition, string>)[c];
  return { condition: c, healthPercent: pct, designMWh: design, fullChargeMWh: full, cycles, evidence: ev, action, runtime: { measured: false, note: 'Real runtime is not measured yet, so Viro does not quote one.' }, trend: { healthPercentChange: change, since: oldest ? oldest.at.toISOString() : null } };
}

export interface StorageTrend { measured: boolean; points: number; spanDays: number; growthBytesPerDay: number | null; projectedBelowThresholdAt: string | null; thresholdBytes: number; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; note: string }

/**
 * Free-space trend of the system drive from health history. A cleanup or repair (a jump up of 5 GB or more) starts a new segment so
 * recovered space is not read as a trend. Reports growth per day and, only when the data supports it, the date free space falls below 10 GB.
 */
export function storageTrend(points: { at: Date; freeBytes: number | null }[], thresholdBytes = 10 * 2 ** 30, now = new Date()): StorageTrend {
  const pts = points.filter((p): p is { at: Date; freeBytes: number } => p.freeBytes != null).sort((a, b) => a.at.getTime() - b.at.getTime());
  let start = 0; for (let i = 1; i < pts.length; i++) if (pts[i].freeBytes - pts[i - 1].freeBytes >= 5 * 2 ** 30) start = i;
  const seg = pts.slice(start);
  const span = seg.length > 1 ? (seg[seg.length - 1].at.getTime() - seg[0].at.getTime()) / 86_400_000 : 0;
  const base = { points: seg.length, spanDays: Math.round(span * 10) / 10, thresholdBytes };
  if (seg.length < 5 || span < 3) return { measured: false, ...base, growthBytesPerDay: null, projectedBelowThresholdAt: null, confidence: 'LOW', note: 'Not enough history yet to judge a trend (needs at least 5 readings over 3 days since the last cleanup).' };
  const t0 = seg[0].at.getTime(), xs = seg.map(p => (p.at.getTime() - t0) / 86_400_000), ys = seg.map(p => p.freeBytes);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const slope = sxx ? sxy / sxx : 0;                                              // bytes per day; negative = filling
  const ssTot = ys.reduce((a, y) => a + (y - my) ** 2, 0), ssRes = ys.reduce((a, y, i) => a + (y - (my + slope * (xs[i] - mx))) ** 2, 0);
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;
  const confidence: StorageTrend['confidence'] = r2 >= 0.85 && seg.length >= 8 ? 'HIGH' : r2 >= 0.6 ? 'MEDIUM' : 'LOW';
  const last = seg[seg.length - 1];
  if (slope >= -50 * 2 ** 20) return { measured: true, ...base, growthBytesPerDay: Math.round(slope), projectedBelowThresholdAt: null, confidence, note: 'Free space is not shrinking in a way that matters.' };
  const days = (last.freeBytes - thresholdBytes) / -slope;
  const at = days <= 0 ? now : new Date(last.at.getTime() + days * 86_400_000);
  return { measured: true, ...base, growthBytesPerDay: Math.round(slope), projectedBelowThresholdAt: at.toISOString(), confidence, note: `Free space is falling by about ${(-slope / 2 ** 30).toFixed(1)} GB per day.` };
}

export async function recordHardwareReading(db: Db, orgId: string, deviceId: string, raw: any): Promise<void> {
  const disks = (Array.isArray(raw?.storage?.disks) ? raw.storage.disks : []).map(diskReadingOf);
  const b = raw?.battery ? { healthPercent: n(raw.battery.designCapacityMWh) && n(raw.battery.fullChargeCapacityMWh) ? Math.round((100 * raw.battery.fullChargeCapacityMWh) / raw.battery.designCapacityMWh) : null, cycles: n(raw.battery.cycleCount), designCapacityMWh: n(raw.battery.designCapacityMWh), fullChargeCapacityMWh: n(raw.battery.fullChargeCapacityMWh) } : null;
  if (!disks.length && !b) return;
  await db.query('INSERT INTO hardware_readings(org_id,device_id,storage,battery) VALUES ($1,$2,$3,$4)', [orgId, deviceId, JSON.stringify(disks), b ? JSON.stringify(b) : null]);
}
