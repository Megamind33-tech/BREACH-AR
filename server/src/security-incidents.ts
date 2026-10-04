import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import { createSystemJob, type JobCtx, type JobSigner } from './jobs.js';

/**
 * Security incident workflow. Microsoft Defender is the detection engine; Viro does not pretend otherwise. What Viro adds is everything after
 * detection: contain, look for what the threat changed, repair only with approval and only with approved recipes, verify with a fresh scan and
 * re-inspection, then observe. A threat is RESOLVED only after all of that, never because a command returned exit code 0.
 *
 *   DETECTED -> CONTAINING -> QUARANTINED -> INVESTIGATING -> REPAIR_READY -> REPAIRING -> VERIFYING -> OBSERVING -> RESOLVED
 *   (ADMIN_ACTION_REQUIRED whenever Viro cannot go on safely or cannot verify; UNRESOLVED when verification fails)
 */
export type SecStatus = 'DETECTED' | 'CONTAINING' | 'QUARANTINED' | 'INVESTIGATING' | 'REPAIR_READY' | 'REPAIRING' | 'VERIFYING' | 'OBSERVING' | 'RESOLVED' | 'UNRESOLVED' | 'ADMIN_ACTION_REQUIRED';
export const OPEN_SEC: SecStatus[] = ['DETECTED', 'CONTAINING', 'QUARANTINED', 'INVESTIGATING', 'REPAIR_READY', 'REPAIRING', 'VERIFYING', 'OBSERVING', 'ADMIN_ACTION_REQUIRED', 'UNRESOLVED'];
export const OBSERVATION_HOURS = 24;
const RECENT_DAYS = 3, REOPEN_DAYS = 14;

export interface Threat { name: string; severity: string; active?: boolean; detectedAt?: string | null; remediated?: boolean | null; resources?: string[] }

export function threatType(name: string): 'malware' | 'ransomware' | 'pua' | 'other' {
  if (/ransom/i.test(name)) return 'ransomware';
  if (/^(PUA|PUP)[:/]|adware|browsermodifier|hijack|unwanted/i.test(name)) return 'pua';
  if (/trojan|virus|worm|backdoor|spyware|stealer|rootkit|exploit|keylog|miner|dropper|downloader|eicar|malware|behavior:/i.test(name)) return 'malware';
  return 'other';
}

export const threatPathsOf = (resources: string[] | undefined) => [...new Set((resources ?? []).map(r => r.replace(/^(file|folder|regkey|process|webfile):_?/i, '').trim()).filter(p => p.length > 3 && /^[A-Za-z]:\\/.test(p)))].slice(0, 20);

/** Checklist that must all pass before an incident may be called clean. Every line is a real measurement, or it is reported as not verified. */
export interface Verification { threatGone: boolean | null; scanClean: boolean | null; noLinkedPersistence: boolean | null; protectionHealthy: boolean | null; policyRestored: boolean | null; unverifiableReason?: string }
export function verdict(v: Verification): 'clean' | 'failed' | 'unverifiable' {
  if (v.unverifiableReason || v.scanClean === null || v.threatGone === null) return 'unverifiable';
  return v.threatGone && v.scanClean && v.noLinkedPersistence !== false && v.protectionHealthy !== false && v.policyRestored !== false ? 'clean' : 'failed';
}

interface Row { id: string; org_id: string; device_id: string; threat_type: string; threat_name: string; status: SecStatus; evidence: any; proposed_actions: any[]; jobs: Record<string, any>; observe_until: string | null; detected_at: string; verification: any }
type JobRow = { id: string; status: string; result: any; error: string | null };

const audit = (db: Db, r: { org_id: string; device_id: string }, action: string, next: object) =>
  db.query(`INSERT INTO audit_log(org_id,actor_type,action,target_type,target_id,next) VALUES ($1,'system',$2,'device',$3,$4)`, [r.org_id, action, r.device_id, JSON.stringify(next)]);

