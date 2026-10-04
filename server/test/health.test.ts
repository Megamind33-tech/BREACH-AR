import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreHealth, SnapshotSchema, type Snapshot } from '../src/health.js';

const GB = 2 ** 30;
const base = (over: Partial<Snapshot> = {}): Snapshot => SnapshotSchema.parse({
  collectedAt: new Date().toISOString(),
  perf: { cpuAvgPercent: 10, ramPercent: 40, commitPercent: 50, diskLatencyMs: 4, diskQueue: 0.1, cpuFrequencyPercent: 100 },
  memory: { totalBytes: 16 * GB },
  volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 300 * GB, isSystem: true }],
  physicalDisks: [{ name: 'SSD', mediaType: 'SSD', health: 'Healthy', isSystem: true }],
  startup: [], processes: [], failedServices: [],
  updates: { pendingCount: 0, pendingCriticalCount: 0, pendingTitles: [], rebootRequired: false, lastInstallDays: 5 },
  defender: { antivirusEnabled: true, realTimeProtection: true, signatureAgeDays: 0, activeThreats: 0 },
  avProducts: ['Windows Defender'], firewall: { domain: true, private: true, public: true },
  crashes: [], unexpectedShutdowns7d: 0, driverErrors: [], ...over,
});

test('a genuinely clean machine scores 100 with no deductions', () => {
  const h = scoreHealth(base());
  assert.equal(h.overall, 100);
  assert.equal(h.status, 'healthy');
  assert.deepEqual(h.deductions, []);
});

test('every deduction has a reason and points; category scores follow from them', () => {
  const h = scoreHealth(base({
    volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 4.8 * GB, isSystem: true }],
    startup: Array.from({ length: 21 }, (_, i) => ({ name: 'app' + i })),
    processes: [{ name: 'chrome.exe', count: 43, workingSetBytes: 5.2 * GB }],
    updates: { pendingCount: 3, pendingCriticalCount: 3, pendingTitles: [], rebootRequired: false, lastInstallDays: 3 },
  }), { cpuAvg: 20, ramAvg: 96, ramMax: 97, ramHighShare: 1, samples: 20 });
  const by = (c: string) => h.deductions.find(x => x.code === c)!;
  assert.match(by('storage.system_low').reason, /only 4\.8 GB free/);
  assert.equal(by('storage.system_low').impact, 'high');
  assert.match(by('perf.startup_heavy').reason, /^21 applications start automatically/);
  assert.match(by('perf.browser_heavy').reason, /Chrome has 43 processes using 5\.2 GB/);
  assert.match(by('updates.critical_pending').reason, /^3 critical/);
  assert.match(by('perf.ram_pressure').reason, /96%/);
  assert.equal(h.categories.storage, 70);
  assert.ok(h.deductions.every(x => x.points > 0 && x.reason.length > 10));
  assert.ok(h.diagnosis.high.length >= 2 && h.diagnosis.safeFixCount >= 1);
  assert.ok(h.overall < 100);
});

test('hardware limits are reported honestly as not software-fixable', () => {
  const h = scoreHealth(base({ memory: { totalBytes: 4 * GB }, physicalDisks: [{ name: 'HDD', mediaType: 'HDD', health: 'Healthy', isSystem: true }] }));
  assert.match(h.diagnosis.hardwareNote!, /limited improvement/);
  assert.match(h.diagnosis.hardwareNote!, /8 GB\+ RAM, SSD/);
  assert.ok(h.deductions.filter(x => x.category === 'hardware').every(x => x.remedy === 'hardware'));
});

test('failing SSD with uncorrectable errors is critical regardless of overall score', () => {
  const h = scoreHealth(base({ physicalDisks: [{ name: 'Samsung SSD', mediaType: 'SSD', health: 'Warning', readErrorsUncorrected: 3, isSystem: true }] }));
  assert.equal(h.status, 'critical');
  assert.ok(h.deductions.some(x => x.code === 'hardware.disk_errors'));
});

test('unmeasured data is not scored, it is listed as not measured', () => {
  const h = scoreHealth(SnapshotSchema.parse({ collectedAt: new Date().toISOString() }));
  assert.equal(h.deductions.length, 0);
  assert.ok(h.notMeasured.includes('System drive free space'));
  assert.ok(h.notMeasured.includes('Windows Update state'));
});

