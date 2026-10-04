import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import { createSystemJob, type JobCtx, type JobSigner } from './jobs.js';
import { scoreHealth, type Snapshot } from './health.js';

/* ------------------------------------------------------------------------------------------------
 * Windows updates and drivers (fleet view), staged driver rollouts, software catalog and policy rules.
 * Everything shown here comes from job results reported by real agents (updates.scan, software inventory).
 * ---------------------------------------------------------------------------------------------- */

export function cmpVersion(a: string, b: string): number {
  const pa = (a.match(/\d+/g) ?? []).map(Number), pb = (b.match(/\d+/g) ?? []).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] ?? 0, y = pb[i] ?? 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Alerts for software that violates organization rules. Open exactly while the software is present. */
export async function refreshSoftwareAlerts(db: Db, orgId: string, deviceId: string): Promise<void> {
  const rules = await db.query('SELECT id, kind, pattern, min_version, note FROM software_rules WHERE org_id=$1', [orgId]);
  const inv = await db.query('SELECT software FROM device_inventory WHERE device_id=$1', [deviceId]);
  const sw: { name: string; version?: string | null }[] = inv.rows[0]?.software ?? [];
  const desired = new Map<string, string>();
  for (const r of rules.rows) {
    const needle = (r.pattern as string).toLowerCase();
    for (const a of sw) {
      if (!a.name.toLowerCase().includes(needle)) continue;
      if (r.kind === 'prohibited') desired.set(`software.prohibited.${r.id}`, `Prohibited software installed: ${a.name}${a.version ? ' ' + a.version : ''}${r.note ? ` (${r.note})` : ''}`);
      else if (a.version && cmpVersion(a.version, r.min_version) < 0) desired.set(`software.outdated.${r.id}`, `${a.name} ${a.version} is older than the required ${r.min_version}${r.note ? ` (${r.note})` : ''}`);
    }
  }
  for (const [code, message] of desired)
    await db.query(`INSERT INTO alerts(org_id,device_id,code,severity,message) VALUES ($1,$2,$3,'warning',$4)
                    ON CONFLICT (device_id, code) WHERE resolved_at IS NULL DO UPDATE SET last_seen_at=now(), message=EXCLUDED.message`, [orgId, deviceId, code, message]);
  await db.query(`UPDATE alerts SET resolved_at=now() WHERE device_id=$1 AND resolved_at IS NULL AND code LIKE 'software.%' AND NOT (code = ANY($2::text[]))`, [deviceId, [...desired.keys()]]);
}

/** After updates.install: decide, by policy, whether to restart automatically, ask, or leave it. */
export async function afterUpdateInstall(db: Db, signer: JobSigner, orgId: string, deviceId: string, result: any): Promise<void> {
  if (!result?.rebootRequired) return;
  const pols = await db.query(
    `SELECT p.settings->>'restartAfterUpdates' AS mode FROM policies p JOIN devices d ON d.id=$2 AND d.org_id=p.org_id
      WHERE p.org_id=$1 AND p.enabled AND (p.scope_type='org' OR (p.scope_type='site' AND d.site_id=p.scope_id) OR (p.scope_type='department' AND d.department_id=p.scope_id) OR (p.scope_type='tag' AND p.scope_tag = ANY(d.tags)))`, [orgId, deviceId]);
  const modes = pols.rows.map(r => r.mode).filter(Boolean) as string[];
  const mode = modes.includes('never') ? 'never' : modes.includes('auto') ? 'auto' : 'ask';
  if (mode === 'never') return;
  if (mode === 'auto') { await createSystemJob(db, signer, { orgId, deviceId, type: 'system.reboot', params: { delaySeconds: 600, message: 'Your IT team is restarting this PC in 10 minutes to finish updates. Please save your work.' }, ttlMinutes: 120, source: { reason: 'restart after updates (policy: auto)' } }); return; }
  await db.query(`INSERT INTO alerts(org_id,device_id,code,severity,message) VALUES ($1,$2,'device.restart_pending','warning','A restart is required to finish installing updates (waiting for approval)')
                  ON CONFLICT (device_id, code) WHERE resolved_at IS NULL DO UPDATE SET last_seen_at=now()`, [orgId, deviceId]);
}

