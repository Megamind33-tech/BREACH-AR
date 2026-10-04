import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { WebSocket, RawData } from 'ws';
import type { Db } from './db.js';
import type { JobCtx } from './jobs.js';

/* ------------------------------------------------------------------------------------------------
 * Remote support. An administrator requests a session for one device and one purpose (terminal, files or desktop) with a
 * stated reason. The device joins on its next heartbeat, tells the person at the PC, and Control relays messages between
 * the two ends while recording who, what and when. Nothing here is hidden from the user or from the audit log.
 * Sessions live on the server instance that holds the sockets; scaling out needs sticky routing (or a pub/sub relay).
 * ---------------------------------------------------------------------------------------------- */

const IDLE_MS = 15 * 60_000, MAX_MS = 2 * 3_600_000, REQUEST_TTL_MS = 10 * 60_000, TICKET_MS = 60_000, MAX_FRAME = 4 * 1024 * 1024;

/** What an administrator's client may send to the device, per session kind. Anything else is dropped and logged. */
export const ADMIN_MESSAGES: Record<string, string[]> = {
  terminal: ['term.start', 'term.in', 'term.stop', 'end'],
  files: ['fs.ls', 'fs.get', 'fs.put', 'fs.chunk', 'end'],
  desktop: ['ds.start', 'ds.stop', 'ds.tune', 'ds.ping', 'ds.text', 'ds.mouse', 'ds.key', 'end'],
};

interface Live { agent?: WebSocket; admin?: WebSocket; kind: string; orgId: string; deviceId: string; adminId: string; adminEmail: string; lastActivity: number; startedAt?: number; counts: Record<string, number> }
const live = new Map<string, Live>();
const tickets = new Map<string, { sessionId: string; userId: string; orgId: string; expires: number }>();

