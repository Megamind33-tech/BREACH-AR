import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import { createSystemJob, type JobCtx, type JobSigner } from './jobs.js';
import { attachRepairJob } from './incidents.js';
import { breakdown, syncPatterns, type GroupBy } from './fleet-intel.js';

/**
 * Staged remediation of a fleet-wide problem: repair one computer, check that the problem is really gone there, repair a small pilot
 * group, check again, then everyone else. A failed or ineffective repair halts the rollout, cancels repairs that have not started, and
 * flags the pattern. "Verified" always means the incident on that computer reached OBSERVING or RESOLVED (symptom gone after the repair);
 * a finished job alone verifies nothing.
 */
const REPAIRABLE = ['REPAIR_READY', 'ADMIN_APPROVAL_REQUIRED', 'UNRESOLVED', 'IMPROVED'];

async function repairableDevices(db: Db, orgId: string, code: string, deviceIds: string[], exclude: string[]): Promise<{ id: string; tags: string[]; score: number | null; online: boolean }[]> {
  const r = await db.query(
    `SELECT d.id, d.tags, d.last_seen_at > now() - interval '10 minutes' AS online, (SELECT overall FROM device_health_history h WHERE h.device_id=d.id ORDER BY h.id DESC LIMIT 1) AS score
       FROM devices d JOIN incidents i ON i.device_id=d.id AND i.code=$3 AND i.status = ANY($4::text[])
      WHERE d.org_id=$1 AND d.revoked_at IS NULL AND d.id = ANY($2::uuid[]) AND NOT (d.id = ANY($5::uuid[]))`, [orgId, deviceIds, code, REPAIRABLE, exclude]);
  return r.rows.map(x => ({ id: x.id, tags: x.tags ?? [], score: x.score, online: !!x.online }));
}

