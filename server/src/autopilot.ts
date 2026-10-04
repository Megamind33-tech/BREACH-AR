import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { JobCtx } from './jobs.js';
import { policyLevel, validateSettings, type Settings } from './policies.js';
import { activity } from './autopilot-brain.js';

/**
 * Autopilot: the default operating mode for an organization. It is an ordinary policy named "Autopilot" (org scope), so everything it
 * does is visible, audited and can be tuned or switched off; there is no hidden behaviour. It keeps every PC healthy without anyone
 * having to open the console: health and hardware checks, security and Windows updates inside the maintenance window with a visible
 * restart countdown, safe automatic repairs, and staged driver rollouts that finish on their own.
 *
 * What it will NOT do on its own, by design: delete personal data (REVIEW cleanup classes), start a remote session, or change
 * anything that needs judgement (those become one clear item on the "needs attention" list).
 */
export const AUTOPILOT_NAME = 'Autopilot';
export interface AutopilotWindow { days: number[]; start: string; end: string }
export const DEFAULT_WINDOW: AutopilotWindow = { days: [0, 1, 2, 3, 4, 5, 6], start: '01:00', end: '05:00' };

export function autopilotSettings(window: AutopilotWindow = DEFAULT_WINDOW, opts: { driverAutoStart?: boolean; level?: 'OBSERVE' | 'SAFE' | 'BALANCED' | 'AGGRESSIVE' } = {}): Settings {
  const level = opts.level ?? 'BALANCED';
  const v = validateSettings({
    schedules: [
      { key: 'health', type: 'health.check', params: {}, everyMinutes: 60 },
      { key: 'security-daily', type: 'security.status', params: {}, everyMinutes: 24 * 60 },
      { key: 'updates-scan', type: 'updates.scan', params: {}, everyMinutes: 12 * 60 },
      { key: 'benchmark', type: 'benchmark.run', params: {}, everyMinutes: 7 * 24 * 60 },   // first run right after enrollment = the device baseline
      { key: 'security-updates', type: 'updates.install', params: { scope: 'security' }, weekly: { days: window.days, time: window.start }, windowOnly: true },
      { key: 'safe-cleanup', type: 'repair.run', params: { recipe: 'cleanup.safe' }, weekly: { days: [0], time: window.start }, windowOnly: true },
      { key: 'hardware-weekly', type: 'hardware.diagnose', params: {}, weekly: { days: [0], time: window.start }, windowOnly: true },
    ],
    maintenanceWindow: window,
    autoRepair: { failedServices: true, safeCleanup: true, safeFixes: true, driverRollouts: true, driverAutoStart: !!opts.driverAutoStart, level2: level === 'BALANCED' || level === 'AGGRESSIVE', level },
    restartAfterUpdates: 'auto',
  });
  if (!v.ok) throw new Error('autopilot settings invalid: ' + v.error);
  return v.settings;
}

/** Plain-language list of what Autopilot does, shown in the console. Kept next to the settings so the two cannot drift apart. */
export function describeAutopilot(window: AutopilotWindow): string[] {
  const days = window.days.length === 7 ? 'every night' : `on ${window.days.map(d => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d]).join(', ')}`;
  return [
    'Checks every PC’s health every hour and its hardware weekly, and tells you only when something needs you.',
    `Installs security updates ${days} between ${window.start} and ${window.end} (local time), and restarts the PC afterwards with a 10-minute on-screen countdown so people can save their work.`,
    'Fixes safe problems by itself and checks the fix worked: stopped services, a full system drive (temporary files only), out-of-date virus definitions.',
    'Rolls out driver updates carefully: one PC first, then a pilot group, then everyone, and stops and rolls back if anything gets worse.',
    'Never deletes personal files, never opens a remote session without a visible request, and never installs anything that needs a decision without asking.',
  ];
}

