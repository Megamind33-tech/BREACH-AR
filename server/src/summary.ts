import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import type { JobCtx } from './jobs.js';
import { deliver } from './webhooks.js';
import { activity } from './autopilot-brain.js';

/**
 * The weekly plain-language summary: what state the PCs are in, what was taken care of automatically, and the short list of things
 * that actually need a person. Built only from recorded facts (device health, alerts, completed jobs); nothing here is estimated.
 */
export interface Summary {
  generatedAt: string; periodDays: number; headline: string;
  pcs: { total: number; healthy: number; attention: number; critical: number; notReporting: number };
  done: { securityUpdatesInstalled: number; repairsFixed: number; cleanedMb: number; restarts: number; driverUpdates: number };
  needsYou: { deviceId: string; hostname: string; severity: 'critical' | 'warning'; message: string }[];
  text: string;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export async function buildSummary(db: Db, orgId: string, periodDays = 7, now = new Date()): Promise<Summary> {
  const since = new Date(now.getTime() - periodDays * 86_400_000);
  const dev = await db.query(
    `SELECT d.id, d.hostname, d.last_seen_at,
            (SELECT overall FROM device_health_history h WHERE h.device_id=d.id ORDER BY h.id DESC LIMIT 1) AS overall
       FROM devices d WHERE d.org_id=$1 AND d.revoked_at IS NULL`, [orgId]);
  const pcs = { total: dev.rowCount ?? 0, healthy: 0, attention: 0, critical: 0, notReporting: 0 };
  for (const d of dev.rows) {
    if (!d.last_seen_at || now.getTime() - new Date(d.last_seen_at).getTime() > 3 * 86_400_000) { pcs.notReporting++; continue; }
    if (d.overall == null || d.overall >= 80) pcs.healthy++; else if (d.overall >= 60) pcs.attention++; else pcs.critical++;
  }

  const j = await db.query(
    `SELECT type, result, error FROM jobs WHERE org_id=$1 AND status='completed' AND finished_at >= $2 AND type IN ('updates.install','repair.run','repair.fix-safe','cleanup.run','system.reboot','driver.install')`, [orgId, since]);
  const done = { securityUpdatesInstalled: 0, repairsFixed: 0, cleanedMb: 0, restarts: 0, driverUpdates: 0 };
  for (const r of j.rows) {
    const res = (r.result ?? {}) as any;
    if (r.type === 'updates.install') done.securityUpdatesInstalled += Number(res.installed ?? 0) || 0;
    else if (r.type === 'repair.run' || r.type === 'repair.fix-safe') { if (/^Repaired and verified/i.test(String(res.summary ?? ''))) done.repairsFixed++; }
    else if (r.type === 'cleanup.run') done.cleanedMb += Math.round(Number(res.freedBytes ?? 0) / 1_048_576) || 0;
    else if (r.type === 'system.reboot') done.restarts++;
    else if (r.type === 'driver.install') done.driverUpdates++;
  }

  const act = await activity(db, orgId, now);
  const needsYou = act.needsYou.filter(i => i.impact !== 'low').slice(0, 10).map(i => ({ deviceId: i.deviceId, hostname: i.hostname, severity: (i.impact === 'high' ? 'critical' : 'warning') as 'critical' | 'warning', message: `${i.title}. ${i.nextStep ?? i.note}` }));

  const headline = pcs.total === 0 ? 'No computers are enrolled yet.'
    : pcs.healthy === pcs.total ? (pcs.total === 1 ? 'Your PC is healthy.' : `All ${pcs.total} PCs are healthy.`)
    : `${pcs.healthy} of ${plural(pcs.total, 'PC')} are healthy${pcs.notReporting ? `, ${pcs.notReporting} not reporting` : ''}.`;
  const lines = [headline];
  const did: string[] = [];
  if (done.securityUpdatesInstalled) did.push(`installed ${plural(done.securityUpdatesInstalled, 'security update')}`);
  if (done.repairsFixed) did.push(`fixed ${plural(done.repairsFixed, 'problem')}`);
  if (done.cleanedMb) did.push(`cleaned ${(done.cleanedMb / 1024).toFixed(1)} GB of temporary files`);
  if (done.restarts) did.push(`restarted ${plural(done.restarts, 'PC')} to finish updates`);
  if (done.driverUpdates) did.push(`updated ${plural(done.driverUpdates, 'driver')}`);
  lines.push(did.length ? `This week, automatically: ${did.join(', ')}.` : 'Nothing needed doing this week.');
  if (needsYou.length) { lines.push(`${plural(needsYou.length, 'thing')} need${needsYou.length === 1 ? 's' : ''} you:`); for (const n of needsYou) lines.push(`- ${n.hostname}: ${n.message}`); }
  else lines.push('Nothing needs your attention.');
  return { generatedAt: now.toISOString(), periodDays, headline, pcs, done, needsYou, text: lines.join('\n') };
}

/** Once a week, push the summary to every enabled webhook of organizations running Autopilot. */
export async function summaryTick(db: Db, now = new Date()): Promise<number> {
  const orgs = await db.query(
    `SELECT o.id FROM organizations o
      WHERE (o.summary_sent_at IS NULL OR o.summary_sent_at < $1)
        AND EXISTS (SELECT 1 FROM policies p WHERE p.org_id=o.id AND p.name='Autopilot' AND p.enabled)
        AND EXISTS (SELECT 1 FROM alert_webhooks w WHERE w.org_id=o.id AND w.enabled)`, [new Date(now.getTime() - 7 * 86_400_000 + 3_600_000)]);
  let sent = 0;
  for (const o of orgs.rows) {
    await db.query('UPDATE organizations SET summary_sent_at=$2 WHERE id=$1', [o.id, now]);      // mark first so a slow receiver cannot cause a repeat
    const s = await buildSummary(db, o.id, 7, now);
    const hooks = await db.query('SELECT url, secret FROM alert_webhooks WHERE org_id=$1 AND enabled', [o.id]);
    for (const w of hooks.rows) { try { await deliver(w, { text: s.text, event: 'weekly_summary', organizationId: o.id, summary: s }); sent++; } catch { /* the console still shows it */ } }
  }
  return sent;
}

export function registerSummaryRoutes(app: FastifyInstance, c: JobCtx) {
  app.get('/api/v1/summary', { preHandler: c.requireRole('viewer') }, async req => buildSummary(c.db, req.user.org));
}
