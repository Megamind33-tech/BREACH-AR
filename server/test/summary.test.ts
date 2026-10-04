import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHarness } from './helpers.js';
import { buildSummary, summaryTick } from '../src/summary.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54341); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });

async function mkOrg(name: string, email: string, autopilot?: boolean) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', ...(autopilot === undefined ? {} : { autopilot }) }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function enroll(auth: Hdr, guid: string, hostname: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
type Dev = Awaited<ReturnType<typeof enroll>>;
const GB = 2 ** 30;
const putHealth = (d: Dev, over: object = {}) => put('/agent/v1/health', { collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }], ...over }, d.dev);
const beat = (d: Dev, hostname: string) => h.app.inject({ method: 'POST', url: '/agent/v1/heartbeat', headers: d.dev, payload: { hostname, agentVersion: '0.1.0', metrics: {} } });
async function runJob(a: { auth: Hdr }, d: Dev, type: string, params: object, result: object) {
  const id = (await post('/api/v1/jobs', { type, params, target: { deviceIds: [d.deviceId] } }, a.auth)).json().jobs[0].id;
  assert.equal((await post(`/agent/v1/jobs/${id}/start`, {}, d.dev)).statusCode, 200);
  assert.equal((await post(`/agent/v1/jobs/${id}/result`, { status: 'completed', result }, d.dev)).statusCode, 200);
}

test('the summary states the facts in plain words: PC states, what was done automatically, and what needs a person', async () => {
  const a = await mkOrg('Sum Org', 'o@sum.test', false);
  const empty = await get('/api/v1/summary', a.auth); assert.match(empty.json().headline, /No computers/);

  const [d1, d2, d3, off] = await Promise.all([1, 2, 3, 4].map(n => enroll(a.auth, `sum-dev-000${n}`, `SUM-PC-${n}`)));
  for (const [d, n] of [[d1, 'SUM-PC-1'], [d2, 'SUM-PC-2'], [d3, 'SUM-PC-3']] as [Dev, string][]) await beat(d, n);           // reporting recently
  for (const d of [d1, d2]) await putHealth(d);
  await putHealth(d3, { volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 3 * GB, isSystem: true }], defender: { antivirusEnabled: false }, avProducts: [] });
  await putHealth(off);
  await h.db.query(`UPDATE devices SET last_seen_at = now() - interval '10 days' WHERE id=$1`, [off.deviceId]);

  await runJob(a, d1, 'updates.install', { scope: 'security' }, { installed: 3, rebootRequired: true });
  await runJob(a, d2, 'cleanup.run', { categories: ['windows-temp'] }, { freedBytes: 2 * GB });
  await runJob(a, d2, 'repair.run', { recipe: 'services.restart-failed' }, { summary: 'Repaired and verified: all services are running' });
  await runJob(a, d1, 'repair.run', { recipe: 'dns.flush' }, { summary: 'No action needed: name resolution works' });

  const s = (await get('/api/v1/summary', a.auth)).json();
  assert.equal(s.pcs.total, 4); assert.equal(s.pcs.notReporting, 1); assert.equal(s.pcs.healthy + s.pcs.attention + s.pcs.critical, 3);
  assert.ok(s.pcs.healthy >= 2);
  assert.equal(s.done.securityUpdatesInstalled, 3); assert.equal(s.done.cleanedMb, 2048); assert.equal(s.done.repairsFixed, 1, '"no action needed" is not counted as a fix');
  assert.equal(s.needsYou[0].severity, 'critical', 'critical first'); assert.equal(s.needsYou[0].hostname, 'SUM-PC-3');
  assert.match(s.headline, /^\d of 4 PCs are healthy, 1 not reporting\.$/);
  assert.match(s.text, /installed 3 security updates/); assert.match(s.text, /fixed 1 problem/); assert.match(s.text, /cleaned 2\.0 GB/); assert.match(s.text, /SUM-PC-3/);

  // acknowledged alerts leave the list; another organization never appears in it
  const b = await mkOrg('Sum Other', 'o@sum-other.test', false); await enroll(b.auth, 'sum-dev-0009', 'OTHER-PC');
  assert.ok(!(await get('/api/v1/summary', b.auth)).json().text.includes('SUM-PC'));
  const clean = await mkOrg('Sum Clean', 'o@sum-clean.test', false); const c1 = await enroll(clean.auth, 'sum-dev-0010', 'C-PC'); await beat(c1, 'C-PC'); await putHealth(c1);
  const cs = (await buildSummary(h.db, clean.orgId)); assert.equal(cs.headline, 'Your PC is healthy.'); assert.match(cs.text, /Nothing needs your attention/); assert.match(cs.text, /Nothing needed doing/);
});

test('the weekly summary is pushed once to the webhooks of Autopilot organizations only', async () => {
  process.env.VIRO_ALLOW_PRIVATE_WEBHOOKS = '1';
  const got: any[] = [];
  const srv = createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`;
  try {
    const on = await mkOrg('Sum On', 'o@sum-on.test');                 // Autopilot by default
    const off = await mkOrg('Sum Off', 'o@sum-off.test', false);
    for (const o of [on, off]) { assert.equal((await post('/api/v1/alert-webhooks', { url }, o.auth)).statusCode, 201); await enroll(o.auth, `sum-hook-${o.orgId.slice(0, 6)}`, 'HOOK-PC'); }
    const n = await summaryTick(h.db);
    assert.equal(n, 1, 'only the Autopilot organization');
    const ev = got.filter(x => x.event === 'weekly_summary'); assert.equal(ev.length, 1);
    assert.equal(ev[0].organizationId, on.orgId); assert.match(ev[0].text, /PC/); assert.equal(ev[0].summary.pcs.total, 1);
    assert.equal(await summaryTick(h.db), 0, 'not again within the week');
    assert.equal(await summaryTick(h.db, new Date(Date.now() + 8 * 86_400_000)), 1, 'due again after a week');
  } finally { delete process.env.VIRO_ALLOW_PRIVATE_WEBHOOKS; srv.closeAllConnections(); await new Promise<void>(r => srv.close(() => r())); }
});