async function move(db: Db, r: Row, status: SecStatus, event: string, detail: string, patch: Record<string, unknown> = {}) {
  const sets = ['status=$2', 'updated_at=now()', `timeline = timeline || $3::jsonb`]; const vals: unknown[] = [r.id, status, JSON.stringify([{ at: new Date().toISOString(), event, detail }])];
  for (const [k, v] of Object.entries(patch)) { vals.push(typeof v === 'object' && v !== null && !(v instanceof Date) ? JSON.stringify(v) : v); sets.push(`${k}=$${vals.length}`); }
  await db.query(`UPDATE security_incidents SET ${sets.join(', ')} WHERE id=$1`, vals);
  await audit(db, r, 'security_incident.' + status.toLowerCase(), { incident: r.id, threat: r.threat_name, event });
  r.status = status;
}

const jobOf = async (db: Db, id: string | undefined): Promise<JobRow | null> => id ? ((await db.query(`SELECT id, status, result, error FROM jobs WHERE id=$1`, [id])).rows[0] ?? null) : null;
const finished = (j: JobRow | null) => !!j && !['queued', 'running'].includes(j.status);

export async function securityTick(db: Db, signer: JobSigner, now = new Date()): Promise<void> {
  await detect(db, now);
  const open = (await db.query(`SELECT * FROM security_incidents WHERE status = ANY($1::text[]) ORDER BY created_at`, [OPEN_SEC.filter(s => s !== 'UNRESOLVED' && s !== 'ADMIN_ACTION_REQUIRED')])).rows as Row[];
  for (const r of open) { try { await advance(db, signer, r, now); } catch (e) { console.error('security incident tick failed', r.id, e); } }
}

/** New detections become incidents. Only recent detections: the 30-day history Defender keeps is not replayed. */
async function detect(db: Db, now: Date) {
  const rows = (await db.query(`SELECT d.id AS device_id, d.org_id, h.snapshot->'security' AS sec FROM device_health h JOIN devices d ON d.id=h.device_id
                                  WHERE d.revoked_at IS NULL AND jsonb_array_length(COALESCE(h.snapshot->'security'->'threats','[]'::jsonb)) > 0`)).rows;
  for (const d of rows) {
    if (d.sec?.engineIsDefender === false) continue;      // another antivirus is in charge: its detections are not visible here, and Viro does not guess
    for (const t of (d.sec.threats ?? []) as Threat[]) {
      if (!t.detectedAt) continue;
      const at = new Date(t.detectedAt); if (!(at.getTime() > now.getTime() - RECENT_DAYS * 86_400_000)) continue;
      const exists = await db.query(`SELECT 1 FROM security_incidents WHERE device_id=$1 AND threat_name=$2 AND detected_at=$3`, [d.device_id, t.name, at]);
      if (exists.rowCount) continue;
      const prev = (await db.query(`SELECT id FROM security_incidents WHERE device_id=$1 AND threat_name=$2 AND status IN ('RESOLVED','OBSERVING') AND updated_at > $3 ORDER BY created_at DESC LIMIT 1`, [d.device_id, t.name, new Date(now.getTime() - REOPEN_DAYS * 86_400_000)])).rows[0];
      const type = threatType(t.name);
      const r = await db.query(`INSERT INTO security_incidents(org_id,device_id,threat_type,threat_name,severity,detected_at,evidence,timeline,reopened_from) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                                ON CONFLICT DO NOTHING RETURNING id`,
        [d.org_id, d.device_id, type, t.name, t.severity ?? 'unknown', at, JSON.stringify({ threat: t, threatPaths: threatPathsOf(t.resources) }), JSON.stringify([{ at: now.toISOString(), event: 'detected', detail: `${t.name} (${t.severity}) reported by Microsoft Defender${prev ? '; it came back after an earlier incident' : ''}` }]), prev?.id ?? null]);
      if (r.rowCount) await audit(db, { org_id: d.org_id, device_id: d.device_id }, 'security_incident.detected', { incident: r.rows[0].id, threat: t.name, type });
      if (prev) await db.query(`UPDATE security_incidents SET status='UNRESOLVED', updated_at=now(), timeline = timeline || $2::jsonb WHERE id=$1 AND status IN ('RESOLVED','OBSERVING')`, [prev.id, JSON.stringify([{ at: now.toISOString(), event: 'recurred', detail: 'the same threat was detected again' }])]);
    }
  }
}

