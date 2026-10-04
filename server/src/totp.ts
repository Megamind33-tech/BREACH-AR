import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/* RFC 6238 time-based one-time passwords (SHA-1, 6 digits, 30 s), compatible with every authenticator app. No third-party code. */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of s.replace(/[\s=-]/g, '').toUpperCase()) {
    const i = B32.indexOf(c); if (i < 0) throw new Error('not base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));
export const stepOf = (ms: number) => Math.floor(ms / 30_000);

export function hotp(secret: Buffer, counter: number): string {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(c).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

/** Accepts the current code and one step either side (clock drift). Returns the matching step, or null. A step at or before `lastStep` is refused (no reuse). */
export function verifyTotp(secretB32: string, code: string, nowMs = Date.now(), lastStep: number | null = null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32), now = stepOf(nowMs);
  for (const s of [now, now - 1, now + 1]) {
    if (lastStep != null && s <= lastStep) continue;
    const want = Buffer.from(hotp(secret, s)), got = Buffer.from(code);
    if (timingSafeEqual(want, got)) return s;
  }
  return null;
}

export const otpauthUri = (issuer: string, account: string, secretB32: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---- secrets at rest -------------------------------------------------------------------------------------------------------
const keyOf = (serverSecret: string) => createHash('sha256').update('viro-mfa-v1:' + serverSecret).digest();
export function sealSecret(plain: string, serverSecret: string): string {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keyOf(serverSecret), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
export function openSecret(sealed: string, serverSecret: string): string {
  const [iv, tag, enc] = sealed.split('.').map(p => Buffer.from(p, 'base64'));
  const d = createDecipheriv('aes-256-gcm', keyOf(serverSecret), iv!); d.setAuthTag(tag!);
  return Buffer.concat([d.update(enc!), d.final()]).toString('utf8');
}

// ---- recovery codes --------------------------------------------------------------------------------------------------------
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => { const p = () => Array.from({ length: 5 }, () => ALPHA[randomInt(ALPHA.length)]).join(''); return `${p()}-${p()}`; });
}
export const normalizeRecovery = (s: string) => s.trim().toLowerCase();
export const hashRecovery = (code: string) => createHash('sha256').update('viro-recovery-v1:' + normalizeRecovery(code)).digest('hex');
