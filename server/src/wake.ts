import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { createSystemJob, type JobCtx, type JobSigner } from './jobs.js';

/**
 * Wake-on-LAN. A switched-off PC cannot receive anything from the internet, so Control asks another PC that is awake on the SAME network (same router and subnet) to send
 * the "magic packet" to it. Control only picks a helper when there is real evidence it is on the same network: the same public address and an overlapping subnet.
 */
export interface NetAdapter { name: string; mac: string; ip: string; prefix: number; gateway?: string | null; wired: boolean; wakeOnMagicPacket?: boolean | null }

export const AdapterSchema = z.object({
  name: z.string().max(120), mac: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/), ip: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/),
  prefix: z.number().int().min(8).max(30), gateway: z.string().max(45).nullish(), wired: z.boolean(), wakeOnMagicPacket: z.boolean().nullish(),
}).strict();

const ipInt = (ip: string) => ip.split('.').reduce((a, o) => (a * 256 + Number(o)) >>> 0, 0);
const maskOf = (p: number) => p <= 0 ? 0 : (0xFFFFFFFF << (32 - p)) >>> 0;
export const subnetOf = (ip: string, prefix: number) => (ipInt(ip) & maskOf(prefix)) >>> 0;
export const broadcastOf = (ip: string, prefix: number) => { const v = (ipInt(ip) | (~maskOf(prefix) >>> 0)) >>> 0; return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.'); };
const privateLan = (ip: string) => { const [a, b] = ip.split('.').map(Number); return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168); };

export interface WakePlan {
  target: { id: string; hostname: string; online: boolean };
  adapters: { name: string; mac: string; wired: boolean; windowsAllows: boolean | null }[];
  relays: { id: string; hostname: string }[];
  canWake: boolean; reasons: string[];
  pick?: { mac: string; broadcast: string; relayId: string };
}

export function planWake(target: { id: string; hostname: string; online: boolean; public_ip: string | null; network: NetAdapter[] | null },
  others: { id: string; hostname: string; public_ip: string | null; network: NetAdapter[] | null }[]): WakePlan {
  const adapters = (target.network ?? []).filter(a => privateLan(a.ip));
  const reasons: string[] = [];
  if (!target.network) reasons.push('This computer has not reported its network details yet. It needs the current Viro version and to have been online once.');
  else if (adapters.length === 0) reasons.push('This computer has no connected network adapter on a private network.');
  // Best adapter first: cable, and Windows allowed to wake it.
  const rank = (a: NetAdapter) => (a.wired ? 0 : 4) + (a.wakeOnMagicPacket === false ? 2 : a.wakeOnMagicPacket == null ? 1 : 0);
  const sorted = [...adapters].sort((a, b) => rank(a) - rank(b));
  const best = sorted[0];
  if (best && !best.wired) reasons.push('This computer is on Wi-Fi. Most Wi-Fi cards cannot wake a switched-off PC; a network cable is needed.');
  if (best && best.wakeOnMagicPacket === false) reasons.push('Windows has Wake on Magic Packet turned off for this adapter. Use "Allow this PC to be woken" while it is on.');
  const relays = best ? others.filter(o => o.public_ip && o.public_ip === target.public_ip && (o.network ?? []).some(n => subnetOf(n.ip, n.prefix) === subnetOf(best.ip, best.prefix) && n.prefix === best.prefix)) : [];
  if (best && relays.length === 0) reasons.push('No other computer is online on this computer\'s network right now. Another Viro PC on the same network has to be on to send the wake-up signal.');
  const plan: WakePlan = {
    target: { id: target.id, hostname: target.hostname, online: target.online },
    adapters: sorted.map(a => ({ name: a.name, mac: a.mac, wired: a.wired, windowsAllows: a.wakeOnMagicPacket ?? null })),
    relays: relays.map(r => ({ id: r.id, hostname: r.hostname })), canWake: !!best && relays.length > 0, reasons,
  };
  if (best && relays.length > 0) plan.pick = { mac: best.mac, broadcast: broadcastOf(best.ip, best.prefix), relayId: relays[0]!.id };
  return plan;
}

export function registerWakeRoutes(app: FastifyInstance, c: JobCtx & { signer: JobSigner }, onlineWindowSeconds: number) {
  const { db } = c;
  async function load(orgId: string, id: string) {
    const t = (await db.query(`SELECT id, hostname, public_ip, network, last_seen_at > now() - make_interval(secs => $3) AS online FROM devices WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL AND uninstalled_at IS NULL`, [id, orgId, onlineWindowSeconds])).rows[0];
    if (!t) return null;
    const o = (await db.query(`SELECT id, hostname, public_ip, network FROM devices WHERE org_id=$1 AND id<>$2 AND revoked_at IS NULL AND uninstalled_at IS NULL AND network IS NOT NULL AND last_seen_at > now() - make_interval(secs => $3)`, [orgId, id, onlineWindowSeconds])).rows;
    return planWake({ id: t.id, hostname: t.hostname, online: !!t.online, public_ip: t.public_ip, network: t.network }, o);
  }

  app.get('/api/v1/devices/:id/wake', { preHandler: c.requireRole('technician') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = await load(req.user.org, id); if (!p) return reply.code(404).send({ error: 'computer not found' });
    const { pick: _pick, ...safe } = p; return safe;
  });

  app.post('/api/v1/devices/:id/wake', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = await load(req.user.org, id); if (!p) return reply.code(404).send({ error: 'computer not found' });
    if (!p.canWake || !p.pick) return reply.code(409).send({ error: p.reasons[0] ?? 'this computer cannot be woken from here', reasons: p.reasons });
    const jobId = await createSystemJob(db, c.signer, { orgId: req.user.org, deviceId: p.pick.relayId, type: 'wol.send', params: { mac: p.pick.mac, broadcasts: [p.pick.broadcast] }, ttlMinutes: 5, source: { wake: id, by: req.user.sub } });
    if (!jobId) return reply.code(500).send({ error: 'could not create the wake-up request' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'device.wake', targetType: 'device', targetId: id, next: { relay: p.pick.relayId, mac: p.pick.mac, jobId } });
    return reply.code(202).send({ jobId, relay: p.relays.find(r => r.id === p.pick!.relayId), note: p.reasons.length ? p.reasons : undefined, online: p.target.online });
  });
}
