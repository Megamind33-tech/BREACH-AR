import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { securityTick, threatType, threatPathsOf, verdict, verification, proposedActions } from '../src/security-incidents.js';
import { decideGate, healthGate } from '../src/healthgate.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54351); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>; type Dev = { deviceId: string; dev: Hdr };
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });
const GB = 1024 ** 3;
async function mkOrg(name: string, email: string) {
  await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { authorization: `Bearer ${l.json().token}` } as Hdr;
}
async function enroll(auth: Hdr, guid: string): Promise<Dev> {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname: guid, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } };
}
const TROJAN = 'C:\\Users\\bob\\AppData\\Roaming\\svch0st\\svch0st.exe';
const threat = (over: object = {}) => ({ name: 'Trojan:Win32/Fakeinstall', severity: 'severe', active: true, detectedAt: new Date().toISOString(), remediated: false, resources: [`file:_${TROJAN}`], ...over });
const health = (d: Dev, threats: object[], sec: object = {}) => put('/agent/v1/health', { collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }], defender: { antivirusEnabled: true, realTimeProtection: true, signatureAgeDays: 0 }, avProducts: ['Windows Defender'], firewall: { domain: true, private: true, public: true }, security: { engine: 'Microsoft Defender', engineIsDefender: true, threats, ...sec } }, d.dev);
const jobsOf = async (d: Dev, type: string) => (await h.db.query(`SELECT id, status, params FROM jobs WHERE device_id=$1 AND type=$2 ORDER BY created_at`, [d.deviceId, type])).rows as { id: string; status: string; params: any }[];
async function agentRuns(d: Dev, jobId: string, status: 'completed' | 'failed', result?: unknown, error?: string) {
  assert.equal((await post(`/agent/v1/jobs/${jobId}/start`, {}, d.dev)).statusCode, 200);
  assert.equal((await post(`/agent/v1/jobs/${jobId}/result`, { status, result, error }, d.dev)).statusCode, 200);
}
const inc = async (d: Dev) => (await h.db.query(`SELECT * FROM security_incidents WHERE device_id=$1 ORDER BY created_at DESC LIMIT 1`, [d.deviceId])).rows[0];
const tick = (now?: Date) => securityTick(h.db, h.signer, now);

test('classification, threat paths, the checklist verdict and proposals are conservative', () => {
  assert.equal(threatType('Ransom:Win32/Locky.A'), 'ransomware'); assert.equal(threatType('PUA:Win32/Presenoker'), 'pua'); assert.equal(threatType('Trojan:Win32/Wacatac'), 'malware'); assert.equal(threatType('Virus:DOS/EICAR_Test_File'), 'malware'); assert.equal(threatType('Something new'), 'other');
  assert.deepEqual(threatPathsOf(['file:_C:\\a\\b.exe', 'regkey:_HKLM\\x', 'file:_/etc/passwd', '  ']), ['C:\\a\\b.exe']);
  assert.equal(verdict({ threatGone: true, scanClean: true, noLinkedPersistence: true, protectionHealthy: true, policyRestored: true }), 'clean');
  assert.equal(verdict({ threatGone: true, scanClean: true, noLinkedPersistence: false, protectionHealthy: true, policyRestored: true }), 'failed');
  assert.equal(verdict({ threatGone: true, scanClean: null, noLinkedPersistence: true, protectionHealthy: true, policyRestored: true }), 'unverifiable', 'an unmeasured scan is never "clean"');
  assert.equal(verdict({ threatGone: null, scanClean: true, noLinkedPersistence: true, protectionHealthy: true, policyRestored: true }), 'unverifiable');
  const v = verification({ scan: { id: 's', status: 'failed', result: null, error: 'Microsoft Defender is not the active antivirus' }, status: { id: 'x', status: 'completed', result: { threats: [], engineIsDefender: true }, error: null }, inspect: { id: 'i', status: 'completed', result: { findings: [] }, error: null } }, 'T');
  assert.equal(verdict(v), 'unverifiable'); assert.match(v.unverifiableReason!, /not the active antivirus/);
  const fs = [{ kind: 'startup-entry', suspicious: true, confidence: 'HIGH', location: 'HKLM\\Run', name: 'svch0st', recipe: 'security.remove-persistence', evidence: 'e1' }, { kind: 'proxy', suspicious: true, confidence: 'MEDIUM', location: 'machine', name: 'proxy', recipe: 'security.restore-proxy', evidence: 'e2' }, { kind: 'startup-entry', suspicious: false, confidence: 'LOW', location: 'x', name: 'Teams', recipe: null, evidence: 'e3' }];
  const acts = proposedActions(fs, ['C:\\a.exe']);
  assert.deepEqual(acts.map(a => a.recipe).sort(), ['security.remove-persistence', 'security.restore-proxy']);
  assert.deepEqual(acts.find(a => a.recipe === 'security.remove-persistence')!.options, { threatPaths: ['C:\\a.exe'], entries: [{ location: 'HKLM\\Run', name: 'svch0st' }] }, 'only what a detection links to is ever named for removal');
  assert.deepEqual(proposedActions([{ ...fs[0], confidence: 'MEDIUM' }], []), [], 'persistence without a linking detection is never proposed for removal');
});

