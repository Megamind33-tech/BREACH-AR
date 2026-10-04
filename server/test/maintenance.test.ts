import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.VIRO_MAIL_MODE = 'outbox';
const { startHarness } = await import('./helpers.js');
import { openAccount, pay } from './people.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54431); });
after(async () => { await h.stop(); });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
const outbox = () => (h.app as any).mailer.outbox as { to: string; subject: string; text: string }[];
const PK = { 'x-platform-key': 'platform-key' };

test('the weekly care report is part of a paid plan and is emailed to the person with what was measured', async () => {
  const me = await openAccount(h, 'weekly@example.com');
  const report = { machine: 'LAPTOP-7', version: '0.1.14', before: { freeBytes: 20e9, memoryPercent: 71, startupItems: 14 }, after: { freeBytes: 31.8e9, memoryPercent: 52, startupItems: 8 },
    steps: [{ title: 'Clear temporary files and caches', applied: true, verified: true, summary: 'Cleared 11.8 GB' }, { title: 'Turn off start-up programs', applied: true, verified: false, summary: 'could not confirm' }] };
  assert.equal((await post('/api/v1/my-pc/maintenance-report', report, me)).statusCode, 402);

  await pay(h, me);

  assert.equal((await post('/api/v1/my-pc/maintenance-report', { ...report, before: { freeBytes: -5, memoryPercent: 71, startupItems: 14 } }, me)).statusCode, 400);
  const before = outbox().length;
  assert.equal((await post('/api/v1/my-pc/maintenance-report', report, me)).statusCode, 201);
  const mail = outbox().slice(before).find(m => m.to === 'weekly@example.com')!;
  assert.match(mail.subject, /fixed 1 thing on LAPTOP-7/); assert.match(mail.text, /Freed 11\.\d GB/); assert.match(mail.text, /down 19 points/); assert.match(mail.text, /Turned off 6 start-up programs/); assert.match(mail.text, /1 fix could not be confirmed and were not counted|1 fix could not be confirmed/);
  assert.equal((await h.db.query('SELECT count(*)::int n FROM maintenance_reports WHERE emailed_at IS NOT NULL')).rows[0].n, 1);
});