export function registerSupportRoutes(app: FastifyInstance, c: JobCtx) {
  const { db } = c;

  /** Events are written in the order they happen, per session, and flushed before a session is closed out. */
  const chains = new Map<string, Promise<unknown>>();
  function event(sessionId: string, kind: string, detail?: string): Promise<unknown> {
    const p = (chains.get(sessionId) ?? Promise.resolve()).then(() => db.query('INSERT INTO support_events(session_id,kind,detail) VALUES ($1,$2,$3)', [sessionId, kind, detail?.slice(0, 500) ?? null])).catch(() => {});
    chains.set(sessionId, p); return p;
  }
  async function finish(id: string, reason: string) {
    const l = live.get(id);
    live.delete(id);
    for (const s of [l?.admin, l?.agent]) { try { if (s && s.readyState <= 1) s.close(1000, reason.slice(0, 100)); } catch { /* already closed */ } }
    await chains.get(id);   // let queued events land first
    const r = await db.query(`UPDATE support_sessions SET status='ended', ended_at=now(), ended_reason=$2 WHERE id=$1 AND status <> 'ended' RETURNING org_id, device_id, admin_id, started_at`, [id, reason]);
    if (!r.rowCount) return;
    await event(id, 'end', reason);
    chains.delete(id);
    await c.audit({ orgId: r.rows[0].org_id, actorType: 'user', actorId: r.rows[0].admin_id, action: 'support.end', targetType: 'device', targetId: r.rows[0].device_id, next: { sessionId: id, reason, counts: l?.counts ?? {}, seconds: r.rows[0].started_at ? Math.round((Date.now() - new Date(r.rows[0].started_at).getTime()) / 1000) : 0 } });
  }
  /** Expire idle/over-long/unclaimed sessions. Called on an interval (and directly in tests). */
  async function sweep(now = Date.now()) {
    let n = 0;
    for (const [id, l] of [...live]) {
      if (l.startedAt && now - l.startedAt > MAX_MS) { await finish(id, 'maximum session length reached'); n++; }
      else if (now - l.lastActivity > IDLE_MS) { await finish(id, 'idle timeout'); n++; }
    }
    const old = await db.query(`UPDATE support_sessions SET status='ended', ended_at=now(), ended_reason='the device did not join in time' WHERE status='requested' AND requested_at < now() - make_interval(secs => $1) RETURNING id`, [REQUEST_TTL_MS / 1000]);
    for (const r of old.rows) live.delete(r.id);
    return n + old.rowCount!;
  }
  (app as any).supportSweep = sweep;
  const timer = setInterval(() => sweep().catch(() => {}), 30_000); timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); for (const id of [...live.keys()]) await finish(id, 'server shutting down'); });

  // ---- REST: request, list, detail, ticket, end ----
  app.post('/api/v1/support/sessions', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const b = z.object({ deviceId: z.string().uuid(), kind: z.enum(['terminal', 'files', 'desktop']), reason: z.string().min(5).max(300) }).strict().parse(req.body);
    const org = await db.query('SELECT remote_support_enabled FROM organizations WHERE id=$1', [req.user.org]);
    if (!org.rows[0]?.remote_support_enabled) return reply.code(403).send({ error: 'remote support is disabled for this organization' });
    const dev = await db.query('SELECT hostname FROM devices WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL', [b.deviceId, req.user.org]);
    if (!dev.rowCount) return reply.code(404).send({ error: 'device not found' });
    if ((await db.query(`SELECT 1 FROM support_sessions WHERE device_id=$1 AND kind=$2 AND status <> 'ended'`, [b.deviceId, b.kind])).rowCount) return reply.code(409).send({ error: `this device already has an open ${b.kind} session` });      // one of each kind, so a screen can be watched beside a terminal
    const r = await db.query('INSERT INTO support_sessions(org_id,device_id,admin_id,kind,reason) VALUES ($1,$2,$3,$4,$5) RETURNING id', [req.user.org, b.deviceId, req.user.sub, b.kind, b.reason]);
    await event(r.rows[0].id, 'request', `${b.kind}: ${b.reason}`);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'support.request', targetType: 'device', targetId: b.deviceId, next: { sessionId: r.rows[0].id, kind: b.kind, reason: b.reason } });
    return reply.code(201).send({ id: r.rows[0].id });
  });

  app.get('/api/v1/support/sessions', { preHandler: c.requireRole('admin') }, async req => {
    const r = await db.query(`SELECT s.id, s.kind, s.reason, s.status, s.ended_reason, s.requested_at, s.started_at, s.ended_at, d.hostname, s.device_id, u.email AS admin,
        (SELECT count(*)::int FROM support_events e WHERE e.session_id=s.id AND e.kind NOT IN ('request','end','connect')) AS actions
      FROM support_sessions s JOIN devices d ON d.id=s.device_id JOIN users u ON u.id=s.admin_id WHERE s.org_id=$1 ORDER BY s.requested_at DESC LIMIT 100`, [req.user.org]);
    return { sessions: r.rows };
  });

  app.get('/api/v1/support/sessions/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const s = await db.query(`SELECT s.*, d.hostname, u.email AS admin FROM support_sessions s JOIN devices d ON d.id=s.device_id JOIN users u ON u.id=s.admin_id WHERE s.id=$1 AND s.org_id=$2`, [id, req.user.org]);
    if (!s.rowCount) return reply.code(404).send({ error: 'not found' });
    const ev = await db.query('SELECT at, kind, detail FROM support_events WHERE session_id=$1 ORDER BY id LIMIT 2000', [id]);
    return { ...s.rows[0], events: ev.rows };
  });

  app.post('/api/v1/support/sessions/:id/ticket', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const s = await db.query(`SELECT admin_id FROM support_sessions WHERE id=$1 AND org_id=$2 AND status <> 'ended'`, [id, req.user.org]);
    if (!s.rowCount) return reply.code(404).send({ error: 'not found or already ended' });
    if (s.rows[0].admin_id !== req.user.sub) return reply.code(403).send({ error: 'only the administrator who requested the session can join it' });
    const t = randomBytes(24).toString('hex'); tickets.set(t, { sessionId: id, userId: req.user.sub, orgId: req.user.org, expires: Date.now() + TICKET_MS });
    return { ticket: t, expiresInSeconds: TICKET_MS / 1000 };
  });

  app.post('/api/v1/support/sessions/:id/end', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const s = await db.query(`SELECT 1 FROM support_sessions WHERE id=$1 AND org_id=$2 AND status <> 'ended'`, [id, req.user.org]);
    if (!s.rowCount) return reply.code(404).send({ error: 'not found or already ended' });
    await finish(id, 'ended by an administrator');
    return { ok: true };
  });

  // ---- WebSocket relay ----
  const asText = (d: RawData) => d.toString('utf8');

  function attach(id: string, side: 'admin' | 'agent', socket: WebSocket) {
    const l = live.get(id)!;
    l[side] = socket; l.lastActivity = Date.now();
    void event(id, 'connect', side);

    socket.on('message', (data: RawData, isBinary: boolean) => {
      const cur = live.get(id); if (!cur) return;
      cur.lastActivity = Date.now();
      const size = Array.isArray(data) ? data.reduce((a, b) => a + b.length, 0) : (data as Buffer).length;
      if (size > MAX_FRAME) { socket.close(1009, 'frame too large'); return; }
      if (side === 'admin') {
        if (isBinary) { void event(id, 'blocked', 'binary frame from admin'); return; }
        let m: any; try { m = JSON.parse(asText(data)); } catch { return; }
        if (!ADMIN_MESSAGES[cur.kind]!.includes(m?.t)) { void event(id, 'blocked', `message "${String(m?.t).slice(0, 30)}" is not allowed in a ${cur.kind} session`); return; }
        if (m.t === 'end') { void finish(id, 'ended by an administrator'); return; }
        cur.counts[m.t] = (cur.counts[m.t] ?? 0) + 1;
        if (m.t === 'term.in') void event(id, 'command', String(m.d ?? ''));
        else if (m.t === 'fs.ls' || m.t === 'fs.get' || m.t === 'fs.put') void event(id, m.t, String(m.path ?? ''));
        else if (m.t === 'ds.start' || m.t === 'ds.stop' || m.t === 'term.start') void event(id, m.t);
        if (cur.agent && cur.agent.readyState === 1) cur.agent.send(JSON.stringify(m));
      } else {
        // agent -> admin: passed through unchanged; failures and exits are recorded
        if (!isBinary) { try { const m = JSON.parse(asText(data)); if (m.t === 'fs.err' || m.t === 'error' || m.t === 'term.exit') void event(id, m.t, String(m.message ?? m.code ?? '')); } catch { /* not JSON: relay anyway */ } }
        if (cur.admin && cur.admin.readyState === 1) cur.admin.send(data, { binary: isBinary });
      }
    });
    socket.on('close', () => {
      const cur = live.get(id); if (!cur || cur[side] !== socket) return;
      delete cur[side]; void event(id, 'disconnect', side);
      void finish(id, `${side} disconnected`);      // either end leaving ends the session: there is no lingering access
    });
    socket.on('error', () => { /* the close handler ends the session */ });

    const cur = live.get(id)!;
    if (cur.agent && cur.admin && !cur.startedAt) {
      cur.startedAt = Date.now();
      void db.query(`UPDATE support_sessions SET status='active', started_at=now() WHERE id=$1 AND status='requested'`, [id]);
      void event(id, 'active');
      void c.audit({ orgId: cur.orgId, actorType: 'user', actorId: cur.adminId, action: 'support.start', targetType: 'device', targetId: cur.deviceId, next: { sessionId: id, kind: cur.kind } });
    }
  }

  app.get('/api/v1/support/sessions/:id/ws', { websocket: true }, async (socket, req) => {
    const { id } = req.params as { id: string }; const ticket = String((req.query as any).ticket ?? '');
    const t = tickets.get(ticket); tickets.delete(ticket);   // single use
    if (!t || t.expires < Date.now() || t.sessionId !== id) { socket.close(4401, 'invalid or expired ticket'); return; }
    const s = await db.query(`SELECT s.kind, s.device_id, s.org_id, s.admin_id, u.email FROM support_sessions s JOIN users u ON u.id=s.admin_id WHERE s.id=$1 AND s.org_id=$2 AND s.status <> 'ended'`, [id, t.orgId]);
    if (!s.rowCount) { socket.close(4404, 'session not available'); return; }
    if (!live.has(id)) live.set(id, { kind: s.rows[0].kind, orgId: s.rows[0].org_id, deviceId: s.rows[0].device_id, adminId: s.rows[0].admin_id, adminEmail: s.rows[0].email, lastActivity: Date.now(), counts: {} });
    attach(id, 'admin', socket);
  });

  app.get('/agent/v1/sessions/:id/ws', { websocket: true, preHandler: c.requireDevice }, async (socket, req) => {
    const { id } = req.params as { id: string }; const dev = req.device!;
    const s = await db.query(`SELECT s.kind, s.device_id, s.org_id, s.admin_id, u.email FROM support_sessions s JOIN users u ON u.id=s.admin_id WHERE s.id=$1 AND s.device_id=$2 AND s.org_id=$3 AND s.status <> 'ended'`, [id, dev.id, dev.orgId]);
    if (!s.rowCount) { socket.close(4404, 'session not available'); return; }
    if (!live.has(id)) live.set(id, { kind: s.rows[0].kind, orgId: s.rows[0].org_id, deviceId: s.rows[0].device_id, adminId: s.rows[0].admin_id, adminEmail: s.rows[0].email, lastActivity: Date.now(), counts: {} });
    if (live.get(id)!.agent) { socket.close(4409, 'device already connected'); return; }
    attach(id, 'agent', socket);
    socket.send(JSON.stringify({ t: 'hello', kind: s.rows[0].kind, admin: s.rows[0].email }));
  });
}

/** Sessions the device should join now (heartbeat piggyback). */
export async function pendingSessions(db: Db, orgId: string, deviceId: string) {
  const r = await db.query(`SELECT s.id, s.kind, s.reason, u.email AS admin FROM support_sessions s JOIN users u ON u.id=s.admin_id WHERE s.device_id=$1 AND s.org_id=$2 AND s.status <> 'ended' ORDER BY s.requested_at`, [deviceId, orgId]);
  return r.rows.filter(x => !live.get(x.id)?.agent);
}