async function queue(db: Db, signer: JobSigner, r: Row, type: string, params: Record<string, unknown>, key: string): Promise<string | null> {
  const id = await createSystemJob(db, signer, { orgId: r.org_id, deviceId: r.device_id, type, params, ttlMinutes: 24 * 60, source: { securityIncident: r.id, step: key } });
  if (id) { r.jobs[key] = id; await db.query(`UPDATE security_incidents SET jobs = jobs || $2::jsonb WHERE id=$1`, [r.id, JSON.stringify({ [key]: id })]); }
  return id;
}

async function advance(db: Db, signer: JobSigner, r: Row, now: Date) {
  const threat: Threat = r.evidence?.threat ?? { name: r.threat_name, severity: 'unknown' };
  const paths: string[] = r.evidence?.threatPaths ?? [];
  switch (r.status) {
    case 'DETECTED': {
      if (threat.active && !threat.remediated) {
        if (!(await queue(db, signer, r, 'security.remediate', {}, 'remediate'))) return move(db, r, 'ADMIN_ACTION_REQUIRED', 'containment', 'the containment job could not be created');
        return move(db, r, 'CONTAINING', 'containing', 'Microsoft Defender is asked to remove the active threat', { containment_action: 'Remove-MpThreat (Microsoft Defender)' });
      }
      return move(db, r, 'QUARANTINED', 'contained', 'Microsoft Defender had already quarantined or removed it', { containment_action: 'Quarantined by Microsoft Defender', removal_action: 'Microsoft Defender' });
    }
    case 'CONTAINING': {
      const j = await jobOf(db, r.jobs.remediate); if (!finished(j)) return;
      if (j!.status === 'completed') return move(db, r, 'QUARANTINED', 'contained', 'the threat was removed by Microsoft Defender', { removal_action: 'Remove-MpThreat (Microsoft Defender)' });
      return move(db, r, 'ADMIN_ACTION_REQUIRED', 'containment failed', j!.error ?? 'containment did not complete; the computer still has an active threat');
    }
    case 'QUARANTINED': {
      await queue(db, signer, r, 'security.investigate', { threatPaths: paths }, 'investigate');
      return move(db, r, 'INVESTIGATING', 'investigating', 'checking startup entries, scheduled tasks, proxy, DNS, hosts file and Defender settings for what the threat changed');
    }
    case 'INVESTIGATING': {
      const j = await jobOf(db, r.jobs.investigate); if (!finished(j)) return;
      if (j!.status !== 'completed') return move(db, r, 'ADMIN_ACTION_REQUIRED', 'investigation failed', j!.error ?? 'the computer could not be inspected');
      const findings = (j!.result?.findings ?? []) as { kind: string; suspicious: boolean; confidence: string; location: string; name: string; recipe: string | null; evidence: string }[];
      const persistence = findings.some(f => ['startup-entry', 'scheduled-task', 'service'].includes(f.kind) && f.suspicious);
      const actions = proposedActions(findings, paths);
      const evidence = { ...r.evidence, findings, investigatedAt: j!.result?.investigatedAt, limits: j!.result?.limits };
      if (actions.length) return move(db, r, 'REPAIR_READY', 'repair ready', `${actions.length} approved repair(s) are proposed; an administrator must approve them`, { evidence, proposed_actions: actions, persistence_found: persistence });
      await db.query(`UPDATE security_incidents SET evidence=$2, persistence_found=$3 WHERE id=$1`, [r.id, JSON.stringify(evidence), persistence]); r.evidence = evidence;
      return startVerification(db, signer, r, 'nothing else the threat changed could be found; verifying');
    }
    case 'REPAIRING': {
      const ids: string[] = r.jobs.repairs ?? []; const js = await Promise.all(ids.map(i => jobOf(db, i)));
      if (!js.every(finished)) return;
      const bad = js.filter(j => j!.status !== 'completed' || j!.result?.verified === false);
      if (bad.length) return move(db, r, 'ADMIN_ACTION_REQUIRED', 'repair failed', `${bad.length} repair(s) did not complete or could not be verified; they were rolled back where possible`);
      return startVerification(db, signer, r, 'repairs completed; verifying with a fresh scan and inspection');
    }
    case 'VERIFYING': {
      const js = { scan: await jobOf(db, r.jobs.vscan), status: await jobOf(db, r.jobs.vstatus), inspect: await jobOf(db, r.jobs.vinspect) };
      if (!finished(js.scan) || !finished(js.status) || !finished(js.inspect)) return;
      const v = verification(js, r.threat_name);
      const res = verdict(v);
      if (res === 'clean') return move(db, r, 'OBSERVING', 'verified clean', 'fresh scan clean, threat gone, no linked persistence, protection healthy; now observing', { verification: v, verification_status: 'clean', observe_until: new Date(now.getTime() + OBSERVATION_HOURS * 3_600_000) });
      if (res === 'unverifiable') return move(db, r, 'ADMIN_ACTION_REQUIRED', 'cannot verify', v.unverifiableReason ?? 'the result could not be measured, so Viro will not call this clean', { verification: v, verification_status: 'unverifiable' });
      return move(db, r, 'UNRESOLVED', 'verification failed', 'the threat or something it changed is still present', { verification: v, verification_status: 'failed' });
    }
    case 'OBSERVING': {
      if (r.observe_until && new Date(r.observe_until) <= now) return move(db, r, 'RESOLVED', 'resolved', `no recurrence for ${OBSERVATION_HOURS} hours after verification`, { resolved_at: now });
      return;
    }
  }
}

