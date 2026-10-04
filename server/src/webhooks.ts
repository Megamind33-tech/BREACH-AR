import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { JobCtx } from './jobs.js';

/**
 * Alert delivery by webhook. Every request is signed (HMAC-SHA256 over "<timestamp>.<body>", header x-viro-signature) so the
 * receiver can verify it came from Viro Control. Targets must be https and must not resolve to a private, loopback or link-local
 * address (the server must never be a way to reach an internal network), unless VIRO_ALLOW_PRIVATE_WEBHOOKS=1 (development only).
 * Deliveries are a durable outbox with exponential retry; a failing receiver never blocks alerting.
 */
const MAX_ATTEMPTS = 6;

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::') return true;
    if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true;
}

const allowPrivate = () => process.env.VIRO_ALLOW_PRIVATE_WEBHOOKS === '1';

export function validateWebhookUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'not a valid URL'; }
  if (u.username || u.password) return 'credentials in the URL are not allowed; use the signature secret';
  if (u.protocol !== 'https:' && !(allowPrivate() && u.protocol === 'http:')) return 'the URL must use https';
  return null;
}

export function sign(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function assertPublicTarget(url: URL): Promise<void> {
  if (allowPrivate()) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map(a => a.address);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error('the target resolves to a private or reserved address');
}

export async function deliver(w: { url: string; secret: string }, payload: unknown): Promise<void> {
  const url = new URL(w.url);
  await assertPublicTarget(url);
  const body = JSON.stringify(payload); const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(url, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', 'user-agent': 'ViroControl-Webhook/1', 'x-viro-timestamp': ts, 'x-viro-signature': sign(w.secret, ts, body) },
    body,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`receiver answered HTTP ${res.status}`);
}

function payloadFor(event: string, a: any) {
  const text = `${event === 'resolved' ? 'Resolved' : a.severity === 'critical' ? 'CRITICAL' : 'Warning'}: ${a.hostname}: ${a.message}`;
  return {
    text, event, organizationId: a.org_id,
    alert: { id: Number(a.id), code: a.code, severity: a.severity, message: a.message, firstSeenAt: a.first_seen_at, resolvedAt: a.resolved_at, device: { id: a.device_id, hostname: a.hostname } },
  };
}

/** Queue events for new/resolved alerts, then send whatever is due. Safe to run from several instances. */
export async function webhookTick(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO alert_deliveries(webhook_id, alert_id, event)
     SELECT w.id, a.id, 'opened' FROM alert_webhooks w JOIN alerts a ON a.org_id=w.org_id
      WHERE w.enabled AND a.first_seen_at >= w.created_at AND (w.min_severity='warning' OR a.severity='critical')
     ON CONFLICT DO NOTHING`);
  // Tell the receiver when an alert it was told about has resolved.
  await db.query(
    `INSERT INTO alert_deliveries(webhook_id, alert_id, event)
     SELECT d.webhook_id, d.alert_id, 'resolved' FROM alert_deliveries d JOIN alerts a ON a.id=d.alert_id JOIN alert_webhooks w ON w.id=d.webhook_id
      WHERE d.event='opened' AND d.status='ok' AND a.resolved_at IS NOT NULL AND w.enabled
     ON CONFLICT DO NOTHING`);
  const due = await db.query(
    `UPDATE alert_deliveries SET attempts=attempts+1, next_attempt_at = now() + interval '5 minutes'
      WHERE id IN (SELECT id FROM alert_deliveries WHERE status='pending' AND next_attempt_at <= now() ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED)
      RETURNING id, webhook_id, alert_id, event, attempts`);
  for (const d of due.rows) {
    const q = await db.query(
      `SELECT w.url, w.secret, w.enabled, a.id, a.org_id, a.device_id, a.code, a.severity, a.message, a.first_seen_at, a.resolved_at, dv.hostname
         FROM alert_webhooks w, alerts a JOIN devices dv ON dv.id=a.device_id WHERE w.id=$1 AND a.id=$2`, [d.webhook_id, d.alert_id]);
    const row = q.rows[0];
    if (!row || !row.enabled) { await db.query(`UPDATE alert_deliveries SET status='failed', last_error='webhook removed or disabled' WHERE id=$1`, [d.id]); continue; }
    try {
      await deliver(row, payloadFor(d.event, row));
      await db.query(`UPDATE alert_deliveries SET status='ok', delivered_at=now(), last_error=NULL WHERE id=$1`, [d.id]);
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 300);
      if (d.attempts >= MAX_ATTEMPTS) await db.query(`UPDATE alert_deliveries SET status='failed', last_error=$2 WHERE id=$1`, [d.id, msg]);
      else await db.query(`UPDATE alert_deliveries SET last_error=$2, next_attempt_at = now() + make_interval(mins => $3) WHERE id=$1`, [d.id, msg, 2 ** d.attempts]);
    }
  }
}

export function registerWebhookRoutes(app: FastifyInstance, c: JobCtx) {
  const { db } = c;
  const view = `id, url, min_severity AS "minSeverity", enabled, created_at AS "createdAt"`;

  app.get('/api/v1/alert-webhooks', { preHandler: c.requireRole('admin') }, async req => {
    const r = await db.query(
      `SELECT w.id, w.url, w.min_severity AS "minSeverity", w.enabled, w.created_at AS "createdAt",
              count(d.*) FILTER (WHERE d.status='ok')::int AS delivered, count(d.*) FILTER (WHERE d.status='pending')::int AS pending, count(d.*) FILTER (WHERE d.status='failed')::int AS failed,
              (SELECT last_error FROM alert_deliveries x WHERE x.webhook_id=w.id AND x.last_error IS NOT NULL ORDER BY x.id DESC LIMIT 1) AS "lastError"
         FROM alert_webhooks w LEFT JOIN alert_deliveries d ON d.webhook_id=w.id WHERE w.org_id=$1 GROUP BY w.id ORDER BY w.created_at`, [req.user.org]);
    return { webhooks: r.rows };
  });

  app.post('/api/v1/alert-webhooks', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const b = z.object({ url: z.string().max(500), minSeverity: z.enum(['warning', 'critical']).default('warning') }).strict().parse(req.body);
    const bad = validateWebhookUrl(b.url);
    if (bad) return reply.code(400).send({ error: bad });
    const n = (await db.query('SELECT count(*)::int n FROM alert_webhooks WHERE org_id=$1', [req.user.org])).rows[0].n;
    if (n >= 10) return reply.code(409).send({ error: 'at most 10 webhooks per organization' });
    const secret = randomBytes(32).toString('hex');
    const r = await db.query(`INSERT INTO alert_webhooks(org_id,url,secret,min_severity) VALUES ($1,$2,$3,$4) RETURNING ${view}`, [req.user.org, b.url, secret, b.minSeverity]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'webhook.create', targetType: 'webhook', targetId: r.rows[0].id, next: { url: b.url, minSeverity: b.minSeverity } });
    return reply.code(201).send({ ...r.rows[0], secret });   // the secret is shown exactly once
  });

  app.patch('/api/v1/alert-webhooks/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ enabled: z.boolean().optional(), minSeverity: z.enum(['warning', 'critical']).optional() }).strict().parse(req.body);
    const r = await db.query(`UPDATE alert_webhooks SET enabled=COALESCE($3,enabled), min_severity=COALESCE($4,min_severity) WHERE id=$1 AND org_id=$2 RETURNING ${view}`, [id, req.user.org, b.enabled ?? null, b.minSeverity ?? null]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'webhook.update', targetType: 'webhook', targetId: id, next: b });
    return r.rows[0];
  });

  app.delete('/api/v1/alert-webhooks/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await db.query('DELETE FROM alert_webhooks WHERE id=$1 AND org_id=$2', [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'webhook.delete', targetType: 'webhook', targetId: id });
    return { ok: true };
  });

  app.post('/api/v1/alert-webhooks/:id/test', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const w = (await db.query('SELECT url, secret FROM alert_webhooks WHERE id=$1 AND org_id=$2', [id, req.user.org])).rows[0];
    if (!w) return reply.code(404).send({ error: 'not found' });
    try {
      await deliver(w, { text: 'Viro Control test notification', event: 'test', organizationId: req.user.org });
      return { ok: true };
    } catch (e) { return reply.code(502).send({ ok: false, error: String((e as Error).message ?? e).slice(0, 300) }); }
  });
}