test('compute is blocked while a threat is handled, paused while it is verified, and allowed again only once it is verified clean', () => {
  assert.equal(decideGate([], []).gate, 'ALLOW');
  assert.equal(decideGate([], [{ status: 'CONTAINING', threat_type: 'malware' }]).gate, 'BLOCK');
  assert.equal(decideGate([], [{ status: 'REPAIR_READY', threat_type: 'malware' }]).gate, 'BLOCK');
  assert.equal(decideGate([], [{ status: 'DETECTED', threat_type: 'ransomware' }]).gate, 'BLOCK'); assert.match(decideGate([], [{ status: 'VERIFYING', threat_type: 'ransomware' }]).reason, /Ransomware/);
  assert.equal(decideGate([], [{ status: 'VERIFYING', threat_type: 'malware' }]).gate, 'PAUSE');
  assert.equal(decideGate([], [{ status: 'OBSERVING', threat_type: 'malware' }]).gate, 'ALLOW'); assert.equal(decideGate([], [{ status: 'RESOLVED', threat_type: 'malware' }]).gate, 'ALLOW');
  assert.equal(decideGate([{ code: 'hardware.disk', status: 'DETECTED', impact: 'high', remedy: 'hardware' }], [{ status: 'CONTAINING', threat_type: 'malware' }]).gate, 'BLOCK');
});

