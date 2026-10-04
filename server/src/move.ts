import { z } from 'zod';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { JobCtx } from './jobs.js';
import { entitlementsOf, has, FEATURES } from './entitlements.js';

/**
 * Viro Move. The Windows app encrypts everything on the person's PC (AES-256-GCM, key made from a passphrase only they know) and uploads it in chunks. This server
 * stores ciphertext and counts bytes against the plan's quota; it never sees a file name, a file, or a setting. A new PC lists the person's snapshots, checks the passphrase
 * against the small key-check value, downloads the chunks and decrypts them locally.
 */
const GB = 1024 ** 3;
export const MAX_CHUNK = 6 * 1024 * 1024;

/** How many bytes this organization may keep: the plan's allowance for personal accounts, a fixed allowance for managed organizations, nothing without the feature. */
export async function moveQuotaBytes(db: JobCtx['db'], orgId: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const e = await entitlementsOf(db, orgId);
  if (!has(e, 'move.cloud')) return 0;
  if (e.kind === 'business') return Math.round(Number(env.MOVE_BUSINESS_QUOTA_GB ?? 20) * GB);
  const p = (await db.query('SELECT p.move_quota_gb FROM subscriptions s JOIN billing_plans p ON p.code=s.plan_code WHERE s.org_id=$1', [orgId])).rows[0];
  return Math.round(Number(p?.move_quota_gb ?? 5) * GB);
}