export function proposedActions(findings: { kind: string; suspicious: boolean; confidence: string; location: string; name: string; recipe: string | null; evidence: string }[], threatPaths: string[]) {
  const by = new Map<string, typeof findings>();
  for (const f of findings) if (f.suspicious && f.recipe) by.set(f.recipe, [...(by.get(f.recipe) ?? []), f]);
  return [...by.entries()].map(([recipe, fs]) => ({
    recipe, evidence: fs.map(f => f.evidence), confidence: fs.some(f => f.confidence === 'HIGH') ? 'HIGH' : 'MEDIUM',
    options: recipe === 'security.remove-persistence' ? { threatPaths, entries: fs.filter(f => f.confidence === 'HIGH').map(f => ({ location: f.location, name: f.name })).slice(0, 50) } : undefined,
  })).filter(a => a.recipe !== 'security.remove-persistence' || (a.options?.entries.length ?? 0) > 0);
}

async function startVerification(db: Db, signer: JobSigner, r: Row, detail: string) {
  const a = await queue(db, signer, r, 'security.scan', { scanType: 'quick' }, 'vscan');
  const b = await queue(db, signer, r, 'security.status', {}, 'vstatus');
  const c = await queue(db, signer, r, 'security.investigate', { threatPaths: r.evidence?.threatPaths ?? [] }, 'vinspect');
  if (!a || !b || !c) return move(db, r, 'ADMIN_ACTION_REQUIRED', 'verification', 'the verification jobs could not be created');
  return move(db, r, 'VERIFYING', 'verifying', detail);
}

/** Turns the three verification jobs into the checklist. A scan that could not run is "not verified", never "clean". */
export function verification(js: { scan: JobRow | null; status: JobRow | null; inspect: JobRow | null }, threatName: string): Verification {
  const v: Verification = { threatGone: null, scanClean: null, noLinkedPersistence: null, protectionHealthy: null, policyRestored: null };
  if (js.scan?.status !== 'completed') { v.unverifiableReason = js.scan?.error ? `a fresh scan could not be run: ${js.scan.error}` : 'a fresh scan could not be run'; }
  else v.scanClean = true;
  const st = js.status?.status === 'completed' ? js.status.result : null;
  if (st) {
    const still = ((st.threats ?? []) as Threat[]).some(t => t.name === threatName && t.active);
    v.threatGone = !still; if (still) v.scanClean = false;
    v.protectionHealthy = st.engineIsDefender === true && st.behaviorMonitor !== false && st.tamperProtection !== false;
  }
  const ins = js.inspect?.status === 'completed' ? js.inspect.result : null;
  if (ins) {
    const f = (ins.findings ?? []) as { suspicious: boolean; confidence: string; kind: string }[];
    v.noLinkedPersistence = !f.some(x => x.suspicious && x.confidence === 'HIGH' && ['startup-entry', 'scheduled-task', 'service'].includes(x.kind));
    v.policyRestored = !f.some(x => x.suspicious && x.kind === 'security-setting' || x.suspicious && x.kind === 'hosts' && x.confidence === 'HIGH');
  }
  return v;
}

