import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { JobCtx } from './jobs.js';
import { createSystemJob } from './jobs.js';
import { policyLevel, type Level } from './policies.js';

/**
 * Care: heat, battery, memory and start-up. The agent does the work and reports facts; this module stores them, turns them into the settings the
 * agent runs with, ranks battery-drain causes from real measurements, and computes before/after results. Nothing here is estimated without saying so.
 */
const LEVELS: Level[] = ['OBSERVE', 'SAFE', 'BALANCED', 'AGGRESSIVE'];

export interface CareSettings { ramTargetPercent?: number; thermalWarningC?: number; popups?: boolean }
export function carePolicy(level: Level, care?: CareSettings) {
  return { printerAuto: level !== 'OBSERVE', printerDrivers: level === 'BALANCED' || level === 'AGGRESSIVE', ramTargetPercent: care?.ramTargetPercent ?? 50, autoTrimIdle: level !== 'OBSERVE', suggestClose: true, autoCloseSafe: level === 'AGGRESSIVE', popups: care?.popups ?? true, thermalWarningC: care?.thermalWarningC ?? 85 };
}

// ---- battery -------------------------------------------------------------------------------------------------
export interface Sample { at: Date; percent: number | null; onBattery: boolean | null; dischargeWatts: number | null; fullChargeWh: number | null; designWh: number | null; healthPercent: number | null }

/** Time on battery per percent, from real discharge periods: consecutive samples on battery with the charge falling. Needs long enough, deep enough periods. */
export function measuredRuntime(samples: Sample[]): { typicalMinutes: number; ratePercentPerHour: number; periods: number; hours: number } | null {
  const s = samples.filter(x => x.percent != null).sort((a, b) => a.at.getTime() - b.at.getTime());
  const periods: { hours: number; drop: number }[] = []; let cur: Sample[] = [];
  const flush = () => { if (cur.length >= 2) { const a = cur[0], b = cur[cur.length - 1]; const hours = (b.at.getTime() - a.at.getTime()) / 3_600_000; const drop = (a.percent ?? 0) - (b.percent ?? 0); if (hours >= 0.5 && drop >= 5) periods.push({ hours, drop }); } cur = []; };
  for (const x of s) {
    const prev = cur[cur.length - 1];
    if (x.onBattery === true && (!prev || (x.at.getTime() - prev.at.getTime() < 20 * 60_000 && (x.percent ?? 0) <= (prev.percent ?? 0) + 1))) cur.push(x);
    else { flush(); if (x.onBattery === true) cur = [x]; }
  }
  flush();
  if (!periods.length) return null;
  const rates = periods.map(p => p.drop / p.hours).sort((a, b) => a - b); const med = rates[Math.floor(rates.length / 2)];
  return { typicalMinutes: Math.round(100 / med * 60), ratePercentPerHour: Math.round(med * 10) / 10, periods: periods.length, hours: Math.round(periods.reduce((n, p) => n + p.hours, 0) * 10) / 10 };
}