test('a detected Trojan is contained, investigated, repaired with approval, verified by a fresh scan, observed and only then resolved', async () => {
  const a = await mkOrg('Sec Org', 'o@sec.test'), d = await enroll(a, 'sec-dev-0001');
  await health(d, [threat()]); await tick();
  let i = await inc(d); assert.equal(i.status, 'CONTAINING'); assert.equal(i.threat_type, 'malware'); assert.equal(i.source, 'Microsoft Defender');
  const rem = (await jobsOf(d, 'security.remediate'))[0]; assert.ok(rem);
  assert.equal((await healthGate(h.db, d.deviceId)).gate, 'BLOCK', 'the real gate for this PC is BLOCK while the threat is handled');
  await tick(); assert.equal((await inc(d)).status, 'CONTAINING', 'waits for the job; nothing is assumed');
  await agentRuns(d, rem.id, 'completed', { action: 'security.remediate' }); await tick(); assert.equal((await inc(d)).status, 'QUARANTINED');
  await tick(); i = await inc(d); assert.equal(i.status, 'INVESTIGATING');
  const inv = (await jobsOf(d, 'security.investigate'))[0]; assert.deepEqual(inv.params.threatPaths, [TROJAN], 'the investigation is told exactly which path Defender reported');

  const findings = [
    { kind: 'startup-entry', severity: 'high', suspicious: true, confidence: 'HIGH', evidence: 'svch0st starts the detected file', location: 'HKU\\S-1-5-21-1\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'svch0st', recipe: 'security.remove-persistence' },
    { kind: 'proxy', severity: 'high', suspicious: true, confidence: 'MEDIUM', evidence: 'traffic goes through 127.0.0.1:8888', location: 'machine', name: 'proxy', recipe: 'security.restore-proxy' },
    { kind: 'startup-entry', severity: 'low', suspicious: false, confidence: 'LOW', evidence: 'Teams starts from AppData', location: 'HKLM\\Run', name: 'Teams', recipe: null }];
  await agentRuns(d, inv.id, 'completed', { findings, investigatedAt: new Date().toISOString(), limits: 'x' }); await tick();
  i = await inc(d); assert.equal(i.status, 'REPAIR_READY'); assert.equal(i.persistence_found, true); assert.deepEqual(i.proposed_actions.map((x: any) => x.recipe).sort(), ['security.remove-persistence', 'security.restore-proxy']);
  assert.equal(i.proposed_actions.find((x: any) => x.recipe === 'security.remove-persistence').options.entries.length, 1, 'Teams is not proposed');

  assert.equal((await post(`/api/v1/security-incidents/${i.id}/approve`, { recipes: ['security.restore-dns'] }, a)).statusCode, 400, 'only what Viro proposed can be approved');
  assert.equal((await post(`/api/v1/security-incidents/${i.id}/approve`, { recipes: ['security.restore-proxy'] }, {})).statusCode, 401);
  const ok = await post(`/api/v1/security-incidents/${i.id}/approve`, { recipes: ['security.remove-persistence', 'security.restore-proxy'] }, a); assert.equal(ok.statusCode, 202);
  assert.equal((await post(`/api/v1/security-incidents/${i.id}/approve`, { recipes: ['security.restore-proxy'] }, a)).statusCode, 409, 'cannot be approved twice');
  const reps = await jobsOf(d, 'repair.run'); assert.equal(reps.length, 2); for (const r of reps) assert.equal(r.params.approved, true);
  assert.deepEqual(reps.find(r => r.params.recipe === 'security.remove-persistence')!.params.options, { threatPaths: [TROJAN], entries: [{ location: findings[0].location, name: 'svch0st' }] });
  await tick(); assert.equal((await inc(d)).status, 'REPAIRING');
  for (const r of reps) await agentRuns(d, r.id, 'completed', { verified: true, summary: 'ok' });
  await tick(); assert.equal((await inc(d)).status, 'VERIFYING');
  assert.equal((await jobsOf(d, 'security.scan')).length, 1); assert.equal((await jobsOf(d, 'security.status')).length, 1); assert.equal((await jobsOf(d, 'security.investigate')).length, 2);

  const [scan] = await jobsOf(d, 'security.scan'), [stat] = await jobsOf(d, 'security.status'), ins = (await jobsOf(d, 'security.investigate'))[1];
  await agentRuns(d, scan.id, 'completed', { action: 'security.scan' }); await tick(); assert.equal((await inc(d)).status, 'VERIFYING', 'waits for all three checks');
  await agentRuns(d, stat.id, 'completed', { threats: [], engineIsDefender: true, behaviorMonitor: true, tamperProtection: true }); await agentRuns(d, ins.id, 'completed', { findings: [findings[2]] });
  await tick(); i = await inc(d); assert.equal(i.status, 'OBSERVING'); assert.equal((await healthGate(h.db, d.deviceId)).gate, 'ALLOW'); assert.equal(i.verification_status, 'clean'); assert.equal(i.verification.scanClean, true); assert.ok(i.observe_until);

  await tick(new Date(Date.now() + 2 * 3_600_000)); assert.equal((await inc(d)).status, 'OBSERVING', 'not resolved until the observation period has passed');
  await tick(new Date(Date.now() + 25 * 3_600_000)); i = await inc(d); assert.equal(i.status, 'RESOLVED'); assert.ok(i.resolved_at);
  const events = i.timeline.map((x: any) => x.event); for (const e of ['detected', 'containing', 'contained', 'investigating', 'repair ready', 'repair approved', 'verifying', 'verified clean', 'resolved']) assert.ok(events.includes(e), e);

  const detail = (await get(`/api/v1/security-incidents/${i.id}`, a)).json(); assert.equal(detail.status, 'RESOLVED'); assert.ok(detail.timeline.length >= 9); assert.equal(detail.hostname, 'sec-dev-0001');
  assert.equal((await get('/api/v1/security-incidents?open=true', a)).json().incidents.length, 0);
  assert.ok((await h.db.query(`SELECT 1 FROM audit_log WHERE action='security_incident.resolved'`)).rowCount);
});

test('if the result cannot be measured or the threat is still there the incident is never called resolved', async () => {
  const a = await mkOrg('Sec Org 2', 'o@sec2.test');
  // Defender could not run the verification scan: unverifiable, handed to an administrator
  const d1 = await enroll(a, 'sec-dev-0002'); await health(d1, [threat({ active: false, remediated: true, name: 'Trojan:Win32/Quiet' })]); await tick();
  assert.equal((await inc(d1)).status, 'QUARANTINED', 'Defender had already quarantined it'); await tick();
  await agentRuns(d1, (await jobsOf(d1, 'security.investigate'))[0].id, 'completed', { findings: [] }); await tick(); assert.equal((await inc(d1)).status, 'VERIFYING', 'nothing else to repair: go straight to verification');
  await agentRuns(d1, (await jobsOf(d1, 'security.scan'))[0].id, 'failed', undefined, 'Microsoft Defender is not the active antivirus on this PC');
  await agentRuns(d1, (await jobsOf(d1, 'security.status'))[0].id, 'completed', { threats: [], engineIsDefender: true }); await agentRuns(d1, (await jobsOf(d1, 'security.investigate'))[1].id, 'completed', { findings: [] });
  await tick(); let i = await inc(d1); assert.equal(i.status, 'ADMIN_ACTION_REQUIRED'); assert.equal(i.verification_status, 'unverifiable'); assert.match(i.timeline.at(-1).detail, /fresh scan could not be run/);
  assert.equal(decideGate([], [{ status: i.status, threat_type: i.threat_type }]).gate, 'BLOCK', 'compute stays off while it is unresolved');

  // the threat is still listed active after "repair": verification fails
  const d2 = await enroll(a, 'sec-dev-0003'); await health(d2, [threat({ active: false, remediated: true, name: 'Trojan:Win32/Stubborn' })]); await tick(); await tick();
  await agentRuns(d2, (await jobsOf(d2, 'security.investigate'))[0].id, 'completed', { findings: [] }); await tick();
  await agentRuns(d2, (await jobsOf(d2, 'security.scan'))[0].id, 'completed', {}); await agentRuns(d2, (await jobsOf(d2, 'security.status'))[0].id, 'completed', { threats: [{ name: 'Trojan:Win32/Stubborn', active: true }], engineIsDefender: true, behaviorMonitor: true });
  await agentRuns(d2, (await jobsOf(d2, 'security.investigate'))[1].id, 'completed', { findings: [] }); await tick();
  i = await inc(d2); assert.equal(i.status, 'UNRESOLVED'); assert.equal(i.verification_status, 'failed'); assert.equal(i.verification.threatGone, false);

  // persistence still present after the repair
  const d3 = await enroll(a, 'sec-dev-0004'); await health(d3, [threat({ active: false, remediated: true, name: 'Trojan:Win32/Sticky' })]); await tick(); await tick();
  const persist = { kind: 'startup-entry', suspicious: true, confidence: 'HIGH', evidence: 'still starts it', location: 'HKLM\\Run', name: 'x', recipe: 'security.remove-persistence' };
  await agentRuns(d3, (await jobsOf(d3, 'security.investigate'))[0].id, 'completed', { findings: [persist] }); await tick(); assert.equal((await inc(d3)).status, 'REPAIR_READY');
  assert.equal((await post(`/api/v1/security-incidents/${(await inc(d3)).id}/verify`, {}, a)).statusCode, 202, 'an administrator may decide to verify without repairing');
  await agentRuns(d3, (await jobsOf(d3, 'security.scan'))[0].id, 'completed', {}); await agentRuns(d3, (await jobsOf(d3, 'security.status'))[0].id, 'completed', { threats: [], engineIsDefender: true, behaviorMonitor: true });
  await agentRuns(d3, (await jobsOf(d3, 'security.investigate'))[1].id, 'completed', { findings: [persist] }); await tick();
  assert.equal((await inc(d3)).status, 'UNRESOLVED'); assert.equal((await inc(d3)).verification.noLinkedPersistence, false);
});

test('detections on PCs protected by another product, old detections, and the same detection twice never create noise; recurrence reopens', async () => {
  const a = await mkOrg('Sec Org 3', 'o@sec3.test');
  const avg = await enroll(a, 'sec-dev-0005'); await health(avg, [threat()], { engineIsDefender: false, engine: 'AVG Antivirus' }); await tick();
  assert.equal(await inc(avg), undefined, 'another antivirus is in charge: Viro does not act on Defender history it cannot trust');
  const old = await enroll(a, 'sec-dev-0006'); await health(old, [threat({ detectedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), remediated: true, active: false })]); await tick();
  assert.equal(await inc(old), undefined, 'the 30-day history is not replayed as new incidents');
  const d = await enroll(a, 'sec-dev-0007'); const at = new Date().toISOString();
  await health(d, [threat({ detectedAt: at, active: false, remediated: true })]); await tick(); await tick(); await health(d, [threat({ detectedAt: at, active: false, remediated: true })]); await tick();
  assert.equal((await h.db.query(`SELECT count(*)::int n FROM security_incidents WHERE device_id=$1`, [d.deviceId])).rows[0].n, 1, 'the same detection is one incident');

  // walk it to OBSERVING, then the threat returns
  await agentRuns(d, (await jobsOf(d, 'security.investigate'))[0].id, 'completed', { findings: [] }); await tick();
  await agentRuns(d, (await jobsOf(d, 'security.scan'))[0].id, 'completed', {}); await agentRuns(d, (await jobsOf(d, 'security.status'))[0].id, 'completed', { threats: [], engineIsDefender: true, behaviorMonitor: true }); await agentRuns(d, (await jobsOf(d, 'security.investigate'))[1].id, 'completed', { findings: [] });
  await tick(); const first = await inc(d); assert.equal(first.status, 'OBSERVING');
  await new Promise(r => setTimeout(r, 15)); await health(d, [threat({ detectedAt: new Date(Date.now() + 1000).toISOString(), active: true })]); await tick();
  const rows = (await h.db.query(`SELECT id, status, reopened_from FROM security_incidents WHERE device_id=$1 ORDER BY created_at`, [d.deviceId])).rows;
  assert.equal(rows.length, 2); assert.equal(rows[0].status, 'UNRESOLVED', 'the earlier incident is reopened as unresolved'); assert.equal(rows[1].reopened_from, rows[0].id);

  const overview = (await get('/api/v1/security-incidents', a)).json(); assert.ok(overview.counts.some((c: any) => c.threat_type === 'malware'));
  assert.equal((await get('/api/v1/security-incidents', await mkOrg('Sec Org 4', 'o@sec4.test'))).json().incidents.length, 0, 'other organizations see nothing');
});
