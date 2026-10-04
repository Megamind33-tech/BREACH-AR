import type { Deduction, Snapshot } from './health.js';

/**
 * Stability engine. Turns the individual crash records an agent reports into one incident per unstable application, works out the most
 * likely cause from evidence (disk and memory state when each crash happened, changes just before the first crash, a common faulting
 * module) and chooses a repair only where a supported one exists. Whether a repair worked is judged on the crashes that happened AFTER
 * it, so old crashes that are still inside the 7-day window never count against a repair.
 */
export interface CrashRec { app: string; kind: 'crash' | 'hang'; appVersion?: string | null; module?: string | null; moduleVersion?: string | null; exceptionCode?: string | null; at: string }
export interface ChangeRec { kind: string; name: string; at: string }
export interface HistoryPoint { at: Date; metrics: Record<string, number | null> | null }

export type CauseKind = 'storage-pressure' | 'memory-pressure' | 'recent-change' | 'faulting-module' | 'unknown';
export interface Classification { cause: CauseKind; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; explanation: string; facts: Record<string, unknown> }

export const STABILITY_PREFIX = 'stability.app:';
export const DETECT_THRESHOLD = 3;      // crashes or hangs of one application within the window
export const REOPEN_THRESHOLD = 2;      // crashes after a previous repair that make it a recurrence
const WINDOW_DAYS = 7, LOW_DISK_BYTES = 2 * 2 ** 30, HIGH_RAM_PERCENT = 90, MATCH_MS = 90 * 60_000;

/** Applications with a supported repair recipe (Microsoft 365 / Office Click-to-Run). */
export const OFFICE_APPS = new Set(['outlook.exe', 'winword.exe', 'excel.exe', 'powerpnt.exe', 'onenote.exe', 'msaccess.exe', 'mspub.exe', 'visio.exe']);
const OFFICE_FIX = { jobType: 'repair.run', params: { recipe: 'office.quick-repair' }, label: 'Repair Office (Quick Repair)' };

const nearest = (t: Date, history: HistoryPoint[]): HistoryPoint | null => {
  let best: HistoryPoint | null = null, gap = MATCH_MS + 1;
  for (const h of history) { const d = Math.abs(h.at.getTime() - t.getTime()); if (d < gap) { gap = d; best = h; } }
  return gap <= MATCH_MS ? best : null;
};

export function classifyCrashes(app: string, crashes: CrashRec[], history: HistoryPoint[], changes: ChangeRec[]): Classification {
  const n = crashes.length;
  const withState = crashes.map(c => ({ c, h: nearest(new Date(c.at), history)?.metrics ?? null })).filter(x => x.h);
  const lowDisk = withState.filter(x => typeof x.h!.systemFreeBytes === 'number' && (x.h!.systemFreeBytes as number) < LOW_DISK_BYTES);
  const highRam = withState.filter(x => typeof x.h!.ramPercent === 'number' && (x.h!.ramPercent as number) >= HIGH_RAM_PERCENT);
  const covered = withState.length;
  if (covered >= 3 && lowDisk.length / covered >= 0.6)
    return { cause: 'storage-pressure', confidence: lowDisk.length / covered >= 0.8 ? 'HIGH' : 'MEDIUM', explanation: `${lowDisk.length} of ${covered} crashes with a recorded disk state happened while the system drive had less than 2 GB free.`, facts: { crashes: n, withRecordedState: covered, whileDiskLow: lowDisk.length } };
  if (covered >= 3 && highRam.length / covered >= 0.6)
    return { cause: 'memory-pressure', confidence: highRam.length / covered >= 0.8 ? 'HIGH' : 'MEDIUM', explanation: `${highRam.length} of ${covered} crashes with a recorded memory state happened while memory use was ${HIGH_RAM_PERCENT}% or higher.`, facts: { crashes: n, withRecordedState: covered, whileMemoryHigh: highRam.length } };
  const first = crashes.map(c => new Date(c.at).getTime()).sort((a, b) => a - b)[0];
  const family = OFFICE_APPS.has(app) ? /office|microsoft 365|outlook|word|excel/i : new RegExp(app.replace(/\.exe$/, '').replace(/[^a-z0-9]/gi, ''), 'i');
  const change = changes.filter(c => { const t = new Date(c.at).getTime(); return t <= first && first - t <= 5 * 86_400_000 && (family.test(c.name) || c.kind === 'windows-update'); }).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0];
  if (change) return { cause: 'recent-change', confidence: family.test(change.name) ? 'MEDIUM' : 'LOW', explanation: `The first crash came ${Math.max(0, Math.round((first - new Date(change.at).getTime()) / 86_400_000))} day(s) after "${change.name}" was ${change.kind === 'windows-update' ? 'installed' : change.kind === 'install' ? 'installed' : 'changed'}.`, facts: { change: change.name, changeAt: change.at } };
  const byModule = new Map<string, number>(); for (const c of crashes) if (c.module) byModule.set(c.module, (byModule.get(c.module) ?? 0) + 1);
  const top = [...byModule.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && n >= 3 && top[1] / n >= 0.7) return { cause: 'faulting-module', confidence: 'MEDIUM', explanation: `${top[1]} of ${n} crashes were in the same module, ${top[0]}.`, facts: { module: top[0], count: top[1] } };
  return { cause: 'unknown', confidence: 'LOW', explanation: 'Viro could not tie these crashes to a measurable cause (disk, memory, a recent change or a common module).', facts: { crashes: n } };
}

