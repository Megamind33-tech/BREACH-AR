import type { Db } from './db.js';
import { HEAVY_RECIPES, autoAllowed, inWindow, policyLevel, type Level, type Settings } from './policies.js';

/**
 * What Autopilot is doing about each open problem, in priority order. The order follows the product's rule of what matters most:
 * safety, data protection, stability, security, everyday performance, storage, updates, drivers, then preventive maintenance.
 */
export const PRIORITIES = ['Safety', 'Data protection', 'Stability', 'Security', 'Performance', 'Storage', 'Updates', 'Drivers', 'Preventive'] as const;

export function priorityOf(code: string): { rank: number; label: (typeof PRIORITIES)[number] } {
  const at = (i: number) => ({ rank: i + 1, label: PRIORITIES[i] });
  if (code.startsWith('security.active_threat')) return at(0);
  if (/^(hw\.storage|hardware\.disk|hardware\.hdd|hw\.disk)/.test(code)) return at(1);
  if (code.startsWith('stability.app:') || code.startsWith('reliability.')) return at(2);
  if (code.startsWith('security.')) return at(3);
  if (code.startsWith('storage.')) return at(5);
  if (code.startsWith('updates.')) return at(6);
  if (code.startsWith('drivers.')) return at(7);
  if (code.startsWith('preventive.')) return at(8);
  return at(4);
}

export type Stance = 'working' | 'observing' | 'will-fix' | 'waiting-window' | 'diagnosing' | 'needs-hardware' | 'needs-user' | 'needs-admin';

export function stanceOf(inc: { status: string; fix: any; code: string }, level: Level, windowOk: boolean): { stance: Stance; note: string } {
  switch (inc.status) {
    case 'REPAIRING': case 'VERIFYING': return { stance: 'working', note: inc.status === 'REPAIRING' ? 'Repair in progress.' : 'Checking that the repair worked.' };
    case 'OBSERVING': return { stance: 'observing', note: 'Repaired and checked; watching to make sure it does not come back.' };
    case 'HARDWARE_ACTION_REQUIRED': return { stance: 'needs-hardware', note: 'Software cannot fix this; a hardware repair is needed.' };
    case 'USER_ACTION_REQUIRED': return { stance: 'needs-user', note: 'Needs someone to act; there is no automatic repair.' };
    case 'UNRESOLVED': case 'IMPROVED': case 'ADMIN_APPROVAL_REQUIRED': return { stance: 'needs-admin', note: inc.status === 'UNRESOLVED' ? 'The repair did not work; Autopilot has stopped and needs a decision.' : inc.status === 'IMPROVED' ? 'The repair helped but did not fully fix it.' : 'Needs an administrator to approve a repair.' };
    case 'REPAIR_READY':
      if (level === 'OBSERVE') return { stance: 'needs-admin', note: 'Autopilot is set to observe only, so it will not repair this by itself.' };
      if (!inc.fix || !autoAllowed(inc.fix, level)) return { stance: 'needs-admin', note: `This repair needs approval at Autopilot level ${level.toLowerCase()}.` };
      if (inc.fix.jobType === 'repair.run' && HEAVY_RECIPES.has(String(inc.fix.params?.recipe)) && !windowOk) return { stance: 'waiting-window', note: 'Autopilot will run this repair in the next maintenance window.' };
      return { stance: 'will-fix', note: 'Autopilot will repair this at the next health report.' };
    default: return { stance: 'diagnosing', note: 'Viro is gathering evidence.' };
  }
}

export async function autopilotContext(db: Db, orgId: string, now = new Date()) {
  const p = (await db.query(`SELECT enabled, settings FROM policies WHERE org_id=$1 AND name='Autopilot'`, [orgId])).rows[0];
  const off = (await db.query('SELECT utc_offset_minutes FROM organizations WHERE id=$1', [orgId])).rows[0]?.utc_offset_minutes ?? 0;
  const settings = p?.settings as Settings | undefined;
  const level: Level = p?.enabled ? policyLevel(settings?.autoRepair) : 'OBSERVE';
  return { level, exists: !!p, enabled: !!p?.enabled, windowOk: inWindow(now, off, settings?.maintenanceWindow) };
}

const IMPACT_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Every open problem with Autopilot's stance, sorted by priority then impact. */
export async function activity(db: Db, orgId: string, now = new Date()) {
  const ctx = await autopilotContext(db, orgId, now);
  const rows = (await db.query(
    `SELECT i.id, i.device_id, d.hostname, i.code, i.title, i.status, i.impact, i.fix, i.recommendation, i.root_cause, i.recurrence_count, i.observation_until, i.last_detected
       FROM incidents i JOIN devices d ON d.id=i.device_id WHERE i.org_id=$1 AND i.status <> 'RESOLVED' AND d.revoked_at IS NULL`, [orgId])).rows;
  const items = rows.map(r => {
    const pr = priorityOf(r.code), st = stanceOf(r, ctx.level, ctx.windowOk);
    return { incidentId: r.id, deviceId: r.device_id, hostname: r.hostname, code: r.code, title: r.title, status: r.status, impact: r.impact, priority: pr.label, priorityRank: pr.rank, stance: st.stance, note: st.note,
      rootCause: r.root_cause, nextStep: r.recommendation, canFix: !!r.fix, recurrenceCount: r.recurrence_count, observationUntil: r.observation_until };
  }).sort((a, b) => a.priorityRank - b.priorityRank || IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact]);
  const by = (s: Stance[]) => items.filter(i => s.includes(i.stance));
  return { level: ctx.level, enabled: ctx.enabled, inMaintenanceWindow: ctx.windowOk, working: by(['working']), observing: by(['observing']), willFix: by(['will-fix']), waiting: by(['waiting-window']),
    needsYou: by(['needs-hardware', 'needs-user', 'needs-admin']), diagnosing: by(['diagnosing']), counts: { open: items.length } };
}
