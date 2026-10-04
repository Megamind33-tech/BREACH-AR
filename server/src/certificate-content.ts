import { createHash } from 'node:crypto';
import { buildReport, REFERENCE_PRICE_BOOK, type Context, type PriceBook, type Part } from './anatomy-engine.js';
import { machineHistory } from './machine-history.js';

type Obj = Record<string, any>;
const VALID_DAYS = 30;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const serialKey = (s: string) => sha('viro-serial-v1|' + s.toUpperCase().replace(/[^A-Z0-9]/g, ''));
const real = (s: unknown): string | null => (typeof s === 'string' && s.trim().length >= 4 && !/^(0+|none|unknown|default string|to be filled.*|system serial number|123456789.*)$/i.test(s.trim()) ? s.trim() : null);
const money = (n: number | null | undefined) => (n == null ? null : Math.round(n));

export type Rating = 'SOUND' | 'FAIR' | 'POOR';

/**
 * What the certificate says. Every figure comes from what the computer reported just now, from Windows' own records, or from a price list that is named on the
 * certificate (the seller's organisation's own prices if it has set them, otherwise Viro's typical prices). Costs are estimates and are labelled as such.
 */
export function buildStatement(o: {
  id: string; now: Date; anatomy: Obj; changes: any[]; service: any[]; firstSeen: string | Date | null; health: number | null; openIssues: string[]; collectedAt: string;
  ctx: Context; book: PriceBook | null; listedBy: string | null; buyerMasked: string;
}) {
  const a = o.anatomy; const book = o.book ?? REFERENCE_PRICE_BOOK;
  const report = buildReport(a, o.ctx, book);
  const history = machineHistory({ anatomy: a, changes: o.changes, service: o.service, firstSeenByViro: o.firstSeen, now: o.now });
  const serial = real(a.system?.serial) ?? real(a.board?.serial);
  const mods = (a.memory?.modules ?? []) as Obj[]; const disks = (a.diagnostics?.storage?.disks ?? []) as Obj[];
  const expires = new Date(o.now.getTime() + VALID_DAYS * 86_400_000);
  const cost: Obj = report.cost as Obj; const priced = cost.priced === true;
  const parts: Part[] = report.parts;

  // ---- the verdict a buyer reads first ------------------------------------------------------------------------------------------------------------------
  const worst = parts.some(p => p.risk === 'CRITICAL') ? 'CRITICAL' : parts.some(p => p.risk === 'HIGH') ? 'HIGH' : parts.some(p => p.risk === 'WATCH') ? 'WATCH' : 'LOW';
  let rating: Rating = worst === 'CRITICAL' ? 'POOR' : worst === 'HIGH' ? 'FAIR' : 'SOUND';
  if (priced) rating = cost.decision === 'REPLACE' ? 'POOR' : cost.decision === 'REPAIR' && rating === 'SOUND' ? 'FAIR' : rating;
  const win = report.windows;
  if (win.runningWindows10 && win.windows11Ready === false && rating === 'SOUND') rating = 'FAIR';
  const reasons: string[] = report.headline.slice(0, 4).map(h => `${h.part}: ${h.why}`);
  if (win.windows11Ready === false) reasons.push('Cannot run Windows 11' + (win.runningWindows10 ? ', and Windows 10 no longer gets regular security updates.' : '.'));
  if (!reasons.length) reasons.push('Nothing measured on this computer gave cause for concern.');
  const label = { SOUND: 'Sound', FAIR: 'Fair: budget for some work', POOR: 'Only worth it at a low price: repairs cost about as much as it is worth' }[rating];
  const age = report.age;

  // ---- what to expect to spend ----------------------------------------------------------------------------------------------------------------------------
  const soon = (cost.lines ?? []).map((l: any) => ({ title: l.title, parts: money(l.parts), labour: money(l.labour), total: money(l.total), priced: l.priced }));
  const value = priced ? cost.residualValue as number | null : null;
  const costs = priced ? {
    currency: cost.currency, priceSource: cost.priceSource === 'entered' ? 'the seller organisation\'s own price list' : 'Viro\'s typical prices (not a quote)',
    workSoon: soon, workSoonTotal: money(cost.repairTotal), newEquivalent: money(cost.replacementCost), migration: money(cost.migrationCost),
    valueToday: money(value), fairPriceRange: value != null ? [money(value * 0.8), money(value * 1.2)] : null,
    decision: cost.decision as string, reasoning: (cost.reasoning as string[]).slice(0, 6),
  } : null;

  // ---- plain-language part checks ----------------------------------------------------------------------------------------------------------------------
  const partRows = parts.map(p => ({
    kind: p.kind, label: String(p.label).replace(/undefined/g, '').replace(/s{2,}/g, ' ').trim() || p.kind, risk: p.risk, why: p.riskReasons.slice(0, 2), lifespan: p.lifespan, action: p.action,
    facts: p.facts.filter(f => !/serial|uuid|mac address|asset/i.test(f.label)).slice(0, 7),
    upgrades: p.upgrades.slice(0, 2).map(u => ({ title: u.title, why: u.why })),
  }));

  const stmt = {
    v: 2, certificateId: o.id, issuedAt: o.now.toISOString(), expiresAt: expires.toISOString(), inspectedAt: o.collectedAt, issuer: 'Viro WorkCare',
    issuedFor: o.buyerMasked, listedBy: o.listedBy,
    verdict: { rating, label, reasons },
    machine: {
      manufacturer: a.system?.manufacturer ?? null, model: a.system?.model ?? null, formFactor: a.system?.formFactor ?? null, serialLast4: serial ? serial.slice(-4) : null,
      cpu: a.cpu?.name ?? null, cpuGeneration: report.age.cpu?.generation ?? null,
      ramGb: mods.length ? Math.round(mods.reduce((n, m) => n + (m.capacityBytes ?? 0), 0) / 2 ** 30) : a.system?.totalPhysicalMemoryBytes ? Math.round(a.system.totalPhysicalMemoryBytes / 2 ** 30) : null,
      ramSlots: a.memory ? { total: a.memory.slotsTotal ?? null, used: mods.length } : null,
      storage: disks.map(d => ({ model: d.model ?? null, type: d.mediaType ?? null, sizeGb: d.sizeBytes ? Math.round(d.sizeBytes / 1e9) : null })),
      graphics: (a.gpus ?? []).map((g: Obj) => g.name).filter(Boolean), screen: (a.monitors ?? []).find((m: Obj) => m.builtIn)?.sizeInches ?? null,
      os: a.os?.caption ?? null, osBuild: a.os?.build ?? null,
    },
    age: { inServiceSince: age.inServiceSince, years: age.ageYears, upToYears: age.ageUpperBoundYears, confidence: age.confidence, note: age.note },
    life: { stage: report.lifeStage.stage, designLifeYears: report.lifeStage.designLifeYears, remainingYears: report.lifeStage.remainingYears, basis: report.lifeStage.basis },
    windows: { windows11Ready: win.windows11Ready, runningWindows10: win.runningWindows10, note: win.supportNote, checks: win.checks.map(c => ({ name: c.name, ok: c.ok, value: c.value })) },
    costs,
    parts: partRows,
    condition: {
      drives: disks.map(d => ({ model: d.model ?? null, health: d.health ?? null, wearPercent: d.nvme?.percentageUsed ?? d.reliability?.wearPercent ?? null, powerOnHours: d.nvme?.powerOnHours ?? d.reliability?.powerOnHours ?? null })),
      battery: a.battery ? { wearPercent: a.battery.wearPercent ?? null, cycles: a.battery.cycleCount ?? null, designMWh: a.battery.designMWh ?? null, fullChargeMWh: a.battery.fullChargeMWh ?? null } : null,
      healthScore: o.health, openIssues: o.openIssues,
    },
    history: { summary: history.summary, facts: history.facts, timeline: history.timeline.slice(0, 40), limits: history.limits },
    // how the buyer ties this paper to the machine in front of them: the machine's own serial number, stored only as a salted hash
    binding: serial ? { serialCheck: serialKey(serial), note: 'Enter the serial number printed on the computer or shown in its BIOS; it must match.' } : { serialCheck: null, note: 'This computer does not report a usable serial number, so this certificate cannot be tied to one physical machine. Check the model, memory and drives yourself.' },
    checklist: checklist(a, report, rating),
    notice: 'Viro states what it measured on the date shown. It is not a warranty, and it cannot see damage that has no sensor (cracks, liquid, a loose hinge). Costs are estimates for planning, not quotes.',
  };
  // identifiers of any kind never leave the machine in clear: scrub the serial numbers the engine's facts may repeat
  const secrets = [serial, real(a.board?.serial), ...mods.map((m: Obj) => real(m.serial)), real(a.battery?.serial), ...(a.network ?? []).map((n: Obj) => real(n.mac))].filter((x): x is string => !!x);
  let text = JSON.stringify(stmt);
  for (const sec of secrets) text = text.split(sec).join('****');
  return JSON.parse(text) as typeof stmt;
}

/** What to do with the computer in your hands, so the certificate is used on the day rather than filed away. */
function checklist(a: Obj, report: ReturnType<typeof buildReport>, rating: Rating): string[] {
  const l = ['Enter the serial number on the certificate page: it must match the computer in front of you.', 'Turn it on and check the screen for dead pixels, bright spots and cracks, and every key, port and the webcam.'];
  if (a.battery) l.push('Unplug the charger and watch the battery percentage for a few minutes: it should not fall quickly or shut off.');
  l.push('Ask the seller to sign out of their accounts, remove work or school management, and reset Windows so you start clean.');
  if (report.windows.windows11Ready === false) l.push('This computer cannot run Windows 11. Ask what Windows it has and for how long it will still get security updates.');
  if (rating !== 'SOUND') l.push('Use the "work to expect" figures in this certificate when you negotiate the price.');
  l.push('Ask for the charger, and any receipts or warranty papers.');
  return l;
}

export const VALID = VALID_DAYS;
