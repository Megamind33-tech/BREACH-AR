import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { JobCtx } from './jobs.js';

/**
 * Benchmarks store what the agent measured (never estimates) and compare two measurements honestly: a difference smaller than the
 * noise threshold is "unchanged", a metric that is missing on either side is not compared, and only measured improvements are reported.
 */
type Dir = 'lower' | 'higher';
export const BENCH_METRICS: Record<string, { label: string; better: Dir; unit: string; noise: number }> = {
  bootSeconds: { label: 'Boot time', better: 'lower', unit: 's', noise: 5 },
  cpuAvgPercent: { label: 'Background CPU', better: 'lower', unit: '%', noise: 10 },
  ramPercent: { label: 'Memory in use', better: 'lower', unit: '%', noise: 5 },
  startupCount: { label: 'Startup programs', better: 'lower', unit: '', noise: 1 },
  runningServices: { label: 'Running services', better: 'lower', unit: '', noise: 3 },
  processCount: { label: 'Running processes', better: 'lower', unit: '', noise: 5 },
  diskSyncWriteMs: { label: 'Disk write latency', better: 'lower', unit: 'ms', noise: 15 },
  systemFreeBytes: { label: 'Free storage on the system drive', better: 'higher', unit: 'bytes', noise: 3 },
};

export interface Comparison { metric: string; label: string; before: number; after: number; changePercent: number; result: 'improved' | 'worse' | 'unchanged'; unit: string }

export function compareBenchmarks(before: Record<string, any> | null | undefined, after: Record<string, any> | null | undefined): { measured: boolean; rows: Comparison[]; improved: Comparison[] } {
  const rows: Comparison[] = [];
  if (!before || !after) return { measured: false, rows, improved: [] };
  for (const [k, def] of Object.entries(BENCH_METRICS)) {
    const b = before[k], a = after[k];
    if (typeof b !== 'number' || typeof a !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (b === 0 && a === 0) continue;
    const change = b === 0 ? 100 : Math.round(((a - b) / Math.abs(b)) * 1000) / 10;
    const small = def.unit === '' ? Math.abs(a - b) < def.noise : Math.abs(change) < def.noise;   // counts use an absolute noise floor
    const better = def.better === 'lower' ? a < b : a > b;
    rows.push({ metric: k, label: def.label, before: b, after: a, changePercent: change, result: small ? 'unchanged' : better ? 'improved' : 'worse', unit: def.unit });
  }
  return { measured: rows.length > 0, rows, improved: rows.filter(r => r.result === 'improved') };
}

export async function storeBenchmark(db: Db, orgId: string, deviceId: string, jobId: string, result: any, incidentId: string | null): Promise<void> {
  const metrics = result?.metrics; if (!metrics || typeof metrics !== 'object') return;
  const has = (await db.query('SELECT 1 FROM benchmarks WHERE device_id=$1 LIMIT 1', [deviceId])).rowCount;
  const kind = incidentId ? 'after' : has ? 'periodic' : 'baseline';
  await db.query('INSERT INTO benchmarks(org_id,device_id,kind,metrics,incident_id,job_id) VALUES ($1,$2,$3,$4,$5,$6)', [orgId, deviceId, kind, JSON.stringify(metrics), incidentId, jobId]);
  if (kind === 'baseline') await db.query(`UPDATE device_baselines SET metrics=$2 WHERE device_id=$1 AND metrics IS NULL`, [deviceId, JSON.stringify(metrics)]);
}

/** The measurement that a repair should be compared against: the latest one taken before the repair, else the device baseline. */
export async function beforeBenchmark(db: Db, deviceId: string, at: Date): Promise<Record<string, any> | null> {
  const r = await db.query(`SELECT metrics FROM benchmarks WHERE device_id=$1 AND taken_at <= $2 AND kind <> 'after' ORDER BY taken_at DESC LIMIT 1`, [deviceId, at]);
  return r.rows[0]?.metrics ?? null;
}

export function registerBenchmarkRoutes(app: FastifyInstance, c: JobCtx) {
  const { db } = c;
  app.get('/api/v1/devices/:id/benchmarks', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await db.query('SELECT 1 FROM devices WHERE id=$1 AND org_id=$2', [id, req.user.org])).rowCount) return reply.code(404).send({ error: 'not found' });
    const rows = (await db.query(`SELECT id, kind, metrics, incident_id, taken_at FROM benchmarks WHERE device_id=$1 ORDER BY taken_at DESC LIMIT 60`, [id])).rows;
    const baseline = [...rows].reverse().find(r => r.kind === 'baseline') ?? null;
    const latest = rows[0] ?? null;
    return {
      measurements: rows.length, baseline, latest, history: rows.slice(0, 20),
      sinceBaseline: baseline && latest && baseline.id !== latest.id ? compareBenchmarks(baseline.metrics, latest.metrics) : null,
      metrics: BENCH_METRICS,
    };
  });
}
