import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Db } from './db.js';

export interface Mail { to: string; subject: string; text: string; html?: string; purpose: string }
export interface Mailer { readonly mode: 'smtp' | 'outbox'; send(m: Mail): Promise<void>; readonly outbox: Mail[] }

const hash = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');
export const emailHash = hash;
/** jane.doe@example.com -> j***@e***.com : enough for a person to recognise where it went, not enough to reuse the address. */
export function maskEmail(e: string): string {
  const [u = '', d = ''] = e.trim().split('@'); const dot = d.lastIndexOf('.');
  return `${u.slice(0, 1)}***@${d.slice(0, 1)}***${dot > 0 ? d.slice(dot) : ''}`;
}

/**
 * Viro's own outgoing mail. Configure SMTP_URL (for example smtps://user:password@mail.example.com) and MAIL_FROM. With VIRO_MAIL_MODE=outbox (development and tests)
 * messages are kept in memory instead of being sent. With neither, `mailer` is null and anything that needs email says plainly that email is not set up.
 */
export function createMailer(db: Db, env: NodeJS.ProcessEnv = process.env): Mailer | null {
  const log = async (m: Mail, status: 'sent' | 'failed', error?: string) => { try { await db.query('INSERT INTO mail_log(purpose,to_hash,status,error) VALUES ($1,$2,$3,$4)', [m.purpose, hash(m.to), status, error ?? null]); } catch { /* the log must never block a send */ } };
  if (env.VIRO_MAIL_MODE === 'outbox') {
    const outbox: Mail[] = [];
    return { mode: 'outbox', outbox, async send(m) { outbox.push(m); await log(m, 'sent'); } };
  }
  if (!env.SMTP_URL) return null;
  const from = env.MAIL_FROM || 'Viro WorkCare <no-reply@viro3.online>';
  const transport = nodemailer.createTransport(env.SMTP_URL);
  return {
    mode: 'smtp', outbox: [],
    async send(m) {
      try { await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html }); await log(m, 'sent'); }
      catch (e: any) { await log(m, 'failed', String(e?.message ?? e).slice(0, 300)); throw new Error('the email could not be sent'); }
    },
  };
}