/* ------------------------------------------------------------------------------------------------
 * Driver rollout engine: test on ONE device -> pilot group -> everyone else. A stage only counts as passed after the
 * device was health-checked again and did not get worse; a failed stage halts the whole rollout.
 * ---------------------------------------------------------------------------------------------- */
const MAX_HEALTH_DROP = 5;

async function latestHealth(db: Db, deviceId: string): Promise<{ score: number | null; driverErrors: Set<string> }> {
  const r = await db.query('SELECT snapshot FROM device_health WHERE device_id=$1', [deviceId]);
  if (!r.rowCount) return { score: null, driverErrors: new Set() };
  const snap = r.rows[0].snapshot as Snapshot;
  return { score: scoreHealth(snap).overall, driverErrors: new Set((snap.driverErrors ?? []).map(e => `${e.name}#${e.code}`)) };
}

export async function rolloutTick(db: Db, signer: JobSigner): Promise<number> {
  let changed = 0;
  const rows = await db.query(`SELECT rd.*, r.title, r.status AS rollout_status FROM rollout_devices rd JOIN rollouts r ON r.id=rd.rollout_id WHERE rd.status IN ('queued','installed') AND r.status='active'`);
  for (const rd of rows.rows) {
    const halt = async (reason: string) => {
      await db.query(`UPDATE rollouts SET status='halted', halt_reason=$2 WHERE id=$1 AND status='active'`, [rd.rollout_id, reason]);
      // a failure must also stop installs that are queued but have not started on other devices
      await db.query(`UPDATE jobs SET status='cancelled', finished_at=now(), error='rollout halted' WHERE status='queued' AND id IN (SELECT install_job FROM rollout_devices WHERE rollout_id=$1 AND status='queued')`, [rd.rollout_id]);
      await db.query(`UPDATE rollout_devices SET status='failed', detail='cancelled: rollout halted', updated_at=now() WHERE rollout_id=$1 AND status='queued'`, [rd.rollout_id]);
    };
    const fail = async (detail: string) => { await db.query(`UPDATE rollout_devices SET status='failed', detail=$3, updated_at=now() WHERE rollout_id=$1 AND device_id=$2`, [rd.rollout_id, rd.device_id, detail]); await halt(`${detail} (device ${rd.device_id})`); changed++; };
    if (rd.status === 'queued') {
      const j = await db.query('SELECT status, error FROM jobs WHERE id=$1', [rd.install_job]);
      const st = j.rows[0]?.status;
      if (st === 'completed') {
        const vj = await createSystemJob(db, signer, { orgId: rd.org_id, deviceId: rd.device_id, type: 'health.check', params: {}, ttlMinutes: 240, source: { rolloutId: rd.rollout_id, purpose: 'post-install verification' } });
        await db.query(`UPDATE rollout_devices SET status='installed', verify_job=$3, updated_at=now() WHERE rollout_id=$1 AND device_id=$2`, [rd.rollout_id, rd.device_id, vj]); changed++;
      } else if (st === 'failed' || st === 'cancelled') await fail(`driver install ${st}: ${j.rows[0]?.error ?? ''}`.trim());
    } else if (rd.status === 'installed') {
      const j = await db.query('SELECT status FROM jobs WHERE id=$1', [rd.verify_job]);
      const st = j.rows[0]?.status;
      if (st === 'completed') {
        const now = await latestHealth(db, rd.device_id);
        const beforeErr = new Set<string>(rd.detail?.startsWith('errors:') ? JSON.parse(rd.detail.slice(7)) : []);
        const newErrors = [...now.driverErrors].filter(e => !beforeErr.has(e));
        const dropped = rd.health_before != null && now.score != null && now.score < rd.health_before - MAX_HEALTH_DROP;
        if (dropped || newErrors.length) await fail(`health verification failed: score ${rd.health_before} -> ${now.score}${newErrors.length ? `, new driver errors: ${newErrors.join(', ')}` : ''}`);
        else { await db.query(`UPDATE rollout_devices SET status='verified', health_after=$3, detail=NULL, updated_at=now() WHERE rollout_id=$1 AND device_id=$2`, [rd.rollout_id, rd.device_id, now.score]); changed++; }
      } else if (st === 'failed' || st === 'cancelled') await fail('post-install health check did not complete');
    }
  }
  // Autopilot: an administrator chooses the driver; once the test stage is verified the rollout widens by itself (test -> pilot -> fleet).
  // Every stage still has to pass its own post-install health verification, and any failure halts everything, exactly as before.
  const ready = await db.query(
    `SELECT r.* FROM rollouts r WHERE r.status='active' AND r.stage IN ('test','pilot') AND EXISTS (SELECT 1 FROM rollout_devices rd WHERE rd.rollout_id=r.id AND rd.stage=r.stage)
        AND NOT EXISTS (SELECT 1 FROM rollout_devices rd WHERE rd.rollout_id=r.id AND rd.stage=r.stage AND rd.status <> 'verified')
        AND EXISTS (SELECT 1 FROM policies p WHERE p.org_id=r.org_id AND p.enabled AND (p.settings->'autoRepair'->>'driverRollouts')::boolean IS TRUE)`);
  for (const ro of ready.rows) {
    const next = ro.stage === 'test' ? 'pilot' : 'fleet';
    const res = await rolloutHelpers(db, signer).advance(ro.org_id, ro, next);
    if ('started' in res) {
      changed++;
      await db.query(`INSERT INTO audit_log(org_id,actor_type,action,target_type,target_id,previous,next) VALUES ($1,'system','rollout.advance','rollout',$2,$3,$4)`, [ro.org_id, ro.id, JSON.stringify({ stage: ro.stage }), JSON.stringify({ stage: next, devices: res.started, by: 'autopilot' })]);
    } else if (/no other devices/.test(res.error)) {
      // nobody left to widen to: the rollout is complete
      await db.query(`UPDATE rollouts SET status='completed' WHERE id=$1 AND status='active'`, [ro.id]); changed++;
    }
  }
  // A rollout whose fleet stage is entirely verified is finished.
  await db.query(`UPDATE rollouts r SET status='completed' WHERE status='active' AND stage='fleet' AND NOT EXISTS (SELECT 1 FROM rollout_devices rd WHERE rd.rollout_id=r.id AND rd.stage='fleet' AND rd.status <> 'verified') AND EXISTS (SELECT 1 FROM rollout_devices rd WHERE rd.rollout_id=r.id AND rd.stage='fleet')`);
  return changed;
}

