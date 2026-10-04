import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { anatomyHelpers } from './anatomy.js';
import { ageAnalysis, windowsReadiness, diffAnatomy } from './anatomy-engine.js';
import { buildUpgradeReport } from './upgrade/engine.js';
import { normalizeBoard, normalizeCpu } from './upgrade/normalize.js';
import { boardKey, defaultProviders, OutcomeTable, type Metrics } from './upgrade/providers.js';
import { verifyUpgrade, type UpgradeChange } from './upgrade/verify.js';
import type { UpgradeContext } from './upgrade/context.js';

type Obj = Record<string, any>;
const HARDWARE_KINDS = ['cpu', 'memory', 'disk', 'board'];
const COMPONENT_OF: Record<string, string> = { cpu: 'cpu', memory: 'memory', disk: 'storage', board: 'cpu' };

/** Everything the engine needs to know about one computer that is not in its anatomy reading: usage, heat, measurements, prices, outcomes. */
export async function upgradeInputs(db: Db, orgId: string, deviceId: string, a: Obj, now = new Date()) {
  const h = anatomyHelpers(db); const base = await h.contextFor(orgId, deviceId, a, now); const prices = await h.priceBookOf(orgId);
  const inv = (await db.query('SELECT hardware FROM device_inventory WHERE device_id=$1', [deviceId])).rows[0]?.hardware;
  const c = (inv?.volumes ?? []).find((v: Obj) => /^C:/i.test(v.name ?? '')); const systemUsedGB = c?.totalBytes && c?.freeBytes != null ? Math.round((c.totalBytes - c.freeBytes) / 1e9) : null;
  const bench = (await db.query(`SELECT metrics, taken_at, safety FROM upgrade_benchmarks WHERE device_id=$1 AND (safety IS NULL OR coalesce((safety->>'aborted')::boolean,false) = false) ORDER BY taken_at DESC LIMIT 1`, [deviceId])).rows[0];
  const os = String(a.os?.caption ?? ''); const win = windowsReadiness(a);
  const age = ageAnalysis(a, base.purchaseDate, now);
  const ctx: UpgradeContext = {
    now, ramPeakPercent: base.ramPeakPercent != null ? Math.round(base.ramPeakPercent) : null, cpuAvgPercent: base.cpuAvgPercent, systemUsedGB, ageYears: age.ageYears,
    thermal: { throttleEvents7d: a.diagnostics?.cpu?.thermalThrottleEvents7d ?? null, maxIdleTempC: base.coolingEvidence.maxIdleTempC }, benchmark: bench?.metrics ? (bench.safety?.noisy ? withoutNoisyFields(bench.metrics) : bench.metrics) : null,
    windows: { running11: /windows 11/i.test(os), running10: /windows 10/i.test(os), ready11: win.windows11Ready }, prices, workload: { gpuBound: null },
  };
  const key = boardKey(normalizeBoard(a));
  const rows = (await db.query(`SELECT board_key, from_part, to_part, count(*) FILTER (WHERE success) AS successes, count(*) FILTER (WHERE NOT success) AS failures,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY gain_percent) FILTER (WHERE success AND gain_percent IS NOT NULL) AS median_gain, percentile_cont(0.5) WITHIN GROUP (ORDER BY temp_change_c) FILTER (WHERE temp_change_c IS NOT NULL) AS median_temp
      FROM upgrade_outcomes WHERE board_key=$1 AND (org_id=$2 OR shared) GROUP BY board_key, from_part, to_part`, [key, orgId])).rows;
  const providers = defaultProviders({ outcomes: new OutcomeTable(rows.map((r: Obj) => ({ boardKey: r.board_key, fromCpu: r.from_part, toCpu: r.to_part, successes: Number(r.successes), failures: Number(r.failures), medianGain: r.median_gain != null ? Number(r.median_gain) / 100 : null, medianTempChangeC: r.median_temp != null ? Number(r.median_temp) : null })) ) });
  return { ctx, providers };
}

/** A run taken while other programs were busy is not evidence about heat or sustained speed. Its raw scores stay on record, but nothing is judged from them. */
function withoutNoisyFields(m: Metrics): Metrics { const { cpuSustainedRatio, clockHeldRatio, clockSustainedMHz, ...rest } = m as Record<string, number>; void cpuSustainedRatio; void clockHeldRatio; void clockSustainedMHz; return rest; }

export async function reportForDevice(db: Db, orgId: string, deviceId: string, a: Obj, now = new Date()) {
  const { ctx, providers } = await upgradeInputs(db, orgId, deviceId, a, now);
  return buildUpgradeReport(a, ctx, { providers });
}

