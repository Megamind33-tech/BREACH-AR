/**
 * Phase 8: post-upgrade verification. After a part is swapped WorkCare notices, re-measures, and compares what happened with what was predicted:
 * Recommend -> Install -> Measure -> Prove -> Learn. Only measured values are compared; a metric missing on either side is not claimed.
 */
import { diffAnatomy } from '../anatomy-engine.js';
import type { Metrics } from './providers.js';

type Obj = Record<string, any>;
export const UPGRADE_METRICS: Record<string, { label: string; better: 'higher' | 'lower'; unit: string; noisePercent?: number; noiseAbs?: number; group: 'cpu' | 'memory' | 'storage' | 'thermal' }> = {
  cpuSingleScore: { label: 'Single-thread CPU performance', better: 'higher', unit: 'pts', noisePercent: 3, group: 'cpu' },
  cpuMultiScore: { label: 'Multi-thread CPU performance', better: 'higher', unit: 'pts', noisePercent: 3, group: 'cpu' },
  cpuSustainedScore: { label: 'Sustained CPU performance', better: 'higher', unit: 'pts', noisePercent: 3, group: 'cpu' },
  memBandwidthMBs: { label: 'Memory bandwidth', better: 'higher', unit: 'MB/s', noisePercent: 4, group: 'memory' },
  memLatencyNs: { label: 'Memory latency', better: 'lower', unit: 'ns', noisePercent: 5, group: 'memory' },
  seqReadMBs: { label: 'Storage sequential read', better: 'higher', unit: 'MB/s', noisePercent: 8, group: 'storage' },
  rndRead4kIops: { label: 'Storage random reads', better: 'higher', unit: 'IOPS', noisePercent: 8, group: 'storage' },
  peakTempC: { label: 'Peak CPU temperature', better: 'lower', unit: '°C', noiseAbs: 2, group: 'thermal' },
  idleTempC: { label: 'Idle temperature', better: 'lower', unit: '°C', noiseAbs: 2, group: 'thermal' },
  cpuSustainedRatio: { label: 'Sustained-to-peak speed ratio', better: 'higher', unit: '', noiseAbs: 0.03, group: 'thermal' },
};
export interface UpgradeChange { kind: string; change: string; label: string }
const RELEVANT: Record<string, string[]> = { cpu: ['cpu', 'thermal'], memory: ['memory'], disk: ['storage'], board: ['cpu', 'memory', 'storage', 'thermal'], gpu: [] };

export function detectHardwareChange(before: Obj | null, after: Obj): UpgradeChange[] {
  return diffAnatomy(before, after).filter(c => ['cpu', 'memory', 'disk', 'board', 'gpu'].includes(c.kind)).map(c => ({ kind: c.kind, change: c.change, label: c.label }));
}

export interface VerifyRow { metric: string; label: string; before: number; after: number; changePercent: number; unit: string; result: 'improved' | 'worse' | 'unchanged' }
export interface Verification {
  verdict: 'VERIFIED' | 'NO_IMPROVEMENT' | 'REGRESSION' | 'INCONCLUSIVE'; rows: VerifyRow[]; overallPercent: number | null; stability: 'PASS' | 'FAIL' | 'UNKNOWN';
  vsPrediction: 'WITHIN' | 'ABOVE' | 'BELOW' | 'UNKNOWN'; headline: string[]; success: boolean; temperatureChangeC: number | null;
}

