import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, randomUUID, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import type { Role } from './security.js';
import { CLEAN_IDS, CLEAN_CATEGORIES, RECIPE_IDS, REPAIR_RECIPES, type RecipeId } from './catalog.js';

/* ------------------------------------------------------------------------------------------------
 * Job catalogue. The agent only executes types compiled into it; the server only issues types listed here.
 * There is deliberately no "run arbitrary command" job.
 * ---------------------------------------------------------------------------------------------- */
export interface JobTypeDef { /** not selectable by administrators directly (created by rollout engines) */ internalOnly?: boolean; /** may appear in policy schedules (default true) */ schedulable?: boolean; validate?: (db: Db, orgId: string, params: Record<string, any>) => Promise<string | null>; role: Role; timeoutSeconds: number | ((p: Record<string, any>) => number); params: z.ZodType<Record<string, unknown>>; description: string }
const none = z.object({}).strict();
const wingetId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{1,100}$/);
/** Applications can only be installed, updated or removed remotely if an administrator approved that package for this organization. */
async function approved(db: Db, orgId: string, id: string, uninstall: boolean): Promise<string | null> {
  const r = await db.query('SELECT allow_uninstall FROM software_catalog WHERE org_id=$1 AND lower(winget_id)=lower($2)', [orgId, id]);
  if (!r.rowCount) return `"${id}" is not in this organization's approved software catalog`;
  if (uninstall && !r.rows[0].allow_uninstall) return `"${id}" is approved for install/update but not for removal`;
  return null;
}
export const JOB_TYPES: Record<string, JobTypeDef> = {
  'health.check': { role: 'technician', timeoutSeconds: 300, params: none, description: 'Collect and upload a fresh health snapshot' },
  'inventory.refresh': { role: 'technician', timeoutSeconds: 180, params: none, description: 'Re-collect hardware and software inventory' },
  'benchmark.run': { role: 'technician', timeoutSeconds: 300, params: none, description: 'Lightweight performance benchmark (boot time, background CPU, memory, startup load, disk write latency); used before and after repairs' },
  'hardware.diagnose': { role: 'technician', timeoutSeconds: 300, params: none, description: 'Deep read-only hardware diagnostics (storage SMART, memory, battery, thermals, hardware error logs)' },
  'repair.run': {
    role: 'admin', description: 'Run one repair recipe: diagnose, change minimally, verify, roll back on failure',
    timeoutSeconds: p => REPAIR_RECIPES[p.recipe as RecipeId]?.timeoutSeconds ?? 900,
    params: z.object({
      recipe: z.enum(RECIPE_IDS), approved: z.boolean().optional(),
      options: z.object({ force: z.boolean().optional(), entries: z.array(z.object({ location: z.string().min(1).max(300), name: z.string().min(1).max(200) }).strict()).min(1).max(50).optional(), threatPaths: z.array(z.string().min(4).max(400)).max(50).optional(), level: z.number().int().min(1).max(3).optional(), printer: z.string().max(120).regex(/^[\p{L}\p{N} ._\-()#,/+]+$/u).optional(), kind: z.enum(['msi', 'appx', 'other']).optional(), hive: z.enum(['HKLM', 'HKLM32', 'HKCU']).optional(), forced: z.boolean().optional(), id: z.string().regex(/^[^\\/\x00-\x1f]{2,200}$/).optional(), pids: z.array(z.number().int().min(1)).min(1).max(50).optional() }).strict().optional(),
    }).strict().superRefine((v, ctx) => {
      if (REPAIR_RECIPES[v.recipe].risk === 'review' && v.approved !== true) ctx.addIssue({ code: 'custom', message: `"${v.recipe}" changes the system and requires approved:true from an administrator` });
      if (v.recipe === 'apps.end-hung' && !Array.isArray(v.options?.pids)) ctx.addIssue({ code: 'custom', message: 'apps.end-hung requires options.pids' });
      if (v.recipe === 'app.update' && !v.options?.id) ctx.addIssue({ code: 'custom', message: 'app.update requires options.id' });
      if (v.recipe === 'app.uninstall' && !(v.options?.kind && v.options?.id)) ctx.addIssue({ code: 'custom', message: 'app.uninstall requires options.kind and options.id' });
      if (v.recipe === 'app.repair' && !(v.options?.kind && v.options?.id)) ctx.addIssue({ code: 'custom', message: 'app.repair requires options.kind and options.id' });
      if ((v.recipe === 'startup.disable' || v.recipe === 'startup.enable') && !v.options?.entries) ctx.addIssue({ code: 'custom', message: v.recipe + ' requires options.entries' });
    }),
  },
  'repair.fix-safe': { role: 'admin', timeoutSeconds: 1800, params: none, description: 'Fix my PC: diagnose every auto-safe repair and apply only those with a real problem' },
  'repair.rollback': { role: 'admin', timeoutSeconds: 900, params: z.object({ repairId: z.string().uuid() }).strict(), description: 'Undo a previous reversible repair using state saved on the device' },
  'cleanup.preview': { role: 'technician', timeoutSeconds: 900, params: none, description: 'Measure recoverable space per cleanup category (read-only)' },
  'cleanup.run': {
    role: 'admin', timeoutSeconds: 1800, description: 'Delete files in the chosen cleanup categories (SAFE by policy, REVIEW only with approval; personal data can never be selected)',
    params: z.object({ categories: z.array(z.enum(CLEAN_IDS)).min(1).max(CLEAN_IDS.length), approveReview: z.boolean().optional() }).strict().superRefine((v, ctx) => {
      if (v.categories.some(c => CLEAN_CATEGORIES[c].class === 'REVIEW') && v.approveReview !== true) ctx.addIssue({ code: 'custom', message: 'REVIEW categories (recycle bin, previous Windows) require approveReview:true' });
    }),
  },
  'security.scan': { role: 'technician', description: 'Run a Microsoft Defender quick or full scan (only when Defender is the active antivirus)', timeoutSeconds: p => p.scanType === 'full' ? 22_000 : 3_600, params: z.object({ scanType: z.enum(['quick', 'full']).default('quick') }).strict() },
  'security.update-signatures': { role: 'technician', timeoutSeconds: 900, params: none, description: 'Update Microsoft Defender threat definitions' },
  'security.investigate': { role: 'technician', timeoutSeconds: 300, params: z.object({ threatPaths: z.array(z.string().min(4).max(400)).max(50).optional() }).strict(), description: 'Read-only: look for what a threat may have changed (startup entries, scheduled tasks, proxy, DNS, hosts file, Defender settings)' },
  'security.remediate': { role: 'admin', timeoutSeconds: 1200, params: none, description: 'Ask Microsoft Defender to remove the threats it currently lists as active (only when Defender is the active antivirus)' },
  'memory.analyze': { role: 'technician', timeoutSeconds: 300, params: none, description: 'Read-only: which programs hold memory, how each is classified, and what Viro would do about it' },
  'battery.diagnose': { role: 'technician', timeoutSeconds: 300, params: none, description: 'Read-only: battery health, discharge rate, top processes, wake locks and power plan, for ranking why the battery drains' },
  'ui.notify': { role: 'admin', timeoutSeconds: 300, params: z.object({ template: z.enum(['storage-failing']), evidence: z.array(z.string().max(200)).max(5).default([]) }).strict(), description: 'Show a fixed notice to the signed-in user (text is fixed on the PC; Control supplies only evidence lines)' },
  'security.status': { role: 'technician', timeoutSeconds: 300, params: none, description: 'Read the full security posture (Defender, firewall, BitLocker, TPM, Secure Boot, UAC, RDP)' },
  'updates.scan': { role: 'technician', timeoutSeconds: 900, params: none, description: 'Scan Windows Update for pending updates and drivers (read-only)' },
  'updates.install': { role: 'admin', timeoutSeconds: 7_200, params: z.object({ scope: z.enum(['security', 'all']).default('security'), updateIds: z.array(z.string().uuid()).min(1).max(50).optional() }).strict(), description: 'Install pending Windows updates (never drivers; those use the staged driver rollout)' },
  'driver.install': { role: 'admin', internalOnly: true, schedulable: false, timeoutSeconds: 3_600, params: z.object({ updateIds: z.array(z.string().uuid()).min(1).max(20) }).strict(), description: 'Install Windows Update driver packages (issued only by the staged rollout)' },
  'driver.rollback': { role: 'admin', schedulable: false, timeoutSeconds: 900, params: z.object({ infName: z.string().regex(/^oem\d{1,5}\.inf$/i) }).strict(), description: 'Remove a third-party driver package so Windows falls back to the previous driver' },
  'software.check-updates': { role: 'technician', timeoutSeconds: 600, params: none, description: 'List installed applications that have newer versions available' },
  'software.install': { role: 'admin', schedulable: false, timeoutSeconds: 2_400, params: z.object({ wingetId: wingetId }).strict(), validate: (db, org, p) => approved(db, org, p.wingetId, false), description: 'Install an organization-approved application' },
  'software.update': { role: 'admin', schedulable: false, timeoutSeconds: 2_400, params: z.object({ wingetId: wingetId }).strict(), validate: (db, org, p) => approved(db, org, p.wingetId, false), description: 'Update an organization-approved application' },
  'software.uninstall': { role: 'admin', schedulable: false, timeoutSeconds: 2_400, params: z.object({ wingetId: wingetId }).strict(), validate: (db, org, p) => approved(db, org, p.wingetId, true), description: 'Uninstall an application the organization has approved for removal' },
  'message.send': { role: 'technician', schedulable: false, timeoutSeconds: 120, params: z.object({ text: z.string().min(1).max(300).regex(/^[\p{L}\p{N} .,:;!?()\-_/'+#%@\r\n]+$/u), seconds: z.number().int().min(5).max(3600).optional() }).strict(), description: 'Show a message to the person using the PC' },
  'system.reboot': { role: 'admin', schedulable: false, timeoutSeconds: 120, params: z.object({ delaySeconds: z.number().int().min(30).max(3600).default(300), message: z.string().min(1).max(200).regex(/^[\p{L}\p{N} .,:;!?()\-_/'+#%@]+$/u).optional() }).strict(), description: 'Restart the PC after a visible countdown (users can save work)' },
  'system.shutdown': { role: 'admin', schedulable: false, timeoutSeconds: 120, params: z.object({ delaySeconds: z.number().int().min(30).max(3600).default(60), message: z.string().min(1).max(200).regex(/^[\p{L}\p{N} .,:;!?()\-_/'+#%@]+$/u).optional() }).strict(), description: 'Switch the PC off after a visible countdown (users can save work). Needs someone to switch it on again.' },
  'wol.send': { role: 'admin', internalOnly: true, schedulable: false, timeoutSeconds: 60, params: z.object({ mac: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/), broadcasts: z.array(z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/)).max(4).default([]) }).strict(), description: 'Send a Wake-on-LAN signal to another computer on this network (issued only by the wake-up request)' },
  'startup.quarantine': { role: 'admin', timeoutSeconds: 120, params: z.object({ name: z.string().min(1).max(200).regex(/^[^\\/:*?"<>|]+$/).refine(n => !/^\.+$/.test(n), 'not a file name'), approved: z.literal(true) }).strict(), description: 'Move one file out of the Windows Startup folders into protected quarantine so it can no longer run. Nothing is deleted: the file keeps its hash and original location and can be restored. Needs administrator approval' },
  'startup.restore': { role: 'admin', timeoutSeconds: 120, params: z.object({ id: z.string().regex(/^[0-9A-Za-z-]{8,60}$/), approved: z.literal(true) }).strict(), description: 'Put a quarantined start-up file back where it was found. Needs administrator approval' },
  'persistence.hunt': { role: 'technician', timeoutSeconds: 300, params: none, description: 'Read-only sweep of the places malware hides to survive a restart (Startup folders, sign-in hooks, image debuggers, AppInit, WMI subscriptions, padded or randomly named scripts in user folders). Reports evidence for review; changes nothing' },
  'startup.inspect': { role: 'technician', timeoutSeconds: 120, params: z.object({ name: z.string().min(1).max(200).optional() }).strict(), description: 'Read-only: list what sits in the Windows Startup folders (size, dates, hash, the opening lines of a script, signer, and indicators such as encoded commands or hidden windows). Changes nothing; can only read inside those folders' },
  'benchmark.upgrade': { role: 'technician', timeoutSeconds: 900, params: z.object({ purpose: z.enum(['baseline', 'after', 'periodic']).default('baseline') }).strict(), description: 'Controlled, non-destructive performance measurement (processor single and multi-thread, sustained load with temperature, memory bandwidth and latency, drive reads); stops by itself if the computer gets too hot' },
  'anatomy.collect': { role: 'technician', timeoutSeconds: 900, params: none, description: 'Read the full anatomy of the computer (every part, serial numbers, ages, measurements) and send it to Control' },
  'system.reboot-cancel': { role: 'admin', schedulable: false, timeoutSeconds: 120, params: none, description: 'Cancel a pending restart or shut-down' },
  'service.restart': { role: 'admin', timeoutSeconds: 120, params: z.object({ name: z.string().regex(/^[A-Za-z0-9_.$-]{1,80}$/) }).strict(), description: 'Restart (or start) a Windows service and verify it is running' },
};

/* ------------------------------------------------------------------------------------------------
 * Signing (ECDSA P-256 / SHA-256, IEEE-P1363 signature so it verifies directly with .NET ECDsa).
 * ---------------------------------------------------------------------------------------------- */
export class JobSigner {
  private constructor(private priv: KeyObject, readonly publicKeySpkiBase64: string) {}

  static fromPem(pem: string) {
    const priv = createPrivateKey(pem);
    const spki = createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer;
    return new JobSigner(priv, spki.toString('base64'));
  }
  static generate() {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return JobSigner.fromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  }
  /** Production: JOB_SIGNING_KEY env (PKCS8 PEM). Development: a persisted key file so agents stay valid across restarts. */
  static load(env: NodeJS.ProcessEnv, devKeyFile = '.devkeys/job-signing.pem') {
    if (env.JOB_SIGNING_KEY) return JobSigner.fromPem(env.JOB_SIGNING_KEY.replace(/\\n/g, '\n'));
    if (env.NODE_ENV === 'production') throw new Error('JOB_SIGNING_KEY is required in production');
    if (existsSync(devKeyFile)) return JobSigner.fromPem(readFileSync(devKeyFile, 'utf8'));
    const s = JobSigner.generate();
    mkdirSync(dirname(devKeyFile), { recursive: true });
    writeFileSync(devKeyFile, s.priv.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o600 });
    return s;
  }
  sign(payload: string): string {
    return cryptoSign('sha256', Buffer.from(payload, 'utf8'), { key: this.priv, dsaEncoding: 'ieee-p1363' }).toString('base64');
  }
  verify(payload: string, signatureB64: string): boolean {
    return cryptoVerify('sha256', Buffer.from(payload, 'utf8'), { key: createPublicKey(this.priv), dsaEncoding: 'ieee-p1363' }, Buffer.from(signatureB64, 'base64'));
  }
}

export interface JobPayload { v: 1; jobId: string; orgId: string; deviceId: string; type: string; params: Record<string, unknown>; issuedAt: string; expiresAt: string; timeoutSeconds: number }

/* ------------------------------------------------------------------------------------------------
 * Routes
 * ---------------------------------------------------------------------------------------------- */
export interface JobCtx {
  db: Db; signer: JobSigner;
  requireRole: (r: Role) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  requireDevice: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  audit: (e: { orgId: string | null; actorType: 'user' | 'device' | 'system'; actorId?: string; action: string; targetType?: string; targetId?: string; previous?: unknown; next?: unknown; result?: string }) => Promise<void>;
  atLeast: (have: Role, need: Role) => boolean;
  afterJob?: (orgId: string, deviceId: string, type: string, status: string, result?: unknown, jobId?: string) => Promise<void>;
}

const TERMINAL = ['completed', 'failed', 'cancelled'];
const REDELIVER_AFTER_SECONDS = 60;
const MAX_TARGETS = 5000;

export function registerJobRoutes(app: FastifyInstance, c: JobCtx) {
  const { db } = c;

  app.get('/api/v1/job-types', { preHandler: c.requireRole('viewer') }, async () => ({
    types: Object.entries(JOB_TYPES).map(([type, d]) => ({ type, requiredRole: d.role, timeoutSeconds: typeof d.timeoutSeconds === 'function' ? null : d.timeoutSeconds, description: d.description })),
  }));

  // ---- create (one job per targeted device) ----
  app.post('/api/v1/jobs', { preHandler: c.requireRole('technician') }, async (req, reply) => {
    const b = z.object({
      type: z.string(), params: z.record(z.string(), z.unknown()).default({}),
      target: z.object({
        deviceIds: z.array(z.string().uuid()).max(MAX_TARGETS).optional(), siteId: z.string().uuid().optional(),
        departmentId: z.string().uuid().optional(), all: z.literal(true).optional(),
      }).strict(),
      ttlMinutes: z.number().int().min(1).max(7 * 24 * 60).default(60),
    }).parse(req.body);
    const def = JOB_TYPES[b.type];
    if (!def) return reply.code(400).send({ error: `unknown job type "${b.type}"` });
    if (def.internalOnly) return reply.code(400).send({ error: `${b.type} is issued only through its staged rollout` });
    if (!c.atLeast(req.user.role, def.role)) return reply.code(403).send({ error: `job type ${b.type} requires role ${def.role}` });
    const params = def.params.safeParse(b.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid params', details: params.error.issues });
    if (def.validate) { const bad = await def.validate(db, req.user.org, params.data); if (bad) return reply.code(400).send({ error: bad }); }
    const t = b.target;
    if ([t.deviceIds, t.siteId, t.departmentId, t.all].filter(x => x !== undefined).length !== 1) return reply.code(400).send({ error: 'target must specify exactly one of deviceIds, siteId, departmentId, all' });

    const org = req.user.org;
    let q: { text: string; values: unknown[] };
    if (t.deviceIds) q = { text: 'SELECT id FROM devices WHERE org_id=$1 AND revoked_at IS NULL AND id = ANY($2::uuid[])', values: [org, t.deviceIds] };
    else if (t.siteId) q = { text: 'SELECT id FROM devices WHERE org_id=$1 AND revoked_at IS NULL AND site_id=$2', values: [org, t.siteId] };
    else if (t.departmentId) q = { text: 'SELECT id FROM devices WHERE org_id=$1 AND revoked_at IS NULL AND department_id=$2', values: [org, t.departmentId] };
    else q = { text: 'SELECT id FROM devices WHERE org_id=$1 AND revoked_at IS NULL', values: [org] };
    const devs = (await db.query(q.text, q.values)).rows.map(r => r.id as string);
    if (t.deviceIds && devs.length !== new Set(t.deviceIds).size) return reply.code(404).send({ error: 'one or more devices not found' });
    if (!devs.length) return reply.code(404).send({ error: 'no devices match the target' });
    if (devs.length > MAX_TARGETS) return reply.code(400).send({ error: `target exceeds ${MAX_TARGETS} devices` });

    const timeout = typeof def.timeoutSeconds === 'function' ? def.timeoutSeconds(params.data) : def.timeoutSeconds;
    const batchId = randomUUID();
    const issuedAt = new Date(), expiresAt = new Date(issuedAt.getTime() + b.ttlMinutes * 60_000);
    const created: { id: string; deviceId: string }[] = [];
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const deviceId of devs) {
        const jobId = randomUUID();
        const payload: JobPayload = { v: 1, jobId, orgId: org, deviceId, type: b.type, params: params.data, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(), timeoutSeconds: timeout };
        const text = JSON.stringify(payload);
        await client.query(
          `INSERT INTO jobs(id,org_id,device_id,batch_id,type,params,created_by,expires_at,timeout_seconds,payload,signature) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [jobId, org, deviceId, batchId, b.type, JSON.stringify(params.data), req.user.sub, expiresAt, timeout, text, c.signer.sign(text)]);
        created.push({ id: jobId, deviceId });
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    for (const j of created) await c.audit({ orgId: org, actorType: 'user', actorId: req.user.sub, action: 'job.create', targetType: 'device', targetId: j.deviceId, next: { jobId: j.id, batchId, type: b.type, params: params.data, status: 'queued' } });
    return reply.code(201).send({ batchId, count: created.length, jobs: created });
  });

  const JOB_COLS = 'id, device_id, batch_id, type, params, status, created_by, created_at, started_at, finished_at, expires_at, cancel_requested, result, error';

  app.get('/api/v1/jobs', { preHandler: c.requireRole('viewer') }, async (req) => {
    const f = z.object({
      deviceId: z.string().uuid().optional(), batchId: z.string().uuid().optional(), type: z.string().optional(),
      status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query);
    const where = ['j.org_id=$1']; const vals: unknown[] = [req.user.org];
    for (const [col, v] of [['j.device_id', f.deviceId], ['j.batch_id', f.batchId], ['j.type', f.type], ['j.status', f.status]] as const)
      if (v) { vals.push(v); where.push(`${col}=$${vals.length}`); }
    vals.push(f.limit);
    const r = await db.query(
      `SELECT j.id, j.device_id, d.hostname, j.batch_id, j.type, j.params, j.status, j.created_at, j.started_at, j.finished_at, j.cancel_requested, j.error,
              CASE j.type
                WHEN 'repair.run' THEN j.result->>'summary'
                WHEN 'repair.fix-safe' THEN (j.result->>'fixedCount') || ' fixed, ' || (j.result->>'failedCount') || ' failed, ' || (j.result->>'unchangedCount') || ' already fine'
                WHEN 'cleanup.run' THEN 'freed ' || round((j.result->>'freedBytes')::numeric / 1048576) || ' MB' || CASE WHEN COALESCE((SELECT sum((c->>'recentBytes')::numeric) FROM jsonb_array_elements(j.result->'categories') c), 0) > 52428800 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j.result->'categories') c WHERE c->>'id'='recent-temp') THEN '; ' || round((SELECT sum((c->>'recentBytes')::numeric) FROM jsonb_array_elements(j.result->'categories') c) / 1048576) || ' MB more is too new to delete safely automatically (use Free more space)' ELSE '' END
                WHEN 'cleanup.preview' THEN round((j.result->>'safeBytes')::numeric / 1048576) || ' MB safely recoverable'
                WHEN 'service.restart' THEN j.result->>'newStatus'
              END AS summary
         FROM jobs j JOIN devices d ON d.id=j.device_id WHERE ${where.join(' AND ')} ORDER BY j.created_at DESC LIMIT $${vals.length}`, vals);
    const counts = await db.query(`SELECT status, count(*)::int n FROM jobs j WHERE ${where.join(' AND ')} GROUP BY status`, vals.slice(0, -1));
    return { jobs: r.rows, counts: Object.fromEntries(counts.rows.map(x => [x.status, x.n])) };
  });

  app.get('/api/v1/jobs/:id', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await db.query(`SELECT ${JOB_COLS} FROM jobs WHERE id=$1 AND org_id=$2`, [id, req.user.org]);
    return r.rowCount ? r.rows[0] : reply.code(404).send({ error: 'not found' });
  });

  app.post('/api/v1/jobs/:id/cancel', { preHandler: c.requireRole('technician') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const cur = await db.query('SELECT status, type FROM jobs WHERE id=$1 AND org_id=$2', [id, req.user.org]);
    if (!cur.rowCount) return reply.code(404).send({ error: 'not found' });
    if (!c.atLeast(req.user.role, JOB_TYPES[cur.rows[0].type]?.role ?? 'admin')) return reply.code(403).send({ error: 'forbidden' });
    const r = await db.query(
      `UPDATE jobs SET cancel_requested=true,
              status = CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
              finished_at = CASE WHEN status='queued' THEN now() ELSE finished_at END,
              error = CASE WHEN status='queued' THEN 'cancelled by administrator before it started' ELSE error END
        WHERE id=$1 AND org_id=$2 AND status IN ('queued','running') RETURNING status`, [id, req.user.org]);
    if (!r.rowCount) return reply.code(409).send({ error: `job already ${cur.rows[0].status}` });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'job.cancel', targetType: 'job', targetId: id, previous: { status: cur.rows[0].status }, next: { status: r.rows[0].status, cancelRequested: true } });
    return { id, status: r.rows[0].status, cancelRequested: true };
  });

  // ---- agent side ----
  app.post('/agent/v1/jobs/:id/start', { preHandler: c.requireDevice }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { id: deviceId, orgId } = req.device!;
    const r = await db.query(`UPDATE jobs SET status='running', started_at=now() WHERE id=$1 AND device_id=$2 AND org_id=$3 AND status='queued' AND cancel_requested=false AND expires_at > now() RETURNING id`, [id, deviceId, orgId]);
    if (!r.rowCount) {
      const cur = await db.query('SELECT status FROM jobs WHERE id=$1 AND device_id=$2', [id, deviceId]);
      return reply.code(cur.rowCount ? 409 : 404).send({ error: cur.rowCount ? `job is ${cur.rows[0].status}` : 'not found' });
    }
    await c.audit({ orgId, actorType: 'device', actorId: deviceId, action: 'job.start', targetType: 'job', targetId: id, previous: { status: 'queued' }, next: { status: 'running' } });
    return { ok: true };
  });

  app.post('/agent/v1/jobs/:id/result', { preHandler: c.requireDevice }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ status: z.enum(['completed', 'failed', 'cancelled']), result: z.unknown().optional(), error: z.string().max(4000).nullish() }).parse(req.body);
    const { id: deviceId, orgId } = req.device!;
    const r = await db.query(
      `UPDATE jobs SET status=$4, finished_at=now(), result=$5, error=$6 WHERE id=$1 AND device_id=$2 AND org_id=$3 AND status='running' RETURNING id`,
      [id, deviceId, orgId, b.status, b.result === undefined ? null : JSON.stringify(b.result), b.error ?? null]);
    if (!r.rowCount) {
      const cur = await db.query('SELECT status FROM jobs WHERE id=$1 AND device_id=$2', [id, deviceId]);
      if (cur.rowCount && cur.rows[0].status === b.status) return { ok: true, duplicate: true };
      return reply.code(cur.rowCount ? 409 : 404).send({ error: cur.rowCount ? `job is ${cur.rows[0].status}` : 'not found' });
    }
    const jt = await db.query('SELECT type FROM jobs WHERE id=$1', [id]);
    if (c.afterJob && jt.rowCount) await c.afterJob(orgId, deviceId, jt.rows[0].type, b.status, b.result, id).catch(() => {});
    await c.audit({ orgId, actorType: 'device', actorId: deviceId, action: 'job.finish', targetType: 'job', targetId: id, previous: { status: 'running' }, next: { status: b.status }, result: b.status === 'completed' ? 'ok' : b.status });
    return { ok: true };
  });
}

/** Creates one signed job on behalf of the platform itself (scheduler, policy reactions). Returns null if the type/params are not valid. */
export async function createSystemJob(db: Db, signer: JobSigner, o: { orgId: string; deviceId: string; type: string; params: Record<string, unknown>; ttlMinutes: number; source: Record<string, unknown> }): Promise<string | null> {
  const def = JOB_TYPES[o.type]; if (!def) return null;
  const p = def.params.safeParse(o.params); if (!p.success) return null;
  const timeout = typeof def.timeoutSeconds === 'function' ? def.timeoutSeconds(p.data) : def.timeoutSeconds;
  const jobId = randomUUID(), issued = new Date(), expires = new Date(issued.getTime() + o.ttlMinutes * 60_000);
  const payload: JobPayload = { v: 1, jobId, orgId: o.orgId, deviceId: o.deviceId, type: o.type, params: p.data, issuedAt: issued.toISOString(), expiresAt: expires.toISOString(), timeoutSeconds: timeout };
  const text = JSON.stringify(payload);
  await db.query(`INSERT INTO jobs(id,org_id,device_id,batch_id,type,params,created_by,expires_at,timeout_seconds,payload,signature) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10)`,
    [jobId, o.orgId, o.deviceId, randomUUID(), o.type, JSON.stringify(p.data), expires, timeout, text, signer.sign(text)]);
  await db.query(`INSERT INTO audit_log(org_id,actor_type,action,target_type,target_id,next) VALUES ($1,'system','job.create','device',$2,$3)`, [o.orgId, o.deviceId, JSON.stringify({ jobId, type: o.type, params: p.data, status: 'queued', ...o.source })]);
  return jobId;
}

/** Jobs handed to an agent in a heartbeat response: queued and unexpired, redelivered if not started within a minute. */
export async function jobsForHeartbeat(db: Db, orgId: string, deviceId: string) {
  const r = await db.query(
    `UPDATE jobs SET dispatched_at=now()
      WHERE id IN (SELECT id FROM jobs WHERE org_id=$1 AND device_id=$2 AND status='queued' AND cancel_requested=false AND expires_at > now()
                     AND (dispatched_at IS NULL OR dispatched_at < now() - make_interval(secs => $3)) ORDER BY created_at LIMIT 10)
      RETURNING id, payload, signature`, [orgId, deviceId, REDELIVER_AFTER_SECONDS]);
  const cancel = await db.query(`SELECT id FROM jobs WHERE org_id=$1 AND device_id=$2 AND status='running' AND cancel_requested=true`, [orgId, deviceId]);
  return { jobs: r.rows, cancel: cancel.rows.map(x => x.id as string) };
}

/** Closes out jobs that can no longer progress. Safe to call repeatedly (interval in production, directly in tests). */
export async function sweepJobs(db: Db): Promise<number> {
  const a = await db.query(`UPDATE jobs SET status='failed', finished_at=now(), error='expired: the device did not pick this job up in time' WHERE status='queued' AND expires_at <= now() RETURNING id, org_id`);
  const b = await db.query(`UPDATE jobs SET status='failed', finished_at=now(), error='the device stopped reporting while running this job' WHERE status='running' AND started_at + make_interval(secs => timeout_seconds * 2 + 60) <= now() RETURNING id, org_id`);
  for (const row of [...a.rows, ...b.rows])
    await db.query(`INSERT INTO audit_log(org_id,actor_type,action,target_type,target_id,next,result) VALUES ($1,'system','job.timeout','job',$2,'{"status":"failed"}','failed')`, [row.org_id, row.id]);
  return a.rowCount! + b.rowCount!;
}
export { TERMINAL };
