import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import { JOB_TYPES, createSystemJob, type JobCtx, type JobSigner } from './jobs.js';
import { SAFE_CLEAN_IDS, REPAIR_RECIPES, type Fix } from './catalog.js';
import { attachRepairJob } from './incidents.js';

/* ------------------------------------------------------------------------------------------------
 * Policy model. A policy applies to an org, a site, a department or a tag and contains:
 *  - schedules: recurring jobs (every N minutes, or weekly at a local time), optionally only inside the maintenance window
 *  - maintenanceWindow: when disruptive work is allowed (local time of the organization)
 *  - autoRepair: reactions to health findings (restart failed services, safe cleanup)
 * ---------------------------------------------------------------------------------------------- */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dow = z.number().int().min(0).max(6);

const Schedule = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,40}$/),
  type: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  everyMinutes: z.number().int().min(5).max(60 * 24 * 30).optional(),
  weekly: z.object({ days: z.array(dow).min(1).max(7), time: hhmm }).strict().optional(),
  windowOnly: z.boolean().optional(),
}).strict().refine(s => (s.everyMinutes != null) !== (s.weekly != null), { message: 'a schedule needs exactly one of everyMinutes or weekly' });

export const MaintenanceWindow = z.object({ days: z.array(dow).min(1).max(7), start: hhmm, end: hhmm }).strict();
export const PolicySettings = z.object({
  schedules: z.array(Schedule).max(30).default([]),
  maintenanceWindow: MaintenanceWindow.optional(),
  autoRepair: z.object({ failedServices: z.boolean().optional(), safeCleanup: z.boolean().optional(), safeFixes: z.boolean().optional(), driverRollouts: z.boolean().optional(), driverAutoStart: z.boolean().optional(), level2: z.boolean().optional(), level: z.enum(['OBSERVE', 'SAFE', 'BALANCED', 'AGGRESSIVE']).optional() }).strict().optional(),
  restartAfterUpdates: z.enum(['ask', 'auto', 'never']).optional(),
  care: z.object({ ramTargetPercent: z.number().int().min(30).max(90).optional(), thermalWarningC: z.number().int().min(60).max(95).optional(), popups: z.boolean().optional() }).strict().optional(),
}).strict();
export type Settings = z.infer<typeof PolicySettings>;
export type ScheduleT = z.infer<typeof Schedule>;

/** Schedules can only use catalogued job types with valid params (so a policy can never do more than an admin could). */
export function validateSettings(raw: unknown): { ok: true; settings: Settings } | { ok: false; error: string } {
  const p = PolicySettings.safeParse(raw);
  if (!p.success) return { ok: false, error: p.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const keys = new Set<string>();
  for (const s of p.data.schedules) {
    if (keys.has(s.key)) return { ok: false, error: `duplicate schedule key "${s.key}"` };
    keys.add(s.key);
    const def = JOB_TYPES[s.type];
    if (!def || def.internalOnly || def.schedulable === false || s.type === 'repair.rollback') return { ok: false, error: `schedule "${s.key}": job type "${s.type}" cannot be scheduled` };
    const r = def.params.safeParse(s.params);
    if (!r.success) return { ok: false, error: `schedule "${s.key}": ${r.error.issues.map(i => i.message).join('; ')}` };
  }
  return { ok: true, settings: p.data };
}

/* ------------------------------------------------------------------------------------------------
 * Time logic (pure, unit-tested). All "local" times use the organization's fixed UTC offset.
 * ---------------------------------------------------------------------------------------------- */
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const local = (now: Date, offsetMin: number) => new Date(now.getTime() + offsetMin * 60_000);

export function inWindow(now: Date, offsetMin: number, w?: z.infer<typeof MaintenanceWindow>): boolean {
  if (!w) return true;
  const t = local(now, offsetMin), day = t.getUTCDay(), m = t.getUTCHours() * 60 + t.getUTCMinutes();
  const s = toMin(w.start), e = toMin(w.end);
  if (s === e) return w.days.includes(day);                     // whole day
  if (s < e) return w.days.includes(day) && m >= s && m < e;
  return (w.days.includes(day) && m >= s) || (w.days.includes((day + 6) % 7) && m < e); // wraps past midnight
}

/** Most recent time (UTC) at or before `now` that matches a weekly schedule; null if none in the last 8 days. */
export function lastWeeklyOccurrence(now: Date, offsetMin: number, days: number[], time: string): Date | null {
  const t = local(now, offsetMin);
  for (let back = 0; back <= 7; back++) {
    const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - back, Math.floor(toMin(time) / 60), toMin(time) % 60));
    if (!days.includes(d.getUTCDay())) continue;
    const utc = new Date(d.getTime() - offsetMin * 60_000);
    if (utc.getTime() <= now.getTime()) return utc;
  }
  return null;
}