test('security: defender off is penalised unless another AV is active; stale signatures and threats count', () => {
  assert.ok(scoreHealth(base({ defender: { antivirusEnabled: false }, avProducts: [] })).deductions.some(x => x.code === 'security.av_off'));
  assert.equal(scoreHealth(base({ defender: null, avProducts: ['CrowdStrike Falcon'] })).deductions.length, 0);
  const h = scoreHealth(base({ defender: { antivirusEnabled: true, realTimeProtection: true, signatureAgeDays: 12, activeThreats: 2 } }));
  assert.ok(h.deductions.some(x => x.code === 'security.signatures_old'));
  assert.ok(h.deductions.some(x => x.code === 'security.active_threat'));
  assert.ok(scoreHealth(base({ firewall: { domain: true, private: true, public: false } })).deductions.some(x => x.code === 'security.firewall_off'));
});

test('a Windows Update search that never returns is reported as a stuck update service', () => {
  const h = scoreHealth(base({ updates: null, updateSearchStuckMinutes: 42 }));
  assert.match(h.deductions.find(x => x.code === 'updates.search_stuck')!.reason, /42 minutes/);
  assert.ok(!h.notMeasured.includes('Windows Update state'));
});

test('passive Defender (third-party AV active) is not penalised for its own real-time flag', () => {
  const h = scoreHealth(base({ defender: { antivirusEnabled: true, realTimeProtection: false, signatureAgeDays: 30 }, avProducts: ['Windows Defender', 'AVG Antivirus'] }));
  assert.equal(h.deductions.filter(x => x.category === 'security').length, 0);
});

test('application instability is tracked with contributing factors, not predictions', () => {
  const h = scoreHealth(base({
    crashes: [{ app: 'OUTLOOK.EXE', kind: 'crash', count: 6 }],
    volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 20 * GB, isSystem: true }],
  }));
  assert.equal(h.appReliability[0]!.app, 'OUTLOOK.EXE');
  assert.equal(h.appReliability[0]!.rating, 'POOR');
  assert.ok(h.appReliability[0]!.factors.includes('Low free disk space'));
  assert.match(h.deductions.find(x => x.code === 'reliability.app_unstable')!.reason, /crashed 6 times in 7 days/);
});

test('scores never go below 0 and reliability deductions are capped', () => {
  const h = scoreHealth(base({ crashes: Array.from({ length: 20 }, (_, i) => ({ app: 'a' + i, kind: 'crash' as const, count: 9 })) }));
  assert.ok(h.categories.reliability >= 0 && h.categories.reliability >= 100 - 32);
});

import { shieldOf } from '../src/health.js';
test('Viro Shield: protected, attention and at-risk states with reasons; never claims what Windows did not report', () => {
  const ok = shieldOf(base({ security: { engine: 'Microsoft Defender', engineIsDefender: true, tamperProtection: true, signatureUpdatedAt: new Date().toISOString(), lastQuickScan: new Date().toISOString(), controlledFolderAccess: 'on', bitLocker: { systemDrive: 'on' }, secureBoot: true, uacEnabled: true, rdp: { enabled: false, networkLevelAuth: true } } }));
  assert.equal(ok.state, 'protected'); assert.equal(ok.engine, 'Microsoft Defender'); assert.equal(ok.firewall, 'on'); assert.equal(ok.threats, 0);
  assert.ok(ok.posture.every(p => p.ok !== false));

  const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const attention = shieldOf(base({ firewall: { domain: true, private: false, public: true }, security: { engine: 'Microsoft Defender', engineIsDefender: true, signatureUpdatedAt: old, lastQuickScan: old } }));
  assert.equal(attention.state, 'attention');
  assert.ok(attention.reasons.some(r => /Firewall is off for some/.test(r)) && attention.reasons.some(r => /Definitions are 20 days old/.test(r)) && attention.reasons.some(r => /Last scan was 20 days ago/.test(r)));

  const risk = shieldOf(base({ defender: { antivirusEnabled: true, realTimeProtection: false, activeThreats: 2 }, avProducts: [] }));
  assert.equal(risk.state, 'at-risk'); assert.equal(risk.threats, 2);
  assert.ok(risk.reasons.includes('Real-time protection is off'));

  assert.equal(shieldOf(base({ defender: null, avProducts: [], security: null })).state, 'at-risk', 'no AV at all');
  assert.equal(shieldOf(SnapshotSchema.parse({ collectedAt: new Date().toISOString() })).state, 'unknown', 'nothing measured is unknown, not protected');
});

test('third-party antivirus: Defender flags and staleness do not count against the PC; posture unreadable stays null', () => {
  const s = shieldOf(base({ defender: { antivirusEnabled: true, realTimeProtection: false, signatureAgeDays: 40 }, avProducts: ['Windows Defender', 'AVG Antivirus'], security: { engine: 'AVG Antivirus', engineIsDefender: false, runningMode: 'SxS Passive Mode', bitLocker: null, tpm: null, secureBoot: false } }));
  assert.equal(s.state, 'protected'); assert.equal(s.engine, 'AVG Antivirus'); assert.equal(s.signatureAgeDays, null);
  const p = Object.fromEntries(s.posture.map(x => [x.label, x.ok]));
  assert.equal(p['Disk encryption (BitLocker)'], null, 'unreadable is null, not false');
  assert.equal(p['Secure Boot'], false);
  assert.equal(p['TPM'], null);
});