async function startStage(db: Db, signer: JobSigner, orgId: string, rolloutId: string, stage: string, fix: any, code: string, deviceIds: string[], by: 'user' | 'autopilot'): Promise<number> {
  let n = 0;
  for (const dev of deviceIds) {
    const job = await createSystemJob(db, signer, { orgId, deviceId: dev, type: fix.jobType, params: fix.params, ttlMinutes: 24 * 60, source: { rolloutId, stage, by } });
    if (!job) continue;
    await attachRepairJob(db, dev, code, job, by);
    await db.query(`INSERT INTO rollout_devices(rollout_id,device_id,org_id,stage,install_job,detail) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [rolloutId, dev, orgId, stage, job, code]);
    n++;
  }
  return n;
}

export async function startFixRollout(db: Db, signer: JobSigner, orgId: string, patternId: string, by: 'user' | 'autopilot', userId: string | null): Promise<{ id: string } | { error: string; code: number }> {
  const p = (await db.query(`SELECT * FROM fleet_patterns WHERE id=$1 AND org_id=$2`, [patternId, orgId])).rows[0];
  if (!p) return { error: 'not found', code: 404 };
  if (!p.fix) return { error: 'Viro has no automatic fix for this problem; follow the recommendation.', code: 409 };
  if ((await db.query(`SELECT 1 FROM rollouts WHERE org_id=$1 AND kind='fix' AND subject_id=$2 AND status='active'`, [orgId, patternId])).rowCount) return { error: 'a repair for this problem is already in progress', code: 409 };
  const cands = await repairableDevices(db, orgId, p.code, p.device_ids, []);
  if (!cands.length) return { error: 'no affected computer is ready to be repaired right now', code: 409 };
  const test = cands.filter(c => c.online).sort((a, b) => Number(b.tags.includes('pilot')) - Number(a.tags.includes('pilot')) || (b.score ?? 0) - (a.score ?? 0))[0];
  if (!test) return { error: 'no affected computer is online to test the repair on', code: 409 };
  const r = await db.query(`INSERT INTO rollouts(org_id,kind,subject_id,title,meta,created_by) VALUES ($1,'fix',$2,$3,$4,$5) RETURNING id`, [orgId, patternId, p.title, JSON.stringify({ patternId, code: p.code, fix: p.fix, deviceIds: p.device_ids, by }), userId]);
  await startStage(db, signer, orgId, r.rows[0].id, 'test', p.fix, p.code, [test.id], by);
  await db.query(`UPDATE fleet_patterns SET status='REMEDIATING' WHERE id=$1`, [patternId]);
  return { id: r.rows[0].id };
}

/** Moves a fix rollout to its next stage. Returns devices started, or an error. */
async function advance(db: Db, signer: JobSigner, ro: any, stage: 'pilot' | 'fleet', by: 'user' | 'autopilot'): Promise<{ started: number } | { error: string }> {
  const order = ['test', 'pilot', 'fleet']; if (order.indexOf(stage) !== order.indexOf(ro.stage) + 1) return { error: `next stage after "${ro.stage}" is "${order[order.indexOf(ro.stage) + 1] ?? 'none'}"` };
  const cur = (await db.query(`SELECT status FROM rollout_devices WHERE rollout_id=$1 AND stage=$2`, [ro.id, ro.stage])).rows;
  if (!cur.length || cur.some(x => x.status !== 'verified')) return { error: `every computer in the "${ro.stage}" stage must be repaired and verified first (${cur.filter(x => x.status === 'verified').length}/${cur.length} verified)` };
  const done = (await db.query('SELECT device_id FROM rollout_devices WHERE rollout_id=$1', [ro.id])).rows.map(x => x.device_id as string);
  const pool = await repairableDevices(db, ro.org_id, ro.meta.code, ro.meta.deviceIds, done);
  if (!pool.length) return { error: 'no other affected computers are ready to be repaired' };
  const chosen = stage === 'pilot'
    ? (pool.some(p => p.tags.includes('pilot')) ? pool.filter(p => p.tags.includes('pilot')) : pool.slice(0, Math.max(2, Math.ceil(pool.length * 0.1)))).map(p => p.id)
    : pool.map(p => p.id);
  await db.query('UPDATE rollouts SET stage=$2 WHERE id=$1', [ro.id, stage]);
  return { started: await startStage(db, signer, ro.org_id, ro.id, stage, ro.meta.fix, ro.meta.code, chosen, by) };
}

export async function fixRolloutTick(db: Db, signer: JobSigner): Promise<number> {
  let changed = 0;
  const rows = (await db.query(`SELECT rd.*, r.meta, r.title FROM rollout_devices rd JOIN rollouts r ON r.id=rd.rollout_id WHERE r.kind='fix' AND r.status='active' AND rd.status IN ('queued','installed')`)).rows;
  for (const rd of rows) {
    const fail = async (why: string) => {
      await db.query(`UPDATE rollout_devices SET status='failed', detail=$3, updated_at=now() WHERE rollout_id=$1 AND device_id=$2`, [rd.rollout_id, rd.device_id, why]);
      await db.query(`UPDATE rollouts SET status='halted', halt_reason=$2 WHERE id=$1 AND status='active'`, [rd.rollout_id, `${why} (${rd.device_id})`]);
      await db.query(`UPDATE jobs SET status='cancelled', finished_at=now(), error='rollout halted' WHERE status='queued' AND id IN (SELECT install_job FROM rollout_devices WHERE rollout_id=$1 AND status='queued')`, [rd.rollout_id]);
      await db.query(`UPDATE rollout_devices SET status='failed', detail='cancelled: rollout halted', updated_at=now() WHERE rollout_id=$1 AND status='queued'`, [rd.rollout_id]);
      await db.query(`UPDATE fleet_patterns SET status='FLAGGED' WHERE id=$1`, [rd.meta.patternId]);
      changed++;
    };
    const job = (await db.query('SELECT status, error, created_at FROM jobs WHERE id=$1', [rd.install_job])).rows[0];
    if (job && (job.status === 'failed' || job.status === 'cancelled') && rd.status === 'queued') { await fail(`repair job ${job.status}${job.error ? ': ' + job.error : ''}`); continue; }
    const inc = (await db.query(`SELECT status, repaired_at, title FROM incidents WHERE device_id=$1 AND code=$2 ORDER BY first_detected DESC LIMIT 1`, [rd.device_id, rd.meta.code])).rows[0];
    if (!inc?.repaired_at || (job && new Date(inc.repaired_at) < new Date(job.created_at))) continue;          // the repair has not run yet (queued, or deferred because the application is open)
    if (inc.status === 'OBSERVING' || inc.status === 'RESOLVED') { await db.query(`UPDATE rollout_devices SET status='verified', detail=NULL, updated_at=now() WHERE rollout_id=$1 AND device_id=$2`, [rd.rollout_id, rd.device_id]); changed++; }
    else if (['UNRESOLVED', 'IMPROVED', 'ADMIN_APPROVAL_REQUIRED'].includes(inc.status)) await fail(`the repair did not fix "${inc.title}" on this computer`);
    else if (rd.status === 'queued') { await db.query(`UPDATE rollout_devices SET status='installed', updated_at=now() WHERE rollout_id=$1 AND device_id=$2`, [rd.rollout_id, rd.device_id]); changed++; }
  }
  // Autopilot: a verified stage widens by itself when the organization allows it; a fully verified fleet stage completes the rollout.
  const ready = (await db.query(
    `SELECT r.* FROM rollouts r WHERE r.kind='fix' AND r.status='active' AND EXISTS (SELECT 1 FROM rollout_devices rd WHERE rd.rollout_id=r.id AND rd.stage=r.stage)
        AND NOT EXISTS (SELECT 1 FROM rollout_devices rd WHERE rd.rollout_id=r.id AND rd.stage=r.stage AND rd.status <> 'verified')`)).rows;
  for (const ro of ready) {
    const auto = (await db.query(`SELECT 1 FROM policies p WHERE p.org_id=$1 AND p.enabled AND (p.settings->'autoRepair'->>'driverRollouts')::boolean IS TRUE`, [ro.org_id])).rowCount;
    if (ro.stage === 'fleet') { await db.query(`UPDATE rollouts SET status='completed' WHERE id=$1`, [ro.id]); await db.query(`UPDATE fleet_patterns SET status='REMEDIATED' WHERE id=$1`, [ro.meta.patternId]); changed++; continue; }
    if (!auto) continue;
    const res = await advance(db, signer, ro, ro.stage === 'test' ? 'pilot' : 'fleet', 'autopilot');
    if ('started' in res) {
      changed++;
      await db.query(`INSERT INTO audit_log(org_id,actor_type,action,target_type,target_id,previous,next) VALUES ($1,'system','fix_rollout.advance','rollout',$2,$3,$4)`, [ro.org_id, ro.id, JSON.stringify({ stage: ro.stage }), JSON.stringify({ stage: ro.stage === 'test' ? 'pilot' : 'fleet', devices: res.started, by: 'autopilot' })]);
    } else if (/no other affected/.test(res.error)) { await db.query(`UPDATE rollouts SET status='completed' WHERE id=$1`, [ro.id]); await db.query(`UPDATE fleet_patterns SET status='REMEDIATED' WHERE id=$1`, [ro.meta.patternId]); changed++; }
  }
  return changed;
}

export function registerFleetIntelRoutes(app: FastifyInstance, c: JobCtx & { signer: JobSigner }) {
  const { db } = c;
  const uuid = z.string().uuid();

  app.get('/api/v1/fleet/patterns', { preHandler: c.requireRole('viewer') }, async req => ({ patterns: await syncPatterns(db, req.user.org) }));

  app.post('/api/v1/fleet/patterns/:id/remediate', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await startFixRollout(db, c.signer, req.user.org, id, 'user', req.user.sub);
    if ('error' in r) return reply.code(r.code).send({ error: r.error });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'fix_rollout.start', targetType: 'rollout', targetId: r.id, next: { patternId: id } });
    return reply.code(201).send({ id: r.id, stage: 'test' });
  });

  app.post('/api/v1/fleet/patterns/:id/dismiss', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query(`UPDATE fleet_patterns SET status='DISMISSED' WHERE id=$1 AND org_id=$2 RETURNING id`, [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'fleet_pattern.dismiss', targetType: 'fleet_pattern', targetId: id });
    return { ok: true };
  });

  app.get('/api/v1/fleet/breakdown', { preHandler: c.requireRole('viewer') }, async req => {
    const q = z.object({ by: z.enum(['site', 'department', 'model', 'os']).default('site') }).parse(req.query);
    return { by: q.by, groups: await breakdown(db, req.user.org, q.by as GroupBy) };
  });

  const view = async (orgId: string, id: string) => {
    const r = (await db.query(`SELECT * FROM rollouts WHERE id=$1 AND org_id=$2 AND kind='fix'`, [id, orgId])).rows[0]; if (!r) return null;
    const devs = (await db.query(`SELECT rd.stage, rd.status, rd.detail, d.hostname, rd.device_id FROM rollout_devices rd JOIN devices d ON d.id=rd.device_id WHERE rd.rollout_id=$1 ORDER BY rd.stage, d.hostname`, [id])).rows;
    return { id: r.id, title: r.title, stage: r.stage, status: r.status, haltReason: r.halt_reason, patternId: r.meta.patternId, createdAt: r.created_at, devices: devs };
  };
  app.get('/api/v1/fix-rollouts', { preHandler: c.requireRole('viewer') }, async req => {
    const rows = (await db.query(`SELECT r.id, r.title, r.stage, r.status, r.halt_reason, r.created_at, (SELECT count(*)::int FROM rollout_devices rd WHERE rd.rollout_id=r.id) AS devices, (SELECT count(*)::int FROM rollout_devices rd WHERE rd.rollout_id=r.id AND rd.status='verified') AS verified
                                    FROM rollouts r WHERE r.org_id=$1 AND r.kind='fix' ORDER BY r.created_at DESC LIMIT 50`, [req.user.org])).rows;
    return { rollouts: rows };
  });
  app.get('/api/v1/fix-rollouts/:id', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const v = await view(req.user.org, id); return v ?? reply.code(404).send({ error: 'not found' });
  });
  app.post('/api/v1/fix-rollouts/:id/advance', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ stage: z.enum(['pilot', 'fleet']) }).strict().parse(req.body);
    const ro = (await db.query(`SELECT * FROM rollouts WHERE id=$1 AND org_id=$2 AND kind='fix'`, [id, req.user.org])).rows[0];
    if (!ro) return reply.code(404).send({ error: 'not found' });
    if (ro.status !== 'active') return reply.code(409).send({ error: `rollout is ${ro.status}${ro.halt_reason ? ': ' + ro.halt_reason : ''}` });
    const res = await advance(db, c.signer, ro, b.stage, 'user'); if ('error' in res) return reply.code(409).send({ error: res.error });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'fix_rollout.advance', targetType: 'rollout', targetId: id, previous: { stage: ro.stage }, next: { stage: b.stage, devices: res.started } });
    return { stage: b.stage, devices: res.started };
  });
  app.post('/api/v1/fix-rollouts/:id/halt', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query(`UPDATE rollouts SET status='halted', halt_reason='halted by an administrator' WHERE id=$1 AND org_id=$2 AND kind='fix' AND status='active' RETURNING meta`, [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found or not active' });
    await db.query(`UPDATE jobs SET status='cancelled', finished_at=now(), error='rollout halted' WHERE status='queued' AND id IN (SELECT install_job FROM rollout_devices WHERE rollout_id=$1 AND status='queued')`, [id]);
    await db.query(`UPDATE fleet_patterns SET status='DETECTED' WHERE id=$1`, [r.rows[0].meta.patternId]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'fix_rollout.halt', targetType: 'rollout', targetId: id });
    return { ok: true };
  });
}
