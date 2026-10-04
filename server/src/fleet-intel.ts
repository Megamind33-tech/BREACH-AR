import { createHash } from 'node:crypto';
import type { Db } from './db.js';

/**
 * Fleet intelligence. Turns per-computer incidents into fleet facts: the same problem on several computers, what those computers have in
 * common, and how the fleet is doing by site, department and model. A "common factor" is only reported when the affected computers share
 * it much more often than the fleet as a whole does, so "all of them are Windows 11" is not a finding.
 */
export interface DeviceFacts { id: string; hostname: string; model: string | null; manufacturer: string | null; osBuild: string | null; site: string | null; department: string | null; agentVersion: string | null }
export interface IncidentFacts { id: string; deviceId: string; code: string; title: string; status: string; impact: string; fix: any | null; recommendation: string | null; appVersion?: string | null; module?: string | null; cause?: string | null; driverDevice?: string | null }
export interface Factor { factor: string; value: string; affectedShare: number; fleetShare: number; lift: number; count: number }
export interface Pattern { signature: string; code: string; title: string; deviceIds: string[]; affected: number; fleetSize: number; factors: Factor[]; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; fix: { jobType: string; params: Record<string, unknown>; label: string } | null; recommendation: string | null; explanation: string }

const FACTORS: [keyof DeviceFacts | 'appVersion' | 'module' | 'cause' | 'driverDevice', string][] = [
  ['model', 'Model'], ['osBuild', 'Windows build'], ['site', 'Site'], ['department', 'Department'], ['agentVersion', 'Agent version'], ['appVersion', 'Application version'], ['module', 'Faulting module'], ['cause', 'Cause'], ['driverDevice', 'Device'],
];
export const FACTOR_LABEL = Object.fromEntries(FACTORS.map(([k, l]) => [k, l]));

export const minAffected = (fleet: number) => Math.max(3, Math.ceil(fleet * 0.1));

export function detectPatterns(devices: DeviceFacts[], incidents: IncidentFacts[]): Pattern[] {
  const fleet = devices.length; if (!fleet) return [];
  const byId = new Map(devices.map(d => [d.id, d]));
  const groups = new Map<string, IncidentFacts[]>();
  for (const i of incidents) { if (!byId.has(i.deviceId) || i.status === 'RESOLVED') continue; const l = groups.get(i.code) ?? []; l.push(i); groups.set(i.code, l); }
  const out: Pattern[] = [];
  for (const [code, list] of groups) {
    const ids = [...new Set(list.map(i => i.deviceId))];
    if (ids.length < minAffected(fleet)) continue;
    const rows = ids.map(id => ({ d: byId.get(id)!, i: list.find(x => x.deviceId === id)! }));
    const value = (r: (typeof rows)[number], f: string): string | null => f === 'appVersion' ? r.i.appVersion ?? null : f === 'module' ? r.i.module ?? null : f === 'cause' ? r.i.cause ?? null : f === 'driverDevice' ? r.i.driverDevice ?? null : ((r.d as any)[f] ?? null);
    const factors: Factor[] = [];
    for (const [f] of FACTORS) {
      const counts = new Map<string, number>(); for (const r of rows) { const v = value(r, f); if (v) counts.set(v, (counts.get(v) ?? 0) + 1); }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]; if (!top) continue;
      const [v, n] = top; const share = n / ids.length;
      const fleetShare = ['appVersion', 'module', 'cause', 'driverDevice'].includes(f) ? 0 : devices.filter(d => (d as any)[f] === v).length / fleet;   // incident-derived factors have no fleet baseline
      const lift = fleetShare > 0 ? share / fleetShare : share >= 0.7 ? 10 : 0;
      if (n >= 3 && share >= 0.7 && (fleetShare === 0 || lift >= 1.4) && (f !== 'site' || true)) factors.push({ factor: f, value: v, affectedShare: Math.round(share * 100) / 100, fleetShare: Math.round(fleetShare * 100) / 100, lift: Math.round(lift * 10) / 10, count: n });
    }
    // Attributes of the computers (model, Windows build, site...) are compared with the whole fleet. Attributes of the incident itself
    // (application version, faulting module, cause) have no fleet baseline and support the finding without deciding its confidence.
    const INCIDENT_FACTORS = ['appVersion', 'module', 'cause', 'driverDevice'];
    const rank = (a: Factor, b: Factor) => b.lift - a.lift || b.affectedShare - a.affectedShare;
    const deviceFactors = factors.filter(x => !INCIDENT_FACTORS.includes(x.factor)).sort(rank);
    const incidentFactors = factors.filter(x => INCIDENT_FACTORS.includes(x.factor)).sort(rank);
    factors.length = 0; factors.push(...deviceFactors.slice(0, 2), ...incidentFactors.slice(0, 2));
    const strong = deviceFactors[0] ?? incidentFactors[0];
    const confidence: Pattern['confidence'] = deviceFactors[0] && deviceFactors[0].lift >= 2 && deviceFactors[0].affectedShare >= 0.9 && ids.length >= 5 ? 'HIGH' : strong ? 'MEDIUM' : 'LOW';
    const fixes = list.map(i => i.fix).filter(Boolean);
    const fixKey = (f: any) => JSON.stringify([f.jobType, f.params]);
    const common = fixes.length >= Math.ceil(list.length * 0.8) ? fixes.find(f => fixes.filter(g => fixKey(g) === fixKey(f)).length === fixes.length) ?? null : null;
    const title = list[0].title.replace(/^(.*) keeps crashing$/, '$1 keeps crashing');
    const sig = createHash('sha256').update(`${code}|${factors.slice(0, 2).map(f => `${f.factor}=${f.value}`).join('|')}`).digest('hex').slice(0, 24);
    out.push({
      signature: sig, code, title, deviceIds: ids, affected: ids.length, fleetSize: fleet, factors, confidence, fix: common ? { jobType: common.jobType, params: common.params, label: common.label } : null,
      recommendation: list[0].recommendation,
      explanation: strong
        ? `${ids.length} of ${fleet} computers have "${title}". ${Math.round(strong.affectedShare * 100)}% of them share ${FACTOR_LABEL[strong.factor as keyof typeof FACTOR_LABEL]?.toLowerCase()} "${strong.value}", which only ${Math.round(strong.fleetShare * 100)}% of the fleet does.`.replace(' which only 0% of the fleet does', '')
        : `${ids.length} of ${fleet} computers have "${title}", but no single shared factor stands out.`,
    });
  }
  return out.sort((a, b) => b.affected - a.affected);
}

