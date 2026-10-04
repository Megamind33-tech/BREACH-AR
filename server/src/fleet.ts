import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { JobCtx } from './jobs.js';

/** Sites, departments, tags, bulk assignment, device revocation. Every statement is scoped by the caller's org. */
export function registerFleetRoutes(app: FastifyInstance, c: JobCtx) {
  const { db } = c;
  const uuid = z.string().uuid();
  const tag = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/);

  app.patch('/api/v1/sites/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params); const { name } = z.object({ name: z.string().min(1).max(120) }).parse(req.body);
    const r = await db.query('UPDATE sites SET name=$3 WHERE id=$1 AND org_id=$2 RETURNING id,name', [id, req.user.org, name]).catch((e: any) => e.code === '23505' ? null : Promise.reject(e));
    if (!r) return reply.code(409).send({ error: 'a site with that name exists' });
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'site.rename', targetType: 'site', targetId: id, next: { name } });
    return r.rows[0];
  });
  app.delete('/api/v1/sites/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query('DELETE FROM sites WHERE id=$1 AND org_id=$2 RETURNING name', [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'site.delete', targetType: 'site', targetId: id, previous: { name: r.rows[0].name } });
    return { ok: true };  // devices keep existing, unassigned (FK is SET NULL); departments go with the site
  });
  app.patch('/api/v1/departments/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params); const { name } = z.object({ name: z.string().min(1).max(120) }).parse(req.body);
    const r = await db.query('UPDATE departments SET name=$3 WHERE id=$1 AND org_id=$2 RETURNING id,name', [id, req.user.org, name]).catch((e: any) => e.code === '23505' ? null : Promise.reject(e));
    if (!r) return reply.code(409).send({ error: 'a department with that name exists in this site' });
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    return r.rows[0];
  });
  app.delete('/api/v1/departments/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query('DELETE FROM departments WHERE id=$1 AND org_id=$2 RETURNING name', [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'department.delete', targetType: 'department', targetId: id, previous: { name: r.rows[0].name } });
    return { ok: true };
  });

  /** Assign one or many devices to a site/department and add/remove tags in one audited operation. */
  const Assign = z.object({
    deviceIds: z.array(uuid).min(1).max(5000),
    siteId: uuid.nullable().optional(), departmentId: uuid.nullable().optional(),
    addTags: z.array(tag).max(20).optional(), removeTags: z.array(tag).max(20).optional(),
    updateRing: z.enum(['internal', 'pilot', 'stable']).optional(),
  }).strict();

  async function assign(req: any, reply: any, deviceIds: string[], b: z.infer<typeof Assign>) {
    const org = req.user.org as string;
    if (b.siteId) if (!(await db.query('SELECT 1 FROM sites WHERE id=$1 AND org_id=$2', [b.siteId, org])).rowCount) return reply.code(404).send({ error: 'site not found' });
    if (b.departmentId) {
      const dep = await db.query('SELECT site_id FROM departments WHERE id=$1 AND org_id=$2', [b.departmentId, org]);
      if (!dep.rowCount) return reply.code(404).send({ error: 'department not found' });
      if (b.siteId && dep.rows[0].site_id !== b.siteId) return reply.code(400).send({ error: 'department does not belong to that site' });
    }
    const found = await db.query('SELECT id, site_id, department_id, tags FROM devices WHERE org_id=$1 AND revoked_at IS NULL AND id = ANY($2::uuid[])', [org, deviceIds]);
    if (found.rowCount !== new Set(deviceIds).size) return reply.code(404).send({ error: 'one or more devices not found' });
    const sets: string[] = []; const vals: unknown[] = [org, deviceIds];
    if (b.siteId !== undefined) { vals.push(b.siteId); sets.push(`site_id=$${vals.length}`); if (b.departmentId === undefined) sets.push('department_id=NULL'); }
    if (b.departmentId !== undefined) { vals.push(b.departmentId); sets.push(`department_id=$${vals.length}`); }
    if (b.addTags?.length || b.removeTags?.length) {
      vals.push(b.addTags ?? []); const a = vals.length; vals.push(b.removeTags ?? []); const r = vals.length;
      sets.push(`tags = ARRAY(SELECT DISTINCT t FROM unnest(tags || $${a}::text[]) t WHERE NOT (t = ANY($${r}::text[])) ORDER BY t)`);
    }
    if (b.updateRing) { vals.push(b.updateRing); sets.push(`update_ring=$${vals.length}`); }
    if (!sets.length) return reply.code(400).send({ error: 'nothing to change' });
    await db.query(`UPDATE devices SET ${sets.join(', ')} WHERE org_id=$1 AND id = ANY($2::uuid[])`, vals);
    for (const p of found.rows)
      await c.audit({ orgId: org, actorType: 'user', actorId: req.user.sub, action: 'device.assign', targetType: 'device', targetId: p.id, previous: { siteId: p.site_id, departmentId: p.department_id, tags: p.tags }, next: b });
    return { updated: found.rowCount };
  }

  app.post('/api/v1/devices/assign', { preHandler: c.requireRole('admin') }, async (req, reply) => assign(req, reply, Assign.parse(req.body).deviceIds, Assign.parse(req.body)));
  app.patch('/api/v1/devices/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = Assign.omit({ deviceIds: true }).extend({ tags: z.array(tag).max(20).optional() }).strict().parse(req.body);
    const { tags, ...rest } = b;
    if (tags) { // replace semantics for the single-device form
      const cur = await db.query('SELECT tags FROM devices WHERE id=$1 AND org_id=$2', [id, req.user.org]);
      if (!cur.rowCount) return reply.code(404).send({ error: 'not found' });
      return assign(req, reply, [id], { ...rest, deviceIds: [id], addTags: tags, removeTags: (cur.rows[0].tags as string[]).filter(t => !tags.includes(t)) });
    }
    return assign(req, reply, [id], { ...rest, deviceIds: [id] });
  });

  /** Revoke a device: its credential stops working immediately; history is kept. */
  app.delete('/api/v1/devices/:id', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query(`UPDATE devices SET revoked_at=now() WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL RETURNING hostname`, [id, req.user.org]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    await db.query(`UPDATE jobs SET status='cancelled', finished_at=now(), error='device was revoked' WHERE device_id=$1 AND status='queued'`, [id]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'device.revoke', targetType: 'device', targetId: id, previous: { hostname: r.rows[0].hostname } });
    return { ok: true };
  });

  /** Organization settings an owner can change. */
  app.get('/api/v1/settings', { preHandler: c.requireRole('viewer') }, async req => {
    const r = await db.query('SELECT name, plan, utc_offset_minutes, remote_support_enabled FROM organizations WHERE id=$1', [req.user.org]);
    return { name: r.rows[0].name, plan: r.rows[0].plan, utcOffsetMinutes: r.rows[0].utc_offset_minutes, remoteSupportEnabled: r.rows[0].remote_support_enabled };
  });
  app.patch('/api/v1/settings', { preHandler: c.requireRole('owner') }, async (req) => {
    const b = z.object({ utcOffsetMinutes: z.number().int().min(-720).max(840).optional(), remoteSupportEnabled: z.boolean().optional() }).strict().parse(req.body);
    const prev = (await db.query('SELECT utc_offset_minutes, remote_support_enabled FROM organizations WHERE id=$1', [req.user.org])).rows[0];
    await db.query('UPDATE organizations SET utc_offset_minutes=COALESCE($2,utc_offset_minutes), remote_support_enabled=COALESCE($3,remote_support_enabled) WHERE id=$1', [req.user.org, b.utcOffsetMinutes ?? null, b.remoteSupportEnabled ?? null]);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'settings.update', targetType: 'organization', targetId: req.user.org, previous: prev, next: b });
    return { ok: true };
  });

  app.get('/api/v1/tags', { preHandler: c.requireRole('viewer') }, async req => {
    const r = await db.query(`SELECT t AS tag, count(*)::int AS devices FROM devices, unnest(tags) t WHERE org_id=$1 AND revoked_at IS NULL GROUP BY t ORDER BY t`, [req.user.org]);
    return { tags: r.rows };
  });

  app.get('/api/v1/audit/search', { preHandler: c.requireRole('admin') }, async req => {
    const f = z.object({ action: z.string().max(60).optional(), targetId: z.string().max(60).optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const w = ['org_id=$1']; const v: unknown[] = [req.user.org];
    if (f.action) { v.push(f.action + '%'); w.push(`action LIKE $${v.length}`); }
    if (f.targetId) { v.push(f.targetId); w.push(`target_id=$${v.length}`); }
    if (f.before) { v.push(f.before); w.push(`id < $${v.length}`); }
    v.push(f.limit);
    const r = await db.query(`SELECT id,at,actor_type,actor_id,action,target_type,target_id,previous,next,result FROM audit_log WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT $${v.length}`, v);
    return { entries: r.rows, next: r.rowCount === f.limit ? r.rows[r.rows.length - 1].id : null };
  });
}
