import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/* ------------------------------------------------------------------------------------------------
 * WCP1: the WorkCare session protocol between a phone (initiator) and a PC (QuickCheck or Desktop, responder).
 * Primitives available on every platform involved: ECDH P-256, HMAC-SHA256, HKDF-SHA256, AES-256-GCM.
 *
 *   offer    The PC creates an ephemeral P-256 key, a random session id, a one-time secret `q` and an expiry. These travel to the phone
 *            by QR (all four) or by a typed session code (the code derives `q`; the phone finds the session id and public key over the
 *            network). `q` is single use, expires with the session and is never stored.
 *   hello    phone -> PC: phone ephemeral public key, nonce, and HMAC(q, "hello" | session | pcPub | phonePub | nonceP).
 *   accept   PC -> phone: nonce and HMAC(q, "accept" | session | pcPub | phonePub | nonceP | nonceC).
 *   keys     HKDF-SHA256(ikm = ECDH(shared) | q, salt = SHA256(session | nonceP | nonceC), info "WCP1 keys") -> client key, server key.
 *            A 6-digit authentication string (HKDF info "WCP1 sas") is shown on both screens; code-bootstrap requires the user to compare it.
 *   frames   AES-256-GCM. Nonce = 4-byte direction prefix + 8-byte big-endian counter; AAD = session | counter | direction. Counters must
 *            strictly increase, so a replayed or reordered frame is rejected.
 * A session grants inspection only. It expires, allows a limited number of failed attempts, and can be revoked. Managing a PC later is a
 * separate, explicit approval and is not part of this protocol.
 * ---------------------------------------------------------------------------------------------- */

export const PROTOCOL = 'WCP1';
export const MAX_FAILED_ATTEMPTS = 5;
export const DEFAULT_TTL_SECONDS = 600;
export const CODE_TTL_SECONDS = 120;

export const b64u = (b: Buffer) => b.toString('base64url');
export const unb64u = (s: string) => Buffer.from(s, 'base64url');
const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const hmac = (key: Buffer, ...parts: (Buffer | string)[]) => { const h = createHmac('sha256', key); for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p); return h.digest(); };
const eq = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export interface Offer { sessionId: Buffer; pcPub: Buffer; expiresAt: number; secret: Buffer; hints: string[] }
export interface PcOffer { offer: Offer; ecdh: ReturnType<typeof createECDH> }

export function createOffer(nowSeconds: number, opts: { ttl?: number; hints?: string[]; privateKey?: Buffer; sessionId?: Buffer; secret?: Buffer } = {}): PcOffer {
  const ecdh = createECDH('prime256v1');
  if (opts.privateKey) ecdh.setPrivateKey(opts.privateKey); else ecdh.generateKeys();
  return { ecdh, offer: { sessionId: opts.sessionId ?? randomBytes(16), pcPub: ecdh.getPublicKey(), expiresAt: nowSeconds + (opts.ttl ?? DEFAULT_TTL_SECONDS), secret: opts.secret ?? randomBytes(16), hints: opts.hints ?? [] } };
}

/** workcare://pair?v=1&s=..&k=..&e=..&q=..&h=lan:host:port,... : nothing about the device, its owner or its health. */
export function encodeOffer(o: Offer): string {
  const p = new URLSearchParams({ v: '1', s: b64u(o.sessionId), k: b64u(o.pcPub), e: String(o.expiresAt), q: b64u(o.secret) });
  if (o.hints.length) p.set('h', o.hints.join(','));
  return 'workcare://pair?' + p.toString();
}
export function parseOffer(url: string): Offer {
  const u = new URL(url);
  if (u.protocol !== 'workcare:' || u.hostname !== 'pair') throw new Error('not a WorkCare pairing code');
  if (u.searchParams.get('v') !== '1') throw new Error('unsupported pairing version');
  const get = (k: string) => { const v = u.searchParams.get(k); if (!v) throw new Error('pairing code is incomplete'); return v; };
  const o: Offer = { sessionId: unb64u(get('s')), pcPub: unb64u(get('k')), expiresAt: Number(get('e')), secret: unb64u(get('q')), hints: (u.searchParams.get('h') ?? '').split(',').filter(Boolean) };
  if (o.sessionId.length !== 16 || o.pcPub.length !== 65 || o.secret.length !== 16 || !Number.isFinite(o.expiresAt)) throw new Error('pairing code is malformed');
  return o;
}

