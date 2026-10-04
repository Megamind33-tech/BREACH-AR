import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import type { JobSigner } from './jobs.js';
import { cmpVersion } from './patching.js';

/* ------------------------------------------------------------------------------------------------
 * Agent updates. A release is a zip signed by manifest (SHA-256 + size + inner exe hash, ECDSA with the same key agents
 * already pin). Rollout is staged internal -> pilot -> 10% -> 50% -> 100% and halts itself when devices fail to update.
 * ---------------------------------------------------------------------------------------------- */
export const STAGES = ['internal', 'pilot', '10', '50', '100'] as const;
export type Stage = typeof STAGES[number];
type Ring = 'internal' | 'pilot' | 'stable';

/** Stable 0-99 bucket per device so a 10% rollout is always the same 10% (and a subset of the 50%). */
export const bucketOf = (deviceId: string) => parseInt(createHash('sha256').update(deviceId).digest('hex').slice(0, 8), 16) % 100;

export function eligible(stage: Stage, ring: Ring, deviceId: string): boolean {
  if (stage === 'internal') return ring === 'internal';
  if (stage === 'pilot') return ring === 'internal' || ring === 'pilot';
  return ring !== 'stable' || bucketOf(deviceId) < Number(stage);
}

export interface Offer { version: string; url: string; manifest: string; signature: string; sha256: string; size: number }

/** The release this device should move to, if any: the newest active release it is eligible for and is older than. */
export async function offerFor(db: Db, device: { id: string; agentVersion: string | null; ring: Ring }): Promise<Offer | null> {
  const r = await db.query(`SELECT version, manifest, signature, sha256, size_bytes, stage FROM agent_releases WHERE status='active'`);
  const best = r.rows.filter(x => eligible(x.stage, device.ring, device.id) && (!device.agentVersion || cmpVersion(x.version, device.agentVersion) > 0)).sort((a, b) => cmpVersion(b.version, a.version))[0];
  return best ? { version: best.version, url: `/agent/v1/releases/${best.version}/download`, manifest: best.manifest, signature: best.signature, sha256: best.sha256, size: Number(best.size_bytes) } : null;
}

/** Update outcomes reported by agents. Enough failures halt the release so it never reaches the rest of the fleet. */
export async function recordUpdateEvent(db: Db, orgId: string, deviceId: string, e: { version: string; status: 'ok' | 'rolled_back' | 'failed'; detail?: string }) {
  await db.query('INSERT INTO agent_update_events(device_id,org_id,version,status,detail) VALUES ($1,$2,$3,$4,$5)', [deviceId, orgId, e.version, e.status, e.detail ?? null]);
  if (e.status === 'ok') return;
  const s = (await db.query(`SELECT count(DISTINCT device_id) FILTER (WHERE status IN ('rolled_back','failed'))::int bad, count(DISTINCT device_id)::int total FROM agent_update_events WHERE version=$1`, [e.version])).rows[0];
  if (s.bad >= 3 && s.bad / s.total >= 0.2)
    await db.query(`UPDATE agent_releases SET status='halted', halt_reason=$2 WHERE version=$1 AND status='active'`, [e.version, `${s.bad} of ${s.total} devices failed to update or had to roll back`]);
}

export interface Integrity { exeSha256?: string; signed?: boolean; signatureTrusted?: boolean; signer?: string | null; serviceOk?: boolean | null; serviceIssue?: string | null; dataDirProtected?: boolean | null; installedPath?: string | null }

/** Turns an integrity report into alerts. Open while the condition holds; resolve when it clears. */
export async function evaluateIntegrity(db: Db, orgId: string, deviceId: string, agentVersion: string | null, i: Integrity | undefined, requireTrusted: boolean) {
  const want = new Map<string, { severity: 'critical' | 'warning'; message: string }>();
  if (i) {
    if (i.exeSha256 && agentVersion) {
      const rel = (await db.query(`SELECT exe_sha256 FROM agent_releases WHERE version=$1 AND status <> 'draft'`, [agentVersion])).rows[0];
      if (rel && rel.exe_sha256.toLowerCase() !== i.exeSha256.toLowerCase()) want.set('tamper.binary_modified', { severity: 'critical', message: `The agent binary does not match the signed release ${agentVersion} (possible modification or replacement).` });
    }
    if (requireTrusted && (i.signed === false || i.signatureTrusted === false)) want.set('tamper.certificate_invalid', { severity: 'critical', message: i.signed === false ? 'The agent binary is not code-signed.' : 'The agent binary signature is not trusted.' });
    if (i.serviceOk === false) want.set('tamper.service_misconfigured', { severity: 'warning', message: `The agent service configuration is not as installed: ${i.serviceIssue ?? 'unknown difference'}.` });
    if (i.dataDirProtected === false) want.set('tamper.config_exposed', { severity: 'warning', message: 'The agent data folder is readable by standard users (its credential could be exposed).' });
  }
  const latest = (await db.query(`SELECT version FROM agent_releases WHERE status='active' AND stage='100'`)).rows.map(r => r.version as string).sort(cmpVersion).pop();
  if (latest && agentVersion && cmpVersion(latest, agentVersion) > 0) want.set('agent.outdated', { severity: 'warning', message: `Agent ${agentVersion} is older than the current release ${latest}.` });
  for (const [code, a] of want)
    await db.query(`INSERT INTO alerts(org_id,device_id,code,severity,message) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (device_id, code) WHERE resolved_at IS NULL DO UPDATE SET last_seen_at=now(), message=EXCLUDED.message`, [orgId, deviceId, code, a.severity, a.message]);
  await db.query(`UPDATE alerts SET resolved_at=now() WHERE device_id=$1 AND resolved_at IS NULL AND (code LIKE 'tamper.%' OR code='agent.outdated') AND NOT (code = ANY($2::text[]))`, [deviceId, [...want.keys()]]);
}