/** The history is written only when the set of recommendations changes, and never edited afterwards. Returns the id of the current row. */
export async function recordRecommendation(db: Db, orgId: string, deviceId: string, report: Obj): Promise<number> {
  const recs = (report.recommendations ?? []).map((r: Obj) => ({ id: r.id, class: r.class, component: r.component, title: r.title, expected: r.expected, confidence: r.confidence.overall, part: r.part, compatibility: r.compatibility.status }));
  const signature = createHash('sha256').update(JSON.stringify([recs.map((r: Obj) => [r.id, r.class]), report.opportunity.grade, report.replacement.action])).digest('hex');
  const last = (await db.query('SELECT id, signature FROM upgrade_recommendations WHERE device_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1', [deviceId])).rows[0];
  if (last && last.signature === signature) return Number(last.id);
  const hardware = { cpu: report.machine.cpu.name, board: [report.machine.board.manufacturer, report.machine.board.model].filter(Boolean).join(' '), memory: report.machine.memory.description, storage: report.machine.storage };
  const r = await db.query('INSERT INTO upgrade_recommendations(org_id,device_id,signature,grade,best,recommendations,replacement,hardware) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [orgId, deviceId, signature, report.opportunity.grade, report.best, JSON.stringify(recs), JSON.stringify(report.replacement), JSON.stringify(hardware)]);
  return Number(r.rows[0].id);
}

export async function storeUpgradeBenchmark(db: Db, orgId: string, deviceId: string, jobId: string, result: Obj | null, purpose: 'baseline' | 'after' | 'periodic') {
  const metrics = result?.metrics; if (!metrics || typeof metrics !== 'object') return null;
  await db.query('INSERT INTO upgrade_benchmarks(org_id,device_id,purpose,metrics,safety,job_id) VALUES ($1,$2,$3,$4,$5,$6)', [orgId, deviceId, purpose, JSON.stringify(metrics), result?.safety ? JSON.stringify(result.safety) : null, jobId]);
  return metrics as Metrics;
}

/** Called when a new anatomy reading shows that a processor, memory, drive or board was changed: start the verification and ask the computer to re-measure. */
export async function onHardwareChanged(db: Db, orgId: string, deviceId: string, raw: ReturnType<typeof diffAnatomy>, queueAfterJob: (() => Promise<string | null>) | null, now = new Date()): Promise<number | null> {
  const items = raw.filter(c => HARDWARE_KINDS.includes(c.kind) && c.change !== 'removed'); if (!items.length) return null;
  const rec = (await db.query('SELECT id, recommendations FROM upgrade_recommendations WHERE device_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1', [deviceId])).rows[0];
  const predicted = items.map(c => { const r = (rec?.recommendations ?? []).find((x: Obj) => x.component === COMPONENT_OF[c.kind]); return r ? { component: r.component, title: r.title, lowPercent: r.expected?.lowPercent ?? null, highPercent: r.expected?.highPercent ?? null } : null; }).filter(Boolean);
  const before = (await db.query(`SELECT metrics, taken_at FROM upgrade_benchmarks WHERE device_id=$1 AND purpose <> 'after' AND (safety IS NULL OR coalesce((safety->>'aborted')::boolean,false) = false) ORDER BY taken_at DESC LIMIT 1`, [deviceId])).rows[0];
  const detail = items.map(c => ({ kind: c.kind, change: c.change, label: c.label, fromPart: partName(c.kind, c.before), toPart: partName(c.kind, c.after) }));
  const jobId = queueAfterJob ? await queueAfterJob() : null;
  const r = await db.query(`INSERT INTO upgrade_verifications(org_id,device_id,recommendation_id,detected_at,changes,before_metrics,before_at,predicted,job_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [orgId, deviceId, rec?.id ?? null, now, JSON.stringify(detail), before?.metrics ? JSON.stringify(before.metrics) : null, before?.taken_at ?? null, predicted.length ? JSON.stringify(predicted) : null, jobId]);
  return Number(r.rows[0].id);
}
function partName(kind: string, d: Obj | undefined): string | null {
  if (!d) return null;
  if (kind === 'cpu') return normalizeCpu({ cpu: d }).model ?? d.name ?? null;
  if (kind === 'memory') return `${d.capacityBytes ? Math.round(d.capacityBytes / 2 ** 30) : '?'}GB ${d.type ?? ''}`.trim();
  if (kind === 'disk') return d.model ?? null;
  return [d.manufacturer, d.product].filter(Boolean).join(' ') || null;
}

/** The re-measurement arrived: judge the result against what was measured before and what was predicted, and keep it as verified knowledge. */
export async function completeVerification(db: Db, orgId: string, deviceId: string, jobId: string, metrics: Metrics, safety: Obj | null, a: Obj | null) {
  const v = (await db.query(`SELECT * FROM upgrade_verifications WHERE device_id=$1 AND state='awaiting_measurement' ORDER BY detected_at DESC LIMIT 1`, [deviceId])).rows[0]; if (!v) return null;
  const changes = (v.changes as Obj[]) as unknown as UpgradeChange[]; const pred = (v.predicted as Obj[] | null)?.[0] ?? null;
  const completed = safety ? safety.aborted !== true : null;
  const beforeNoisy = !!(await db.query(`SELECT safety FROM upgrade_benchmarks WHERE device_id=$1 AND purpose <> 'after' ORDER BY taken_at DESC LIMIT 1`, [deviceId])).rows[0]?.safety?.noisy;
  const res = verifyUpgrade({ changes, before: v.before_metrics, after: metrics, predicted: pred ? { lowPercent: pred.lowPercent, highPercent: pred.highPercent } : null, newHardwareErrors: completed === true ? 0 : completed === false ? 1 : null, newCrashes: null, noisy: safety?.noisy === true || beforeNoisy });
  const state = res.verdict === 'INCONCLUSIVE' ? 'inconclusive' : 'done';
  await db.query(`UPDATE upgrade_verifications SET state=$2, result=$3, after_metrics=$4, completed_at=now() WHERE id=$1`, [v.id, state, JSON.stringify(res), JSON.stringify(metrics)]);
  if (state === 'done' && a) {
    const share = !!(await db.query('SELECT share_outcomes FROM upgrade_settings WHERE org_id=$1', [orgId])).rows[0]?.share_outcomes; const key = boardKey(normalizeBoard(a));
    for (const c of v.changes as Obj[]) if (c.toPart) await db.query('INSERT INTO upgrade_outcomes(org_id,shared,board_key,component,from_part,to_part,success,gain_percent,temp_change_c) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [orgId, share, key, COMPONENT_OF[c.kind] ?? c.kind, c.fromPart, c.toPart, res.success, res.overallPercent, res.temperatureChangeC]);
  }
  void jobId; return { id: Number(v.id), ...res };
}