/** A typed session code: 9 digits grouped 3-3-3. The one-time secret is derived from it, so a typed code is weaker than a QR (lower entropy): it is short-lived, attempt-limited, and the authentication string must be compared. */
export const secretFromCode = (code: string): Buffer => hmac(Buffer.from('WCP1 code', 'utf8'), code.replace(/\D/g, '')).subarray(0, 16);
export function newCode(): string { const n = randomBytes(4).readUInt32BE() % 1_000_000_000; const s = String(n).padStart(9, '0'); return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`; }

export interface Hello { phonePub: Buffer; nonceP: Buffer; proof: Buffer }
export interface Accept { nonceC: Buffer; proof: Buffer }
const helloProof = (q: Buffer, sid: Buffer, pcPub: Buffer, phonePub: Buffer, nonceP: Buffer) => hmac(q, 'hello', sid, pcPub, phonePub, nonceP);
const acceptProof = (q: Buffer, sid: Buffer, pcPub: Buffer, phonePub: Buffer, nonceP: Buffer, nonceC: Buffer) => hmac(q, 'accept', sid, pcPub, phonePub, nonceP, nonceC);

export interface Keys { clientKey: Buffer; serverKey: Buffer; sas: string }
export function deriveKeys(shared: Buffer, q: Buffer, sid: Buffer, nonceP: Buffer, nonceC: Buffer): Keys {
  const salt = sha256(sid, nonceP, nonceC);
  const okm = Buffer.from(hkdfSync('sha256', Buffer.concat([shared, q]), salt, 'WCP1 keys', 64));
  const sasBytes = Buffer.from(hkdfSync('sha256', Buffer.concat([shared, q]), salt, 'WCP1 sas', 4));
  return { clientKey: okm.subarray(0, 32), serverKey: okm.subarray(32, 64), sas: String(sasBytes.readUInt32BE() % 1_000_000).padStart(6, '0') };
}

/** Phone side. */
export function makeHello(offer: Offer, opts: { privateKey?: Buffer; nonce?: Buffer } = {}) {
  const e = createECDH('prime256v1'); if (opts.privateKey) e.setPrivateKey(opts.privateKey); else e.generateKeys();
  const phonePub = e.getPublicKey(), nonceP = opts.nonce ?? randomBytes(16);
  const hello: Hello = { phonePub, nonceP, proof: helloProof(offer.secret, offer.sessionId, offer.pcPub, phonePub, nonceP) };
  return { hello, finish(accept: Accept): Keys {
    if (!eq(accept.proof, acceptProof(offer.secret, offer.sessionId, offer.pcPub, phonePub, nonceP, accept.nonceC))) throw new Error('the computer did not prove it holds this pairing code');
    return deriveKeys(e.computeSecret(offer.pcPub), offer.secret, offer.sessionId, nonceP, accept.nonceC);
  } };
}

export type HelloResult = { ok: true; accept: Accept; keys: Keys } | { ok: false; reason: 'expired' | 'bad_proof' | 'locked' | 'used' | 'malformed' };
/** PC side: one session object per offer. Enforces expiry, single use and the failed-attempt limit. */
export class PcSession {
  failed = 0; used = false; revoked = false;
  constructor(readonly pc: PcOffer) {}
  hello(h: Hello, nowSeconds: number, nonceC: Buffer = randomBytes(16)): HelloResult {
    const { offer, ecdh } = this.pc;
    if (this.revoked || nowSeconds >= offer.expiresAt) return { ok: false, reason: 'expired' };
    if (this.failed >= MAX_FAILED_ATTEMPTS) return { ok: false, reason: 'locked' };
    if (this.used) return { ok: false, reason: 'used' };
    if (h.phonePub.length !== 65 || h.nonceP.length !== 16) return { ok: false, reason: 'malformed' };
    if (!eq(h.proof, helloProof(offer.secret, offer.sessionId, offer.pcPub, h.phonePub, h.nonceP))) { this.failed++; return { ok: false, reason: 'bad_proof' }; }
    let shared: Buffer; try { shared = ecdh.computeSecret(h.phonePub); } catch { this.failed++; return { ok: false, reason: 'malformed' }; }
    this.used = true;
    return { ok: true, accept: { nonceC, proof: acceptProof(offer.secret, offer.sessionId, offer.pcPub, h.phonePub, h.nonceP, nonceC) }, keys: deriveKeys(shared, offer.secret, offer.sessionId, h.nonceP, nonceC) };
  }
  revoke() { this.revoked = true; }
}

// ---------------------------------------------------------------------------------------------- frames
export type Direction = 'c2s' | 's2c';
const DIR: Record<Direction, number> = { c2s: 1, s2c: 2 };
const nonceOf = (dir: Direction, counter: bigint) => { const n = Buffer.alloc(12); n.writeUInt32BE(DIR[dir], 0); n.writeBigUInt64BE(counter, 4); return n; };
const aadOf = (sid: Buffer, dir: Direction, counter: bigint) => { const a = Buffer.alloc(16 + 1 + 8); sid.copy(a, 0); a.writeUInt8(DIR[dir], 16); a.writeBigUInt64BE(counter, 17); return a; };

export function seal(key: Buffer, sid: Buffer, dir: Direction, counter: bigint, plaintext: Buffer): Buffer {
  const c = createCipheriv('aes-256-gcm', key, nonceOf(dir, counter)); c.setAAD(aadOf(sid, dir, counter));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const frame = Buffer.alloc(8); frame.writeBigUInt64BE(counter);
  return Buffer.concat([frame, ct, c.getAuthTag()]);          // counter(8) | ciphertext | tag(16)
}
export function open(key: Buffer, sid: Buffer, dir: Direction, frame: Buffer): { counter: bigint; plaintext: Buffer } {
  if (frame.length < 8 + 16) throw new Error('frame too short');
  const counter = frame.readBigUInt64BE(0), ct = frame.subarray(8, frame.length - 16), tag = frame.subarray(frame.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, nonceOf(dir, counter)); d.setAAD(aadOf(sid, dir, counter)); d.setAuthTag(tag);
  return { counter, plaintext: Buffer.concat([d.update(ct), d.final()]) };
}

/** One direction of an established session: tracks the highest counter seen so replays and reordering are refused. */
export class Channel {
  private sendCounter = 0n; private lastSeen = -1n;
  constructor(private keys: Keys, private sid: Buffer, private role: 'client' | 'server') {}
  private get sendDir(): Direction { return this.role === 'client' ? 'c2s' : 's2c'; }
  private get recvDir(): Direction { return this.role === 'client' ? 's2c' : 'c2s'; }
  private key(dir: Direction) { return dir === 'c2s' ? this.keys.clientKey : this.keys.serverKey; }
  send(plaintext: Buffer): Buffer { return seal(this.key(this.sendDir), this.sid, this.sendDir, this.sendCounter++, plaintext); }
  receive(frame: Buffer): Buffer {
    const { counter, plaintext } = open(this.key(this.recvDir), this.sid, this.recvDir, frame);
    if (counter <= this.lastSeen) throw new Error('replayed or out-of-order frame');
    this.lastSeen = counter; return plaintext;
  }
}