export async function ensureAutopilot(db: Db, orgId: string, actor: { id?: string } = {}): Promise<{ id: string; created: boolean }> {
  const ex = await db.query(`SELECT id FROM policies WHERE org_id=$1 AND name=$2`, [orgId, AUTOPILOT_NAME]);
  if (ex.rowCount) return { id: ex.rows[0].id, created: false };
  const r = await db.query(
    `INSERT INTO policies(org_id,name,description,enabled,scope_type,settings,created_by) VALUES ($1,$2,$3,true,'org',$4,$5) RETURNING id`,
    [orgId, AUTOPILOT_NAME, 'Recommended defaults: the PCs look after themselves.', JSON.stringify(autopilotSettings()), actor.id ?? null]);
  return { id: r.rows[0].id, created: true };
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export function registerAutopilotRoutes(app: FastifyInstance, c: JobCtx) {
  const { db } = c;

  async function state(orgId: string) {
    const p = await db.query(`SELECT id, enabled, settings FROM policies WHERE org_id=$1 AND name=$2`, [orgId, AUTOPILOT_NAME]);
    if (!p.rowCount) return { exists: false, enabled: false, level: 'OBSERVE', window: DEFAULT_WINDOW, does: describeAutopilot(DEFAULT_WINDOW), recent: [], counts: { last7Days: 0 } };
    const window = (p.rows[0].settings as Settings).maintenanceWindow ?? DEFAULT_WINDOW;
    // Jobs remember which policy created them in the audit trail entry written at creation.
    const made = `FROM audit_log a JOIN jobs j ON j.id = (a.next->>'jobId')::uuid JOIN devices d ON d.id=j.device_id WHERE a.org_id=$1 AND a.action='job.create' AND a.next->>'policyId'=$2`;
    const recent = await db.query(
      `SELECT j.id, j.type, j.status, j.created_at, j.finished_at, j.params, d.hostname, left(COALESCE(j.result->>'summary', j.error, ''), 200) AS outcome ${made}
          AND j.type NOT IN ('health.check','security.status','updates.scan') ORDER BY j.created_at DESC LIMIT 15`, [orgId, p.rows[0].id]);
    const n = await db.query(`SELECT count(*)::int n ${made} AND j.status='completed' AND j.created_at > now() - interval '7 days'`, [orgId, p.rows[0].id]);
    return { exists: true, enabled: p.rows[0].enabled as boolean, driverAutoStart: !!(p.rows[0].settings as Settings).autoRepair?.driverAutoStart, level: policyLevel((p.rows[0].settings as Settings).autoRepair), window, does: describeAutopilot(window), recent: recent.rows, counts: { last7Days: n.rows[0].n } };
  }

  app.get('/api/v1/autopilot', { preHandler: c.requireRole('viewer') }, async req => state(req.user.org));

  /** What Autopilot is working on, what it will do next, and what needs a person, in priority order. */
  app.get('/api/v1/autopilot/activity', { preHandler: c.requireRole('viewer') }, async req => activity(db, req.user.org));

  app.put('/api/v1/autopilot', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const b = z.object({
      enabled: z.boolean().optional(), driverAutoStart: z.boolean().optional(), level: z.enum(['OBSERVE', 'SAFE', 'BALANCED', 'AGGRESSIVE']).optional(),
      window: z.object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: hhmm, end: hhmm }).strict().optional(),
    }).strict().parse(req.body);
    const { id } = await ensureAutopilot(db, req.user.org, { id: req.user.sub });
    const before = await db.query('SELECT enabled, settings FROM policies WHERE id=$1', [id]);
    const cur = before.rows[0].settings as Settings;
    const settings = (b.window || b.driverAutoStart !== undefined || b.level)
      ? autopilotSettings(b.window ?? cur.maintenanceWindow ?? DEFAULT_WINDOW, { driverAutoStart: b.driverAutoStart ?? cur.autoRepair?.driverAutoStart, level: b.level ?? policyLevel(cur.autoRepair) })
      : cur;
    await db.query(`UPDATE policies SET enabled=COALESCE($2,enabled), settings=$3, updated_at=now() WHERE id=$1`, [id, b.enabled ?? null, JSON.stringify(settings)]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'autopilot.update', targetType: 'policy', targetId: id, previous: { enabled: before.rows[0].enabled }, next: b });
    return reply.send(await state(req.user.org));
  });
}
