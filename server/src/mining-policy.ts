import { z } from 'zod';
import { sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { isValidWorkerId } from './mining-worker-id.js';

/**
 * The signed mining policy an endpoint receives and must verify before acting on it (directive: "the endpoint verifies the policy signature before
 * applying it... never place private signing keys inside the Windows client"). Uses the same ECDSA P-256 / SHA-256 / IEEE-P1363 scheme as JobSigner in
 * jobs.ts, deliberately, so both can be verified by the one public key already shipped in the agent, rather than adding a second key the client must trust.
 *
 * Fail-closed on authorization, fail-safe on hardware: `validUntil` is mandatory, and an endpoint that cannot refresh an expired policy must stop mining,
 * while the temperature/battery/CPU limits remain enforced by the endpoint regardless of what the policy says (a policy can only be more conservative
 * than the endpoint's own hard limits, never less — see HARD_LIMITS below).
 */
export const XMR_ADDRESS = /^[48][0-9A-Za-z]{94}([0-9A-Za-z]{11})?$/;

export const HARD_LIMITS = Object.freeze({
  maxCpuPercentCeiling: 80,   // a policy can request less; it can never request more than this
  minTemperatureCeilingC: 60, // a policy's maxTemperatureC can never be set higher than this, i.e. cooler-than-this is always required
  maxTemperatureCeilingC: 85,
});

export const MiningPoolEndpoint = z.object({ host: z.string().min(3).max(120).regex(/^[A-Za-z0-9.-]+$/), port: z.number().int().min(1).max(65535) }).strict();

export const MiningPolicy = z.object({
  deviceId: z.string().uuid(),
  workerId: z.string().refine(isValidWorkerId, 'not a valid worker id'),
  enabled: z.boolean(),
  poolPrimary: MiningPoolEndpoint,
  poolFailover: MiningPoolEndpoint.optional(),
  tls: z.literal(true),       // plaintext pool connections are never issued
  wallet: z.string().regex(XMR_ADDRESS, 'wallet must be a public Monero address'),
  engineVersion: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
  engineSha256: z.string().regex(/^[0-9a-f]{64}$/),
  maxCpuPercent: z.number().int().min(5).max(HARD_LIMITS.maxCpuPercentCeiling),
  stopOnBattery: z.literal(true),  // the directive's examples always set this true; mining is never authorized to run unplugged
  maxTemperatureC: z.number().int().min(HARD_LIMITS.minTemperatureCeilingC).max(HARD_LIMITS.maxTemperatureCeilingC),
  onlyWhileIdle: z.boolean().default(true),
  issuedAt: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }),
}).strict().superRefine((v, ctx) => {
  if (new Date(v.validUntil) <= new Date(v.issuedAt)) ctx.addIssue({ code: 'custom', message: 'validUntil must be after issuedAt' });
  if (new Date(v.validUntil).getTime() - new Date(v.issuedAt).getTime() > 7 * 24 * 60 * 60 * 1000) ctx.addIssue({ code: 'custom', message: 'a mining policy cannot be valid for more than 7 days without a refresh' });
});
export type MiningPolicyT = z.infer<typeof MiningPolicy>;

export interface SignedMiningPolicy { policy: MiningPolicyT; signature: string }

export function signMiningPolicy(priv: KeyObject, policy: MiningPolicyT): SignedMiningPolicy {
  const parsed = MiningPolicy.parse(policy); // throws if the policy itself violates the hard limits — nothing unsafe is ever signed
  const payload = canonical(parsed);
  const signature = cryptoSign('sha256', Buffer.from(payload, 'utf8'), { key: priv, dsaEncoding: 'ieee-p1363' }).toString('base64');
  return { policy: parsed, signature };
}

/** What the endpoint does: verify the signature against the ONE public key it ships with, then re-validate every field. A valid signature over an invalid shape is still refused. */
export function verifyMiningPolicy(pub: KeyObject, signed: SignedMiningPolicy): { ok: true; policy: MiningPolicyT } | { ok: false; reason: string } {
  const parsed = MiningPolicy.safeParse(signed.policy);
  if (!parsed.success) return { ok: false, reason: 'policy failed validation: ' + parsed.error.issues.map(i => i.message).join('; ') };
  const payload = canonical(parsed.data);
  let valid: boolean;
  try { valid = cryptoVerify('sha256', Buffer.from(payload, 'utf8'), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(signed.signature, 'base64')); }
  catch { return { ok: false, reason: 'malformed signature' }; }
  if (!valid) return { ok: false, reason: 'signature does not match' };
  if (new Date(parsed.data.validUntil) <= new Date()) return { ok: false, reason: 'policy has expired' };   // fail closed on authorization
  return { ok: true, policy: parsed.data };
}

/** Deterministic key order so the same policy always signs/verifies to the same bytes regardless of how the object was constructed. */
function canonical(p: MiningPolicyT): string {
  const ordered = Object.keys(p).sort().reduce((o, k) => { (o as any)[k] = (p as any)[k]; return o; }, {} as Record<string, unknown>);
  return JSON.stringify(ordered);
}
