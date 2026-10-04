import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { JobCtx } from './jobs.js';

/**
 * The machine's history: what Windows, the hardware and Viro's own records say about how this computer has been used and changed.
 * Every line carries its basis, so nobody reads a guess as a fact:
 *   measured  - read from the machine itself (Windows' own install records, drive and battery counters)
 *   observed  - seen by Viro between two readings (a part appeared or disappeared); only covers the time Viro has known the computer
 *   recorded  - entered and confirmed by a person (the service history)
 * What cannot be known (a clean reinstall wipes Windows' own records; changes before Viro's first reading) is listed under `limits`.
 */
export type Basis = 'measured' | 'observed' | 'recorded';
export interface HistoryItem { date: string | null; kind: 'windows' | 'memory' | 'storage' | 'battery' | 'part' | 'service' | 'system'; title: string; detail?: string; basis: Basis }
export interface Fact { label: string; value: string; basis: Basis }

type Obj = Record<string, any>;
const day = (v: unknown): string | null => { if (typeof v !== 'string') return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
const gb = (b: number) => `${Math.round(b / 2 ** 30)} GB`;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface HistoryInput { anatomy: Obj | null; changes: { detected_at: string | Date; kind: string; change: string; label: string }[]; service: { occurred_at: string | Date; service_type: string; reason?: string | null; source?: string }[]; firstSeenByViro: string | Date | null; now?: Date }

export function machineHistory(i: HistoryInput) {
  const a = i.anatomy ?? {}; const now = i.now ?? new Date();
  const timeline: HistoryItem[] = []; const limits: string[] = []; const facts: Fact[] = [];

  // ---- Windows: every earlier version leaves a "Source OS" record, so upgrades are counted exactly; a clean install wipes them
  const earlier = ((a.evidence?.windowsInstalls ?? []) as Obj[]).filter(x => x?.date).sort((x, y) => String(x.date).localeCompare(String(y.date)));
  for (const e of earlier) timeline.push({ date: day(e.date), kind: 'windows', title: `${e.product ?? 'Windows'}${e.build ? ` (build ${e.build})` : ''} was replaced by a newer Windows`, detail: 'Windows keeps one record for every version it was upgraded from.', basis: 'measured' });
  const current = day(a.evidence?.currentWindowsInstall) ?? day(a.os?.installedAt);
  if (current) timeline.push({ date: current, kind: 'windows', title: `${a.os?.caption ?? 'Windows'}${a.os?.build ? ` (build ${a.os.build})` : ''} installed`, detail: earlier.length ? 'The Windows version in use today.' : 'The date this copy of Windows was installed. A fresh install starts Windows\' own records again.', basis: 'measured' });
  const upgrades = earlier.length;
  const firstWindows = earlier[0] ? day(earlier[0].date) : current;
  // a current install much later than every other sign of use means Windows was reinstalled from scratch at least once
  const otherUse = [a.evidence?.setupApiLogStart, ...((a.evidence?.profiles ?? []) as Obj[]).map(p => p?.createdAt), ...(((a.evidence?.deviceFirstInstalled ?? []) as Obj[]).map(d => d?.firstInstalled))].map(day).filter((d): d is string => !!d).sort();
  const cleanLikely = !!(current && otherUse[0] && otherUse[0] < current && daysBetween(otherUse[0], current) > 120 && !earlier.length);
  facts.push({ label: 'Windows versions upgraded through', value: upgrades ? String(upgrades) : '0 on record', basis: 'measured' });
  if (current) facts.push({ label: 'Current Windows installed', value: current, basis: 'measured' });
  if (cleanLikely) { facts.push({ label: 'Windows reinstalled from scratch', value: 'At least once (likely)', basis: 'measured' }); timeline.push({ date: otherUse[0]!, kind: 'system', title: 'Earliest sign this computer was in use', detail: 'Older than the current Windows install, so Windows was reinstalled after this.', basis: 'measured' }); }
  limits.push('A clean reinstall (formatting the drive) erases Windows\' own upgrade records, so the number of reinstalls is a minimum, never an exact count.');

  // ---- parts changed while Viro watched
  const memChanges = i.changes.filter(c => c.kind === 'memory'), diskChanges = i.changes.filter(c => c.kind === 'storage' || c.kind === 'disk'), otherChanges = i.changes.filter(c => !['memory', 'storage', 'disk'].includes(c.kind));
  for (const c of i.changes) timeline.push({ date: day(String(c.detected_at)), kind: c.kind === 'memory' ? 'memory' : c.kind === 'storage' || c.kind === 'disk' ? 'storage' : 'part', title: `${c.kind === 'memory' ? 'Memory' : c.kind === 'storage' || c.kind === 'disk' ? 'Drive' : cap(c.kind)} ${c.change}: ${c.label}`, basis: 'observed' });
  const since = i.firstSeenByViro ? day(String(i.firstSeenByViro)) : null;
  facts.push({ label: 'Memory changes seen', value: String(memChanges.length), basis: 'observed' }, { label: 'Drive changes seen', value: String(diskChanges.length), basis: 'observed' }, { label: 'Other parts changed', value: String(otherChanges.length), basis: 'observed' });
  limits.push(since ? `Part changes are only known from ${since}, when Viro first saw this computer. Anything done to it before then is not in this record.` : 'Part changes are only known from when Viro first saw this computer.');

  // ---- what is fitted now, and how worn it is (measured)
  const mods = (a.memory?.modules ?? []) as Obj[];
  if (mods.length) facts.push({ label: 'Memory fitted', value: `${gb(mods.reduce((n, m) => n + (num(m.capacityBytes) ?? 0), 0))} in ${mods.length} module${mods.length > 1 ? 's' : ''}${a.memory?.slotsTotal ? ` of ${a.memory.slotsTotal} slots` : ''}`, basis: 'measured' });
  const manufacturers = new Set(mods.map(m => `${m.manufacturer ?? ''}|${m.partNumber ?? ''}`.trim()));
  if (mods.length > 1 && manufacturers.size > 1) facts.push({ label: 'Memory modules', value: 'Different makes or models mixed together (a sign memory was added later)', basis: 'measured' });
  const disks = ((a.diagnostics?.storage?.disks ?? []) as Obj[]);
  for (const d of disks) {
    const poh = num(d.nvme?.powerOnHours) ?? num(d.reliability?.powerOnHours), unsafe = num(d.nvme?.unsafeShutdowns) ?? num(d.reliability?.unsafeShutdowns), cycles = num(d.nvme?.powerCycles) ?? num(d.reliability?.powerCycleCount);
    const wear = num(d.nvme?.percentageUsed) ?? num(d.reliability?.wearPercent);
    if (poh != null) facts.push({ label: `${d.model ?? 'Drive'}: time powered on`, value: `${Math.round(poh).toLocaleString('en-US')} hours (about ${(poh / 8760).toFixed(1)} years)`, basis: 'measured' });
    if (cycles != null) facts.push({ label: `${d.model ?? 'Drive'}: times switched on`, value: cycles.toLocaleString('en-US'), basis: 'measured' });
    if (unsafe != null) facts.push({ label: `${d.model ?? 'Drive'}: unsafe power-offs`, value: unsafe.toLocaleString('en-US'), basis: 'measured' });
    if (wear != null) facts.push({ label: `${d.model ?? 'Drive'}: write wear used`, value: `${wear}%`, basis: 'measured' });
  }
  if (disks.length) limits.push('Drive counters belong to the drive. If a drive was replaced, they describe the new drive, not the computer.');
  const b = a.battery as Obj | null;
  if (b) {
    const wear = num(b.wearPercent) ?? (num(b.designMWh) && num(b.fullChargeMWh) ? Math.max(0, Math.round((1 - b.fullChargeMWh / b.designMWh) * 100)) : null);
    if (num(b.cycleCount) != null) facts.push({ label: 'Battery charge cycles', value: String(b.cycleCount), basis: 'measured' });
    if (wear != null) facts.push({ label: 'Battery capacity lost', value: `${wear}%`, basis: 'measured' });
    if (day(b.manufactureDate)) timeline.push({ date: day(b.manufactureDate), kind: 'battery', title: 'Battery manufactured', detail: 'Dates the battery. It dates the computer only if the battery was never replaced.', basis: 'measured' });
  }
  const mdate = day(a.bios?.releaseDate); if (mdate) facts.push({ label: 'Firmware (BIOS) released', value: mdate, basis: 'measured' });

  // ---- recorded service
  for (const s of i.service) timeline.push({ date: day(String(s.occurred_at)), kind: 'service', title: s.service_type + (s.reason ? ` (${s.reason})` : ''), detail: 'Confirmed in the service history.', basis: 'recorded' });
  if (since) timeline.push({ date: since, kind: 'system', title: 'Viro first saw this computer', basis: 'recorded' });

  timeline.sort((x, y) => (y.date ?? '').localeCompare(x.date ?? ''));
  const summary = {
    windowsUpgrades: upgrades, firstWindowsOnRecord: firstWindows, currentWindowsInstalled: current, windowsReinstalledLikely: cleanLikely,
    memoryChangesSeen: memChanges.length, driveChangesSeen: diskChanges.length, otherPartChangesSeen: otherChanges.length, confirmedServices: i.service.length, watchedSince: since,
  };
  return { asOf: ymd(now), hasData: !!i.anatomy, summary, facts, timeline: timeline.slice(0, 120), limits };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function daysBetween(a: string, b: string) { return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000); }

/** Loads everything the history is built from, for one computer. */
export async function loadHistory(c: JobCtx, orgId: string, deviceId: string) {
  const { db } = c;
  const dev = (await db.query('SELECT hostname, enrolled_at FROM devices WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL', [deviceId, orgId])).rows[0];
  if (!dev) return null;
  const anatomy = (await db.query('SELECT data, collected_at FROM device_anatomy WHERE device_id=$1', [deviceId])).rows[0];
  const changes = (await db.query('SELECT detected_at, kind, change, label FROM anatomy_changes WHERE device_id=$1 ORDER BY detected_at DESC LIMIT 200', [deviceId])).rows;
  const service = (await db.query(`SELECT occurred_at, service_type, reason, source FROM service_events WHERE device_id=$1 AND status='CONFIRMED' ORDER BY occurred_at DESC LIMIT 200`, [deviceId])).rows;
  return { hostname: dev.hostname as string, anatomyCollectedAt: anatomy?.collected_at ?? null, ...machineHistory({ anatomy: anatomy?.data ?? null, changes, service, firstSeenByViro: dev.enrolled_at }) };
}

export function registerHistoryRoutes(app: FastifyInstance, c: JobCtx) {
  app.get('/api/v1/devices/:id/history', { preHandler: c.requireRole('viewer') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const h = await loadHistory(c, req.user.org, id);
    return h ? h : reply.code(404).send({ error: 'computer not found' });
  });
}
