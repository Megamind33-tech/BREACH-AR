import { z } from 'zod';
import type { HwAnalysis } from './hardware.js';
import { SAFE_CLEAN_IDS, type Fix } from './catalog.js';

/**
 * Viro Health engine. Pure function: snapshot (+ optional heartbeat trend) -> explainable scores.
 * Every point removed carries a code, a human reason, and an impact level. Missing data is never scored:
 * it is listed in `notMeasured` instead.
 */

const num = z.number().nullable().optional();
const pct = z.number().min(0).max(100).nullable().optional();
export const SnapshotSchema = z.object({
  collectedAt: z.string().datetime(),
  perf: z.object({ cpuAvgPercent: pct, cpuFrequencyPercent: z.number().min(0).max(400).nullable().optional(), ramPercent: pct, commitPercent: z.number().min(0).max(1000).nullable().optional(), diskLatencyMs: z.number().min(0).max(100000).nullable().optional(), diskQueue: z.number().min(0).max(100000).nullable().optional() }).optional(),
  memory: z.object({ totalBytes: num, availableBytes: num }).optional(),
  volumes: z.array(z.object({ name: z.string(), totalBytes: z.number(), freeBytes: z.number(), isSystem: z.boolean() })).max(64).optional(),
  physicalDisks: z.array(z.object({
    name: z.string().nullable().optional(), mediaType: z.string().nullable().optional(), health: z.string().nullable().optional(),
    sizeBytes: num, temperatureC: num, wearPercent: num, readErrorsUncorrected: num, writeErrorsUncorrected: num, powerOnHours: num, isSystem: z.boolean().optional(),
  })).max(32).optional(),
  startupItems: z.array(z.object({ location: z.string(), name: z.string(), command: z.string().optional(), enabled: z.boolean(), cls: z.enum(['KEEP', 'SAFE_TO_DISABLE', 'ASK']), reason: z.string().optional() })).max(300).optional(),
  boot: z.object({ lastBootSeconds: z.number().nullish(), lastBootAt: z.string().nullish(), mainPathSeconds: z.number().nullish(), postBootSeconds: z.number().nullish(), history: z.array(z.object({ at: z.string(), seconds: z.number() })).max(30).optional(), degrading: z.array(z.object({ name: z.string(), seconds: z.number() })).max(30).optional(), optimizableStartup: z.number().nullish(), startupOptimizedAt: z.string().nullish() }).nullable().optional(),
  care: z.object({ thermal: z.object({ level: z.string().optional(), cpuTempC: z.number().nullish(), sustainedHotMinutesLowLoad: z.number().optional(), warningEvents: z.number().optional(), coolingSuspected: z.boolean().optional(), available: z.boolean().optional() }).nullish(), ramTargetPercent: z.number().optional(), memory: z.object({ usedPercent: z.number().nullish(), targetPercent: z.number().nullish(), idleTrimmableMb: z.number().nullish(), askUserMb: z.number().nullish() }).nullish() }).passthrough().nullable().optional(),
  resources: z.object({ commitPercent: z.number().nullish(), commitUsedMb: z.number().nullish(), commitLimitMb: z.number().nullish(), ramTotalMb: z.number().nullish(),
    topCommit: z.array(z.object({ name: z.string(), privateMb: z.number(), workingSetMb: z.number().optional(), category: z.string().optional() })).max(20).optional(),
    lowVirtualMemory24h: z.array(z.object({ at: z.string(), top: z.array(z.object({ name: z.string(), mb: z.number() })).max(10) })).max(20).optional(),
    failedShutdowns7d: z.number().nullish(), firmwareThrottle24h: z.number().nullish(), securityEngines: z.array(z.object({ name: z.string(), memoryMb: z.number() })).max(20).optional() }).nullable().optional(),
  backup: z.object({ lastWindowsBackupAt: z.string().nullish(), lastWindowsBackupFailureAt: z.string().nullish(), newestRestorePointAt: z.string().nullish(), restorePoints: z.number().nullish() }).nullable().optional(),
  startup: z.array(z.object({ name: z.string(), command: z.string().nullable().optional(), location: z.string().nullable().optional() })).max(500).optional(),
  processes: z.array(z.object({ name: z.string(), count: z.number(), workingSetBytes: z.number() })).max(100).optional(),
  printing: z.object({ spooler: z.string().nullable().optional(), printers: num, issues: z.array(z.object({ code: z.string().max(40), printer: z.string().max(120).nullable().optional(), detail: z.string().max(300), fixable: z.boolean() })).max(20) }).nullable().optional(),
  failedServices: z.array(z.object({ name: z.string(), displayName: z.string().nullable().optional(), exitCode: num })).max(100).optional(),
  updates: z.object({ pendingCount: z.number(), pendingCriticalCount: z.number(), pendingTitles: z.array(z.string()).max(50), rebootRequired: z.boolean().nullable().optional(), lastInstallDays: num }).nullable().optional(),
  defender: z.object({
    antivirusEnabled: z.boolean().nullable().optional(), realTimeProtection: z.boolean().nullable().optional(),
    signatureAgeDays: num, activeThreats: num, quickScanAgeDays: num,
  }).nullable().optional(),
  avProducts: z.array(z.string()).max(20).optional(),
  firewall: z.object({ domain: z.boolean().nullable(), private: z.boolean().nullable(), public: z.boolean().nullable() }).nullable().optional(),
  crashes: z.array(z.object({ app: z.string(), kind: z.enum(['crash', 'hang']), count: z.number(), lastAt: z.string().nullable().optional() })).max(200).optional(),
  unexpectedShutdowns7d: num,
  stability: z.object({
    windowDays: z.number().optional(),
    crashes: z.array(z.object({ app: z.string(), kind: z.enum(['crash', 'hang']), appVersion: z.string().nullish(), module: z.string().nullish(), moduleVersion: z.string().nullish(), exceptionCode: z.string().nullish(), at: z.string() })).max(400),
    recentChanges: z.array(z.object({ kind: z.string(), name: z.string().max(300), at: z.string() })).max(200).optional(),
  }).nullable().optional(),
  updateSearchStuckMinutes: num,
  os: z.object({ caption: z.string().nullable().optional(), build: z.string().nullable().optional() }).nullable().optional(),
  security: z.object({
    engine: z.string().nullable().optional(), engineIsDefender: z.boolean().optional(), runningMode: z.string().nullable().optional(),
    tamperProtection: z.boolean().nullable().optional(), behaviorMonitor: z.boolean().nullable().optional(), networkInspection: z.boolean().nullable().optional(),
    signatureVersion: z.string().nullable().optional(), signatureUpdatedAt: z.string().nullable().optional(), engineVersion: z.string().nullable().optional(),
    lastQuickScan: z.string().nullable().optional(), lastFullScan: z.string().nullable().optional(),
    controlledFolderAccess: z.enum(['on', 'off', 'audit']).nullable().optional(),
    bitLocker: z.object({ systemDrive: z.string() }).nullable().optional(), secureBoot: z.boolean().nullable().optional(),
    tpm: z.object({ present: z.boolean(), enabled: z.boolean().nullable().optional(), activated: z.boolean().nullable().optional(), specVersion: z.string().nullable().optional() }).nullable().optional(),
    hijackingExtensions: z.array(z.object({ browser: z.string(), id: z.string(), reason: z.string() })).max(50).nullable().optional(),
    hardening: z.object({ pua: z.string().nullable().optional(), networkProtection: z.string().nullable().optional(), asrRansomware: z.string().nullable().optional(), smb1Enabled: z.boolean().nullable().optional(), llmnrDisabled: z.boolean().optional(), scriptBlockLogging: z.boolean().optional(), telemetryLevel: z.number().nullable().optional(), advertisingIdDisabled: z.boolean().optional(), activityHistoryDisabled: z.boolean().optional(), consumerContentDisabled: z.boolean().optional(), locationDisabled: z.boolean().optional(), restorePoints: z.number().nullable().optional(), systemRestoreOff: z.boolean().optional() }).nullable().optional(),
    uacEnabled: z.boolean().nullable().optional(), rdp: z.object({ enabled: z.boolean().nullable(), networkLevelAuth: z.boolean().nullable() }).nullable().optional(),
    threats: z.array(z.object({ name: z.string(), severity: z.string(), active: z.boolean().optional(), detectedAt: z.string().nullable().optional(), remediated: z.boolean().nullable().optional(), resources: z.array(z.string()).max(5).optional() })).max(30).optional(),
  }).nullable().optional(),
  driverErrors: z.array(z.object({ name: z.string(), code: z.number() })).max(200).optional(),
  collectionErrors: z.array(z.string()).max(50).optional(),
  collectionTimingsMs: z.record(z.string(), z.number()).optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export interface Trend { cpuAvg: number | null; ramAvg: number | null; ramMax: number | null; ramHighShare: number | null; samples: number }

export type Category = 'security' | 'performance' | 'storage' | 'drivers' | 'updates' | 'reliability' | 'hardware';
export type Impact = 'high' | 'medium' | 'low';
export interface Deduction {
  category: Category; points: number; code: string; reason: string; impact: Impact;
  /** What kind of remedy exists. 'hardware' means software cannot fix it. Repair recipes themselves arrive in Phase 2. */
  remedy: 'safe-fix' | 'review' | 'manual' | 'hardware';
  recommendation: string;
  /** A concrete signed job an administrator can run to address this, when one exists. */
  fix?: Fix;
}
export interface HealthResult {
  overall: number; status: 'healthy' | 'attention' | 'critical';
  categories: Record<Category, number>; deductions: Deduction[];
  notMeasured: string[];
  /** Per category: false when its key inputs could not be read (the number is then not a real score). */
  measured: Record<Category, boolean>;
  diagnosis: { high: Deduction[]; medium: Deduction[]; low: Deduction[]; safeFixCount: number; hardwareNote: string | null };
  shield: Shield;
  appReliability: { app: string; crashes: number; hangs: number; rating: 'POOR' | 'FAIR'; factors: string[] }[];
}

export interface Shield {
  state: 'protected' | 'attention' | 'at-risk' | 'unknown';
  engine: string | null; reasons: string[]; threats: number;
  firewall: 'on' | 'partial' | 'off' | 'unknown'; realTime: boolean | null;
  signatureAgeDays: number | null; lastScanAt: string | null; posture: { label: string; ok: boolean | null }[];
}
const daysSince = (iso?: string | null) => iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)) : null;