export interface Cause { rank: number; cause: string; impact: 'HIGH' | 'MEDIUM' | 'LOW'; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; evidence: string; action: string | null }
const IMPACT: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/** Ranks why a laptop drains quickly from what the agent measured. Each cause carries its evidence; a cause with no evidence is not listed. */
export function rankBatteryDrain(d: any): Cause[] {
  if (!d?.hasBattery) return [];
  const out: Omit<Cause, 'rank'>[] = []; const r = d.reading ?? {};
  if (r.healthPercent != null && r.healthPercent < 80) out.push({ cause: 'The battery has lost capacity', impact: r.healthPercent < 60 ? 'HIGH' : 'MEDIUM', confidence: 'HIGH', evidence: `It now holds ${r.fullChargeWh} Wh of the ${r.designWh} Wh it was built for (${r.healthPercent}% health).`, action: r.healthPercent < 60 ? 'Plan a battery replacement; software cannot restore capacity.' : 'Expect shorter runtime; replace when it no longer lasts a working session.' });
  for (const p of (d.topCpu ?? []).filter((x: any) => x.cpuPercent >= 10)) out.push({ cause: `${p.name} is using the processor`, impact: p.cpuPercent >= 40 ? 'HIGH' : 'MEDIUM', confidence: 'MEDIUM', evidence: `${p.name} used ${p.cpuPercent}% CPU while the battery was being measured (${p.memoryMb} MB memory).`, action: p.assessment === 'SAFE_TO_SUGGEST_CLOSE' ? 'A background helper: it can be closed safely.' : 'Close it when not needed, or check for a fault if it should be idle.' });
  const locks = (d.wakeLocks ?? []).filter((w: any) => w.kind === 'SYSTEM' || w.kind === 'DISPLAY');
  if (locks.length) out.push({ cause: 'Something is preventing the PC or screen from sleeping', impact: 'MEDIUM', confidence: 'HIGH', evidence: `Windows lists: ${locks.slice(0, 4).map((w: any) => `${w.name} (${w.kind})`).join('; ')}.`, action: 'Close those programs, or find out why they hold the PC awake.' });
  const br = (d.browsers ?? []).filter((b: any) => b.processes >= 20 || b.memoryMb >= 2048);
  for (const b of br) out.push({ cause: `${b.browser} has many processes open`, impact: 'MEDIUM', confidence: 'MEDIUM', evidence: `${b.processes} processes using ${Math.round(b.memoryMb / 1024 * 10) / 10} GB.`, action: 'Close tabs and extensions you are not using.' });
  if ((d.backgroundApps ?? []).length) out.push({ cause: 'Chat, meeting or sync apps are running in the background', impact: 'LOW', confidence: 'MEDIUM', evidence: `Running: ${d.backgroundApps.join(', ')}.`, action: 'Quit them when you are not in a call or waiting for files.' });
  if (r.dischargeWatts != null && r.dischargeWatts >= 18 && !(d.topCpu ?? []).some((x: any) => x.cpuPercent >= 10)) out.push({ cause: 'The PC is drawing a lot of power without an obvious program', impact: 'MEDIUM', confidence: 'LOW', evidence: `Measured draw ${r.dischargeWatts} W with no single program above 10% CPU. A driver, the screen brightness or the graphics chip may be responsible; this could not be narrowed further.`, action: 'Lower screen brightness, then check graphics and wireless drivers.' });
  if (/high performance|ultimate/i.test(d.powerPlan ?? '')) out.push({ cause: `The power plan is "${d.powerPlan}"`, impact: 'MEDIUM', confidence: 'HIGH', evidence: 'This plan keeps the processor running fast and uses much more power on battery.', action: 'Switch to a balanced plan.' });
  return out.sort((a, b) => IMPACT[b.impact] - IMPACT[a.impact] || IMPACT[b.confidence] - IMPACT[a.confidence]).map((c, i) => ({ rank: i + 1, ...c }));
}