export function registerMoveRoutes(app: FastifyInstance, c: JobCtx, deps: { dir: string }) {
  const { db } = c; const root = deps.dir;
  const uuid = z.string().uuid();
  const dirOf = (org: string, id: string) => join(root, org, id);
  const used = async (org: string) => Number((await db.query(`SELECT COALESCE(sum(bytes),0)::bigint b FROM move_snapshots WHERE org_id=$1 AND status <> 'failed'`, [org])).rows[0].b);
  const mine = async (req: any, id: string) => (await db.query('SELECT * FROM move_snapshots WHERE id=$1 AND org_id=$2 AND user_id=$3', [id, req.user.org, req.user.sub])).rows[0];
  const gate = async (req: any, reply: any) => { const e = await entitlementsOf(db, req.user.org); if (!has(e, 'move.cloud')) { reply.code(402).send({ error: `${FEATURES['move.cloud']!.title} is part of a paid plan. See Plan and payments to add it.`, upgrade: true }); return true; } return false; };

  app.get('/api/v1/move/snapshots', { preHandler: c.requireRole('viewer') }, async req => {
    const rows = (await db.query(`SELECT id, label, machine, status, kdf, key_check, chunk_count, bytes, created_at, completed_at FROM move_snapshots WHERE org_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 50`, [req.user.org, req.user.sub])).rows
      .map(r => ({ ...r, bytes: Number(r.bytes) }));
    const quota = await moveQuotaBytes(db, req.user.org);
    return { snapshots: rows, usedBytes: await used(req.user.org), quotaBytes: quota };
  });

  app.post('/api/v1/move/snapshots', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    if (await gate(req, reply)) return;
    const b = z.object({ label: z.string().trim().min(1).max(80), machine: z.string().max(80).optional(),
      kdf: z.object({ alg: z.literal('pbkdf2-sha256'), iterations: z.number().int().min(100_000).max(5_000_000), salt: z.string().min(16).max(64) }).strict(), keyCheck: z.string().min(20).max(400) }).strict().parse(req.body);
    const stale = (await db.query(`SELECT id FROM move_snapshots WHERE org_id=$1 AND user_id=$2 AND status='uploading' AND created_at < now() - interval '2 days'`, [req.user.org, req.user.sub])).rows;
    for (const s of stale) { rmSync(dirOf(req.user.org, s.id), { recursive: true, force: true }); await db.query(`UPDATE move_snapshots SET status='failed', bytes=0 WHERE id=$1`, [s.id]); }
    const r = await db.query(`INSERT INTO move_snapshots(org_id,user_id,label,machine,kdf,key_check) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [req.user.org, req.user.sub, b.label, b.machine ?? null, JSON.stringify(b.kdf), b.keyCheck]);
    mkdirSync(dirOf(req.user.org, r.rows[0].id), { recursive: true });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'move.start', targetType: 'move_snapshot', targetId: r.rows[0].id } as any);
    return reply.code(201).send({ id: r.rows[0].id, quotaBytes: await moveQuotaBytes(db, req.user.org), usedBytes: await used(req.user.org), maxChunkBytes: MAX_CHUNK });
  });

  app.put('/api/v1/move/snapshots/:id/chunks/:n', { preHandler: c.requireRole('viewer'), bodyLimit: MAX_CHUNK + 1024 }, async (req, reply) => {
    const { id, n } = z.object({ id: uuid, n: z.coerce.number().int().min(0).max(1_000_000) }).parse(req.params);
    const snap = await mine(req, id); if (!snap || snap.status !== 'uploading') return reply.code(404).send({ error: 'snapshot not found or already finished' });
    const body = req.body as Buffer; if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_CHUNK) return reply.code(400).send({ error: 'a chunk must be between 1 byte and 6 MB' });
    const sha = createHash('sha256').update(body).digest('hex');
    if (String(req.headers['x-chunk-sha256'] ?? '') !== sha) return reply.code(400).send({ error: 'the chunk was damaged in transit; send it again' });
    const existing = (await db.query('SELECT size FROM move_chunks WHERE snapshot_id=$1 AND n=$2', [id, n])).rows[0];
    const delta = body.length - (existing?.size ?? 0);
    const quota = await moveQuotaBytes(db, req.user.org);
    if ((await used(req.user.org)) + delta > quota) return reply.code(413).send({ error: 'This would go over your storage allowance. Choose less to back up, or ask about a larger plan.', quotaBytes: quota });
    writeFileSync(join(dirOf(req.user.org, id), `${n}.bin`), body);
    await db.query(`INSERT INTO move_chunks(snapshot_id,n,size,sha256) VALUES ($1,$2,$3,$4) ON CONFLICT (snapshot_id,n) DO UPDATE SET size=EXCLUDED.size, sha256=EXCLUDED.sha256`, [id, n, body.length, sha]);
    await db.query(`UPDATE move_snapshots SET bytes = bytes + $2, chunk_count = (SELECT count(*) FROM move_chunks WHERE snapshot_id=$1) WHERE id=$1`, [id, delta]);
    return { ok: true };
  });

  app.post('/api/v1/move/snapshots/:id/finish', { preHandler: c.requireRole('viewer'), bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params); const b = z.object({ manifest: z.string().min(20).max(6_000_000), chunks: z.number().int().min(0).max(1_000_000) }).strict().parse(req.body);
    const snap = await mine(req, id); if (!snap || snap.status !== 'uploading') return reply.code(404).send({ error: 'snapshot not found or already finished' });
    const have = (await db.query('SELECT count(*)::int n, COALESCE(max(n)+1,0)::int top FROM move_chunks WHERE snapshot_id=$1', [id])).rows[0];
    if (have.n !== b.chunks || have.top !== b.chunks) return reply.code(409).send({ error: `${b.chunks} chunks were expected but ${have.n} arrived; upload the missing ones and finish again` });
    await db.query(`UPDATE move_snapshots SET status='complete', manifest=$2, chunk_count=$3, completed_at=now() WHERE id=$1`, [id, b.manifest, b.chunks]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'move.complete', targetType: 'move_snapshot', targetId: id, next: { bytes: Number(snap.bytes), chunks: b.chunks } } as any);
    return { ok: true };
  });

  app.get('/api/v1/move/snapshots/:id', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params); const s = await mine(req, id);
    if (!s || s.status !== 'complete') return reply.code(404).send({ error: 'snapshot not found' });
    return { id: s.id, label: s.label, machine: s.machine, kdf: s.kdf, keyCheck: s.key_check, manifest: s.manifest, chunks: s.chunk_count, bytes: Number(s.bytes), createdAt: s.created_at };
  });

  app.get('/api/v1/move/snapshots/:id/chunks/:n', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id, n } = z.object({ id: uuid, n: z.coerce.number().int().min(0) }).parse(req.params);
    const s = await mine(req, id); const ch = s?.status === 'complete' ? (await db.query('SELECT sha256 FROM move_chunks WHERE snapshot_id=$1 AND n=$2', [id, n])).rows[0] : null;
    const file = join(dirOf(req.user.org, id), `${n}.bin`);
    if (!ch || !existsSync(file)) return reply.code(404).send({ error: 'chunk not found' });
    return reply.header('x-chunk-sha256', ch.sha256).type('application/octet-stream').send(readFileSync(file));
  });

  app.delete('/api/v1/move/snapshots/:id', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params); const s = await mine(req, id);
    if (!s) return reply.code(404).send({ error: 'snapshot not found' });
    rmSync(dirOf(req.user.org, id), { recursive: true, force: true });
    await db.query('DELETE FROM move_snapshots WHERE id=$1', [id]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'move.delete', targetType: 'move_snapshot', targetId: id } as any);
    return { ok: true };
  });
}
