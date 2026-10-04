import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { HealthResult, Snapshot } from './health.js';
import type { JobCtx } from './jobs.js';
import { CONTROLS, protectionOf } from './protection.js';
import { measuredRuntime, bootComparison } from './care.js';
import { deviceTimeline } from './outcomes.js';
import { policyLevel } from './policies.js';

/**
 * What the person at the PC sees in the Viro window: this one computer's whole picture, from the same engine the administrator console uses. It is read-only,
 * limited to the calling device, and plain-language; nothing in it can be used to change another computer or any organization setting.
 */
interface Deps { healthOf: (orgId: string, deviceId: string) => Promise<{ snap: Snapshot; h: HealthResult } | null> }
const LEVELS = ['OBSERVE', 'SAFE', 'BALANCED', 'AGGRESSIVE'];

export async function selfView(db: Db, deps: Deps, orgId: string, deviceId: string) {
  const dev = (await db.query('SELECT d.hostname, o.name AS org_name, s.name AS site_name, dp.name AS dept_name FROM devices d JOIN organizations o ON o.id=d.org_id LEFT JOIN sites s ON s.id=d.site_id LEFT JOIN departments dp ON dp.id=d.department_id WHERE d.id=$1 AND d.org_id=$2', [deviceId, orgId])).rows[0];
  const policies = (await db.query(`SELECT p.settings FROM policies p JOIN devices d ON d.id=$2 AND d.org_id=p.org_id WHERE p.org_id=$1 AND p.enabled AND (p.scope_type='org' OR (p.scope_type='site' AND d.site_id=p.scope_id) OR (p.scope_type='department' AND d.department_id=p.scope_id))`, [orgId, deviceId])).rows;
  const level = policies.map(r => policyLevel(r.settings?.autoRepair)).sort((a, b) => LEVELS.indexOf(b) - LEVELS.indexOf(a))[0] ?? 'OBSERVE';
  const hx = await deps.healthOf(orgId, deviceId);
  const out: Record<string, unknown> = { hostname: dev?.hostname ?? null, workspace: { organization: dev?.org_name ?? null, site: dev?.site_name ?? null, department: dev?.dept_name ?? null }, autopilotLevel: level, generatedAt: new Date().toISOString(), hasHealth: !!hx };
  if (!hx) return out;
  const { snap, h } = hx;

  out.health = {
    overall: h.overall, status: h.status, categories: h.categories, measured: h.measured, notMeasured: h.notMeasured.slice(0, 12),
    findings: h.deductions.filter(d => d.points > 0).sort((a, b) => b.points - a.points).slice(0, 16).map(d => ({ code: d.code, category: d.category, impact: d.impact, reason: d.reason, remedy: d.remedy, recommendation: d.recommendation ?? null, fix: d.fix ? { label: d.fix.label, recipe: d.fix.jobType === 'repair.run' ? String((d.fix.params as any)?.recipe ?? '') : d.fix.jobType } : null })),
  };
  out.shield = h.shield;
  const prot = protectionOf(snap as any);
  out.protection = { score: prot.score, controls: prot.controls.map(c => { const m = CONTROLS.find(x => x.id === c.id)!; return { id: c.id, group: c.group, title: m.title, why: m.why, state: c.state, recipe: m.recipe }; }) };
  out.securityIncidents = (await db.query(`SELECT threat_name, threat_type, status, detected_at, verification_status FROM security_incidents WHERE device_id=$1 AND org_id=$2 ORDER BY created_at DESC LIMIT 5`, [deviceId, orgId])).rows;

  const samples = (await db.query(`SELECT at, percent, on_battery, discharge_watts, full_charge_wh, design_wh, health_percent FROM battery_samples WHERE device_id=$1 AND at > now() - interval '30 days' ORDER BY at`, [deviceId])).rows
    .map(r => ({ at: new Date(r.at), percent: r.percent, onBattery: r.on_battery, dischargeWatts: r.discharge_watts, fullChargeWh: r.full_charge_wh, designWh: r.design_wh, healthPercent: r.health_percent }));
  const last = samples[samples.length - 1];
  const care = (snap as any).care ?? {};
  out.care = {
    thermal: care.thermal ?? null, memory: care.memory ?? null,
    battery: last ? { percent: last.percent, onBattery: last.onBattery, healthPercent: last.healthPercent, fullChargeWh: last.fullChargeWh, designWh: last.designWh, runtime: measuredRuntime(samples) } : null,
    heatEvents30d: (await db.query(`SELECT count(*)::int n FROM thermal_incidents WHERE device_id=$1 AND at > now() - interval '30 days'`, [deviceId])).rows[0].n,
    boot: { last: (snap as any).boot?.lastBootSeconds ?? null, history: (await db.query(`SELECT boot_at, seconds FROM boot_history WHERE device_id=$1 ORDER BY boot_at DESC LIMIT 12`, [deviceId])).rows.reverse().map(r => ({ at: r.boot_at, seconds: r.seconds })), comparison: await bootComparison(db, deviceId), slowest: ((snap as any).boot?.degrading ?? []).slice(0, 5) },
  };
  out.updates = { pending: snap.updates?.pendingCount ?? null, critical: snap.updates?.pendingCriticalCount ?? null, rebootRequired: snap.updates?.rebootRequired ?? null, driverErrors: (snap.driverErrors ?? []).length };
  out.recent = (await deviceTimeline(db, orgId, deviceId, 30)).slice(0, 15);
  return out;
}

export function registerSelfRoutes(app: FastifyInstance, c: JobCtx, deps: Deps) {
  app.get('/agent/v1/self', { preHandler: c.requireDevice }, async req => { const { id, orgId } = req.device!; return selfView(c.db, deps, orgId, id); });
}