export function isDue(s: ScheduleT, lastRun: Date | null, policyCreatedAt: Date, now: Date, offsetMin: number): boolean {
  if (s.everyMinutes != null) return !lastRun || now.getTime() - lastRun.getTime() >= s.everyMinutes * 60_000;
  const occ = lastWeeklyOccurrence(now, offsetMin, s.weekly!.days, s.weekly!.time);
  if (!occ) return false;
  return occ.getTime() > (lastRun ?? policyCreatedAt).getTime();
}

/* ------------------------------------------------------------------------------------------------
 * Scheduler: turns due schedules into signed jobs. Idempotent per tick; safe to run on several servers
 * because policy_runs is updated in the same statement path (worst case: one duplicate that the open-job check absorbs).
 * ---------------------------------------------------------------------------------------------- */
const SCOPE_SQL = `(p.scope_type='org' OR (p.scope_type='site' AND d.site_id=p.scope_id) OR (p.scope_type='department' AND d.department_id=p.scope_id) OR (p.scope_type='tag' AND p.scope_tag = ANY(d.tags)))`;
const MAX_JOBS_PER_TICK = 2000;

export async function schedulerTick(db: Db, signer: JobSigner, now = new Date()): Promise<number> {
  const pols = await db.query(`SELECT p.id, p.org_id, p.settings, p.created_at, o.utc_offset_minutes FROM policies p JOIN organizations o ON o.id=p.org_id WHERE p.enabled`);
  let created = 0;
  for (const pol of pols.rows) {
    const v = validateSettings(pol.settings);
    if (!v.ok || !v.settings.schedules.length) continue;
    const off = pol.utc_offset_minutes as number;
    const devs = (await db.query(`SELECT d.id FROM policies p JOIN devices d ON d.org_id=p.org_id AND d.revoked_at IS NULL WHERE p.id=$1 AND ${SCOPE_SQL}`, [pol.id])).rows.map(r => r.id as string);
    if (!devs.length) continue;
    const runs = await db.query('SELECT schedule_key, device_id, last_run_at FROM policy_runs WHERE policy_id=$1', [pol.id]);
    const last = new Map(runs.rows.map(r => [`${r.schedule_key}|${r.device_id}`, new Date(r.last_run_at)]));
    const open = await db.query(`SELECT device_id, type FROM jobs WHERE org_id=$1 AND status IN ('queued','running')`, [pol.org_id]);
    const openSet = new Set(open.rows.map(r => `${r.device_id}|${r.type}`));
    for (const s of v.settings.schedules) {
      if (s.windowOnly && !inWindow(now, off, v.settings.maintenanceWindow)) continue;
      for (const dev of devs) {
        if (created >= MAX_JOBS_PER_TICK) return created;
        if (!isDue(s, last.get(`${s.key}|${dev}`) ?? null, new Date(pol.created_at), now, off)) continue;
        if (openSet.has(`${dev}|${s.type}`)) continue;                 // never pile up the same job on a device
        // windowOnly jobs are created right at the start of the maintenance window (often overnight), when the PC may
        // still be asleep; they need to survive until it is next turned on, not just until the window itself ends.
        const id = await createSystemJob(db, signer, { orgId: pol.org_id, deviceId: dev, type: s.type, params: s.params, ttlMinutes: s.windowOnly ? 20 * 60 : s.weekly ? 6 * 60 : 12 * 60, source: { policyId: pol.id, schedule: s.key } });
        if (!id) continue;
        await db.query(`INSERT INTO policy_runs(policy_id,schedule_key,device_id,last_run_at) VALUES ($1,$2,$3,$4) ON CONFLICT (policy_id,schedule_key,device_id) DO UPDATE SET last_run_at=EXCLUDED.last_run_at`, [pol.id, s.key, dev, now]);
        openSet.add(`${dev}|${s.type}`); created++;
      }
    }
  }
  return created;
}

/** Policy reactions to a fresh health assessment ("critical repairs: automatic"). Cooldowns stop repair loops. */
/**
 * Fixes Autopilot may run without asking: only what the health engine itself calls a safe fix, and only from this allowlist
 * (safe repair recipes, safe-class cleanup, a quick scan, a definitions update). Anything that needs judgement stays a recommendation.
 */
