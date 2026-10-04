import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { protectionOf, CONTROLS } from '../src/protection.js';
import { scoreHealth } from '../src/health.js';
import { REPAIR_RECIPES } from '../src/catalog.js';
import { autoAllowed, policyLevel } from '../src/policies.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54350); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });
const GB = 1024 ** 3;
async function mkOrg(name: string, email: string) {
  await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { authorization: `Bearer ${l.json().token}` } as Hdr;
}
async function enroll(auth: Hdr, guid: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname: guid, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
const health = (d: { dev: Hdr }, over: object = {}) => put('/agent/v1/health', { collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }], ...over }, d.dev);

const SAFE = { engine: 'Microsoft Defender', engineIsDefender: true, controlledFolderAccess: 'audit', hijackingExtensions: [], rdp: { enabled: false, networkLevelAuth: true },
  hardening: { pua: 'on', networkProtection: 'on', asrRansomware: 'on', smb1Enabled: false, llmnrDisabled: true, scriptBlockLogging: true, telemetryLevel: 1, advertisingIdDisabled: true, activityHistoryDisabled: true, consumerContentDisabled: true, locationDisabled: true, restorePoints: 2 } };
const fw = { domain: true, private: true, public: true };

test('a control is reported ON only when Windows said so, OFF only when it said off, and unknown when it could not be read', () => {
  const full = protectionOf({ security: SAFE as any, firewall: fw });
  assert.equal(full.off, 0); assert.equal(full.score, 100); assert.ok(full.controls.filter(c => c.id !== 'ransomware-block').every(c => c.state === 'on' || c.state === 'na'), 'audit mode is not blocking mode: that stronger control stays off and is not counted against the PC');
  assert.equal(full.controls.find(c => c.id === 'rdp-nla')!.state, 'na', 'Remote Desktop is off, so the NLA control does not apply');

  const none = protectionOf({});
  assert.ok(none.controls.every(c => c.state === 'unknown'), 'no data means unknown, never off and never on'); assert.equal(none.score, null);

  const bad = protectionOf({ security: { ...SAFE, controlledFolderAccess: 'off', hardening: { ...SAFE.hardening, smb1Enabled: true, pua: 'off', telemetryLevel: 3, restorePoints: 0 } } as any, firewall: { ...fw, public: false } });
  const st = (id: string) => bad.controls.find(c => c.id === id)!.state;
  assert.equal(st('ransomware-shield'), 'off'); assert.equal(st('smb1'), 'off'); assert.equal(st('pua'), 'off'); assert.equal(st('telemetry'), 'off'); assert.equal(st('restore-points'), 'off'); assert.equal(st('firewall'), 'off');
  assert.equal(st('ransomware-block'), 'off'); assert.equal(protectionOf({ security: { ...SAFE, controlledFolderAccess: 'on' } as any, firewall: fw }).controls.find(c => c.id === 'ransomware-block')!.state, 'on');

  const thirdParty = protectionOf({ security: { ...SAFE, engineIsDefender: false, controlledFolderAccess: 'off' } as any, firewall: fw });
  assert.equal(thirdParty.controls.find(c => c.id === 'ransomware-shield')!.state, 'na', 'another antivirus manages Defender settings: never claimed or changed');
  assert.equal(protectionOf({ security: { ...SAFE, hardening: { ...SAFE.hardening, smb1Enabled: null } } as any, firewall: fw }).controls.find(c => c.id === 'smb1')!.state, 'on', 'no SMBv1 setting means the feature is not installed');
});

test('every control maps to a real recipe and the safe ones may run automatically, the risky ones never', () => {
  for (const c of CONTROLS) if (c.recipe) assert.ok(c.recipe in REPAIR_RECIPES, c.recipe);
  const fix = (recipe: string) => ({ jobType: 'repair.run', params: { recipe }, label: recipe });
  for (const r of ['protect.ransomware-audit', 'protect.asr-ransomware', 'protect.pua', 'protect.firewall', 'protect.smb1-off']) {
    assert.equal(autoAllowed(fix(r), 'SAFE'), false, r + ' is a policy change, so not at the most cautious level'); assert.equal(autoAllowed(fix(r), 'BALANCED'), true, r); assert.equal(autoAllowed(fix(r), 'OBSERVE'), false);
  }
  for (const r of ['protect.ransomware-block', 'protect.network-protection', 'protect.rdp-nla', 'privacy.location-off']) { assert.equal(REPAIR_RECIPES[r as keyof typeof REPAIR_RECIPES].risk, 'review'); assert.equal(autoAllowed(fix(r), 'AGGRESSIVE'), false, r + ' always needs a person'); }
  assert.ok(policyLevel(undefined) === 'OBSERVE');
});

