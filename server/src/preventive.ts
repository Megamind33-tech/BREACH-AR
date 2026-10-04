import type { Db } from './db.js';
import type { Deduction } from './health.js';
import { SAFE_CLEAN_IDS } from './catalog.js';
import { storageTrend } from './condition.js';

/**
 * Preventive findings: the computer has not failed, but a measured trend says it is heading somewhere bad. They are ordinary incidents
 * (evidence, action, verification) so Autopilot handles them like any other, but they are never invented: each needs recorded history.
 */
type Finding = Deduction & { evidence: { type: 'TELEMETRY'; source: string; value: Record<string, unknown>; note?: string }[] };
const GB = 2 ** 30;

export async function preventiveFindings(db: Db, deviceId: string, now = new Date()): Promise<Finding[]> {
  const out: Finding[] = [];
  const hist = (await db.query(`SELECT at, overall, metrics FROM device_health_history WHERE device_id=$1 AND at > $2 ORDER BY at`, [deviceId, new Date(now.getTime() - 30 * 86_400_000)])).rows;

  // 1) free space is falling fast enough to run out soon
  const t = storageTrend(hist.map(r => ({ at: new Date(r.at), freeBytes: (r.metrics as any)?.systemFreeBytes ?? null })), undefined, now);
  const last = [...hist].reverse().find(r => (r.metrics as any)?.systemFreeBytes != null);
  const nowFree = (last?.metrics as any)?.systemFreeBytes as number | undefined;
  if (t.measured && t.growthBytesPerDay != null && t.growthBytesPerDay <= -0.5 * GB && t.projectedBelowThresholdAt && nowFree != null && nowFree > t.thresholdBytes) {
    const days = (new Date(t.projectedBelowThresholdAt).getTime() - now.getTime()) / 86_400_000;
    if (days <= 14) out.push({
      category: 'storage', points: 2, code: 'preventive.storage_filling', impact: 'medium', remedy: 'safe-fix',
      reason: `Free space on the system drive is falling by about ${(-t.growthBytesPerDay / GB).toFixed(1)} GB per day. At this rate it drops below ${(t.thresholdBytes / GB).toFixed(0)} GB in about ${Math.max(1, Math.round(days))} day${Math.round(days) === 1 ? '' : 's'}. What is filling it has not been measured.`,
      recommendation: 'Recover safe temporary files now, before the drive fills up and causes failures. If it keeps filling, find the growing folder.',
      fix: { jobType: 'cleanup.run', params: { categories: SAFE_CLEAN_IDS }, label: 'Clean safe files', confirm: 'Delete temporary files, caches and crash dumps? Personal files are never touched.' },
      evidence: [{ type: 'TELEMETRY', source: 'Free-space history', value: { growthBytesPerDay: t.growthBytesPerDay, readings: t.points, spanDays: t.spanDays, projectedBelowThresholdAt: t.projectedBelowThresholdAt, confidence: t.confidence }, note: t.note }],
    } as Finding);
  }

  // 2) health has been getting steadily worse
  const recent = hist.filter(r => new Date(r.at).getTime() >= now.getTime() - 14 * 86_400_000);
  if (recent.length >= 5) {
    const first = recent[0].overall as number, lastO = recent[recent.length - 1].overall as number;
    if (first - lastO >= 15 && lastO < 85) out.push({
      category: 'reliability', points: 2, code: 'preventive.health_declining', impact: 'medium', remedy: 'manual',
      reason: `Health fell from ${first} to ${lastO} in ${Math.max(1, Math.round((new Date(recent[recent.length - 1].at).getTime() - new Date(recent[0].at).getTime()) / 86_400_000))} days. Nothing has failed yet, but the computer's condition has deteriorated.`,
      recommendation: 'Look at what changed on this computer recently. Viro keeps watching and will act on any specific problem it finds.',
      evidence: [{ type: 'TELEMETRY', source: 'Health history', value: { from: first, to: lastO, readings: recent.length }, note: 'Measured health scores over the last 14 days.' }],
    } as Finding);
  }

  // 3) it takes noticeably longer to start than when Viro first measured it
  const b = (await db.query(`SELECT kind, metrics, taken_at FROM benchmarks WHERE device_id=$1 AND metrics->>'bootSeconds' IS NOT NULL ORDER BY taken_at`, [deviceId])).rows;
  if (b.length >= 2) {
    const base = Number(b[0].metrics.bootSeconds), cur = Number(b[b.length - 1].metrics.bootSeconds);
    if (base > 0 && cur >= base * 1.5 && cur - base >= 20) out.push({
      category: 'performance', points: 2, code: 'preventive.boot_slower', impact: 'medium', remedy: 'review',
      reason: `Start-up now takes ${Math.round(cur)} seconds, up from ${Math.round(base)} seconds when it was first measured.`,
      recommendation: 'Review the programs that start with Windows and pending updates; a slower start is usually the first sign of a heavier machine.',
      evidence: [{ type: 'TELEMETRY', source: 'Benchmark history', value: { bootSecondsBaseline: base, bootSecondsNow: cur, measurements: b.length }, note: 'Boot time as recorded by Windows.' }],
    } as Finding);
  }
  return out;
}