export function registerReleaseRoutes(app: FastifyInstance, o: { db: Db; signer: JobSigner; platformKey: string; releasesDir: string; requireDevice: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>; safeEq: (a: string, b: string) => boolean; audit: (e: any) => Promise<void> }) {
  const { db } = o;
  mkdirSync(o.releasesDir, { recursive: true });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 300 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  // The platform key (scripts) or a signed-in platform admin (the operator console).
  const platform = (req: FastifyRequest, reply: FastifyReply) => (app as any).platformGuard(req, reply);

  /** Upload a release package. The signer (platform operator) states the inner exe hash; the server signs the manifest. */
  app.post('/api/v1/platform/releases', { preHandler: platform, bodyLimit: 300 * 1024 * 1024 }, async (req, reply) => {
    const q = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), exeSha256: z.string().regex(/^[0-9a-f]{64}$/i), computeExeSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(), notes: z.string().max(500).optional() }).parse(req.query);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 1024 || body.subarray(0, 2).toString('latin1') !== 'PK') return reply.code(400).send({ error: 'body must be a zip package (Content-Type: application/octet-stream)' });
    const sha = createHash('sha256').update(body).digest('hex');
    const manifest = JSON.stringify({ component: 'agent', version: q.version, sha256: sha, size: body.length, exeSha256: q.exeSha256.toLowerCase(), ...(q.computeExeSha256 ? { computeExeSha256: q.computeExeSha256.toLowerCase() } : {}), createdAt: new Date().toISOString() });
    const file = join(o.releasesDir, `agent-${q.version}.zip`);
    try {
      await db.query(`INSERT INTO agent_releases(version,sha256,exe_sha256,size_bytes,manifest,signature,file_path,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [q.version, sha, q.exeSha256.toLowerCase(), body.length, manifest, o.signer.sign(manifest), file, q.notes ?? null]);
    } catch (e: any) { if (e.code === '23505') return reply.code(409).send({ error: `release ${q.version} already exists (releases are immutable)` }); throw e; }
    writeFileSync(file, body);
    await o.audit({ orgId: null, actorType: 'system', action: 'release.upload', targetType: 'release', targetId: q.version, next: { sha256: sha, size: body.length } });
    return reply.code(201).send({ version: q.version, sha256: sha, stage: 'internal', status: 'draft' });
  });

  app.patch('/api/v1/platform/releases/:version', { preHandler: platform }, async (req, reply) => {
    const { version } = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).parse(req.params);
    const b = z.object({ stage: z.enum(STAGES).optional(), status: z.enum(['active', 'halted']).optional() }).strict().parse(req.body);
    const cur = await db.query('SELECT stage, status FROM agent_releases WHERE version=$1', [version]);
    if (!cur.rowCount) return reply.code(404).send({ error: 'not found' });
    if (b.stage && STAGES.indexOf(b.stage) < STAGES.indexOf(cur.rows[0].stage)) return reply.code(409).send({ error: 'a rollout only moves forward; halt it instead' });
    const r = await db.query(`UPDATE agent_releases SET stage=COALESCE($2,stage), status=COALESCE($3,status), halt_reason=CASE WHEN $3='active' THEN NULL WHEN $3='halted' THEN 'halted by the platform operator' ELSE halt_reason END WHERE version=$1 RETURNING stage,status`, [version, b.stage ?? null, b.status ?? null]);
    await o.audit({ orgId: null, actorType: 'system', action: 'release.update', targetType: 'release', targetId: version, previous: cur.rows[0], next: r.rows[0] });
    return r.rows[0];
  });

  app.get('/api/v1/platform/releases', { preHandler: platform }, async () => {
    const r = await db.query(`SELECT r.version, r.stage, r.status, r.halt_reason, r.size_bytes, r.created_at, r.notes,
        (SELECT count(DISTINCT device_id)::int FROM agent_update_events e WHERE e.version=r.version AND e.status='ok') AS updated,
        (SELECT count(DISTINCT device_id)::int FROM agent_update_events e WHERE e.version=r.version AND e.status IN ('rolled_back','failed')) AS failed,
        (SELECT count(*)::int FROM devices d WHERE d.agent_version=r.version AND d.revoked_at IS NULL) AS running
       FROM agent_releases r ORDER BY string_to_array(r.version,'.')::int[] DESC`);
    return { releases: r.rows };
  });

  app.get('/agent/v1/releases/:version/download', { preHandler: o.requireDevice }, async (req, reply) => {
    const { version } = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).parse(req.params);
    const r = await db.query(`SELECT file_path, size_bytes, sha256 FROM agent_releases WHERE version=$1 AND status='active'`, [version]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not available' });
    return reply.header('content-type', 'application/octet-stream').header('content-length', String(r.rows[0].size_bytes)).header('x-sha256', r.rows[0].sha256).send(createReadStream(r.rows[0].file_path));
  });
}