test('missing ransomware and attack-surface protection lowers the health score and comes with a safe one-click fix, but only for Defender-managed PCs', () => {
  const base = { collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }], defender: { antivirusEnabled: true, realTimeProtection: true, signatureAgeDays: 0 }, avProducts: ['Windows Defender'], firewall: fw };
  const codes = (s: object) => scoreHealth({ ...base, ...s } as any).deductions.map(d => d.code);
  assert.ok(!codes({ security: SAFE }).some(c => /ransomware|pua|smb1|restore/.test(c)));
  const weak = scoreHealth({ ...base, security: { ...SAFE, controlledFolderAccess: 'off', hardening: { ...SAFE.hardening, asrRansomware: 'off', pua: 'off', smb1Enabled: true, restorePoints: 0 } } } as any);
  for (const c of ['security.ransomware_shield_off', 'security.asr_ransomware_off', 'security.pua_off', 'security.smb1_on', 'security.no_restore_points']) assert.ok(weak.deductions.some(d => d.code === c), c);
  assert.equal(weak.deductions.find(d => d.code === 'security.smb1_on')!.fix!.params.recipe, 'protect.smb1-off');
  assert.equal(weak.deductions.find(d => d.code === 'security.no_restore_points')!.fix, undefined, 'Viro does not pretend to fix a missing backup');
  assert.equal(weak.deductions.find(d => d.code === 'security.firewall_off'), undefined);
  const fwOff = scoreHealth({ ...base, firewall: { ...fw, public: false }, security: SAFE } as any).deductions.find(d => d.code === 'security.firewall_off')!;
  assert.equal(fwOff.fix!.params.recipe, 'protect.firewall'); assert.equal(fwOff.remedy, 'safe-fix');
  assert.ok(!codes({ security: { ...SAFE, engineIsDefender: false, controlledFolderAccess: 'off', hardening: { ...SAFE.hardening, pua: 'off', asrRansomware: 'off' } } }).some(c => /ransomware_shield|asr_|pua/.test(c)), 'never reports Defender settings when another product is protecting the PC');
});

test('the console sees fleet coverage per control, and administrators queue fixes only where the control is actually off', async () => {
  const a = await mkOrg('Prot Org', 'o@prot.test'), b = await mkOrg('Prot Other', 'o@protb.test');
  const d1 = await enroll(a, 'prot-dev-0001'), d2 = await enroll(a, 'prot-dev-0002'), other = await enroll(b, 'prot-dev-0003');
  await health(d1, { firewall: fw, security: SAFE });
  await health(d2, { firewall: { ...fw, public: false }, security: { ...SAFE, controlledFolderAccess: 'off', hardening: { ...SAFE.hardening, smb1Enabled: true } } });
  await health(other, { firewall: { ...fw, public: false }, security: SAFE });

  const ov = (await get('/api/v1/protection/overview', a)).json();
  assert.equal(ov.devices, 2); const smb = ov.controls.find((c: any) => c.id === 'smb1');
  assert.equal(smb.on, 1); assert.equal(smb.off, 1); assert.deepEqual(smb.devicesOff.map((x: any) => x.hostname), ['prot-dev-0002']); assert.equal(smb.recipe, 'protect.smb1-off');
  assert.equal(ov.controls.find((c: any) => c.id === 'restore-points').reportOnly, true); assert.match(ov.limits, /not an antivirus/);
  assert.ok(ov.score > 0 && ov.score < 100); assert.equal(ov.weakest[0].hostname, 'prot-dev-0002');

  const r = await post('/api/v1/protection/apply', { control: 'smb1' }, a); assert.equal(r.statusCode, 202); assert.equal(r.json().queued, 1, 'only the PC where it is off');
  const j = (await h.db.query(`SELECT device_id, params FROM jobs WHERE type='repair.run' AND org_id=(SELECT org_id FROM devices WHERE id=$1)`, [d2.deviceId])).rows;
  assert.equal(j.length, 1); assert.equal(j[0].device_id, d2.deviceId); assert.deepEqual(j[0].params, { recipe: 'protect.smb1-off' });
  assert.equal((await post('/api/v1/protection/apply', { control: 'firewall', deviceIds: [d1.deviceId] }, a)).json().queued, 0, 'already on: nothing queued');
  assert.equal((await post('/api/v1/protection/apply', { control: 'restore-points' }, a)).statusCode, 400, 'report-only controls are never changed');
  assert.equal((await post('/api/v1/protection/apply', { control: 'location' }, a)).statusCode, 400, 'review-risk controls need approved:true');
  await health(d2, { firewall: fw, security: { ...SAFE, hardening: { ...SAFE.hardening, locationDisabled: false } } });
  const loc = await post('/api/v1/protection/apply', { control: 'location', approved: true }, a); assert.equal(loc.json().queued, 1);
  assert.deepEqual((await h.db.query(`SELECT params FROM jobs WHERE params->>'recipe'='privacy.location-off'`)).rows[0].params, { recipe: 'privacy.location-off', approved: true });
  assert.equal((await post('/api/v1/protection/apply', { control: 'smb1' }, {})).statusCode, 401);
  assert.equal((await get('/api/v1/protection/overview', b)).json().devices, 1, 'another organization never sees these PCs');
  assert.ok((await h.db.query(`SELECT 1 FROM audit_log WHERE action='protection.apply'`)).rowCount);
});