export function verifyUpgrade(o: { changes: UpgradeChange[]; before: Metrics | null; after: Metrics | null; predicted?: { lowPercent: number | null; highPercent: number | null } | null; newHardwareErrors?: number | null; newCrashes?: number | null; noisy?: boolean }): Verification {
  const groups = new Set(o.changes.flatMap(c => RELEVANT[c.kind] ?? [])); const rows: VerifyRow[] = [];
  if (o.before && o.after) for (const [k, d] of Object.entries(UPGRADE_METRICS)) {
    const b = o.before[k], a = o.after[k]; if (typeof b !== 'number' || typeof a !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    const change = b === 0 ? (a === 0 ? 0 : 100) : Math.round(((a - b) / Math.abs(b)) * 1000) / 10;
    const small = d.noiseAbs != null ? Math.abs(a - b) < d.noiseAbs : Math.abs(change) < (d.noisePercent ?? 3);
    const better = d.better === 'higher' ? a > b : a < b;
    rows.push({ metric: k, label: d.label, before: b, after: a, changePercent: change, unit: d.unit, result: small ? 'unchanged' : better ? 'improved' : 'worse' });
  }
  const relevant = rows.filter(r => groups.has(UPGRADE_METRICS[r.metric]!.group) && UPGRADE_METRICS[r.metric]!.group !== 'thermal');
  // overall: geometric mean of the ratios of the metrics the replaced part could affect (lower-is-better metrics are inverted)
  let overall: number | null = null;
  if (relevant.length) { const logs = relevant.map(r => Math.log(UPGRADE_METRICS[r.metric]!.better === 'higher' ? r.after / r.before : r.before / r.after)); overall = Math.round((Math.exp(logs.reduce((s, x) => s + x, 0) / logs.length) - 1) * 1000) / 10; }
  const stabilityKnown = o.newHardwareErrors != null || o.newCrashes != null; const stability = !stabilityKnown ? 'UNKNOWN' : (o.newHardwareErrors ?? 0) > 0 || (o.newCrashes ?? 0) > 0 ? 'FAIL' : 'PASS';
  const temp = rows.find(r => r.metric === 'peakTempC'); const tempChange = temp ? Math.round((temp.after - temp.before) * 10) / 10 : null;
  let vsPrediction: Verification['vsPrediction'] = 'UNKNOWN';
  if (overall != null && o.predicted && o.predicted.lowPercent != null && o.predicted.highPercent != null) vsPrediction = overall < o.predicted.lowPercent ? 'BELOW' : overall > o.predicted.highPercent ? 'ABOVE' : 'WITHIN';
  let verdict: Verification['verdict'];
  if (!relevant.length) verdict = 'INCONCLUSIVE';
  else if (relevant.some(r => r.result === 'worse' && Math.abs(r.changePercent) >= 10) || stability === 'FAIL') verdict = 'REGRESSION';
  else if (overall != null && overall >= 3) verdict = 'VERIFIED';
  else verdict = 'NO_IMPROVEMENT';
  // A run taken while the computer was busy cannot show that nothing improved or that something got worse.
  if (o.noisy && (verdict === 'NO_IMPROVEMENT' || verdict === 'REGRESSION')) verdict = 'INCONCLUSIVE';
  const headline: string[] = [];
  if (verdict === 'VERIFIED') headline.push('UPGRADE VERIFIED');
  else if (verdict === 'NO_IMPROVEMENT') headline.push('NO MEASURABLE IMPROVEMENT');
  else if (verdict === 'REGRESSION') headline.push('THE UPGRADE MADE SOMETHING WORSE');
  else headline.push('NOT ENOUGH MEASUREMENTS TO JUDGE');
  if (overall != null) headline.push(`Overall improvement of the affected parts: ${overall >= 0 ? '+' : ''}${overall}%`);
  for (const r of relevant) headline.push(`${r.label}: ${r.changePercent >= 0 ? '+' : ''}${r.changePercent}%`);
  if (tempChange != null) headline.push(`Peak CPU temperature: ${tempChange >= 0 ? '+' : ''}${tempChange}°C`);
  if (o.noisy) headline.push('One of the measurements was taken while the computer was busy with other work, so the figures are less precise. Measure again when it is idle for a firmer result.');
  headline.push(`System stability: ${stability === 'UNKNOWN' ? 'not yet judged' : stability}`);
  if (vsPrediction !== 'UNKNOWN') headline.push(vsPrediction === 'WITHIN' ? 'The result matches what was predicted.' : vsPrediction === 'ABOVE' ? 'The result beat the prediction.' : 'The result fell short of the prediction.');
  return { verdict, rows, overallPercent: overall, stability, vsPrediction, headline, success: verdict === 'VERIFIED' && stability !== 'FAIL', temperatureChangeC: tempChange };
}

/** Pooled outcome statistics for one board and one change, used to replace model predictions with observed results. */
export function summariseOutcomes(rows: { success: boolean; gain: number | null; tempChangeC: number | null }[]) {
  const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
  const gains = rows.filter(r => r.success && r.gain != null).map(r => r.gain! / 100); const temps = rows.filter(r => r.tempChangeC != null).map(r => r.tempChangeC!);
  return { successes: rows.filter(r => r.success).length, failures: rows.filter(r => !r.success).length, medianGain: med(gains), medianTempChangeC: med(temps) };
}