test('posture deductions: encryption, Secure Boot, UAC, RDP without NLA, tamper protection, stale scan, real threats', () => {
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const h = scoreHealth(base({ security: { engine: 'Microsoft Defender', engineIsDefender: true, tamperProtection: false, lastQuickScan: old, bitLocker: { systemDrive: 'off' }, secureBoot: false, uacEnabled: false, rdp: { enabled: true, networkLevelAuth: false }, threats: [{ name: 'Trojan:Win32/Test', severity: 'high', active: true }] } }));
  const codes = h.deductions.map(d => d.code);
  for (const c of ['security.no_encryption', 'security.secure_boot_off', 'security.uac_off', 'security.rdp_no_nla', 'security.tamper_off', 'security.scan_stale', 'security.active_threat']) assert.ok(codes.includes(c), c);
  assert.equal(h.deductions.find(d => d.code === 'security.scan_stale')!.fix!.jobType, 'security.scan');
  assert.ok(h.categories.security < 40);
  assert.equal(scoreHealth(base({ security: { engine: 'AVG', engineIsDefender: false, bitLocker: null, secureBoot: null, uacEnabled: true } })).deductions.length, 0, 'unmeasured posture costs nothing');
});

import { osSupport } from '../src/health.js';
test('unsupported Windows versions are flagged; supported and unknown builds are not', () => {
  assert.match(osSupport('Microsoft Windows 10 Pro', '19045')!, /Windows 10 no longer receives/);
  assert.match(osSupport('Microsoft Windows 11 Home', '22621')!, /22H2/);
  assert.equal(osSupport('Microsoft Windows 11 Home Single Language', '26200'), null);
  assert.equal(osSupport('Microsoft Windows 11 Pro', '26100'), null);
  assert.equal(osSupport(null, null), null); assert.equal(osSupport('Windows', 'abc'), null);
  const h = scoreHealth(base({ os: { caption: 'Microsoft Windows 10 Pro', build: '19045' } }));
  assert.ok(h.deductions.some(d => d.code === 'security.os_unsupported' && d.points === 15));
  assert.ok(!scoreHealth(base({ os: { caption: 'Microsoft Windows 11', build: '26200' } })).deductions.some(d => d.code === 'security.os_unsupported'));
});

test('a category Viro could not read is flagged and left out of the overall score instead of showing a perfect 100', () => {
  const full = scoreHealth(base({ firewall: { domain: false, private: false, public: false } }));
  assert.equal(full.measured.updates, true);
  const noUpdates = scoreHealth(base({ updates: undefined, firewall: { domain: false, private: false, public: false } }));
  assert.ok(noUpdates.notMeasured.includes('Windows Update state'));
  assert.equal(noUpdates.measured.updates, false);
  assert.equal(noUpdates.measured.security, true);
  // The same real problem now weighs more, because the unread category no longer pads the average with a made-up 100.
  assert.ok(noUpdates.overall < full.overall, `${noUpdates.overall} should be below ${full.overall}`);
  assert.equal(scoreHealth(base()).overall, 100);
});

test('printing problems become findings: software-fixable ones get a repair, paper and network ones are named for a person', () => {
  const clean = scoreHealth(base({ printing: { spooler: 'Running', printers: 1, issues: [] } }));
  assert.equal(clean.overall, 100);
  const h = scoreHealth(base({ printing: { spooler: 'Running', printers: 2, issues: [
    { code: 'printer.driver', printer: 'Office HP', detail: 'Office HP has a missing or damaged driver (HP Universal PCL6).', fixable: true },
    { code: 'printer.physical', printer: 'Front desk', detail: 'Front desk reports it is out of paper.', fixable: false },
  ] } }));
  const driver = h.deductions.find(d => d.code === 'printing.printer.driver')!, paper = h.deductions.find(d => d.code === 'printing.printer.physical')!;
  assert.equal(driver.category, 'drivers'); assert.deepEqual(driver.fix?.params, { recipe: 'printer.repair' }); assert.equal(driver.remedy, 'safe-fix');
  assert.equal(paper.fix, undefined); assert.equal(paper.remedy, 'manual'); assert.match(paper.recommendation ?? '', /paper, toner/);
  assert.ok(h.overall < 100);
});
