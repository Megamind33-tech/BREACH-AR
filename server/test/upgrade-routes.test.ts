import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startHarness } from './helpers.js';

const fixture = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/upgrade/${n}`, import.meta.url), 'utf8'));
let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54373); });
after(async () => { await h.stop(); });
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) => h.app.inject({ method, url, payload: payload as any, headers });
const PK = { 'x-platform-key': 'platform-key' }; const PW = 'correct horse battery';
async function org(name: string, email: string) {
  const r = await call('POST', '/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: PW, autopilot: false }, PK);
  const l = await call('POST', '/api/v1/auth/login', { email, password: PW }); return { id: r.json().organizationId as string, auth: { authorization: `Bearer ${l.json().token}` } };
}
async function enroll(o: { auth: Record<string, string> }, name: string) {
  const t = await call('POST', '/api/v1/enrollment-tokens', {}, o.auth);
  const e = await call('POST', '/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: 'G-' + randomBytes(6).toString('hex'), hostname: name, agentVersion: '0.1.5' });
  return { id: e.json().deviceId as string, auth: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } };
}

test('upgrade advice from a real reading: stored as history only when it changes, immutable, priced from the price book, and isolated per organization', async () => {
  const a = await org('Upgrade Co', 'owner@upgrade.test'), b = await org('Other Upgrade', 'owner@other-upgrade.test');
  const pc = await enroll(a, 'OFFICE-PC');
  assert.equal((await call('GET', `/api/v1/devices/${pc.id}/upgrades`, undefined, a.auth)).json().available, false);
  assert.equal((await call('POST', '/agent/v1/anatomy', fixture('hp-290-g4.json'), pc.auth)).statusCode, 201);
  const r1 = (await call('GET', `/api/v1/devices/${pc.id}/upgrades`, undefined, a.auth)).json();
  assert.equal(r1.available, true); assert.equal(r1.report.best, 'storage-failing'); assert.equal(r1.report.recommendations[0].class, 'ESSENTIAL'); assert.ok(!JSON.stringify(r1).includes('weights'));
  assert.ok(!r1.report.recommendations.some((x: any) => x.component === 'cpu'));
  const r2 = (await call('GET', `/api/v1/devices/${pc.id}/upgrades`, undefined, a.auth)).json(); assert.equal(r2.recommendationRecord, r1.recommendationRecord, 'unchanged advice does not write a second history row');
  assert.equal((await h.db.query('SELECT count(*)::int n FROM upgrade_recommendations WHERE device_id=$1', [pc.id])).rows[0].n, 1);
  await assert.rejects(h.db.query('UPDATE upgrade_recommendations SET grade=$2 WHERE device_id=$1', [pc.id, 'A']), /immutable/);
  // prices make the money figures appear, and a changed set of recommendations is a new history row
  await call('POST', '/api/v1/price-book/reference', {}, a.auth);
  const r3 = (await call('GET', `/api/v1/devices/${pc.id}/upgrades`, undefined, a.auth)).json(); assert.ok(r3.report.recommendations[0].cost.currency === 'USD');
  assert.equal((await call('GET', `/api/v1/devices/${pc.id}/upgrades`, undefined, b.auth)).statusCode, 404);
  assert.equal((await call('GET', '/api/v1/upgrades/fleet', undefined, b.auth)).json().analysed, 0);
  const fleet = (await call('GET', '/api/v1/upgrades/fleet', undefined, a.auth)).json(); assert.equal(fleet.analysed, 1); assert.equal(fleet.categories[0].category, 'Storage replacement'); assert.ok(fleet.purchasePlan.length >= 1);
  assert.equal((await call('PUT', '/api/v1/upgrades/settings', { shareOutcomes: true }, a.auth)).statusCode, 200); assert.equal((await call('GET', '/api/v1/upgrades/settings', undefined, a.auth)).json().shareOutcomes, true);
});

test('recommend -> install -> measure -> prove -> learn: a swap is detected, re-measured by the computer, judged against the prediction, and kept as a verified outcome', async () => {
  const o = await org('Verify Co', 'owner@verify.test'); const pc = await enroll(o, 'LAB-PC');
  const before = { ...fixture('hp-290-g4.json') };
  await call('POST', '/agent/v1/anatomy', before, pc.auth);
  await call('GET', `/api/v1/devices/${pc.id}/upgrades`, undefined, o.auth);                                               // a recommendation record exists
  await call('PUT', '/api/v1/upgrades/settings', { shareOutcomes: true }, o.auth);
  // the computer reports a baseline measurement taken before the change (stored as the comparison point)
  await h.db.query(`INSERT INTO upgrade_benchmarks(org_id,device_id,purpose,metrics,safety) VALUES ($1,$2,'baseline',$3,$4)`, [o.id, pc.id, JSON.stringify({ cpuSingleScore: 100, cpuMultiScore: 400, cpuSustainedScore: 380, peakTempC: 74 }), JSON.stringify({ aborted: false })]);
  // someone fits a different processor: the next reading shows it
  const after = JSON.parse(JSON.stringify(before)); after.collectedAt = '2026-10-05T10:00:00Z'; after.cpu = { ...after.cpu, name: 'Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz', cores: 8, logical: 16 };
  const r = await call('POST', '/agent/v1/anatomy', after, pc.auth); assert.equal(r.statusCode, 201);
  const ver = (await h.db.query('SELECT * FROM upgrade_verifications WHERE device_id=$1', [pc.id])).rows; assert.equal(ver.length, 1); assert.equal(ver[0].state, 'awaiting_measurement'); assert.equal(ver[0].changes[0].kind, 'cpu'); assert.equal(ver[0].changes[0].fromPart, '10500'); assert.equal(ver[0].changes[0].toPart, '10700');
  assert.ok(ver[0].job_id, 'the computer was asked to re-measure'); assert.deepEqual(ver[0].before_metrics, { cpuSingleScore: 100, cpuMultiScore: 400, cpuSustainedScore: 380, peakTempC: 74 });
  // the computer starts the job and returns its measurements
  assert.equal((await call('POST', `/agent/v1/jobs/${ver[0].job_id}/start`, {}, pc.auth)).statusCode, 200);
  const res = await call('POST', `/agent/v1/jobs/${ver[0].job_id}/result`, { status: 'completed', result: { metrics: { cpuSingleScore: 112, cpuMultiScore: 590, cpuSustainedScore: 555, peakTempC: 71 }, safety: { aborted: false, maxTempC: 71 } } }, pc.auth); assert.equal(res.statusCode, 200);
  const done = (await h.db.query('SELECT state, result FROM upgrade_verifications WHERE id=$1', [ver[0].id])).rows[0];
  assert.equal(done.state, 'done'); assert.equal(done.result.verdict, 'VERIFIED'); assert.equal(done.result.stability, 'PASS'); assert.equal(done.result.temperatureChangeC, -3); assert.ok(done.result.overallPercent > 30 && done.result.overallPercent < 60);
  const out = (await h.db.query('SELECT * FROM upgrade_outcomes WHERE org_id=$1', [o.id])).rows; assert.equal(out.length, 1); assert.equal(out[0].success, true); assert.equal(out[0].shared, true); assert.equal(out[0].to_part, '10700'); assert.equal(out[0].board_key, 'hp 8948');
  const hist = (await call('GET', `/api/v1/devices/${pc.id}/upgrades/history`, undefined, o.auth)).json(); assert.equal(hist.verifications[0].state, 'done');
  // a failed re-measurement is "inconclusive", never "verified"
  const pc2 = await enroll(o, 'LAB-PC-2'); await call('POST', '/agent/v1/anatomy', before, pc2.auth); const after2 = JSON.parse(JSON.stringify(before)); after2.collectedAt = '2026-10-05T10:00:00Z'; after2.cpu = { ...after2.cpu, name: 'Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz', cores: 8, logical: 16 };
  await call('POST', '/agent/v1/anatomy', after2, pc2.auth); const v2 = (await h.db.query('SELECT job_id FROM upgrade_verifications WHERE device_id=$1', [pc2.id])).rows[0];
  await call('POST', `/agent/v1/jobs/${v2.job_id}/start`, {}, pc2.auth); await call('POST', `/agent/v1/jobs/${v2.job_id}/result`, { status: 'failed', error: 'too hot' }, pc2.auth);
  assert.equal((await h.db.query('SELECT state FROM upgrade_verifications WHERE device_id=$1', [pc2.id])).rows[0].state, 'inconclusive');
});