/** Viro Shield: orchestration/visibility over Windows-native security. It never claims protection Windows did not report. */
export function shieldOf(s: Snapshot): Shield {
  const sec = s.security, df = s.defender;
  const otherAv = (s.avProducts ?? []).filter(n => !/defender/i.test(n));
  // Who protects this PC: a third-party product Security Center reports as ON, otherwise Defender (if present at all).
  const thirdParty = otherAv.length > 0 || (sec?.engine != null && !/defender/i.test(sec.engine));
  const defenderPrimary = !thirdParty && (df != null || sec?.engine != null);
  const defenderOff = defenderPrimary && (df?.antivirusEnabled === false || (df == null && sec?.engineIsDefender === false));
  const engine = thirdParty ? (otherAv[0] ?? sec?.engine ?? null) : defenderPrimary ? 'Microsoft Defender' : null;
  const defenderEngine = defenderPrimary && !defenderOff;   // Defender is actively the engine (its own flags, scans and definitions matter)
  const threats = Math.max(df?.activeThreats ?? 0, (sec?.threats ?? []).filter(t => t.active).length);
  const fw = s.firewall ? (['domain', 'private', 'public'] as const).map(k => s.firewall![k]) : null;
  const firewall = !fw ? 'unknown' : fw.every(x => x === true) ? 'on' : fw.some(x => x === false) ? (fw.every(x => x === false) ? 'off' : 'partial') : 'unknown';
  const sigAge = defenderEngine ? (daysSince(sec?.signatureUpdatedAt) ?? df?.signatureAgeDays ?? null) : null;
  const lastScan = [sec?.lastQuickScan, sec?.lastFullScan].filter(Boolean).sort().pop() ?? null;
  const realTime = defenderEngine ? (df?.realTimeProtection ?? null) : (engine ? true : null);
  const reasons: string[] = []; let state: Shield['state'] = 'protected';
  const risk = (m: string) => { reasons.push(m); state = 'at-risk'; };
  const warn = (m: string) => { reasons.push(m); if (state !== 'at-risk') state = 'attention'; };
  if (!engine && s.avProducts) risk('No antivirus product detected');
  else if (!engine) state = 'unknown';
  if (defenderOff) risk('Microsoft Defender is off and no other antivirus is active');
  if (defenderEngine && df?.realTimeProtection === false) risk('Real-time protection is off');
  if (threats > 0) risk(`${threats} active threat${threats === 1 ? '' : 's'}`);
  if (firewall === 'off') risk('Firewall is off'); else if (firewall === 'partial') warn('Firewall is off for some network profiles');
  if (sigAge != null && sigAge > 7) warn(`Definitions are ${sigAge} days old`);
  if (defenderEngine) { const sc = daysSince(lastScan); if (sc == null) warn('No antivirus scan on record'); else if (sc > 14) warn(`Last scan was ${sc} days ago`); }
  if (defenderEngine && sec?.tamperProtection === false) warn('Tamper protection is off');
  if (s.updates && s.updates.pendingCriticalCount > 0) warn(`${s.updates.pendingCriticalCount} security update(s) pending`);
  if (!s.security && !s.defender && !s.avProducts && !s.firewall) state = 'unknown';
  const yn = (v: boolean | null | undefined): boolean | null => v == null ? null : v;
  const posture = [
    { label: 'Antivirus active', ok: engine ? true : (s.avProducts ? false : null) },
    { label: 'Real-time protection', ok: yn(realTime) },
    { label: 'Firewall', ok: firewall === 'unknown' ? null : firewall === 'on' },
    { label: 'Tamper protection', ok: defenderEngine ? yn(sec?.tamperProtection) : null },
    { label: 'Ransomware protection (Controlled folder access)', ok: sec?.controlledFolderAccess == null ? null : sec.controlledFolderAccess === 'on' },
    { label: 'Disk encryption (BitLocker)', ok: sec?.bitLocker == null ? null : sec.bitLocker.systemDrive === 'on' ? true : sec.bitLocker.systemDrive === 'off' ? false : null },
    { label: 'Secure Boot', ok: yn(sec?.secureBoot) },
    { label: 'TPM', ok: sec?.tpm == null ? null : sec.tpm.present && sec.tpm.enabled !== false },
    { label: 'User Account Control', ok: yn(sec?.uacEnabled) },
    { label: 'Remote Desktop protected (NLA) or off', ok: sec?.rdp == null ? null : sec.rdp.enabled === false ? true : sec.rdp.networkLevelAuth },
  ];
  return { state, engine: engine ?? null, reasons, threats, firewall, realTime: realTime ?? null, signatureAgeDays: sigAge, lastScanAt: lastScan, posture };
}