// ---- routes ------------------------------------------------------------------------------------------------------
export function registerSecurityIncidentRoutes(app: FastifyInstance, c: JobCtx & { signer: JobSigner }) {
  const { db } = c;
  const cols = `s.id, s.device_id, d.hostname, s.threat_type, s.threat_name, s.source, s.severity, s.detected_at, s.status, s.containment_action, s.removal_action, s.persistence_found, s.verification_status, s.resolved_at, s.observe_until, s.reopened_from, s.created_at, s.updated_at`;

  app.get('/api/v1/security-incidents', { preHandler: c.requireRole('viewer') }, async req => {
    const q = z.object({ status: z.string().optional(), deviceId: z.string().uuid().optional(), open: z.enum(['true', 'false']).optional() }).parse(req.query);
    const vals: unknown[] = [req.user.org]; let where = 's.org_id=$1';
    if (q.status) { vals.push(q.status); where += ` AND s.status=$${vals.length}`; }
    if (q.deviceId) { vals.push(q.deviceId); where += ` AND s.device_id=$${vals.length}`; }
    if (q.open === 'true') where += ` AND s.status <> 'RESOLVED'`;
    const r = await db.query(`SELECT ${cols} FROM security_incidents s JOIN devices d ON d.id=s.device_id WHERE ${where} ORDER BY s.created_at DESC LIMIT 200`, vals);
    const counts = (await db.query(`SELECT threat_type, status, count(*)::int n FROM security_incidents WHERE org_id=$1 GROUP BY 1,2`, [req.user.org])).rows;
    return { incidents: r.rows, counts };
  });

  app.get('/api/v1/security-incidents/:id', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await db.query(`SELECT ${cols}, s.evidence, s.proposed_actions, s.verification, s.timeline FROM security_incidents s JOIN devices d ON d.id=s.device_id WHERE s.id=$1 AND s.org_id=$2`, [id, req.user.org]);
    return r.rowCount ? r.rows[0] : reply.code(404).send({ error: 'not found' });
  });

  /** An administrator approves named repairs from the ones Viro proposed. Nothing outside the proposal can be requested. */
  app.post('/api/v1/security-incidents/:id/approve', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ recipes: z.array(z.string().max(60)).min(1).max(10) }).strict().parse(req.body);
    const row = (await db.query(`SELECT * FROM security_incidents WHERE id=$1 AND org_id=$2`, [id, req.user.org])).rows[0] as Row | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (row.status !== 'REPAIR_READY') return reply.code(409).send({ error: `this incident is ${row.status}; repairs can be approved only when it is REPAIR_READY` });
    const chosen = row.proposed_actions.filter((a: any) => b.recipes.includes(a.recipe));
    if (chosen.length !== b.recipes.length) return reply.code(400).send({ error: 'only repairs Viro proposed for this incident can be approved' });
    const ids: string[] = [];
    for (const a of chosen) { const j = await createSystemJob(db, c.signer, { orgId: row.org_id, deviceId: row.device_id, type: 'repair.run', params: { recipe: a.recipe, approved: true, ...(a.options ? { options: a.options } : {}) }, ttlMinutes: 24 * 60, source: { securityIncident: id, approvedBy: req.user.sub } }); if (j) ids.push(j); }
    if (!ids.length) return reply.code(500).send({ error: 'no repair could be queued' });
    await move(db, row, 'REPAIRING', 'repair approved', `approved by an administrator: ${b.recipes.join(', ')}`, { jobs: { ...row.jobs, repairs: ids } });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'security_incident.approve', targetType: 'security_incident', targetId: id, next: { recipes: b.recipes } });
    return reply.code(202).send({ status: 'REPAIRING', jobs: ids });
  });

  /** Skip repairs: verify what is there now. Used when an administrator decides the flagged items are legitimate. */
  app.post('/api/v1/security-incidents/:id/verify', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = (await db.query(`SELECT * FROM security_incidents WHERE id=$1 AND org_id=$2`, [id, req.user.org])).rows[0] as Row | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (!['REPAIR_READY', 'ADMIN_ACTION_REQUIRED', 'UNRESOLVED'].includes(row.status)) return reply.code(409).send({ error: `this incident is ${row.status}` });
    await startVerification(db, c.signer, row, 'verification requested by an administrator');
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'security_incident.verify', targetType: 'security_incident', targetId: id });
    return reply.code(202).send({ status: 'VERIFYING' });
  });
}