// ---- boot ----------------------------------------------------------------------------------------------------
export async function recordBoots(db: Db, orgId: string, deviceId: string, snap: { boot?: { history?: { at: string; seconds: number }[] } | null }) {
  for (const b of snap.boot?.history ?? []) await db.query(`INSERT INTO boot_history(device_id,org_id,boot_at,seconds) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [deviceId, orgId, b.at, b.seconds]);
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
/** Start-up time before and after the last start-up optimization, measured from real boots. Null until a restart has happened since the change. */
export async function bootComparison(db: Db, deviceId: string) {
  const job = (await db.query(`SELECT finished_at FROM jobs WHERE device_id=$1 AND type='repair.run' AND status='completed' AND params->>'recipe'='startup.optimize' AND (result->>'applied')::boolean IS TRUE ORDER BY finished_at DESC LIMIT 1`, [deviceId])).rows[0];
  if (!job) return null;
  const boots = (await db.query(`SELECT boot_at, seconds FROM boot_history WHERE device_id=$1 ORDER BY boot_at`, [deviceId])).rows as { boot_at: Date; seconds: number }[];
  const before = boots.filter(b => b.boot_at < job.finished_at).slice(-5).map(b => b.seconds), after = boots.filter(b => b.boot_at > job.finished_at).map(b => b.seconds);
  if (!before.length || !after.length) return { optimizedAt: job.finished_at, beforeSeconds: median(before), afterSeconds: null, note: after.length ? null : 'The new start-up time is measured at the next restart.' };
  const b = median(before)!, a = median(after)!;
  return { optimizedAt: job.finished_at, beforeSeconds: b, afterSeconds: a, improvementPercent: Math.round((b - a) / b * 100), restartsMeasured: after.length };
}

/** When a drive shows a real failure, tell the person at the PC once a week (the notice text is fixed on the PC; only the evidence lines come from here). */
export async function maybeNotifyStorage(db: Db, signer: any, orgId: string, deviceId: string, deductions: { code: string; reason: string }[]) {
  const bad = deductions.filter(d => /^hardware\.(disk_unhealthy|disk_errors|disk_warning)$/.test(d.code));
  if (!bad.length) return false;
  if ((await db.query(`SELECT 1 FROM jobs WHERE device_id=$1 AND type='ui.notify' AND created_at > now() - interval '7 days'`, [deviceId])).rowCount) return false;
  return !!(await createSystemJob(db, signer, { orgId, deviceId, type: 'ui.notify', params: { template: 'storage-failing', evidence: bad.map(d => d.reason.slice(0, 190)).slice(0, 5) }, ttlMinutes: 24 * 60, source: { purpose: 'storage failing notice' } }));
}

/** Heat before and after the last physical cooling service (cleaning, fan, thermal paste), from real thermal records and confirmed service history. */
export async function coolingServiceEffect(db: Db, deviceId: string, now = new Date()) {
  const s = (await db.query(`SELECT occurred_at, service_type FROM service_events WHERE device_id=$1 AND status NOT IN ('PENDING_CONFIRMATION','DISMISSED') AND service_type IN ('physical cleaning','fan replacement','thermal paste replacement') ORDER BY occurred_at DESC LIMIT 1`, [deviceId])).rows[0];
  if (!s) return null;
  const at = new Date(s.occurred_at), before = new Date(at.getTime() - 30 * 86_400_000);
  const n = async (from: Date, to: Date) => (await db.query(`SELECT count(*)::int n FROM thermal_incidents WHERE device_id=$1 AND at >= $2 AND at < $3`, [deviceId, from, to])).rows[0].n as number;
  const daysSince = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  const last = (await db.query(`SELECT max(at) t FROM thermal_incidents WHERE device_id=$1 AND at >= $2`, [deviceId, at])).rows[0].t;
  return { service: s.service_type, at, heatEventsBefore30d: await n(before, at), heatEventsSince: await n(at, new Date(now.getTime() + 1)), daysSince, daysWithoutHeat: last ? Math.floor((now.getTime() - new Date(last).getTime()) / 86_400_000) : daysSince };
}

/**
 * The start-up manager's list: every program that starts with Windows, whether it is enabled, how Viro classifies it, and how many seconds Windows itself
 * measured it adding to the last start-up (when the boot log was readable). Classification is advice; the choice is always a person's.
 */
export function startupManager(snap: { startupItems?: { location: string; name: string; command?: string; enabled: boolean; cls: string; reason?: string }[]; boot?: { degrading?: { name: string; seconds: number }[] } | null } | null | undefined) {
  const deg = snap?.boot?.degrading ?? [];
  const delayOf = (n: string) => { const k = n.toLowerCase().replace(/\.exe$/, ''); return deg.find(d => { const x = d.name.toLowerCase(); return x.includes(k) || k.includes(x); })?.seconds ?? null; };
  return (snap?.startupItems ?? []).map(i => ({ ...i, delaySeconds: delayOf(i.name) })).sort((a, b) => Number(b.enabled) - Number(a.enabled) || (b.delaySeconds ?? 0) - (a.delaySeconds ?? 0) || a.name.localeCompare(b.name));
}

// ---- routes --------------------------------------------------------------------------------------------------
const EVENT_KINDS = ['thermal.heat', 'thermal.recovered', 'thermal.cooling-suspect', 'memory.trim', 'apps.closed', 'ui.heat-notice', 'ui.memory-notice', 'ui.battery-notice', 'ui.storage-notice', 'battery.sample', 'printer.fix', 'printer.failing'] as const;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function registerCareRoutes(app: FastifyInstance, c: JobCtx & { signer: any }) {
  const { db } = c;

  app.get('/agent/v1/care/policy', { preHandler: c.requireDevice }, async req => {
    const { id, orgId } = req.device!;
    const rows = (await db.query(`SELECT p.settings FROM policies p JOIN devices d ON d.id=$2 AND d.org_id=p.org_id WHERE p.org_id=$1 AND p.enabled AND (p.scope_type='org' OR (p.scope_type='site' AND d.site_id=p.scope_id) OR (p.scope_type='department' AND d.department_id=p.scope_id))`, [orgId, id])).rows;
    const level = rows.map(r => policyLevel(r.settings?.autoRepair)).sort((a, b) => LEVELS.indexOf(b) - LEVELS.indexOf(a))[0] ?? 'OBSERVE';
    const care = rows.map(r => r.settings?.care as CareSettings | undefined).find(x => x) ;
    return carePolicy(level, care);
  });

  app.post('/agent/v1/care/events', { preHandler: c.requireDevice }, async req => {
    const b = z.object({ events: z.array(z.object({ at: z.string().datetime({ offset: true }), kind: z.enum(EVENT_KINDS), data: z.record(z.string(), z.unknown()).default({}) })).max(300) }).parse(req.body);
    const { id, orgId } = req.device!; const now = Date.now();
    for (const e of b.events) {
      const at = new Date(Math.min(new Date(e.at).getTime(), now));       // a device clock in the future cannot back-date or forward-date records
      const d = e.data as any;
      if (e.kind === 'battery.sample') {
        await db.query(`INSERT INTO battery_samples(device_id,org_id,at,percent,on_battery,discharge_watts,remaining_wh,full_charge_wh,design_wh,health_percent,cycle_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
          [id, orgId, at, num(d.percent), typeof d.onBattery === 'boolean' ? d.onBattery : null, num(d.dischargeWatts), num(d.remainingWh), num(d.fullChargeWh), num(d.designWh), num(d.healthPercent), num(d.cycleCount)]);
        continue;
      }
      await db.query(`INSERT INTO care_events(org_id,device_id,at,kind,data) VALUES ($1,$2,$3,$4,$5)`, [orgId, id, at, e.kind, JSON.stringify(e.data)]);
      if (e.kind === 'thermal.heat' && (d.level === 'warning' || d.level === 'critical'))
        await db.query(`INSERT INTO thermal_incidents(org_id,device_id,at,level,temperature_c,load_percent,throttling_state,top_processes,compute_state,action_taken) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [orgId, id, at, d.level, num(d.tempC), num(d.cpuLoad), typeof d.gate === 'string' ? d.gate : null, JSON.stringify(Array.isArray(d.topProcesses) ? d.topProcesses.slice(0, 8) : []), d.computeRunning ? 'running' : 'stopped', typeof d.action === 'string' ? d.action.slice(0, 300) : null]);
      else if (e.kind === 'thermal.recovered') await db.query(`UPDATE thermal_incidents SET recovered_at=$2 WHERE id=(SELECT id FROM thermal_incidents WHERE device_id=$1 AND recovered_at IS NULL ORDER BY at DESC LIMIT 1)`, [id, at]);
      else if (e.kind === 'thermal.cooling-suspect') await db.query(`UPDATE thermal_incidents SET cooling_suspected=true WHERE id=(SELECT id FROM thermal_incidents WHERE device_id=$1 ORDER BY at DESC LIMIT 1)`, [id]);
    }
    return { ok: true, accepted: b.events.length };
  });

  /** What Viro did, per device: real records only. */
  app.get('/api/v1/devices/:id/care', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await db.query('SELECT 1 FROM devices WHERE id=$1 AND org_id=$2', [id, req.user.org])).rowCount) return reply.code(404).send({ error: 'not found' });
    const thermal = (await db.query(`SELECT id, at, level, temperature_c, load_percent, throttling_state, top_processes, compute_state, action_taken, recovered_at, cooling_suspected FROM thermal_incidents WHERE device_id=$1 ORDER BY at DESC LIMIT 20`, [id])).rows;
    const memory = (await db.query(`SELECT at, data FROM care_events WHERE device_id=$1 AND kind='memory.trim' ORDER BY at DESC LIMIT 20`, [id])).rows;
    const boots = (await db.query(`SELECT boot_at, seconds FROM boot_history WHERE device_id=$1 ORDER BY boot_at DESC LIMIT 20`, [id])).rows;
    const samples = (await db.query(`SELECT at, percent, on_battery, discharge_watts, full_charge_wh, design_wh, health_percent FROM battery_samples WHERE device_id=$1 AND at > now() - interval '30 days' ORDER BY at`, [id])).rows
      .map(r => ({ at: new Date(r.at), percent: r.percent, onBattery: r.on_battery, dischargeWatts: r.discharge_watts, fullChargeWh: r.full_charge_wh, designWh: r.design_wh, healthPercent: r.health_percent }));
    const diag = (await db.query(`SELECT finished_at, result FROM jobs WHERE device_id=$1 AND type='battery.diagnose' AND status='completed' ORDER BY finished_at DESC LIMIT 1`, [id])).rows[0];
    const last = samples[samples.length - 1];
    return {
      thermal, coolingService: await coolingServiceEffect(db, id), memory: memory.map(m => ({ at: m.at, ...m.data })), boots, bootComparison: await bootComparison(db, id),
      battery: samples.length ? { hasData: true, health: last?.healthPercent ?? null, fullChargeWh: last?.fullChargeWh ?? null, designWh: last?.designWh ?? null, percent: last?.percent ?? null, runtime: measuredRuntime(samples), samples: samples.length, diagnosedAt: diag?.finished_at ?? null, causes: diag ? rankBatteryDrain(diag.result) : [] }
        : { hasData: false, note: 'No battery readings yet (desktop PC, or the agent has not reported).' },
    };
  });

  app.post('/api/v1/devices/:id/battery/diagnose', { preHandler: c.requireRole('technician') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await db.query('SELECT 1 FROM devices WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL', [id, req.user.org])).rowCount) return reply.code(404).send({ error: 'not found' });
    const job = await createSystemJob(db, c.signer, { orgId: req.user.org, deviceId: id, type: 'battery.diagnose', params: {}, ttlMinutes: 120, source: { requestedBy: req.user.sub } });
    return reply.code(202).send({ jobId: job });
  });

  /** Organization outcomes from the care records (the figures are sums of real events). */
  app.get('/api/v1/care/overview', { preHandler: c.requireRole('viewer') }, async req => {
    const org = req.user.org;
    const one = async (sql: string, v: unknown[] = [org]) => (await db.query(sql, v)).rows[0];
    const heat = await one(`SELECT count(*)::int events, count(*) FILTER (WHERE level='critical')::int critical, count(DISTINCT device_id)::int devices, count(*) FILTER (WHERE cooling_suspected)::int suspected FROM thermal_incidents WHERE org_id=$1 AND at > now() - interval '30 days'`);
    const mem = await one(`SELECT count(*)::int runs, COALESCE(sum((data->>'reclaimedMb')::numeric),0)::int reclaimed_mb, count(DISTINCT device_id)::int devices FROM care_events WHERE org_id=$1 AND kind='memory.trim' AND at > now() - interval '30 days'`);
    const closed = await one(`SELECT COALESCE(sum(jsonb_array_length(COALESCE(data->'results','[]'::jsonb))),0)::int attempts FROM care_events WHERE org_id=$1 AND kind='apps.closed' AND at > now() - interval '30 days'`);
    const boot = (await db.query(`SELECT DISTINCT device_id FROM jobs WHERE org_id=$1 AND type='repair.run' AND status='completed' AND params->>'recipe'='startup.optimize' AND finished_at > now() - interval '90 days'`, [org])).rows;
    const comps = (await Promise.all(boot.map(b => bootComparison(db, b.device_id)))).filter((x): x is NonNullable<typeof x> => !!x && x.afterSeconds != null);
    const bat = await one(`SELECT count(DISTINCT device_id)::int devices, count(DISTINCT device_id) FILTER (WHERE health_percent < 70)::int degraded FROM (SELECT DISTINCT ON (device_id) device_id, health_percent FROM battery_samples WHERE org_id=$1 ORDER BY device_id, at DESC) x`);
    return {
      heat: { events30d: heat.events, critical: heat.critical, devices: heat.devices, coolingSuspected: heat.suspected },
      memory: { trims30d: mem.runs, reclaimedMb: mem.reclaimed_mb, devices: mem.devices, appCloseAttempts: closed.attempts },
      startup: { devicesMeasured: comps.length, avgSecondsSaved: comps.length ? Math.round(comps.reduce((n, x) => n + (x.beforeSeconds! - x.afterSeconds!), 0) / comps.length) : null, improved: comps.filter(x => (x.improvementPercent ?? 0) > 0).length },
      battery: { devicesReporting: bat.devices, degraded: bat.degraded },
    };
  });
}
