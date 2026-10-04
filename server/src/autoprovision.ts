import type { Db } from './db.js';
import { cmpVersion } from './patching.js';
import { createSystemJob, type JobSigner } from './jobs.js';

/**
 * Things every computer needs without anyone doing them one PC at a time. Runs on each heartbeat, so a PC that is enrolled tomorrow gets the same treatment as
 * the ones enrolled today: its anatomy is collected, and (when its organization is compute-sponsored) the agent is told to put the compute worker in place.
 */
export const ANATOMY_MIN_AGENT = '0.1.4';
export const ANATOMY_REFRESH_DAYS = 2;

/** Queue the first anatomy read, and a refresh when it is stale. At most one request every 6 hours, so an offline-then-online PC is not flooded. */
export async function ensureAnatomy(db: Db, signer: JobSigner, orgId: string, deviceId: string, agentVersion: string): Promise<boolean> {
  if (cmpVersion(agentVersion, ANATOMY_MIN_AGENT) < 0) return false;
  const have = (await db.query('SELECT collected_at FROM device_anatomy WHERE device_id=$1', [deviceId])).rows[0];
  if (have && Date.now() - new Date(have.collected_at).getTime() < ANATOMY_REFRESH_DAYS * 86_400_000) return false;
  const recent = await db.query(`SELECT 1 FROM jobs WHERE device_id=$1 AND type='anatomy.collect' AND created_at > now() - interval '6 hours' LIMIT 1`, [deviceId]);
  if (recent.rowCount) return false;
  return !!(await createSystemJob(db, signer, { orgId, deviceId, type: 'anatomy.collect', params: {}, ttlMinutes: 24 * 60, source: { purpose: 'automatic anatomy' } }));
}

/** Whether this PC's agent should make sure the compute worker is installed: the organization is sponsored and has set a policy. */
export async function computeWanted(db: Db, orgId: string): Promise<{ install: boolean }> {
  const r = await db.query(`SELECT 1 FROM organizations o WHERE o.id=$1 AND o.plan='compute_sponsored' AND EXISTS (SELECT 1 FROM compute_policies p WHERE p.org_id=o.id)`, [orgId]);
  return { install: !!r.rowCount };
}
