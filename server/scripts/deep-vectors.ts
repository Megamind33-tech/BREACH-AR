// Appends the deep-audit conformance vectors to packages/health-rules/vectors.json.
// The expected findings are produced by the TypeScript reference evaluator and then checked by the C# (QuickCheck) and Kotlin (phone) evaluators.
import { readFileSync, writeFileSync } from 'node:fs';
import { evaluate } from '../src/twin/rules.js';

const file = new URL('../../packages/health-rules/vectors.json', import.meta.url);
const doc = JSON.parse(readFileSync(file, 'utf8'));
doc.cases = doc.cases.filter((c: { name: string }) => !c.name.startsWith('deep:'));

const healthy = { schemaVersion: 1, deep: {
  encryption: { systemDriveProtected: true }, secureBoot: true, tpm: { present: true, ready: true },
  updates: { lastInstalledDaysAgo: 12, pendingReboot: false }, os: { build: '26200', daysSinceSupportEnded: -400, supportEnds: '2027-10-12' },
  defender: { signatureAgeDays: 1, daysSinceQuickScan: 4 }, settings: { uacEnabled: true, smb1Enabled: false, rdpEnabled: false, autoLogon: false, guestEnabled: false },
  reliability: { bluescreens30d: 0, unexpectedShutdowns30d: 1, diskErrors30d: 0, appCrashes30d: 3, topCrashingApp: 'chrome.exe' },
  wifi: { security: 'wpa3' }, startup: { count: 12 } } };
const risky = { schemaVersion: 1, deep: {
  encryption: { systemDriveProtected: false }, secureBoot: false, tpm: { present: false },
  updates: { lastInstalledDaysAgo: 200, pendingReboot: true }, os: { build: '19045', daysSinceSupportEnded: 90, supportEnds: '2025-10-14' },
  defender: { signatureAgeDays: 40, daysSinceQuickScan: 60 }, settings: { uacEnabled: false, smb1Enabled: true, rdpEnabled: true, autoLogon: true, guestEnabled: true },
  reliability: { bluescreens30d: 4, unexpectedShutdowns30d: 9, diskErrors30d: 12, appCrashes30d: 40, topCrashingApp: 'game.exe' },
  wifi: { security: 'open' }, startup: { count: 41 } } };
const partial = { schemaVersion: 1, deep: { updates: { lastInstalledDaysAgo: 80 }, wifi: { security: 'wpa2' } } };
const empty = { schemaVersion: 1, deep: {} };

const toCase = (name: string, input: Record<string, unknown>) => {
  const r = evaluate(input);
  return { name, input, expect: r.findings.map(f => ({ id: f.id, severity: f.severity, evidenceType: f.evidenceType, evidence: Object.fromEntries(f.evidence.map(e => [e.name, e.value])) })) };
};
doc.cases.push(toCase('deep: healthy Windows audit', healthy), toCase('deep: risky Windows audit', risky), toCase('deep: partly readable, the rest skipped', partial), toCase('deep: nothing readable, nothing guessed', empty));
writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
console.log(doc.cases.length, 'cases');
