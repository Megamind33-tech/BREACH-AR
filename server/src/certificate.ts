import { z } from 'zod';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cSign, verify as cVerify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { JobCtx } from './jobs.js';
import { emailHash, maskEmail, type Mailer } from './mailer.js';
import { buildStatement, serialKey } from './certificate-content.js';
import { certificateEmail, certificateEmailHtml } from './certificate-pages.js';
import { certificateDocument } from './certificate-document.js';
import { anatomyHelpers } from './anatomy.js';
import { REFERENCE_PRICE_BOOK } from './anatomy-engine.js';
import { lacks } from './entitlements.js';
export { buildStatement, serialKey };

/**
 * The Viro resale certificate.
 * A seller asks Viro to inspect a computer for a named buyer. Viro reads the machine afresh, signs what it measured, and emails the certificate directly
 * to the buyer. The seller is only ever told where it was sent (a masked address): the verification code exists in the buyer's email and nowhere the seller can see.
 * The statement is signed with Viro's own key, so a copy that has been edited, or that Viro never issued, does not verify.
 */
const DOMAIN = 'viro-resale-cert-v1\n';
const VALID_DAYS = 30;
const INSPECTION_WAIT_HOURS = 24;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export class CertSigner {
  private constructor(private priv: KeyObject, readonly spkiBase64: string, readonly keyId: string) {}
  static fromPem(pem: string) {
    const priv = createPrivateKey(pem); const spki = createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer;
    return new CertSigner(priv, spki.toString('base64'), createHash('sha256').update(spki).digest('hex').slice(0, 12));
  }
  /** Production: CERT_SIGNING_KEY (PKCS8 PEM) is required. Development: a persisted key file. */
  static load(env: NodeJS.ProcessEnv = process.env, devFile = '.devkeys/cert-signing.pem') {
    if (env.CERT_SIGNING_KEY_B64) return CertSigner.fromPem(Buffer.from(env.CERT_SIGNING_KEY_B64, 'base64').toString('utf8'));
    if (env.CERT_SIGNING_KEY) return CertSigner.fromPem(env.CERT_SIGNING_KEY.replace(/\\n/g, '\n'));
    if (env.NODE_ENV === 'production') return null;
    if (existsSync(devFile)) return CertSigner.fromPem(readFileSync(devFile, 'utf8'));
    const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    mkdirSync(dirname(devFile), { recursive: true }); writeFileSync(devFile, pem, { mode: 0o600 });
    return CertSigner.fromPem(pem);
  }
  sign(canonical: string) { return cSign('sha256', Buffer.from(DOMAIN + canonical), { key: this.priv, dsaEncoding: 'ieee-p1363' }).toString('base64'); }
  verify(canonical: string, sig: string) { try { return cVerify('sha256', Buffer.from(DOMAIN + canonical), { key: createPublicKey(this.priv), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64')); } catch { return false; } }
}

/** Key order must never change what is signed. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const newCode = () => { const b = randomBytes(12); const c = Array.from(b, x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join(''); return `VIRO-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`; };
export const normaliseCode = (s: string) => { const t = s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^VIRO/, ''); return t.length === 12 ? `VIRO-${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8, 12)}` : null; };

type Obj = Record<string, any>;

export function registerCertificateRoutes(app: FastifyInstance, c: JobCtx, deps: { mailer: Mailer | null; signer: CertSigner | null; baseUrl: string }) {
  const { db } = c; const { mailer, signer, baseUrl } = deps;
  const uuid = z.string().uuid();

  // ---- the seller's side: ask for an inspection; the certificate itself never comes back here ------------------------------------------------
  app.post('/api/v1/devices/:id/certificates', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ buyerEmail: z.string().email().max(200) }).strict().parse(req.body);
    { const why = await lacks(db, req.user.org, 'certificate.issue'); if (why) return reply.code(402).send({ error: why, upgrade: true }); }
    if (!mailer || !signer) return reply.code(503).send({ error: 'Certificates cannot be issued yet: Viro email delivery or the signing key is not set up on this server.' });
    if (!(await db.query('SELECT 1 FROM devices WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL', [id, req.user.org])).rowCount) return reply.code(404).send({ error: 'computer not found' });
    await db.query(`UPDATE resale_certificates SET status='failed', failure='the computer did not report back in time' WHERE status='awaiting_inspection' AND requested_at < now() - interval '${INSPECTION_WAIT_HOURS} hours'`);
    if ((await db.query(`SELECT 1 FROM resale_certificates WHERE device_id=$1 AND status='awaiting_inspection'`, [id])).rowCount) return reply.code(409).send({ error: 'An inspection for this computer is already in progress.' });
    const r = await db.query(`INSERT INTO resale_certificates(org_id,device_id,requested_by,buyer_email_hash,buyer_email_masked,buyer_email_pending) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, requested_at`,
      [req.user.org, id, req.user.sub, emailHash(b.buyerEmail), maskEmail(b.buyerEmail), b.buyerEmail.trim()]);
    const { createSystemJob } = await import('./jobs.js');
    await createSystemJob(db, c.signer, { orgId: req.user.org, deviceId: id, type: 'anatomy.collect', params: {}, ttlMinutes: INSPECTION_WAIT_HOURS * 60, source: { by: req.user.sub, certificate: r.rows[0].id } });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'certificate.request', targetType: 'device', targetId: id, next: { certificateId: r.rows[0].id, buyer: maskEmail(b.buyerEmail) } });
    return reply.code(202).send({ id: r.rows[0].id, status: 'awaiting_inspection', buyerEmail: maskEmail(b.buyerEmail), message: 'Viro is inspecting the computer now. When it finishes, the certificate is emailed straight to the buyer.' });
  });

  app.get('/api/v1/devices/:id/certificates', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await db.query('SELECT 1 FROM devices WHERE id=$1 AND org_id=$2', [id, req.user.org])).rowCount) return reply.code(404).send({ error: 'computer not found' });
    const rows = (await db.query(`SELECT id, status, buyer_email_masked, requested_at, issued_at, expires_at, emailed_at, revoked_at, revoke_reason, failure FROM resale_certificates WHERE device_id=$1 ORDER BY requested_at DESC LIMIT 50`, [id])).rows;
    return { certificates: rows.map(r => ({ id: r.id, status: r.status === 'issued' && new Date(r.expires_at) < new Date() ? 'expired' : r.status, sentTo: r.buyer_email_masked, requestedAt: r.requested_at, issuedAt: r.issued_at, expiresAt: r.expires_at, emailedAt: r.emailed_at, revokedAt: r.revoked_at, revokeReason: r.revoke_reason, failure: r.failure })) };
  });

  app.post('/api/v1/certificates/:id/revoke', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params); const b = z.object({ reason: z.string().min(3).max(300) }).strict().parse(req.body);
    const r = await db.query(`UPDATE resale_certificates SET status='revoked', revoked_at=now(), revoke_reason=$3 WHERE id=$1 AND org_id=$2 AND status='issued' RETURNING device_id`, [id, req.user.org, b.reason]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found or not issued' });
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'certificate.revoke', targetType: 'device', targetId: r.rows[0].device_id, next: { certificateId: id, reason: b.reason } });
    return { ok: true };
  });

  // ---- issuing: runs when the computer reports a reading taken after the request ------------------------------------------------------------
  async function issueWaiting(orgId: string, deviceId: string) {
    if (!mailer || !signer) return;
    const waiting = (await db.query(`SELECT id, requested_at, buyer_email_pending FROM resale_certificates WHERE device_id=$1 AND status='awaiting_inspection' ORDER BY requested_at`, [deviceId])).rows;
    if (!waiting.length) return;
    const an = (await db.query('SELECT data, collected_at FROM device_anatomy WHERE device_id=$1', [deviceId])).rows[0]; if (!an) return;
    const dev = (await db.query('SELECT enrolled_at FROM devices WHERE id=$1', [deviceId])).rows[0];
    const changes = (await db.query('SELECT detected_at, kind, change, label FROM anatomy_changes WHERE device_id=$1 ORDER BY detected_at DESC LIMIT 200', [deviceId])).rows;
    const service = (await db.query(`SELECT occurred_at, service_type, reason, source FROM service_events WHERE device_id=$1 AND status='CONFIRMED'`, [deviceId])).rows;
    const health = (await db.query('SELECT overall FROM device_health_history WHERE device_id=$1 ORDER BY id DESC LIMIT 1', [deviceId])).rows[0]?.overall ?? null;
    const issues = (await db.query(`SELECT title FROM incidents WHERE device_id=$1 AND status <> 'RESOLVED' ORDER BY points DESC LIMIT 8`, [deviceId])).rows.map((r: any) => r.title as string);
    const orgName = (await db.query('SELECT name FROM organizations WHERE id=$1', [orgId])).rows[0]?.name ?? null;
    const helpers = anatomyHelpers(db); const book = (await helpers.priceBookOf(orgId)) ?? REFERENCE_PRICE_BOOK;
    for (const w of waiting) {
      if (new Date(an.collected_at) <= new Date(w.requested_at)) continue;            // the reading must be taken after the request: an old reading proves nothing
      const now = new Date(); const code = newCode(); const to = String(w.buyer_email_pending);
      const ctx = await helpers.contextFor(orgId, deviceId, an.data, now);
      const stmt = buildStatement({ id: w.id, now, anatomy: an.data, changes, service, firstSeen: dev?.enrolled_at ?? null, health, openIssues: issues, collectedAt: new Date(an.collected_at).toISOString(), ctx, book, listedBy: orgName, buyerMasked: maskEmail(to) });
      const canon = canonical(stmt); const sig = signer.sign(canon);
      const claim = await db.query(`UPDATE resale_certificates SET status='issued', issued_at=$2, expires_at=$3, statement=$4, signature=$5, key_id=$6, code_hash=$7, buyer_email_pending=NULL WHERE id=$1 AND status='awaiting_inspection' RETURNING id`,
        [w.id, now, stmt.expiresAt, canon, sig, signer.keyId, sha(code)]);
      if (!claim.rowCount) continue;
      try {
        const link = `${baseUrl}/verify/${code}`;
        await mailer.send({ to, purpose: 'resale-certificate', subject: `Your Viro certificate for a ${stmt.machine.manufacturer ?? ''} ${stmt.machine.model ?? 'computer'}`.replace(/\s+/g, ' '), text: certificateEmail(stmt, code, link), html: certificateEmailHtml(stmt, code, link, baseUrl) });
        await db.query('UPDATE resale_certificates SET emailed_at=now() WHERE id=$1', [w.id]);
        await c.audit({ orgId, actorType: 'system', action: 'certificate.issued', targetType: 'device', targetId: deviceId, next: { certificateId: w.id, buyer: maskEmail(to) } });
      } catch (e: any) {
        await db.query(`UPDATE resale_certificates SET status='failed', failure=$2, code_hash=NULL, statement=NULL, signature=NULL WHERE id=$1`, [w.id, String(e?.message ?? e).slice(0, 200)]);
      }
    }
  }
  (c as any).afterAnatomy = issueWaiting;

  // ---- the buyer's side: public, read-only ------------------------------------------------------------------------------------------------
  const hits = new Map<string, number[]>();
  const limited = (ip: string) => { const now = Date.now(); const h = (hits.get(ip) ?? []).filter(t => now - t < 60_000); h.push(now); hits.set(ip, h); if (hits.size > 5000) hits.clear(); return h.length > 30; };

  async function lookup(raw: string) {
    const code = normaliseCode(raw); if (!code) return null;
    const r = (await db.query('SELECT id, status, issued_at, expires_at, statement, signature, key_id, revoked_at, revoke_reason FROM resale_certificates WHERE code_hash=$1', [sha(code)])).rows[0];
    if (!r) return null;
    const sigOk = !!signer && r.key_id === signer.keyId && signer.verify(r.statement, r.signature);
    const expired = new Date(r.expires_at) < new Date();
    const state = r.status === 'revoked' ? 'revoked' : !sigOk ? 'invalid' : expired ? 'expired' : 'valid';
    return { state, id: r.id, issuedAt: r.issued_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, revokeReason: r.revoke_reason, signatureValid: sigOk, keyId: r.key_id, statement: JSON.parse(r.statement), signature: r.signature };
  }

  app.get('/api/v1/verify/:code', async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).send({ error: 'too many checks; try again in a minute' });
    const v = await lookup(String((req.params as any).code));
    return v ? v : reply.code(404).send({ state: 'unknown', error: 'No Viro certificate matches this code.' });
  });
  app.post('/api/v1/verify/:code/check-serial', async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).send({ error: 'too many checks; try again in a minute' });
    const b = z.object({ serial: z.string().min(4).max(64) }).strict().parse(req.body); const v = await lookup(String((req.params as any).code));
    if (!v) return reply.code(404).send({ error: 'unknown code' });
    const want = v.statement.binding?.serialCheck; if (!want) return { match: null, note: v.statement.binding?.note };
    return { match: want === serialKey(b.serial) };
  });
  app.get('/api/v1/public/certificate-key', async () => (signer ? { algorithm: 'ECDSA P-256 / SHA-256 (IEEE P1363)', keyId: signer.keyId, spkiBase64: signer.spkiBase64, domainPrefix: DOMAIN.trim() } : { error: 'not configured' }));

  app.get('/verify/:code', async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).type('text/plain').send('Too many checks. Try again in a minute.');
    const v = await lookup(String((req.params as any).code));
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').send(await certificateDocument(v, String((req.params as any).code), baseUrl));
  });
  app.get('/verify', async (_req, reply) => reply.type('text/html; charset=utf-8').send(await certificateDocument(null, '', baseUrl)));
}

