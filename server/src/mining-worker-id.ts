import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';

/**
 * Per-device mining worker identity: COUNTRY-ORGHASH-SITE-DEVICEHASH, generated server-side, never typed by a person, never built from a name/phone/email.
 * A worker_id, once issued, is unique forever (see mining_worker_ids) and is immutable for the life of that device's mining registration: a device is
 * retired and re-registered rather than having its worker_id changed.
 */
export interface WorkerIdInputs { countryCode: string; orgId: string; orgHint?: string | null; siteHint?: string | null; deviceId: string }

const CODE = /^[A-Z]{2}$/;
/** A short, readable token from a UUID/string: upper-case hex, not reversible to the original id beyond what's already public (the id itself). */
function token(input: string, len: number): string {
  return input.replace(/-/g, '').toUpperCase().slice(0, len).padEnd(len, '0');
}
function sanitizeHint(s: string | null | undefined, len: number): string | null {
  if (!s) return null;
  const clean = s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, len);
  return clean.length >= 3 ? clean : null;
}

/** Builds the human-readable id; does not touch the database. Falls back to a hash token when no safe short name is available (never a person's name). */
export function formatWorkerId(o: WorkerIdInputs): string {
  if (!CODE.test(o.countryCode)) throw new Error('countryCode must be a 2-letter ISO code, e.g. "ZM"');
  const org = sanitizeHint(o.orgHint, 8) ?? token(o.orgId, 6);
  const site = sanitizeHint(o.siteHint, 4) ?? token(o.deviceId, 3);
  const device = token(o.deviceId, 8);
  return `${o.countryCode}-${org}-${site}-${device}`;
}

/**
 * Issues (or returns the existing) worker_id for a device, inside the caller's transaction/connection. Collision-safe: if the formatted id is already
 * taken by a different device (hash truncation can collide), a short random suffix is appended and retried.
 */
export async function ensureWorkerId(db: Db, o: WorkerIdInputs): Promise<string> {
  const existing = (await db.query('SELECT worker_id FROM mining_devices WHERE device_id=$1', [o.deviceId])).rows[0];
  if (existing) return existing.worker_id as string;
  let id = formatWorkerId(o);
  for (let attempt = 0; attempt < 5; attempt++) {
    const taken = (await db.query('SELECT device_id FROM mining_worker_ids WHERE worker_id=$1', [id])).rows[0];
    if (!taken) break;
    if (taken.device_id === o.deviceId) return id;
    id = `${formatWorkerId(o)}-${randomBytes(2).toString('hex').toUpperCase()}`;
  }
  await db.query('INSERT INTO mining_worker_ids(worker_id, device_id, org_id) VALUES ($1,$2,$3) ON CONFLICT (worker_id) DO NOTHING', [id, o.deviceId, o.orgId]);
  await db.query(`INSERT INTO mining_devices(device_id, org_id, site_id, worker_id, enabled) VALUES ($1,$2,$3,$4,false)
                  ON CONFLICT (device_id) DO NOTHING`, [o.deviceId, o.orgId, null, id]);
  return id;
}

export function isValidWorkerId(id: string): boolean {
  return /^[A-Z]{2}-[A-Z0-9]{3,12}-[A-Z0-9]{3,8}-[A-Z0-9]{8}(-[A-F0-9]{4})?$/.test(id);
}
