import { z } from 'zod';
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JobCtx } from './jobs.js';
import { lacks } from './entitlements.js';

/**
 * Lost mode. An administrator marks a missing computer and sets a passphrase; the agent is told at its next heartbeat and shows a full-screen lock on the
 * signed-in session, asking for that passphrase. Checking the passphrase happens on the PC itself (the agent is given a salted hash, never the passphrase,
 * and never needs the network to check an entry), so the lock still works once a connection is lost. An administrator can also unlock it from here directly.
 *
 * What this is not: it does not survive a reinstall of Windows, and nothing here stops someone who has full administrator rights on the machine from
 * removing the agent, the same way no user-mode software can. It raises the bar for an opportunistic thief; it is not a firmware-level lock.
 */
const PBKDF2_ITERATIONS = 210_000, PBKDF2_KEYLEN = 32;

function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  const key = pbkdf2Sync(passphrase.normalize('NFKC'), salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, 'sha256');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassphrase(passphrase: string, stored: string): boolean {
  const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterStr || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = pbkdf2Sync(passphrase.normalize('NFKC'), Buffer.from(saltB64, 'base64'), Number(iterStr), expected.length, 'sha256');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
/** Split for the agent: it needs the salt and the hash (not secret, the way a password hash in a database never is) to check an entry locally. */
function saltAndHashOf(stored: string): { saltB64: string; hashB64: string; iterations: number } | null {
  const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
  return scheme === 'pbkdf2' && iterStr && saltB64 && hashB64 ? { saltB64, hashB64, iterations: Number(iterStr) } : null;
}

const DOMAIN = 'viro-serial-v1\n';
export const serialHashOf = (serial: string) => createHash('sha256').update(DOMAIN + serial.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

/** What the agent is told at each heartbeat: whether to be locked, and, if so, the salt and hash to check an entry against. */
export async function lostStateFor(db: JobCtx['db'], deviceId: string): Promise<{ locked: boolean; salt?: string; hash?: string; iterations?: number } | null> {
  const r = (await db.query('SELECT lost_mode, lost_passphrase FROM devices WHERE id=$1', [deviceId])).rows[0];
  if (!r || !r.lost_mode) return { locked: false };
  const sh = r.lost_passphrase ? saltAndHashOf(r.lost_passphrase) : null;
  if (!sh) return { locked: false };      // marked lost with no passphrase yet (should not happen) is never shown as locked
  return { locked: true, salt: sh.saltB64, hash: sh.hashB64, iterations: sh.iterations };
}

/** Called from the heartbeat handler: records a new row only when the public IP actually changed, so the trail reads as a sequence of places, not one per minute. */
export async function trackLocation(db: JobCtx['db'], orgId: string, deviceId: string, publicIp: string | null, network: unknown): Promise<void> {
  if (!publicIp) return;
  const last = (await db.query('SELECT public_ip FROM device_locations WHERE device_id=$1 ORDER BY at DESC LIMIT 1', [deviceId])).rows[0];
  if (last && last.public_ip === publicIp) return;
  await db.query('INSERT INTO device_locations(org_id,device_id,public_ip,network) VALUES ($1,$2,$3,$4)', [orgId, deviceId, publicIp, network ? JSON.stringify(network) : null]);
  await db.query(`DELETE FROM device_locations WHERE device_id=$1 AND id < (SELECT COALESCE(MIN(id),0) FROM (SELECT id FROM device_locations WHERE device_id=$1 ORDER BY id DESC LIMIT 200) t)`, [deviceId]);
}

export function registerLostModeRoutes(app: FastifyInstance, c: JobCtx) {
  const { db } = c;

  app.post('/api/v1/devices/:id/lost', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const why = await lacks(db, req.user.org, 'device.lost_mode'); if (why) return reply.code(402).send({ error: why, upgrade: true });
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ passphrase: z.string().min(6).max(200), note: z.string().max(400).optional() }).strict().parse(req.body);
    const r = await db.query(`UPDATE devices SET lost_mode=true, lost_at=now(), lost_note=$3, lost_passphrase=$4, recovered_at=NULL WHERE id=$1 AND org_id=$2 RETURNING hostname`,
      [id, req.user.org, b.note ?? null, hashPassphrase(b.passphrase)]);
    if (!r.rowCount) return reply.code(404).send({ error: 'computer not found' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'device.lost', targetType: 'device', targetId: id, next: { note: b.note ?? null } });
    return reply.code(200).send({ ok: true, message: `${r.rows[0].hostname} will lock the next time it is online, and whenever it is signed in to afterwards, until the passphrase is entered or you cancel lost mode.` });
  });

  /** Ends lost mode from here, without needing the passphrase (the computer was found, or the report was a mistake). */
  app.post('/api/v1/devices/:id/lost/cancel', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await db.query(`UPDATE devices SET lost_mode=false, lost_passphrase=NULL, recovered_at=now() WHERE id=$1 AND org_id=$2 AND lost_mode RETURNING hostname`, [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'this computer is not in lost mode' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'device.lost.cancel', targetType: 'device', targetId: id });
    return { ok: true, message: `${r.rows[0].hostname} will unlock the next time it is online.` };
  });

  app.get('/api/v1/devices/:id/locations', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await db.query('SELECT 1 FROM devices WHERE id=$1 AND org_id=$2', [id, req.user.org])).rowCount) return reply.code(404).send({ error: 'computer not found' });
    const r = await db.query('SELECT at, public_ip, network FROM device_locations WHERE device_id=$1 ORDER BY at DESC LIMIT 50', [id]);
    const d = await db.query('SELECT lost_mode, lost_at, lost_note, recovered_at FROM devices WHERE id=$1', [id]);
    return { ...d.rows[0], locations: r.rows };
  });

  /** The agent confirms a successful local unlock here (the passphrase itself is never sent). */
  app.post('/agent/v1/lost/recovered', { preHandler: c.requireDevice }, async req => {
    const { id, orgId } = req.device!;
    await db.query(`UPDATE devices SET lost_mode=false, lost_passphrase=NULL, recovered_at=now() WHERE id=$1`, [id]);
    await c.audit({ orgId, actorType: 'device', actorId: id, action: 'device.lost.recovered', targetType: 'device', targetId: id, ip: req.ip } as any);
    return { ok: true };
  });

  /** Public, privacy-safe: tells a prospective buyer whether a serial was reported stolen, the way a Viro certificate's serial check works. No device or owner detail. */
  const checked = new Map<string, number>();
  const limited = (ip: string) => { const n = (checked.get(ip) ?? 0) + 1; checked.set(ip, n); if (checked.size > 5000) checked.clear(); return n > 20; };
  app.post('/api/v1/public/stolen-check', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).send({ error: 'too many checks; try again in a minute' });
    const b = z.object({ serial: z.string().min(2).max(120) }).strict().parse(req.body);
    const r = await db.query('SELECT lost_at FROM devices WHERE serial_hash=$1 AND lost_mode LIMIT 1', [serialHashOf(b.serial)]);
    return { reported: !!r.rowCount, since: r.rows[0]?.lost_at ?? null };
  });
}