export interface StabilityFinding { deduction: Deduction & { crashCount: number; evidence: { type: 'EVENT_LOG' | 'TELEMETRY'; source: string; value: Record<string, unknown>; note?: string }[] }; classification: Classification; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; app: string; crashCount: number }

/**
 * One finding per application that is unstable right now.
 * `sinceByCode` holds, for applications Viro has already repaired, the time of that repair: only crashes after it count.
 */
/** How many crashes or hangs of an application were recorded at or after a time (the verification measure after a repair). */
export function crashesSince(snap: Snapshot, code: string, since: Date): number {
  const app = code.startsWith(STABILITY_PREFIX) ? code.slice(STABILITY_PREFIX.length) : code;
  return ((snap.stability?.crashes ?? []) as CrashRec[]).filter(c => c.app === app && new Date(c.at).getTime() >= since.getTime()).length;
}

export function stabilityFindings(snap: Snapshot, history: HistoryPoint[], sinceByCode: Map<string, { repairedAt: Date | null; inObservation: boolean }>, now = new Date()): StabilityFinding[] {
  const st = snap.stability; if (!st?.crashes?.length) return [];
  const all = st.crashes as CrashRec[];
  const changes = (st.recentChanges ?? []) as ChangeRec[];
  const windowStart = now.getTime() - WINDOW_DAYS * 86_400_000;
  const byApp = new Map<string, CrashRec[]>();
  for (const c of all) { const l = byApp.get(c.app) ?? []; l.push(c); byApp.set(c.app, l); }
  const out: StabilityFinding[] = [];
  for (const [app, list] of byApp) {
    const code = STABILITY_PREFIX + app;
    const prior = sinceByCode.get(code);
    const sinceMs = prior?.repairedAt ? prior.repairedAt.getTime() : null;
    const relevant = list.filter(c => new Date(c.at).getTime() >= Math.max(windowStart, sinceMs ?? 0)).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const need = sinceMs == null ? DETECT_THRESHOLD : prior?.inObservation ? 1 : REOPEN_THRESHOLD;
    if (relevant.length < need) continue;
    const cls = classifyCrashes(app, relevant, history, changes);
    const office = OFFICE_APPS.has(app);
    const points = Math.min(15, Math.round(relevant.length * 1.5));
    let fix: Deduction['fix'] | undefined; let remedy: Deduction['remedy'] = 'manual'; let recommendation: string;
    if (cls.cause === 'storage-pressure') { remedy = 'safe-fix'; recommendation = 'Free up storage on the system drive first; the crashes coincide with a nearly full disk.'; }
    else if (cls.cause === 'memory-pressure') { remedy = 'manual'; recommendation = 'Reduce what runs alongside this application or add memory; the crashes coincide with very high memory use.'; }
    else if (office) { fix = OFFICE_FIX; remedy = 'safe-fix'; recommendation = 'Run Office Quick Repair. It restores the program files without touching documents or mail, then Viro watches for a week to confirm the crashes stopped.'; }
    else { recommendation = `There is no automatic repair for ${app}. Check for an update or reinstall it; Viro keeps watching and will reopen this if it continues.`; }
    const reason = `${app} crashed or hung ${relevant.length} time${relevant.length === 1 ? '' : 's'}${sinceMs == null ? ` in the last ${WINDOW_DAYS} days` : ' since it was last repaired'}. ${cls.explanation}`;
    out.push({
      app, classification: cls, confidence: cls.confidence, crashCount: relevant.length,
      deduction: {
        category: 'reliability', points, code, reason, crashCount: relevant.length, impact: relevant.length >= 5 ? 'high' : 'medium', remedy, recommendation, ...(fix ? { fix } : {}),
        evidence: [
          { type: 'EVENT_LOG', source: 'Windows Application log', value: { app, crashes: relevant.slice(0, 8), total: relevant.length }, note: 'Faulting module, exception code and version as recorded by Windows.' },
          { type: 'TELEMETRY', source: 'Cause analysis', value: { cause: cls.cause, confidence: cls.confidence, ...cls.facts }, note: cls.explanation },
        ],
      } as StabilityFinding['deduction'],
    });
  }
  return out;
}