/** Loads the facts detectPatterns needs from the database. */
export async function loadFleetFacts(db: Db, orgId: string): Promise<{ devices: DeviceFacts[]; incidents: IncidentFacts[] }> {
  const d = await db.query(
    `SELECT d.id, d.hostname, d.os_build, d.agent_version, s.name AS site, dp.name AS department, i.hardware->>'model' AS model, i.hardware->>'manufacturer' AS manufacturer
       FROM devices d LEFT JOIN sites s ON s.id=d.site_id LEFT JOIN departments dp ON dp.id=d.department_id LEFT JOIN device_inventory i ON i.device_id=d.id
      WHERE d.org_id=$1 AND d.revoked_at IS NULL`, [orgId]);
  const inc = await db.query(`SELECT id, device_id, code, title, status, impact, fix, recommendation FROM incidents WHERE org_id=$1 AND status <> 'RESOLVED'`, [orgId]);
  const ev = inc.rowCount ? (await db.query(`SELECT DISTINCT ON (incident_id, type) incident_id, type, value FROM incident_evidence WHERE incident_id = ANY($1::uuid[]) AND type IN ('EVENT_LOG','TELEMETRY') ORDER BY incident_id, type, observed_at DESC`, [inc.rows.map(r => r.id)])).rows : [];
  const evOf = (id: string, type: string) => ev.find(e => e.incident_id === id && e.type === type)?.value ?? null;
  return {
    devices: d.rows.map(r => ({ id: r.id, hostname: r.hostname, model: r.model, manufacturer: r.manufacturer, osBuild: r.os_build, site: r.site, department: r.department, agentVersion: r.agent_version })),
    incidents: inc.rows.map(r => {
      const log = evOf(r.id, 'EVENT_LOG'), tel = evOf(r.id, 'TELEMETRY');
      const first = Array.isArray(log?.crashes) ? log.crashes[0] : null;
      const errs = Array.isArray(log?.errors) ? log.errors : null;
      return { id: r.id, deviceId: r.device_id, code: r.code, title: r.title, status: r.status, impact: r.impact, fix: r.fix, recommendation: r.recommendation,
        appVersion: first?.appVersion ?? null, module: first?.module ?? null, cause: tel?.cause ?? null, driverDevice: errs?.[0]?.name ?? null };
    }),
  };
}