/** Returns a sentence when the installed Windows version is out of support, else null. Only builds whose end-of-support is certain are listed. */
export function osSupport(caption?: string | null, build?: string | null): string | null {
  const b = Number(build); if (!Number.isFinite(b) || b <= 0) return null;
  if (/Windows 10/i.test(caption ?? '') || (b >= 10240 && b <= 19045)) return 'Windows 10 no longer receives free security updates (support ended 14 October 2025).';
  if (b === 22000) return 'Windows 11 version 21H2 is out of support (ended 10 October 2023).';
  if (b === 22621) return 'Windows 11 version 22H2 is out of support (ended 8 October 2024).';
  if (b === 22631) return 'Windows 11 version 23H2 is out of support (ended 11 November 2025).';
  return null;
}

const WEIGHTS: Record<Category, number> = { security: 0.2, performance: 0.2, storage: 0.15, updates: 0.1, drivers: 0.05, reliability: 0.15, hardware: 0.15 };
/** Measurements that, when ALL are missing, leave a category with nothing behind its score. */
const UNMEASURED_WHEN: Partial<Record<Category, string[]>> = { updates: ['Windows Update state'], security: ['Antivirus state', 'Firewall state'], storage: ['System drive free space'], performance: ['CPU load', 'Memory pressure'], hardware: ['Disk health'] };
const GB = 2 ** 30;
const gb = (b: number) => (b / GB).toFixed(1);
const BROWSERS: Record<string, string> = { chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', brave: 'Brave', opera: 'Opera', vivaldi: 'Vivaldi' };

/** What is known about a recent backup, in plain words. Only Windows' own backup and restore points are visible; a third-party product is reported as unknown, never as missing or fine. */
export function backupSentence(b: Snapshot['backup'], now = new Date()): string {
  if (!b) return 'Whether a recent backup exists could not be checked on this PC.';
  const times = [b.lastWindowsBackupAt, b.newestRestorePointAt].filter((x): x is string => !!x).map(x => new Date(x).getTime());
  if (!times.length) return 'No Windows backup or restore point was found; if another backup product is used, confirm it has a recent copy before anything else.';
  const hours = Math.max(0, Math.round((now.getTime() - Math.max(...times)) / 3_600_000)), ago = hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
  return hours <= 48 ? `The newest backup or restore point is ${ago}, so it is safe to plan the replacement.` : `The newest backup or restore point is ${ago}: back up now before doing anything else.`;
}

export function scoreHealth(s: Snapshot, trend?: Trend, hw?: HwAnalysis | null): HealthResult {
  const d: Deduction[] = [];
  const notMeasured: string[] = [];
  const backupNote = backupSentence(s.backup);
  const add = (x: Omit<Deduction, 'impact'>) => { if (x.points > 0) d.push({ ...x, recommendation: /^hardware\.disk_(unhealthy|errors|warning)$/.test(x.code) && x.recommendation ? `${x.recommendation} ${backupNote}` : x.recommendation, impact: x.points >= 12 ? 'high' : x.points >= 5 ? 'medium' : 'low' }); };

  // ---- Storage ----
  const sys = s.volumes?.find(v => v.isSystem);
  if (!sys) notMeasured.push('System drive free space');
  else if (sys.totalBytes > 0) {
    const pct = (100 * sys.freeBytes) / sys.totalBytes, freeGb = sys.freeBytes / GB;
    const pts = freeGb < 5 || pct < 5 ? 30 : freeGb < 10 || pct < 10 ? 20 : pct < 15 ? 12 : pct < 20 ? 6 : 0;
    add({ category: 'storage', points: pts, code: 'storage.system_low', reason: `System drive ${sys.name} has only ${gb(sys.freeBytes)} GB free (${pct.toFixed(1)}% of ${gb(sys.totalBytes)} GB).`, remedy: 'safe-fix', recommendation: 'Clean safe temporary files, caches and update leftovers.', fix: { jobType: 'cleanup.run', params: { categories: SAFE_CLEAN_IDS }, label: 'Clean safe files', confirm: 'Delete temporary files, caches and crash dumps? Personal files are never touched.' } });
  }
  for (const v of (s.volumes ?? []).filter(v => !v.isSystem && v.totalBytes > 0 && v.freeBytes / v.totalBytes < 0.05))
    add({ category: 'storage', points: 5, code: 'storage.data_low', reason: `Drive ${v.name} has only ${gb(v.freeBytes)} GB free.`, remedy: 'review', recommendation: 'Review large files on this drive.' });

  // ---- Performance ----
  const p = s.perf ?? {};
  const ramNow = trend?.ramAvg ?? p.ramPercent ?? null;
  const cpu = trend?.cpuAvg ?? p.cpuAvgPercent ?? null;
  if (ramNow == null) notMeasured.push('Memory pressure'); else {
    const high = trend?.ramHighShare != null && trend.samples >= 5 && trend.ramHighShare >= 0.5 && (trend.ramMax ?? 0) >= 90;
    const pts = ramNow >= 95 ? 20 : ramNow >= 90 ? 16 : ramNow >= 85 ? 10 : ramNow >= 80 ? 6 : high ? 8 : 0;
    add({ category: 'performance', points: pts, code: 'perf.ram_pressure', reason: high && ramNow < 80 ? `RAM repeatedly reaches ${Math.round(trend!.ramMax!)}%.` : `RAM use is ${Math.round(ramNow)}%${trend?.ramMax && trend.ramMax > ramNow + 2 ? ` (peaks at ${Math.round(trend.ramMax)}%)` : ''}.`, remedy: 'review', recommendation: 'Close or reduce heavy applications; if this is constant the PC needs more RAM.' });
  }
  if (cpu == null) notMeasured.push('CPU load'); else
    add({ category: 'performance', points: cpu >= 90 ? 15 : cpu >= 75 ? 8 : 0, code: 'perf.cpu_saturation', reason: `CPU averages ${Math.round(cpu)}% busy.`, remedy: 'review', recommendation: 'Identify the process driving CPU load.' });
  if (p.cpuFrequencyPercent != null && p.cpuFrequencyPercent < 70 && (cpu ?? 0) >= 50)
    add({ category: 'performance', points: 8, code: 'perf.throttling', reason: `CPU runs at ${Math.round(p.cpuFrequencyPercent)}% of its maximum frequency under load (possible thermal or power throttling).`, remedy: 'manual', recommendation: 'Check power plan and cooling; clean fans and vents.' });
  if (p.diskLatencyMs == null) notMeasured.push('Disk latency'); else
    add({ category: 'performance', points: p.diskLatencyMs >= 50 ? 15 : p.diskLatencyMs >= 25 ? 8 : 0, code: 'perf.disk_latency', reason: `Disk response time is ${p.diskLatencyMs.toFixed(0)} ms.`, remedy: 'review', recommendation: 'Slow disk: check for heavy disk activity, scans, or a failing/HDD drive.' });
  if (p.diskQueue != null && p.diskQueue >= 2)
    add({ category: 'performance', points: 6, code: 'perf.disk_queue', reason: `Disk queue length is ${p.diskQueue.toFixed(1)}.`, remedy: 'review', recommendation: 'Disk is saturated; find what is reading/writing.' });
  if (p.commitPercent != null && p.commitPercent >= 90)
    add({ category: 'performance', points: 10, code: 'perf.pagefile_pressure', reason: `Committed memory is ${Math.round(p.commitPercent)}% of the limit (pagefile pressure).`, remedy: 'review', recommendation: 'Reduce memory use or enlarge the pagefile.' });
  if (s.startup) {
    const n = s.startup.length;
    add({ category: 'performance', points: n > 20 ? 12 : n > 12 ? 8 : n > 8 ? 4 : 0, code: 'perf.startup_heavy', reason: `${n} applications start automatically.`, remedy: 'review', recommendation: 'Choose non-essential startup items to disable (reversible; nothing is deleted).' });
  } else notMeasured.push('Startup programs');

  // Slow start-up, measured from the boots Windows itself timed. The repair's effect is only known after the next restart, so until then it asks for one.
  const bt = s.boot;
  if (bt?.lastBootSeconds != null) {
    const hdd = (s.physicalDisks ?? []).some(dk => dk.isSystem && /hdd/i.test(String(dk.mediaType ?? '')));
    const [slow, verySlow] = hdd ? [120, 200] : [75, 120], sec = Math.round(bt.lastBootSeconds);
    if (sec >= slow) {
      const pending = bt.startupOptimizedAt != null && bt.lastBootAt != null && bt.startupOptimizedAt > bt.lastBootAt;
      const top = (bt.degrading ?? []).slice(0, 3).map(x => `${x.name} (+${Math.round(x.seconds)} s)`).join(', ');
      const why = `Windows took ${sec} seconds to start${top ? `; the slowest start-ups were ${top}` : ''}.`;
      if (pending) add({ category: 'performance', points: sec >= verySlow ? 10 : 6, code: 'perf.slow_boot', reason: why + ' Start-up programs were reduced since; the result is measured at the next restart.', remedy: 'manual', recommendation: 'Restart the computer so the new start-up time can be measured.' });
      else if ((bt.optimizableStartup ?? 0) > 0) add({ category: 'performance', points: sec >= verySlow ? 14 : 8, code: 'perf.slow_boot', reason: why, remedy: 'safe-fix', recommendation: `${bt.optimizableStartup} launcher/updater program(s) can be stopped from starting with Windows (reversible).`, fix: { jobType: 'repair.run', params: { recipe: 'startup.optimize' }, label: 'Speed up start-up' } });
      else add({ category: 'performance', points: sec >= verySlow ? 10 : 6, code: 'perf.slow_boot', reason: why, remedy: 'review', recommendation: hdd ? 'The system drive is a mechanical disk; an SSD is the lasting fix. Review the slowest start-up programs.' : 'Review the slowest start-up programs.' });
    }
  }
  // What actually exhausts a PC: commit (memory promised to programs), not just what is in RAM right now. Named from Windows' own records and the live process list.
  const rs = s.resources, gbOf = (mb: number) => (Math.round(mb / 102.4) / 10).toFixed(1);
  const ramMb = rs?.ramTotalMb ?? 0, lowMem = rs?.lowVirtualMemory24h ?? [];
  if (lowMem.length) {
    const top = [...new Map(lowMem.flatMap(e => e.top).map(t => [t.name, t])).values()].sort((a, b) => b.mb - a.mb).slice(0, 3).map(t => `${t.name} (${gbOf(t.mb)} GB)`).join(', ');
    add({ category: 'performance', points: lowMem.length >= 2 ? 12 : 8, code: 'perf.low_virtual_memory', reason: `Windows ran out of memory ${lowMem.length} time${lowMem.length === 1 ? '' : 's'} in the last 24 hours. The biggest users: ${top}.`, remedy: 'review',
      recommendation: `Restart or close the biggest program if it is not in use, and check it for an update (a program that keeps growing may have a memory leak).${ramMb > 0 && ramMb <= 8300 ? ' This PC has about 8 GB of memory; 16 GB is the lasting fix.' : ''}` });
  }
  const hog = (rs?.topCommit ?? []).find(c => c.category !== 'SYSTEM_CRITICAL' && c.privateMb >= Math.max(2048, ramMb * 0.25));
  if (hog) add({ category: 'performance', points: hog.privateMb >= 4096 ? 8 : 5, code: 'perf.memory_hog', reason: `${hog.name} is holding ${gbOf(hog.privateMb)} GB of memory${ramMb ? ` (${Math.round(hog.privateMb / ramMb * 100)}% of this PC's RAM)` : ''}.`, remedy: 'review', recommendation: 'If you are not using it, restart it. If it keeps growing, update or reinstall it. Viro will not close it for you because it may hold unsaved work.' });
  const engines = (rs?.securityEngines ?? []).filter(e => e.name !== 'Microsoft Defender');
  if (engines.length >= 2) add({ category: 'performance', points: 4, code: 'security.multiple_engines', reason: `${engines.map(e => e.name).join(', ')} are all running protection and use ${Math.round(engines.reduce((n, e) => n + e.memoryMb, 0))} MB of memory.`, remedy: 'review', recommendation: 'Confirm each one is needed. Two full antivirus products can slow the PC and conflict; a second scanner that is designed to run alongside (such as Malwarebytes) is usually fine.' });
  if ((rs?.failedShutdowns7d ?? 0) >= 1) add({ category: 'reliability', points: (rs!.failedShutdowns7d ?? 0) >= 2 ? 10 : 6, code: 'reliability.shutdown_failures', reason: `Windows failed to restart or shut down ${rs!.failedShutdowns7d} time${rs!.failedShutdowns7d === 1 ? '' : 's'} in the last 7 days.`, remedy: 'review', recommendation: 'A program or driver is blocking shutdown, or memory is exhausted. Look at the memory findings first, and save work and close programs before restarting.' });
  if ((rs?.firmwareThrottle24h ?? 0) >= 2) add({ category: 'performance', points: (rs!.firmwareThrottle24h ?? 0) >= 5 ? 8 : 4, code: 'perf.firmware_throttle', reason: `The firmware limited the processor speed ${rs!.firmwareThrottle24h} times in the last 24 hours (heat or power limits).`, remedy: 'manual', recommendation: 'Check the vents, the fan and that the original power adapter is used; see the heat findings.' });
  // Idle programs holding memory above the target (the agent measured what could be given back without closing anything).
  const cm = s.care?.memory;
  if (cm?.usedPercent != null && cm.targetPercent != null && cm.usedPercent > cm.targetPercent && (cm.idleTrimmableMb ?? 0) >= 300)
    add({ category: 'performance', points: cm.usedPercent >= 80 ? 8 : 4, code: 'perf.ram_idle_waste', reason: `Memory use is ${Math.round(cm.usedPercent)}% (target ${cm.targetPercent}%); idle programs hold ${Math.round((cm.idleTrimmableMb ?? 0) / 100) / 10} GB.`, remedy: 'safe-fix', recommendation: 'Let Windows take back the memory idle programs are holding; nothing is closed.', fix: { jobType: 'repair.run', params: { recipe: 'memory.trim-idle' }, label: 'Free memory from idle programs' } });
  // Heat that persists while the PC is mostly idle and Viro's own work is off: software is unlikely, so a cooling problem is suspected, with evidence.
  const th = s.care?.thermal;
  if (th?.coolingSuspected) add({ category: 'hardware', points: 8, code: 'hardware.cooling', reason: `The CPU has stayed hot (${Math.round(th.cpuTempC ?? 0)}°C) for ${Math.round(th.sustainedHotMinutesLowLoad ?? 0)} minutes while mostly idle. Software is unlikely to be the cause.`, remedy: 'hardware', recommendation: 'Inspect the vents and fan, clean the cooling system and check the heatsink (technician). Compute stays off until it cools.' });
  const groups = new Map<string, { count: number; ws: number }>();
  for (const pr of s.processes ?? []) { const b = BROWSERS[pr.name.toLowerCase().replace(/\.exe$/, '')]; if (b) { const g = groups.get(b) ?? { count: 0, ws: 0 }; g.count += pr.count; g.ws += pr.workingSetBytes; groups.set(b, g); } }
  for (const [b, g] of groups) if (g.count >= 25 || g.ws >= 3 * GB)
    add({ category: 'performance', points: 6, code: 'perf.browser_heavy', reason: `${b} has ${g.count} processes using ${gb(g.ws)} GB.`, remedy: 'review', recommendation: 'Close unused tabs/extensions.' });
  // Printing: what Windows reports about the print spooler and printers. A problem software can fix gets a one-click repair (the PC also repairs it by itself, within policy); paper, toner, cables and networks are named so someone can go and look.
  for (const i of (s.printing?.issues ?? []).slice(0, 4)) {
    if (i.fixable) add({ category: i.code === 'printer.driver' ? 'drivers' : 'reliability', points: 6, code: 'printing.' + i.code, reason: i.detail, remedy: 'safe-fix', recommendation: 'Viro clears stuck jobs, restarts the spooler and fixes or updates the printer driver.', fix: { jobType: 'repair.run', params: { recipe: 'printer.repair' }, label: 'Repair printing', confirm: 'Clear stuck print jobs, restart the print spooler and fix or update the printer driver on this computer?' } });
    else add({ category: 'reliability', points: 2, code: 'printing.' + i.code, reason: i.detail, remedy: 'manual', recommendation: 'This needs someone at the printer: check paper, toner, covers, the cable or the network connection.' });
  }
  for (const sv of (s.failedServices ?? []).slice(0, 4))
    add({ category: 'performance', points: 3, code: 'perf.service_failed', reason: `Service "${sv.displayName ?? sv.name}" is set to start automatically but has failed${sv.exitCode ? ` (exit code ${sv.exitCode})` : ''}.`, remedy: 'safe-fix', recommendation: 'Restart the service and check its dependencies.', fix: { jobType: 'repair.run', params: { recipe: 'services.restart-failed' }, label: 'Restart failed services' } });

  // ---- Updates ----
  const u = s.updates;
  if (s.updateSearchStuckMinutes != null)
    add({ category: 'updates', points: 8, code: 'updates.search_stuck', reason: `Windows Update has not answered for ${s.updateSearchStuckMinutes} minutes (update service may be stuck).`, remedy: 'safe-fix', recommendation: 'Reset Windows Update components safely.', fix: { jobType: 'repair.run', params: { recipe: 'windows.update-reset', approved: true, options: { force: true } }, label: 'Reset Windows Update', confirm: 'Reset Windows Update components? The old caches are kept so this can be rolled back.' } });
  if (u == null) { if (s.updateSearchStuckMinutes == null) notMeasured.push('Windows Update state'); } else {
    add({ category: 'updates', points: Math.min(15, u.pendingCriticalCount * 3), code: 'updates.critical_pending', reason: `${u.pendingCriticalCount} critical/security Windows update${u.pendingCriticalCount === 1 ? '' : 's'} remain pending.`, remedy: 'safe-fix', recommendation: 'Install pending updates in the next maintenance window.' });
    const other = u.pendingCount - u.pendingCriticalCount;
    add({ category: 'updates', points: other > 10 ? 5 : 0, code: 'updates.many_pending', reason: `${other} other updates are pending.`, remedy: 'safe-fix', recommendation: 'Install pending updates.' });
    if (u.rebootRequired) add({ category: 'updates', points: 5, code: 'updates.reboot_required', reason: 'A restart is required to finish installing updates.', remedy: 'review', recommendation: 'Restart at a convenient time.' });
    if (u.lastInstallDays != null) add({ category: 'updates', points: u.lastInstallDays > 90 ? 10 : u.lastInstallDays > 45 ? 5 : 0, code: 'updates.stale', reason: `No Windows update has installed in ${u.lastInstallDays} days.`, remedy: 'review', recommendation: 'Check whether Windows Update is stuck.' });
  }

  // ---- Security ----
  const df = s.defender;
  const otherAv = (s.avProducts ?? []).filter(n => !/defender/i.test(n));
  if (df == null && !otherAv.length) {
    if (s.avProducts) add({ category: 'security', points: 30, code: 'security.no_av', reason: 'No antivirus product was detected.', remedy: 'review', recommendation: 'Enable Microsoft Defender or install an approved endpoint-security product.' });
    else notMeasured.push('Antivirus state');
  } else if (df != null && (df.antivirusEnabled === false) && !otherAv.length)
    add({ category: 'security', points: 40, code: 'security.av_off', reason: 'Microsoft Defender antivirus is turned off and no other antivirus is active.', remedy: 'review', recommendation: 'Re-enable Defender.' });
  else if (df != null && df.antivirusEnabled !== false && !otherAv.length) {
    // Defender is the active engine only when no other AV is ON; otherwise it runs passive and its own flags say nothing.
    if (df.realTimeProtection === false) add({ category: 'security', points: 30, code: 'security.rtp_off', reason: 'Real-time protection is off.', remedy: 'review', recommendation: 'Turn real-time protection on.' });
    if (df.signatureAgeDays != null) add({ category: 'security', points: df.signatureAgeDays > 7 ? 15 : df.signatureAgeDays > 3 ? 6 : 0, code: 'security.signatures_old', reason: `Threat definitions are ${df.signatureAgeDays} days old.`, remedy: 'safe-fix', recommendation: 'Update Defender signatures.', fix: { jobType: 'security.update-signatures', params: {}, label: 'Update definitions' } });
    if ((df.activeThreats ?? 0) > 0) add({ category: 'security', points: 40, code: 'security.active_threat', reason: `${df.activeThreats} active threat(s) reported by Microsoft Defender.`, remedy: 'review', recommendation: 'Run a scan and review detections.' });
  }
  if (s.firewall) {
    const off = (['domain', 'private', 'public'] as const).filter(k => s.firewall![k] === false);
    add({ category: 'security', points: Math.min(30, off.reduce((a, k) => a + (k === 'public' ? 15 : 10), 0)), code: 'security.firewall_off', reason: `Windows Firewall is off for the ${off.join(', ')} profile${off.length > 1 ? 's' : ''}.`, remedy: 'safe-fix', recommendation: 'Turn the firewall on.', fix: { jobType: 'repair.run', params: { recipe: 'protect.firewall' }, label: 'Turn the firewall on' } });
  } else notMeasured.push('Firewall state');

  // Windows versions that no longer receive free security updates (dates from Microsoft's lifecycle pages).
  const eol = osSupport(s.os?.caption, s.os?.build);
  if (eol) add({ category: 'security', points: 15, code: 'security.os_unsupported', reason: eol, remedy: 'manual', recommendation: 'Upgrade Windows (or enrol in Extended Security Updates where available).' });

  // Posture beyond antivirus/firewall (only when the agent could read it).
  const sx = s.security;
  if (sx) {
    if (sx.bitLocker?.systemDrive === 'off') add({ category: 'security', points: 8, code: 'security.no_encryption', reason: 'The system drive is not encrypted (BitLocker is off).', remedy: 'manual', recommendation: 'Enable BitLocker so a lost or stolen PC does not expose its data.' });
    if (sx.secureBoot === false) add({ category: 'security', points: 4, code: 'security.secure_boot_off', reason: 'Secure Boot is turned off.', remedy: 'manual', recommendation: 'Enable Secure Boot in the firmware settings.' });
    if (sx.uacEnabled === false) add({ category: 'security', points: 15, code: 'security.uac_off', reason: 'User Account Control is disabled.', remedy: 'review', recommendation: 'Re-enable User Account Control.' });
    if (sx.rdp?.enabled === true && sx.rdp.networkLevelAuth === false) add({ category: 'security', points: 8, code: 'security.rdp_no_nla', reason: 'Remote Desktop is enabled without Network Level Authentication.', remedy: 'review', recommendation: 'Require NLA or turn Remote Desktop off.' });
    if (sx.engineIsDefender && sx.tamperProtection === false) add({ category: 'security', points: 6, code: 'security.tamper_off', reason: 'Defender tamper protection is off.', remedy: 'review', recommendation: 'Turn tamper protection on.' });
    if (sx.engineIsDefender) { const sc = daysSince([sx.lastQuickScan, sx.lastFullScan].filter(Boolean).sort().pop()); if (sc != null && sc > 14) add({ category: 'security', points: 6, code: 'security.scan_stale', reason: `No antivirus scan in ${sc} days.`, remedy: 'safe-fix', recommendation: 'Run a quick scan.', fix: { jobType: 'security.scan', params: { scanType: 'quick' }, label: 'Run quick scan' } }); }
    // Ransomware and attack-surface protection Windows offers but has not switched on (Defender-managed PCs only; never claimed where another product is active).
    const hx = sx.hardening;
    if (sx.engineIsDefender && sx.controlledFolderAccess === 'off') add({ category: 'security', points: 5, code: 'security.ransomware_shield_off', reason: 'Ransomware protection for personal folders (Controlled Folder Access) is off.', remedy: 'safe-fix', recommendation: 'Turn it on in watch-only mode first; nothing is blocked until an administrator chooses to.', fix: { jobType: 'repair.run', params: { recipe: 'protect.ransomware-audit' }, label: 'Turn on the ransomware shield (watch mode)' } });
    if (sx.engineIsDefender && hx?.asrRansomware === 'off') add({ category: 'security', points: 3, code: 'security.asr_ransomware_off', reason: "Defender's advanced ransomware protection rule is not enabled.", remedy: 'safe-fix', recommendation: 'Enable the cloud-based ransomware rule.', fix: { jobType: 'repair.run', params: { recipe: 'protect.asr-ransomware' }, label: 'Enable advanced ransomware protection' } });
    if (sx.engineIsDefender && hx?.pua === 'off') add({ category: 'security', points: 3, code: 'security.pua_off', reason: 'Protection against potentially unwanted applications is off.', remedy: 'safe-fix', recommendation: 'Turn on PUA blocking.', fix: { jobType: 'repair.run', params: { recipe: 'protect.pua' }, label: 'Block unwanted applications' } });
    if (hx?.smb1Enabled === true) add({ category: 'security', points: 10, code: 'security.smb1_on', reason: 'The obsolete SMBv1 protocol is enabled (used by WannaCry-style worms).', remedy: 'safe-fix', recommendation: 'Turn SMBv1 off.', fix: { jobType: 'repair.run', params: { recipe: 'protect.smb1-off' }, label: 'Turn off SMBv1' } });
    if (hx?.restorePoints === 0 && hx.systemRestoreOff !== false) add({ category: 'security', points: 3, code: 'security.no_restore_points', reason: 'No restore point or shadow copy exists, so there is nothing to recover files from after ransomware or a bad update.', remedy: 'manual', recommendation: 'Turn on System Protection or a backup for the system drive.' });
    const act = (sx.threats ?? []).filter(t => t.active).length;
    if (act > 0 && !(df?.activeThreats)) add({ category: 'security', points: 40, code: 'security.active_threat', reason: `${act} active threat${act === 1 ? '' : 's'} reported by Windows security.`, remedy: 'review', recommendation: 'Run a scan and review detections.' });
  }

  // ---- Drivers (device errors only; outdated-driver evaluation is a later phase) ----
  for (const e of (s.driverErrors ?? []).slice(0, 5))
    add({ category: 'drivers', points: 8, code: 'drivers.device_error', reason: `Device "${e.name}" reports a driver problem (Device Manager error code ${e.code}).`, remedy: 'review', recommendation: 'Reinstall or roll back the driver from Windows Update or the OEM.' });

  // ---- Reliability ----
  const byApp = new Map<string, { crashes: number; hangs: number }>();
  for (const c of s.crashes ?? []) { const g = byApp.get(c.app) ?? { crashes: 0, hangs: 0 }; if (c.kind === 'crash') g.crashes += c.count; else g.hangs += c.count; byApp.set(c.app, g); }
  let relTotal = 0;
  const appReliability: HealthResult['appReliability'] = [];
  for (const [app, g] of [...byApp].sort((a, b) => b[1].crashes + b[1].hangs - a[1].crashes - a[1].hangs)) {
    const n = g.crashes + g.hangs;
    const pts = n >= 5 ? 8 : n >= 3 ? 4 : 0;
    if (!pts || relTotal >= 25) continue;
    relTotal += pts;
    add({ category: 'reliability', points: pts, code: 'reliability.app_unstable', reason: `${app} ${g.crashes ? `crashed ${g.crashes} time${g.crashes === 1 ? '' : 's'}` : ''}${g.crashes && g.hangs ? ' and ' : ''}${g.hangs ? `stopped responding ${g.hangs} time${g.hangs === 1 ? '' : 's'}` : ''} in 7 days.`, remedy: 'review', recommendation: 'Diagnose the application; check disk space, memory and updates.' });
    appReliability.push({ app, crashes: g.crashes, hangs: g.hangs, rating: n >= 5 ? 'POOR' : 'FAIR', factors: [] });
  }
  if (s.unexpectedShutdowns7d != null)
    add({ category: 'reliability', points: s.unexpectedShutdowns7d >= 3 ? 10 : s.unexpectedShutdowns7d >= 1 ? 4 : 0, code: 'reliability.unexpected_shutdown', reason: `${s.unexpectedShutdowns7d} unexpected shutdown${s.unexpectedShutdowns7d === 1 ? '' : 's'} in 7 days.`, remedy: 'manual', recommendation: 'Check power supply, overheating and drivers.' });

  // ---- Hardware ----
  let critical = false;
  // A completed hardware.diagnose job reads the drives directly (SMART/NVMe log, I/O error events) and supersedes these coarser snapshot signals.
  for (const disk of hw ? [] : s.physicalDisks ?? []) {
    const nm = disk.name ?? 'Disk';
    const uncorrectable = (disk.readErrorsUncorrected ?? 0) + (disk.writeErrorsUncorrected ?? 0);
    if (disk.health === 'Unhealthy') { critical = true; add({ category: 'hardware', points: 60, code: 'hardware.disk_unhealthy', reason: `${nm} reports Unhealthy status.`, remedy: 'hardware', recommendation: 'Back up data and replace the storage device.' }); }
    else if (disk.health === 'Warning') add({ category: 'hardware', points: 30, code: 'hardware.disk_warning', reason: `${nm} reports a Warning health status.`, remedy: 'hardware', recommendation: 'Back up data and plan to replace the device.' });
    if (uncorrectable > 0) { critical = true; add({ category: 'hardware', points: 40, code: 'hardware.disk_errors', reason: `${nm}: ${uncorrectable} uncorrectable read/write error(s) recorded.`, remedy: 'hardware', recommendation: 'Storage reliability has deteriorated. Verify backup, then replace the device.' }); }
    if (disk.wearPercent != null) add({ category: 'hardware', points: disk.wearPercent >= 90 ? 30 : disk.wearPercent >= 80 ? 15 : 0, code: 'hardware.disk_wear', reason: `${nm} has used ${disk.wearPercent}% of its rated write endurance.`, remedy: 'hardware', recommendation: 'Plan SSD replacement.' });
    if (disk.temperatureC != null) add({ category: 'hardware', points: disk.temperatureC >= 70 ? 10 : 0, code: 'hardware.disk_hot', reason: `${nm} is at ${disk.temperatureC}°C.`, remedy: 'manual', recommendation: 'Check airflow and cooling.' });
  }
  if (!s.physicalDisks && !hw) notMeasured.push('Disk health');
  for (const x of hw?.findings ?? []) {
    if (x.severity === 'info') continue;
    if (x.severity === 'critical') critical = true;
    add({ category: 'hardware', points: x.severity === 'critical' ? 40 : 12, code: 'hw.' + x.code, reason: x.message, remedy: x.component === 'thermal' || x.component === 'cpu' ? 'manual' : 'hardware', recommendation: x.recommendation });
  }
  const limits: string[] = [];
  const totalRam = s.memory?.totalBytes;
  if (totalRam != null && totalRam <= 4.5 * GB) { limits.push('4 GB or less RAM'); add({ category: 'hardware', points: 10, code: 'hardware.low_ram', reason: `This machine has only ${gb(totalRam)} GB RAM.`, remedy: 'hardware', recommendation: 'Upgrade to 8 GB+ RAM.' }); }
  const sysDisk = s.physicalDisks?.find(x => x.isSystem) ?? (s.physicalDisks?.length === 1 ? s.physicalDisks[0] : undefined);
  if (sysDisk?.mediaType === 'HDD') { limits.push('a mechanical hard drive'); add({ category: 'hardware', points: 8, code: 'hardware.hdd_system', reason: 'The system drive is a mechanical hard disk.', remedy: 'hardware', recommendation: 'Replace with an SSD.' }); }
  const hardwareNote = limits.length
    ? `This machine has ${limits.join(' and ')}.\nSoftware optimization will provide limited improvement.\nRecommended upgrade: ${[limits.some(l => l.includes('RAM')) ? '8 GB+ RAM' : null, limits.some(l => l.includes('hard drive')) ? 'SSD' : null].filter(Boolean).join(', ')}`
    : null;

  // Contributing factors for unstable apps.
  const has = (c: string) => d.some(x => x.code === c);
  for (const a of appReliability) {
    if (has('storage.system_low')) a.factors.push('Low free disk space');
    if (has('perf.ram_pressure')) a.factors.push('Repeated RAM pressure');
    if (has('updates.critical_pending') || has('updates.stale')) a.factors.push('Outdated Windows updates');
    if (has('reliability.unexpected_shutdown')) a.factors.push('Unexpected shutdowns');
  }

  const categories = {} as Record<Category, number>;
  for (const c of Object.keys(WEIGHTS) as Category[]) categories[c] = Math.max(0, 100 - d.filter(x => x.category === c).reduce((a, x) => a + x.points, 0));
  // A category whose key inputs could not be read has no real score: showing 100 would claim a health Viro never saw. It is flagged, and left out of the overall score.
  const measured = {} as Record<Category, boolean>;
  for (const c of Object.keys(WEIGHTS) as Category[]) measured[c] = !(UNMEASURED_WHEN[c] ?? []).length || !UNMEASURED_WHEN[c]!.every(m => notMeasured.includes(m));
  const cats = (Object.keys(WEIGHTS) as Category[]).filter(c => measured[c]);
  const weightSum = cats.reduce((a, c) => a + WEIGHTS[c], 0) || 1;
  const overall = Math.round(cats.reduce((a, c) => a + categories[c] * WEIGHTS[c], 0) / weightSum);
  const status = critical || overall < 60 ? 'critical' : overall < 80 ? 'attention' : 'healthy';
  const order = (a: Deduction, b: Deduction) => b.points - a.points;
  const sorted = [...d].sort(order);
  return {
    overall, status, categories, measured, deductions: sorted, notMeasured,
    diagnosis: {
      high: sorted.filter(x => x.impact === 'high'), medium: sorted.filter(x => x.impact === 'medium'), low: sorted.filter(x => x.impact === 'low'),
      safeFixCount: d.filter(x => x.remedy === 'safe-fix' && x.fix).length, hardwareNote,
    },
    appReliability, shield: shieldOf(s),
  };
}
