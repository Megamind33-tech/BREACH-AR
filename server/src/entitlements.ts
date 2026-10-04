import type { Db } from './db.js';

/**
 * What each person can use. One list, used by the server, the console and the Windows app, so "free" and "paid" mean the same everywhere.
 * Free: everything the free tools from Microsoft and others already give away, plus one full scan. Paid: what they do not offer.
 * Organizations that an operator set up (kind "business") are managed customers and get every feature; the free/paid line applies to personal accounts.
 */
export type Tier = 'free' | 'plus' | 'help' | 'business';
export const FEATURES: Record<string, { title: string; tier: Tier }> = {
  // free
  'scan.full': { title: 'Full scan: what is wrong with this PC', tier: 'free' },
  'clean.space': { title: 'Free up space', tier: 'free' },
  'startup.manage': { title: 'Start-up programs', tier: 'free' },
  'memory.trim': { title: 'Memory', tier: 'free' },
  'apps.list': { title: 'Installed programs with sizes, normal uninstall', tier: 'free' },
  'updates.view': { title: 'Windows and program updates', tier: 'free' },
  // paid for people
  'fix.verified': { title: 'Fixes that are re-checked, with before and after and undo', tier: 'plus' },
  'diagnose.cause': { title: 'Why it is slow or crashing: the actual cause', tier: 'plus' },
  'health.warnings': { title: 'Early warning for failing drives and batteries', tier: 'plus' },
  'advice.replace': { title: 'Repair, upgrade or replace advice with a price', tier: 'plus' },
  'uninstall.forced': { title: 'Remove stubborn and hidden programs, with undo', tier: 'plus' },
  'repair.programs': { title: 'Repair broken programs, printers and Windows pieces', tier: 'plus' },
  'backup.check': { title: 'Backup check', tier: 'plus' },
  'maintenance.scheduled': { title: 'Scheduled fixes and a weekly "what we fixed" report', tier: 'plus' },
  'history.machine': { title: 'Machine history', tier: 'plus' },
  'move.cloud': { title: 'Viro Move: your apps, files and settings on your next PC', tier: 'plus' },
  // human help
  'help.technician': { title: 'Ask a technician', tier: 'help' },
  // businesses
  'fleet.console': { title: 'Many computers in one console', tier: 'business' },
  'certificate.issue': { title: 'Buyer certificates', tier: 'business' },
};
export const FREE = Object.keys(FEATURES).filter(k => FEATURES[k]!.tier === 'free');
export const PLUS = Object.keys(FEATURES).filter(k => FEATURES[k]!.tier === 'plus');
export const ALL = Object.keys(FEATURES);

/** The features a plan gives when the operator has not listed them by hand. */
export function planFeatures(audience: string, listed: unknown): string[] {
  const own = Array.isArray(listed) ? listed.filter((x): x is string => typeof x === 'string' && x in FEATURES) : [];
  if (own.length) return own;
  if (audience === 'business') return ALL;
  if (audience === 'shop') return [...PLUS, 'certificate.issue', 'help.technician'];
  return PLUS;
}

export interface Entitlements { kind: 'business' | 'personal'; plan: string | null; planName: string | null; features: string[]; validUntil: string | null; active: boolean; verified: boolean }

export async function entitlementsOf(db: Db, orgId: string, now = new Date()): Promise<Entitlements> {
  const o = (await db.query('SELECT kind FROM organizations WHERE id=$1', [orgId])).rows[0];
  if (!o) return { kind: 'personal', plan: null, planName: null, features: FREE, validUntil: null, active: false, verified: false };
  if (o.kind === 'business') return { kind: 'business', plan: null, planName: null, features: ALL, validUntil: null, active: true, verified: true };
  const s = (await db.query(`SELECT s.plan_code, s.current_period_end, p.name, p.audience, p.entitlements FROM subscriptions s JOIN billing_plans p ON p.code=s.plan_code WHERE s.org_id=$1`, [orgId])).rows[0];
  if (!s) return { kind: 'personal', plan: null, planName: null, features: FREE, validUntil: null, active: false, verified: true };
  const active = !s.current_period_end || new Date(s.current_period_end).getTime() > now.getTime();
  return {
    kind: 'personal', plan: s.plan_code, planName: s.name, features: active ? [...new Set([...FREE, ...planFeatures(s.audience, s.entitlements)])] : FREE,
    validUntil: s.current_period_end ? new Date(s.current_period_end).toISOString() : null, active, verified: true,
  };
}

export const has = (e: Entitlements, feature: string) => e.features.includes(feature);

/** For server-side features: null when the organization may use it, otherwise the message to send with a 402 (payment required). */
export async function lacks(db: Db, orgId: string, feature: string): Promise<string | null> {
  const e = await entitlementsOf(db, orgId);
  return has(e, feature) ? null : `${FEATURES[feature]?.title ?? feature} is part of a paid plan. See Plan and payments to add it.`;
}