/** Detects patterns and keeps them in fleet_patterns so their status (remediating, flagged) survives between looks. */
export async function syncPatterns(db: Db, orgId: string): Promise<(Pattern & { id: string; status: string; firstDetected: string })[]> {
  const { devices, incidents } = await loadFleetFacts(db, orgId);
  const found = detectPatterns(devices, incidents);
  const out: (Pattern & { id: string; status: string; firstDetected: string })[] = [];
  for (const p of found) {
    const r = await db.query(
      `INSERT INTO fleet_patterns(org_id,signature,code,title,factors,device_ids,affected,fleet_size,confidence,fix,last_detected) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (org_id, signature) DO UPDATE SET title=EXCLUDED.title, factors=EXCLUDED.factors, device_ids=EXCLUDED.device_ids, affected=EXCLUDED.affected, fleet_size=EXCLUDED.fleet_size, confidence=EXCLUDED.confidence, fix=EXCLUDED.fix, last_detected=now(),
         status = CASE WHEN fleet_patterns.status IN ('REMEDIATED','DISMISSED') AND fleet_patterns.last_detected < now() - interval '1 day' THEN 'DETECTED' ELSE fleet_patterns.status END
       RETURNING id, status, first_detected`,
      [orgId, p.signature, p.code, p.title, JSON.stringify(p.factors), p.deviceIds, p.affected, p.fleetSize, p.confidence, p.fix ? JSON.stringify(p.fix) : null]);
    out.push({ ...p, id: r.rows[0].id, status: r.rows[0].status, firstDetected: r.rows[0].first_detected });
  }
  return out.filter(p => p.status !== 'DISMISSED');
}

/* ------------------------------------------------------------------------------------------------------------------------------
 * Breakdown by site, department, model, Windows build
 * ---------------------------------------------------------------------------------------------------------------------------- */
export type GroupBy = 'site' | 'department' | 'model' | 'os';
export async function breakdown(db: Db, orgId: string, by: GroupBy) {
  const key = by === 'site' ? `COALESCE(s.name,'No site')` : by === 'department' ? `COALESCE(s.name || ' / ' || dp.name, s.name, 'No department')` : by === 'model' ? `COALESCE(i.hardware->>'model','Unknown model')` : `COALESCE(d.os_caption || ' (build ' || d.os_build || ')', 'Unknown Windows')`;
  const r = await db.query(
    `SELECT ${key} AS grp, count(*)::int AS devices,
            round(avg((SELECT overall FROM device_health_history h WHERE h.device_id=d.id ORDER BY h.id DESC LIMIT 1))::numeric, 0)::int AS avg_health,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM incidents x WHERE x.device_id=d.id AND x.status <> 'RESOLVED' AND x.impact IN ('high','medium')))::int AS with_problems,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM incidents x WHERE x.device_id=d.id AND x.status = 'HARDWARE_ACTION_REQUIRED'))::int AS hardware_action,
            0 AS unused
       FROM devices d LEFT JOIN sites s ON s.id=d.site_id LEFT JOIN departments dp ON dp.id=d.department_id LEFT JOIN device_inventory i ON i.device_id=d.id
      WHERE d.org_id=$1 AND d.revoked_at IS NULL GROUP BY grp ORDER BY with_problems DESC, devices DESC`, [orgId]);
  return r.rows.map(x => ({ group: x.grp as string, devices: x.devices as number, averageHealth: x.avg_health as number | null, withProblems: x.with_problems as number, hardwareAction: x.hardware_action as number }));
}

/* ------------------------------------------------------------------------------------------------------------------------------
 * KPIs (directive 70). Every figure is a ratio of recorded events; a ratio with no denominator is null, not zero.
 * ---------------------------------------------------------------------------------------------------------------------------- */
export async function kpis(db: Db, orgId: string, since: Date) {
  const q = async (sql: string) => (await db.query(sql, [orgId, since])).rows[0];
  const repaired = await q(`SELECT count(*)::int n FROM incidents WHERE org_id=$1 AND repaired_at >= $2`);
  const verified = await q(`SELECT count(*)::int n FROM incidents WHERE org_id=$1 AND resolution='viro-repair' AND resolved_at >= $2`);
  const reopened = await q(`SELECT count(*)::int n FROM incidents WHERE org_id=$1 AND recurrence_count > 0 AND last_detected >= $2 AND repaired_at IS NOT NULL`);
  const auto = await q(`SELECT count(DISTINCT i.id)::int n FROM incidents i JOIN incident_actions a ON a.incident_id=i.id AND a.kind='repair' AND a.by='autopilot' WHERE i.org_id=$1 AND i.resolution='viro-repair' AND i.resolved_at >= $2`);
  const eligible = await q(`SELECT count(*)::int n FROM incidents WHERE org_id=$1 AND first_detected >= $2 AND fix IS NOT NULL`);
  const mtth = await q(`SELECT avg(extract(epoch FROM (resolved_at - first_detected)) / 3600)::float8 h FROM incidents WHERE org_id=$1 AND resolution='viro-repair' AND resolved_at >= $2`);
  const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
  return {
    repairAttempts: repaired.n, verifiedFixes: verified.n, verifiedFixRate: rate(verified.n, repaired.n),
    recurrenceRate: rate(reopened.n, verified.n + reopened.n), automaticResolutionRate: rate(auto.n, eligible.n),
    meanTimeToHealthHours: mtth.h == null ? null : Math.round(mtth.h * 10) / 10,
  };
}