/** Shared by the routes and the Autopilot ticker so a rollout advances exactly the same way whoever moves it. */
export function rolloutHelpers(db: Db, signer: JobSigner) {
  const c = { signer };
  const latestScans = async (orgId: string, siteId?: string) => (await db.query(
    `SELECT DISTINCT ON (j.device_id) j.device_id, d.hostname, j.result, j.finished_at FROM jobs j JOIN devices d ON d.id=j.device_id
      WHERE j.org_id=$1 AND j.type='updates.scan' AND j.status='completed' AND j.result IS NOT NULL AND d.revoked_at IS NULL ORDER BY j.device_id, j.finished_at DESC`, [orgId])).rows;
  const health = async (deviceId: string) => (await db.query('SELECT overall FROM device_health_history WHERE device_id=$1 ORDER BY id DESC LIMIT 1', [deviceId])).rows[0]?.overall ?? null;
  const errorsJson = async (deviceId: string) => JSON.stringify([...(await latestHealth(db, deviceId)).driverErrors]);

  async function startStage(orgId: string, rolloutId: string, updateId: string, stage: string, deviceIds: string[]) {
    let n = 0;
    for (const dev of deviceIds) {
      const job = await createSystemJob(db, c.signer, { orgId, deviceId: dev, type: 'driver.install', params: { updateIds: [updateId] }, ttlMinutes: 24 * 60, source: { rolloutId, stage } });
      if (!job) continue;
      await db.query(`INSERT INTO rollout_devices(rollout_id,device_id,org_id,stage,install_job,health_before,detail) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [rolloutId, dev, orgId, stage, job, await health(dev), 'errors:' + await errorsJson(dev)]); n++;
    }
    return n;
  }
  async function eligible(orgId: string, updateId: string, exclude: string[]) {
    const out: { id: string; tags: string[] }[] = [];
    for (const s of await latestScans(orgId)) {
      if (exclude.includes(s.device_id) || !((s.result as any).drivers ?? []).some((d: any) => d.id === updateId)) continue;
      const t = await db.query('SELECT tags FROM devices WHERE id=$1 AND revoked_at IS NULL', [s.device_id]); if (t.rowCount) out.push({ id: s.device_id, tags: t.rows[0].tags });
    }
    return out;
  }

  /** Move a rollout to its next stage. Returns the number of devices started, or an error message. */
  async function advance(orgId: string, ro: any, stage: 'pilot' | 'fleet', deviceIds?: string[]): Promise<{ started: number } | { error: string }> {
    const order = ['test', 'pilot', 'fleet']; if (order.indexOf(stage) !== order.indexOf(ro.stage) + 1) return { error: `next stage after "${ro.stage}" is "${order[order.indexOf(ro.stage) + 1] ?? 'none'}"` };
    const cur = await db.query(`SELECT status FROM rollout_devices WHERE rollout_id=$1 AND stage=$2`, [ro.id, ro.stage]);
    if (!cur.rowCount || cur.rows.some(x => x.status !== 'verified')) return { error: `every device in the "${ro.stage}" stage must be installed and health-verified first (${cur.rows.filter(x => x.status === 'verified').length}/${cur.rowCount} verified)` };
    const done = (await db.query('SELECT device_id FROM rollout_devices WHERE rollout_id=$1', [ro.id])).rows.map(x => x.device_id as string);
    const pool = await eligible(orgId, ro.subject_id, done);
    let chosen: string[];
    if (stage === 'pilot') {
      const explicit = deviceIds?.filter(x => pool.some(p => p.id === x));
      const tagged = pool.filter(p => p.tags.includes('pilot')).map(p => p.id);
      chosen = explicit?.length ? explicit : tagged.length ? tagged : pool.slice(0, Math.max(2, Math.ceil(pool.length * 0.1))).map(p => p.id);   // explicit > "pilot" tag > 10% (min 2)
    } else chosen = pool.map(p => p.id);
    if (!chosen.length) return { error: 'no other devices have this driver pending' };
    await db.query('UPDATE rollouts SET stage=$2 WHERE id=$1', [ro.id, stage]);
    return { started: await startStage(orgId, ro.id, ro.subject_id, stage, chosen) };
  }
  return { latestScans, health, errorsJson, startStage, eligible, advance };
}

/** Windows Update driver classes Autopilot never starts on its own: a bad one can leave a PC without network, display, storage or boot. */
export const DRIVER_AUTOSTART_DENY = new Set(['net', 'display', 'hdc', 'scsiadapter', 'system', 'processor', 'firmware', 'bluetooth', 'security devices', 'securitydevices']);

/**
 * Opt-in Autopilot step: inside the maintenance window, start ONE rollout at a time for a pending driver that no rollout has covered in
 * the last 30 days, on the healthiest online PC (a PC tagged "pilot" first). From there the normal engine takes over: install, health
 * verification, pilot, fleet, halt-and-cancel on any failure. Returns the number of rollouts started.
 */
export async function autoStartDriverRollouts(db: Db, signer: JobSigner, now = new Date()): Promise<number> {
  const { inWindow } = await import('./policies.js');
  const orgs = await db.query(`SELECT p.org_id, p.settings, o.utc_offset_minutes FROM policies p JOIN organizations o ON o.id=p.org_id WHERE p.enabled AND p.name='Autopilot' AND (p.settings->'autoRepair'->>'driverAutoStart')::boolean IS TRUE`);
  let started = 0;
  for (const o of orgs.rows) {
    if (!inWindow(now, o.utc_offset_minutes, o.settings?.maintenanceWindow)) continue;
    if ((await db.query(`SELECT 1 FROM rollouts WHERE org_id=$1 AND kind='driver' AND status='active'`, [o.org_id])).rowCount) continue;
    const helpers = rolloutHelpers(db, signer);
    const seen = new Set((await db.query(`SELECT subject_id FROM rollouts WHERE org_id=$1 AND kind='driver' AND created_at > $2`, [o.org_id, new Date(now.getTime() - 30 * 86_400_000)])).rows.map(r => r.subject_id as string));
    const cands = new Map<string, { title: string; driver: any; devices: string[] }>();
    for (const s of await helpers.latestScans(o.org_id)) for (const d of (s.result as any)?.drivers ?? []) {
      if (seen.has(d.id) || DRIVER_AUTOSTART_DENY.has(String(d.driver?.class ?? '').toLowerCase())) continue;
      const e: { title: string; driver: any; devices: string[] } = cands.get(d.id) ?? { title: d.title, driver: d.driver, devices: [] as string[] }; e.devices.push(s.device_id); cands.set(d.id, e);
    }
    const pick = [...cands.entries()].sort((a, b) => b[1].devices.length - a[1].devices.length)[0];
    if (!pick) continue;
    const [updateId, cand] = pick;
    const online = await db.query(
      `SELECT d.id, d.tags, (SELECT overall FROM device_health_history h WHERE h.device_id=d.id ORDER BY h.id DESC LIMIT 1) AS score
         FROM devices d WHERE d.org_id=$1 AND d.revoked_at IS NULL AND d.id = ANY($2::uuid[]) AND d.last_seen_at > $3`, [o.org_id, cand.devices, new Date(now.getTime() - 10 * 60_000)]);
    const test = online.rows.sort((a, b) => Number((b.tags ?? []).includes('pilot')) - Number((a.tags ?? []).includes('pilot')) || (b.score ?? 0) - (a.score ?? 0))[0];
    if (!test) continue;
    const r = await db.query(`INSERT INTO rollouts(org_id,kind,subject_id,title,meta) VALUES ($1,'driver',$2,$3,$4) RETURNING id`, [o.org_id, updateId, cand.title, JSON.stringify({ driver: cand.driver, by: 'autopilot' })]);
    await helpers.startStage(o.org_id, r.rows[0].id, updateId, 'test', [test.id]);
    await db.query(`INSERT INTO audit_log(org_id,actor_type,action,target_type,target_id,next) VALUES ($1,'system','rollout.start','rollout',$2,$3)`, [o.org_id, r.rows[0].id, JSON.stringify({ title: cand.title, testDevice: test.id, by: 'autopilot' })]);
    started++;
  }
  return started;
}

export function registerPatchingRoutes(app: FastifyInstance, c: JobCtx & { signer: JobSigner }) {
  const { db } = c;
  const uuid = z.string().uuid();

  const rollout = rolloutHelpers(db, c.signer);
  const { latestScans, health, errorsJson, startStage, eligible } = rollout;

  // ---- Windows updates ----
  app.get('/api/v1/updates/overview', { preHandler: c.requireRole('viewer') }, async req => {
    const scans = await latestScans(req.user.org);
    const total = (await db.query('SELECT count(*)::int n FROM devices WHERE org_id=$1 AND revoked_at IS NULL', [req.user.org])).rows[0].n;
    const titles = new Map<string, { title: string; kb: string | null; security: boolean; devices: number }>();
    const devices: any[] = []; let sec = 0, all = 0;
    for (const s of scans) {
      const r = s.result as any; sec += r.securityCount ?? 0; all += r.pendingCount ?? 0;
      for (const u of r.updates ?? []) { const t = titles.get(u.id) ?? { title: u.title, kb: u.kb, security: (u.categories ?? []).some((x: string) => /Security|Critical/.test(x)), devices: 0 }; t.devices++; titles.set(u.id, t); }
      devices.push({ deviceId: s.device_id, hostname: s.hostname, pending: r.pendingCount ?? 0, security: r.securityCount ?? 0, rebootRequired: !!r.rebootRequired, scannedAt: s.finished_at });
    }
    const restart = (await db.query(`SELECT a.device_id, d.hostname, a.first_seen_at FROM alerts a JOIN devices d ON d.id=a.device_id WHERE a.org_id=$1 AND a.code='device.restart_pending' AND a.resolved_at IS NULL`, [req.user.org])).rows;
    return { devicesScanned: scans.length, devicesTotal: total, pendingSecurity: sec, pendingTotal: all,
      topUpdates: [...titles.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.devices - a.devices).slice(0, 15),
      devices: devices.sort((a, b) => b.security - a.security || b.pending - a.pending), restartPending: restart };
  });

  // ---- drivers ----
  app.get('/api/v1/drivers/overview', { preHandler: c.requireRole('viewer') }, async req => {
    const scans = await latestScans(req.user.org);
    type DriverEntry = { id: string; title: string; manufacturer: string | null; model: string | null; class: string | null; version: string | null; devices: { deviceId: string; hostname: string }[] };
    const by = new Map<string, DriverEntry>();
    for (const s of scans) for (const d of (s.result as any).drivers ?? []) {
      const e: DriverEntry = by.get(d.id) ?? { id: d.id, title: d.title, manufacturer: d.driver?.manufacturer ?? null, model: d.driver?.model ?? null, class: d.driver?.class ?? null, version: d.driver?.version ?? null, devices: [] };
      e.devices.push({ deviceId: s.device_id, hostname: s.hostname }); by.set(d.id, e);
    }
    const hs = await db.query(`SELECT h.device_id, d.hostname, h.snapshot->'driverErrors' AS errs FROM device_health h JOIN devices d ON d.id=h.device_id WHERE h.org_id=$1 AND d.revoked_at IS NULL AND jsonb_array_length(COALESCE(h.snapshot->'driverErrors','[]'::jsonb)) > 0`, [req.user.org]);
    let missing = 0, failed = 0; const problems = new Map<string, { name: string; code: number; devices: string[] }>();
    for (const r of hs.rows) for (const e of r.errs) { (e.code === 28 ? missing++ : failed++); const k = `${e.name}#${e.code}`; const p: { name: string; code: number; devices: string[] } = problems.get(k) ?? { name: e.name, code: e.code, devices: [] }; p.devices.push(r.hostname); problems.set(k, p); }
    const rollouts = await db.query(`SELECT r.id, r.title, r.stage, r.status, r.halt_reason, r.created_at, (SELECT count(*)::int FROM rollout_devices rd WHERE rd.rollout_id=r.id) AS devices,
                                            (SELECT count(*)::int FROM rollout_devices rd WHERE rd.rollout_id=r.id AND rd.status='verified') AS verified FROM rollouts r WHERE r.org_id=$1 AND r.kind='driver' ORDER BY r.created_at DESC LIMIT 20`, [req.user.org]);
    const out = [...by.values()].sort((a, b) => b.devices.length - a.devices.length);
    return { outdated: out.reduce((n, d) => n + d.devices.length, 0), missing, failed, updates: out, problems: [...problems.values()], rollouts: rollouts.rows, devicesScanned: scans.length,
      note: 'Driver updates come from Windows Update (first in the driver hierarchy). OEM catalogs and vendor packages are not yet integrated.' };
  });


  app.post('/api/v1/driver-rollouts', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const b = z.object({ updateId: uuid, deviceId: uuid }).strict().parse(req.body);
    const scan = (await latestScans(req.user.org)).find(s => s.device_id === b.deviceId);
    const drv = ((scan?.result as any)?.drivers ?? []).find((d: any) => d.id === b.updateId);
    if (!drv) return reply.code(404).send({ error: 'that driver update is not pending on that device (run a Windows Update scan first)' });
    if ((await db.query(`SELECT 1 FROM rollouts WHERE org_id=$1 AND subject_id=$2 AND status='active'`, [req.user.org, b.updateId])).rowCount) return reply.code(409).send({ error: 'a rollout for this driver is already active' });
    const r = await db.query(`INSERT INTO rollouts(org_id,kind,subject_id,title,meta,created_by) VALUES ($1,'driver',$2,$3,$4,$5) RETURNING id`, [req.user.org, b.updateId, drv.title, JSON.stringify({ driver: drv.driver }), req.user.sub]);
    await startStage(req.user.org, r.rows[0].id, b.updateId, 'test', [b.deviceId]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'rollout.start', targetType: 'rollout', targetId: r.rows[0].id, next: { title: drv.title, testDevice: b.deviceId } });
    return reply.code(201).send({ id: r.rows[0].id, stage: 'test' });
  });

  app.get('/api/v1/driver-rollouts/:id', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query('SELECT * FROM rollouts WHERE id=$1 AND org_id=$2', [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    const devs = await db.query(`SELECT rd.stage, rd.status, rd.detail, rd.health_before, rd.health_after, d.hostname, rd.device_id FROM rollout_devices rd JOIN devices d ON d.id=rd.device_id WHERE rd.rollout_id=$1 ORDER BY rd.stage, d.hostname`, [id]);
    return { ...r.rows[0], devices: devs.rows.map(x => ({ ...x, detail: x.detail?.startsWith('errors:') ? null : x.detail })) };
  });

  app.post('/api/v1/driver-rollouts/:id/advance', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ stage: z.enum(['pilot', 'fleet']), deviceIds: z.array(uuid).max(500).optional() }).strict().parse(req.body);
    const r = await db.query('SELECT * FROM rollouts WHERE id=$1 AND org_id=$2', [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    const ro = r.rows[0];
    if (ro.status !== 'active') return reply.code(409).send({ error: `rollout is ${ro.status}${ro.halt_reason ? ': ' + ro.halt_reason : ''}` });
    const res = await rollout.advance(req.user.org, ro, b.stage, b.deviceIds);
    if ('error' in res) return reply.code(409).send({ error: res.error });
    const n = res.started;
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'rollout.advance', targetType: 'rollout', targetId: id, previous: { stage: ro.stage }, next: { stage: b.stage, devices: n } });
    return { stage: b.stage, devices: n };
  });

  app.post('/api/v1/driver-rollouts/:id/halt', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query(`UPDATE rollouts SET status='halted', halt_reason='halted by an administrator' WHERE id=$1 AND org_id=$2 AND status='active' RETURNING id`, [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found or not active' });
    await db.query(`UPDATE jobs SET status='cancelled', finished_at=now(), error='rollout halted' WHERE status='queued' AND id IN (SELECT install_job FROM rollout_devices WHERE rollout_id=$1 AND status='queued')`, [id]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'rollout.halt', targetType: 'rollout', targetId: id });
    return { ok: true };
  });

  /** Undo: remove the newly installed package on every device that took it (Windows falls back to the previous driver). */
  app.post('/api/v1/driver-rollouts/:id/rollback', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ro = await db.query('SELECT * FROM rollouts WHERE id=$1 AND org_id=$2', [id, req.user.org]);
    if (!ro.rowCount) return reply.code(404).send({ error: 'not found' });
    await db.query(`UPDATE rollouts SET status='halted', halt_reason=COALESCE(halt_reason,'rolled back by an administrator') WHERE id=$1`, [id]);
    const devs = await db.query(`SELECT rd.device_id, j.result FROM rollout_devices rd JOIN jobs j ON j.id=rd.install_job WHERE rd.rollout_id=$1 AND rd.status IN ('installed','verified','failed') AND j.status='completed'`, [id]);
    const queued: string[] = [], unavailable: string[] = [];
    for (const d of devs.rows) {
      const res = d.result as any;
      const before = new Set<string>((res?.driversBefore ?? []).flatMap((x: any) => (x.installed ?? []).map((i: any) => String(i.infName).toLowerCase())));
      const storeAdded: string[] = (res?.packagesAdded ?? []).map((n: any) => String(n).toLowerCase()).filter((n: string) => /^oem\d{1,5}\.inf$/.test(n));
      const added = storeAdded.length ? storeAdded : [...new Set<string>((res?.driversAfter ?? []).flatMap((x: any) => (x.installed ?? []).map((i: any) => String(i.infName).toLowerCase())))].filter(n => !before.has(n) && /^oem\d{1,5}\.inf$/.test(n));
      if (!added.length) { unavailable.push(d.device_id); continue; }
      for (const inf of added) await createSystemJob(db, c.signer, { orgId: req.user.org, deviceId: d.device_id, type: 'driver.rollback', params: { infName: inf }, ttlMinutes: 24 * 60, source: { rolloutId: id } });
      await db.query(`UPDATE rollout_devices SET status='rolled_back', updated_at=now() WHERE rollout_id=$1 AND device_id=$2`, [id, d.device_id]); queued.push(d.device_id);
    }
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'rollout.rollback', targetType: 'rollout', targetId: id, next: { queued: queued.length, unavailable: unavailable.length } });
    return { rollbackQueued: queued.length, couldNotDetermine: unavailable.length };
  });

  // ---- software: catalog, rules, inventory, violations ----
  app.get('/api/v1/software/catalog', { preHandler: c.requireRole('viewer') }, async req => ({ catalog: (await db.query('SELECT id,name,winget_id,allow_uninstall,note,created_at FROM software_catalog WHERE org_id=$1 ORDER BY name', [req.user.org])).rows }));
  app.post('/api/v1/software/catalog', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const b = z.object({ name: z.string().min(1).max(120), wingetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{1,100}$/), allowUninstall: z.boolean().default(false), note: z.string().max(300).optional() }).strict().parse(req.body);
    try {
      const r = await db.query('INSERT INTO software_catalog(org_id,name,winget_id,allow_uninstall,note,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [req.user.org, b.name, b.wingetId, b.allowUninstall, b.note ?? null, req.user.sub]);
      await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'software.approve', targetType: 'software', targetId: b.wingetId, next: b });
      return reply.code(201).send({ id: r.rows[0].id });
    } catch (e: any) { if (e.code === '23505') return reply.code(409).send({ error: 'already in the catalog' }); throw e; }
  });
  app.delete('/api/v1/software/catalog/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query('DELETE FROM software_catalog WHERE id=$1 AND org_id=$2 RETURNING winget_id', [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'software.unapprove', targetType: 'software', targetId: r.rows[0].winget_id });
    return { ok: true };
  });

  const refreshAllSoftwareAlerts = async (orgId: string) => { for (const d of (await db.query('SELECT id FROM devices WHERE org_id=$1 AND revoked_at IS NULL', [orgId])).rows) await refreshSoftwareAlerts(db, orgId, d.id); };
  app.get('/api/v1/software/rules', { preHandler: c.requireRole('viewer') }, async req => ({ rules: (await db.query('SELECT id,kind,pattern,min_version,note,created_at FROM software_rules WHERE org_id=$1 ORDER BY created_at', [req.user.org])).rows }));
  app.post('/api/v1/software/rules', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const b = z.object({ kind: z.enum(['prohibited', 'min_version']), pattern: z.string().min(2).max(120), minVersion: z.string().regex(/^\d+(\.\d+){0,3}$/).optional(), note: z.string().max(200).optional() }).strict()
      .refine(v => v.kind !== 'min_version' || !!v.minVersion, { message: 'min_version rules need minVersion' }).parse(req.body);
    const r = await db.query('INSERT INTO software_rules(org_id,kind,pattern,min_version,note,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [req.user.org, b.kind, b.pattern, b.minVersion ?? null, b.note ?? null, req.user.sub]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'software.rule.create', targetType: 'software_rule', targetId: r.rows[0].id, next: b });
    await refreshAllSoftwareAlerts(req.user.org);
    return reply.code(201).send({ id: r.rows[0].id });
  });
  app.delete('/api/v1/software/rules/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query('DELETE FROM software_rules WHERE id=$1 AND org_id=$2 RETURNING id', [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'software.rule.delete', targetType: 'software_rule', targetId: id });
    await refreshAllSoftwareAlerts(req.user.org);
    return { ok: true };
  });

  app.get('/api/v1/software/inventory', { preHandler: c.requireRole('viewer') }, async req => {
    const q = z.object({ q: z.string().max(100).optional() }).parse(req.query).q?.toLowerCase();
    const r = await db.query(`SELECT i.software, d.id, d.hostname FROM device_inventory i JOIN devices d ON d.id=i.device_id WHERE i.org_id=$1 AND d.revoked_at IS NULL`, [req.user.org]);
    const apps = new Map<string, { name: string; publisher: string | null; versions: Map<string, number>; devices: number }>();
    for (const row of r.rows) for (const a of row.software as { name: string; version?: string; publisher?: string; hidden?: boolean }[]) {
      if (a.hidden) continue;
      if (q && !a.name.toLowerCase().includes(q)) continue;
      const k = a.name.toLowerCase(); const e = apps.get(k) ?? { name: a.name, publisher: a.publisher ?? null, versions: new Map(), devices: 0 };
      e.devices++; e.versions.set(a.version ?? '?', (e.versions.get(a.version ?? '?') ?? 0) + 1); apps.set(k, e);
    }
    return { devices: r.rowCount, applications: [...apps.values()].map(a => ({ name: a.name, publisher: a.publisher, devices: a.devices, versions: [...a.versions].map(([version, devices]) => ({ version, devices })).sort((x, y) => cmpVersion(y.version, x.version)) })).sort((a, b) => b.devices - a.devices).slice(0, 500) };
  });

  app.get('/api/v1/software/violations', { preHandler: c.requireRole('viewer') }, async req => {
    const r = await db.query(`SELECT a.id, a.device_id, d.hostname, a.code, a.message, a.first_seen_at FROM alerts a JOIN devices d ON d.id=a.device_id WHERE a.org_id=$1 AND a.resolved_at IS NULL AND a.code LIKE 'software.%' ORDER BY a.first_seen_at DESC`, [req.user.org]);
    return { violations: r.rows };
  });
}