/** Key-order-independent form of a JSON value, so parameters read back from the database compare equal to the ones we built. */
const canon = (v: unknown): string => Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v as object).sort().map(k => JSON.stringify(k) + ':' + canon((v as any)[k])).join(',')}}` : JSON.stringify(v);

/** Level 2 (controlled automatic) repairs: they change the system's program files, so they need the policy to allow them. */
export const LEVEL2_RECIPES = new Set(['windows.sfc', 'windows.dism', 'office.quick-repair', 'startup.optimize', 'protect.ransomware-audit', 'protect.asr-ransomware', 'protect.pua', 'protect.firewall', 'protect.smb1-off']);
/** Heavy repairs (long, disk-intensive) that are only started inside the maintenance window. */
export const HEAVY_RECIPES = new Set(['windows.sfc', 'windows.dism', 'windows.update-reset']);
/** Reversible repairs that only the AGGRESSIVE level starts on its own (they rename update folders and keep a backup; nothing is deleted). */
export const AGGRESSIVE_RECIPES = new Set(['windows.update-reset']);

/**
 * How much Autopilot may do by itself.
 *   OBSERVE     nothing: it diagnoses and reports only
 *   SAFE        level 1: documented temporary files, restarting failed services, definitions updates, quick scans
 *   BALANCED    level 1 plus controlled level 2 (Office Quick Repair, SFC, DISM), each verified afterwards (the default)
 *   AGGRESSIVE  BALANCED plus reversible update-component repair. Never anything irreversible, whatever the level.
 */
export type Level = 'OBSERVE' | 'SAFE' | 'BALANCED' | 'AGGRESSIVE';
export function policyLevel(ar: Settings['autoRepair'] | undefined): Level {
  if (!ar) return 'OBSERVE';
  if (ar.level) return ar.level;
  if (ar.safeFixes) return ar.level2 ? 'BALANCED' : 'SAFE';
  return ar.failedServices || ar.safeCleanup ? 'SAFE' : 'OBSERVE';
}

export function autoAllowed(fix: Fix, level: Level | boolean = 'SAFE'): boolean {
  const lv: Level = level === true ? 'BALANCED' : level === false ? 'SAFE' : level;
  if (lv === 'OBSERVE') return false;
  const allowLevel2 = lv === 'BALANCED' || lv === 'AGGRESSIVE';
  if (lv === 'AGGRESSIVE' && fix.jobType === 'repair.run' && AGGRESSIVE_RECIPES.has(String(fix.params.recipe))) return true;
  if (fix.confirm && fix.jobType !== 'cleanup.run') return false;
  switch (fix.jobType) {
    case 'repair.run': { const r = REPAIR_RECIPES[fix.params.recipe as keyof typeof REPAIR_RECIPES]; return !!r && r.risk === 'safe' && !fix.params.approved && (allowLevel2 || !LEVEL2_RECIPES.has(String(fix.params.recipe))); }
    case 'cleanup.run': return Array.isArray(fix.params.categories) && (fix.params.categories as string[]).every(c => (SAFE_CLEAN_IDS as readonly string[]).includes(c));
    case 'security.scan': return fix.params.scanType === 'quick';
    case 'security.update-signatures': return true;
    default: return false;
  }
}

export async function reactToHealth(db: Db, signer: JobSigner, orgId: string, deviceId: string, codes: Set<string>, now = new Date(), fixes: ReadonlyMap<string, Fix> = new Map()): Promise<number> {
  if (!codes.has('perf.service_failed') && !codes.has('storage.system_low') && !fixes.size) return 0;
  const pols = await db.query(`SELECT p.id, p.settings, o.utc_offset_minutes FROM policies p JOIN devices d ON d.id=$2 AND d.org_id=p.org_id JOIN organizations o ON o.id=p.org_id WHERE p.org_id=$1 AND p.enabled AND ${SCOPE_SQL}`, [orgId, deviceId]);
  let n = 0;
  let polSettings: Settings | undefined; let polOffset = 0;
  const react = async (policyId: string, key: string, cooldownH: number, type: string, params: Record<string, unknown>, code: string) => {
    const recipe = type === 'repair.run' ? String(params.recipe ?? '') : '';
    if (HEAVY_RECIPES.has(recipe) && polSettings?.maintenanceWindow && !inWindow(now, polOffset, polSettings.maintenanceWindow)) return;   // heavy repairs wait for the maintenance window
    if (LEVEL2_RECIPES.has(recipe) || HEAVY_RECIPES.has(recipe)) {
      if ((await db.query(`SELECT 1 FROM incidents WHERE device_id=$1 AND safety_level >= 2 AND status IN ('REPAIRING','VERIFYING') AND code <> $2`, [deviceId, code])).rowCount) return;   // one heavy repair at a time per computer
    }
    const last = await db.query('SELECT last_run_at FROM policy_runs WHERE policy_id=$1 AND schedule_key=$2 AND device_id=$3', [policyId, key, deviceId]);
    if (last.rowCount && now.getTime() - new Date(last.rows[0].last_run_at).getTime() < cooldownH * 3600_000) return;
    const open = await db.query(`SELECT id, params FROM jobs WHERE device_id=$1 AND type=$2 AND status IN ('queued','running')`, [deviceId, type]);
    if (open.rowCount) {
      // The same repair is already on its way (for example one cleanup serving two findings): this problem shares it instead of starting a second one.
      const same = open.rows.find(r => canon(r.params) === canon(params));
      if (same) await attachRepairJob(db, deviceId, code, same.id, 'autopilot');
      return;
    }
    const jobId = await createSystemJob(db, signer, { orgId, deviceId, type, params, ttlMinutes: 6 * 60, source: { policyId, schedule: key } });
    if (!jobId) return;
    await attachRepairJob(db, deviceId, code, jobId, 'autopilot');   // the incident now tracks this repair: it is only resolved after verification
    await db.query(`INSERT INTO policy_runs(policy_id,schedule_key,device_id,last_run_at) VALUES ($1,$2,$3,$4) ON CONFLICT (policy_id,schedule_key,device_id) DO UPDATE SET last_run_at=EXCLUDED.last_run_at`, [policyId, key, deviceId, now]);
    n++;
  };
  for (const p of pols.rows) {
    const ar = (p.settings as Settings)?.autoRepair; if (!ar) continue;
    const level = policyLevel(ar); if (level === 'OBSERVE') continue;
    polSettings = p.settings as Settings; polOffset = p.utc_offset_minutes ?? 0;
    if (ar.failedServices && codes.has('perf.service_failed')) await react(p.id, 'auto:services', 6, 'repair.run', { recipe: 'services.restart-failed' }, 'perf.service_failed');
    if (ar.safeCleanup && codes.has('storage.system_low')) await react(p.id, 'auto:cleanup', 24, 'cleanup.run', { categories: SAFE_CLEAN_IDS }, 'storage.system_low');
    if (ar.safeFixes) for (const [code, fix] of fixes) {
      if ((ar.failedServices && code === 'perf.service_failed') || (ar.safeCleanup && code === 'storage.system_low')) continue;   // handled above
      if (autoAllowed(fix, level)) await react(p.id, `auto:${code}`, level === 'AGGRESSIVE' ? 6 : 24, fix.jobType, fix.params, code);
    }
  }
  return n;
}

/* ------------------------------------------------------------------------------------------------
 * Templates (the example policy from the product brief) and routes.
 * ---------------------------------------------------------------------------------------------- */
export const POLICY_TEMPLATES = [
  {
    id: 'finance', name: 'Finance PCs', description: 'Health scan every 30 min, safe cleanup Friday 18:00, critical repairs automatic, updates and drivers only in the maintenance window.',
    settings: {
      schedules: [
        { key: 'health', type: 'health.check', params: {}, everyMinutes: 30 },
        { key: 'safe-cleanup', type: 'repair.run', params: { recipe: 'cleanup.safe' }, weekly: { days: [5], time: '18:00' } },
        { key: 'hardware-weekly', type: 'hardware.diagnose', params: {}, weekly: { days: [0], time: '03:00' } },
      ],
      maintenanceWindow: { days: [0], start: '02:00', end: '06:00' }, autoRepair: { failedServices: true }, restartAfterUpdates: 'ask',
    },
  },
  {
    id: 'lab', name: 'Computer lab', description: 'Nightly safe cleanup and hourly health scan; automatic repairs of failed services and low disk.',
    settings: {
      schedules: [{ key: 'health', type: 'health.check', params: {}, everyMinutes: 60 }, { key: 'nightly-clean', type: 'repair.run', params: { recipe: 'cleanup.safe' }, weekly: { days: [0, 1, 2, 3, 4, 5, 6], time: '01:00' } }],
      maintenanceWindow: { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '05:00' }, autoRepair: { failedServices: true, safeCleanup: true }, restartAfterUpdates: 'auto',
    },
  },
] as const;

export function registerPolicyRoutes(app: FastifyInstance, c: JobCtx) {
  const { db } = c;
  const Scope = z.object({ type: z.enum(['org', 'site', 'department', 'tag']), id: z.string().uuid().optional(), tag: z.string().min(1).max(60).optional() }).strict();
  const Body = z.object({ name: z.string().min(1).max(120), description: z.string().max(500).optional(), enabled: z.boolean().default(true), scope: Scope, settings: z.unknown() });

  async function checkScope(org: string, s: z.infer<typeof Scope>): Promise<string | null> {
    if (s.type === 'org') return null;
    if (s.type === 'tag') return s.tag ? null : 'tag scope needs a tag';
    if (!s.id) return `${s.type} scope needs an id`;
    const t = s.type === 'site' ? 'sites' : 'departments';
    return (await db.query(`SELECT 1 FROM ${t} WHERE id=$1 AND org_id=$2`, [s.id, org])).rowCount ? null : `${s.type} not found`;
  }
  const row = (r: any) => ({ id: r.id, name: r.name, description: r.description, enabled: r.enabled, scope: { type: r.scope_type, id: r.scope_id, tag: r.scope_tag }, settings: r.settings, createdAt: r.created_at, updatedAt: r.updated_at });

  app.get('/api/v1/policy-templates', { preHandler: c.requireRole('viewer') }, async () => ({ templates: POLICY_TEMPLATES }));

  app.get('/api/v1/policies', { preHandler: c.requireRole('viewer') }, async req => {
    const r = await db.query(`SELECT p.*, (SELECT count(*)::int FROM devices d WHERE d.org_id=p.org_id AND d.revoked_at IS NULL AND ${SCOPE_SQL}) AS devices FROM policies p WHERE p.org_id=$1 ORDER BY p.name`, [req.user.org]);
    return { policies: r.rows.map(x => ({ ...row(x), deviceCount: x.devices })) };
  });

  app.post('/api/v1/policies', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const b = Body.parse(req.body);
    const v = validateSettings(b.settings); if (!v.ok) return reply.code(400).send({ error: v.error });
    const se = await checkScope(req.user.org, b.scope); if (se) return reply.code(400).send({ error: se });
    try {
      const r = await db.query(`INSERT INTO policies(org_id,name,description,enabled,scope_type,scope_id,scope_tag,settings,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.user.org, b.name, b.description ?? null, b.enabled, b.scope.type, b.scope.id ?? null, b.scope.tag ?? null, JSON.stringify(v.settings), req.user.sub]);
      await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'policy.create', targetType: 'policy', targetId: r.rows[0].id, next: row(r.rows[0]) });
      return reply.code(201).send(row(r.rows[0]));
    } catch (e: any) { if (e.code === '23505') return reply.code(409).send({ error: 'a policy with that name exists' }); throw e; }
  });

  app.patch('/api/v1/policies/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const cur = await db.query('SELECT * FROM policies WHERE id=$1 AND org_id=$2', [id, req.user.org]);
    if (!cur.rowCount) return reply.code(404).send({ error: 'not found' });
    const b = Body.partial().parse(req.body);
    let settings = cur.rows[0].settings;
    if (b.settings !== undefined) { const v = validateSettings(b.settings); if (!v.ok) return reply.code(400).send({ error: v.error }); settings = v.settings; }
    const scope = b.scope ?? { type: cur.rows[0].scope_type, id: cur.rows[0].scope_id ?? undefined, tag: cur.rows[0].scope_tag ?? undefined };
    const se = await checkScope(req.user.org, scope); if (se) return reply.code(400).send({ error: se });
    const r = await db.query(`UPDATE policies SET name=$3, description=$4, enabled=$5, scope_type=$6, scope_id=$7, scope_tag=$8, settings=$9, updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING *`,
      [id, req.user.org, b.name ?? cur.rows[0].name, b.description ?? cur.rows[0].description, b.enabled ?? cur.rows[0].enabled, scope.type, scope.id ?? null, scope.tag ?? null, JSON.stringify(settings)]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'policy.update', targetType: 'policy', targetId: id, previous: row(cur.rows[0]), next: row(r.rows[0]) });
    return row(r.rows[0]);
  });

  app.delete('/api/v1/policies/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await db.query('DELETE FROM policies WHERE id=$1 AND org_id=$2 RETURNING name', [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'policy.delete', targetType: 'policy', targetId: id, previous: { name: r.rows[0].name } });
    return { ok: true };
  });

  app.get('/api/v1/devices/:id/policies', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const dev = await db.query('SELECT 1 FROM devices WHERE id=$1 AND org_id=$2', [id, req.user.org]);
    if (!dev.rowCount) return reply.code(404).send({ error: 'not found' });
    const r = await db.query(`SELECT p.* FROM policies p JOIN devices d ON d.id=$2 AND d.org_id=p.org_id WHERE p.org_id=$1 AND p.enabled AND ${SCOPE_SQL} ORDER BY p.name`, [req.user.org, id]);
    return { policies: r.rows.map(row) };
  });
}
