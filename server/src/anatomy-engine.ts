import { diskCondition, diskReadingOf, batteryCondition, type Condition } from './condition.js';

/**
 * The anatomy report: everything a computer's owner needs to understand what they have. Every statement is built from something read from the machine, recorded by a person, or
 * entered in the price book, and carries its evidence. Where the machine could not tell us, the report says so instead of guessing. No part is declared "dying" without a measurement
 * or a documented rule behind it, and every rule's thresholds are listed here in one place.
 */

// ---- thresholds (the documented rules; change them here and in the tests, never inline) ----------------------------------------------------------------------------------
/** The date a panel's year/week stamp falls on (middle of that week); mid-year when the week is not given. */
function weekDate(year: number, week?: number | null) { const d = new Date(Date.UTC(year, 0, 1 + ((week && week > 0 ? week : 26) - 1) * 7 + 3)); return d.toISOString().slice(0, 10); }

export const RULES = {
  hddWatchYears: 3, hddWorryYears: 5,                     // mechanical drives: failure statistics published by large drive fleets rise steeply after about 3 to 5 years of running time
  batteryWatchPercent: 80, batteryReplacePercent: 60, batteryCycleWatch: 400, batteryCycleReplace: 800, batteryAgeWatchYears: 3, batteryAgeReplaceYears: 5,
  coolingServiceLaptopYears: 3, coolingServiceDesktopYears: 4, idleHotC: 75,
  biosWatchYears: 4, driverWatchYears: 2,
  ramMinimumGb: 4, ramComfortableGb: 8, ramBusyPercent: 85,
  displayWatchYears: 7,
  lifeYears: { laptop: 5, 'all-in-one': 6, desktop: 7, server: 8, unknown: 5 } as Record<string, number>,   // typical dependable service life before replacement is the better choice
  residualDecay: 0.30, residualFloor: 0.10,                // declining-balance depreciation, 30% a year, never below 10% of the starting value
  repairShareOfNew: 0.35,                                  // repair when the work costs no more than this share of a replacement
} as const;

type Obj = Record<string, any>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const yearsBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / (365.25 * 86_400_000);
const day = (s?: string | null) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s) : null);
const round1 = (x: number) => Math.round(x * 10) / 10;
const gb = (b: number | null | undefined) => (b == null ? null : round1(b / 2 ** 30));

export type Risk = 'LOW' | 'WATCH' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
const RISK_RANK: Record<Risk, number> = { UNKNOWN: -1, LOW: 0, WATCH: 1, HIGH: 2, CRITICAL: 3 };
const fromCondition = (c: Condition): Risk => ({ HEALTHY: 'LOW', WATCH: 'WATCH', DEGRADED: 'HIGH', REPLACEMENT_ADVISED: 'HIGH', CRITICAL: 'CRITICAL', NOT_MEASURED: 'UNKNOWN' } as const)[c];
const worst = (...r: Risk[]) => r.reduce((a, b) => (RISK_RANK[b] > RISK_RANK[a] ? b : a), 'UNKNOWN' as Risk);

// ---- processor identification --------------------------------------------------------------------------------------------------------------------------------------------
export interface CpuInfo { vendor: string | null; family: string | null; generation: number | null; firstSoldYear: number | null; windows11: boolean | null; note: string }
const INTEL_YEAR: Record<number, number> = { 2: 2011, 3: 2012, 4: 2013, 5: 2014, 6: 2015, 7: 2016, 8: 2017, 9: 2018, 10: 2019, 11: 2020, 12: 2021, 13: 2022, 14: 2023 };
const RYZEN_YEAR: Record<number, number> = { 1: 2017, 2: 2018, 3: 2019, 4: 2020, 5: 2021, 6: 2022, 7: 2022, 8: 2023, 9: 2024 };
export function cpuInfo(name: string | null | undefined): CpuInfo {
  const n = name ?? '';
  const intel = /Core\(TM\)\s+(i[3579])-(\d{4,5})/i.exec(n);
  if (intel) {
    const digits = intel[2]!; const gen = digits.length === 5 ? Number(digits.slice(0, 2)) : Number(digits[0]);
    const year = INTEL_YEAR[gen] ?? null;
    return { vendor: 'Intel', family: `Core ${intel[1]!.toLowerCase()}`, generation: gen, firstSoldYear: year, windows11: gen >= 8, note: `Intel Core generation ${gen} (first sold around ${year ?? 'an unknown year'}), read from the model number.` };
  }
  if (/Core\(TM\)\s+Ultra/i.test(n)) return { vendor: 'Intel', family: 'Core Ultra', generation: null, firstSoldYear: 2023, windows11: true, note: 'Intel Core Ultra (first sold in 2023).' };
  const ryzen = /Ryzen\s+(?:[3579]|Threadripper)\s+(?:PRO\s+)?(\d)(\d{3})/i.exec(n);
  if (ryzen) {
    const series = Number(ryzen[1]); const year = RYZEN_YEAR[series] ?? null;
    return { vendor: 'AMD', family: `Ryzen ${series}000 series`, generation: series, firstSoldYear: year, windows11: series >= 2, note: `AMD Ryzen ${series}000 series (first sold around ${year ?? 'an unknown year'}), read from the model number.` };
  }
  const vendor = /Intel/i.test(n) ? 'Intel' : /AMD/i.test(n) ? 'AMD' : null;
  return { vendor, family: null, generation: null, firstSoldYear: null, windows11: null, note: 'The processor model could not be matched to a known generation, so its age and Windows 11 support are not assumed. Check Microsoft\'s PC Health Check.' };
}

// ---- when was it made, when did it start being used -----------------------------------------------------------------------------------------------------------------------
export interface DatedEvidence { source: string; date: string; meaning: string; weight: 'strong' | 'medium' | 'weak' }
export function ageAnalysis(a: Obj, purchaseDate: string | null, now: Date) {
  const ev: DatedEvidence[] = [];
  const add = (source: string, date: string | null | undefined, meaning: string, weight: DatedEvidence['weight']) => { if (date && day(date)) ev.push({ source, date: date.slice(0, 10), meaning, weight }); };
  add('Purchase date', purchaseDate, 'Recorded by an administrator.', 'strong');
  const panel = (a.monitors ?? []).find((m: Obj) => m.builtIn && m.year);
  if (panel) add('Built-in screen made', weekDate(panel.year, panel.week), `The screen panel reports it was made in week ${panel.week ?? '?'} of ${panel.year}. Laptop panels are fitted within a few months of being made, so this dates the machine closely.`, 'strong');
  add('Battery made', a.battery?.manufactureDate, 'The battery reports its own manufacture date. It dates the battery; it dates the machine only if the battery was never replaced.', 'medium');
  const cpu = cpuInfo(a.cpu?.name);
  if (cpu.firstSoldYear) add('Processor first sold', `${cpu.firstSoldYear}-01-01`, 'The computer cannot be older than its processor: this is the earliest it could have been built.', 'medium');
  const ins = (a.evidence?.windowsInstalls ?? []).map((x: Obj) => x.date).filter(Boolean).sort();
  if (ins[0]) add('Earliest Windows install on record', ins[0], 'Windows keeps a record of every earlier install. A computer cannot have been used before its first install, though it may have been installed later than it was bought.', 'medium');
  add('Current Windows install', a.evidence?.currentWindowsInstall ?? a.os?.installedAt, 'When this copy of Windows was installed. A reinstall resets it, so it only shows the computer was in use by this date.', 'weak');
  const profiles = (a.evidence?.profiles ?? []).map((x: Obj) => x.createdAt).filter(Boolean).sort();
  if (profiles[0]) add('Oldest user account created', profiles[0], 'The oldest person account on this Windows.', 'weak');
  add('Device history starts', a.evidence?.setupApiLogStart, 'Windows\' device installation log begins on this date.', 'weak');
  const devs = (a.evidence?.deviceFirstInstalled ?? []).map((x: Obj) => x.firstInstalled).filter(Boolean).sort();
  if (devs[0]) add('First hardware installed on this Windows', devs[0], 'The first time Windows saw one of this computer\'s parts.', 'weak');
  add('BIOS released', a.bios?.releaseDate, 'The firmware version installed now was released on this date. Firmware can be updated, so it says nothing about when the computer was made.', 'weak');
  ev.sort((x, y) => x.date.localeCompare(y.date));

  const strong = ev.find(e => e.source === 'Purchase date') ?? ev.find(e => e.weight === 'strong');   // a recorded purchase beats the panel's make date (a panel is made before it is sold)
  const firstUse = ev.filter(e => e.weight !== 'weak' || e.source !== 'BIOS released').filter(e => e.source !== 'Processor first sold' && e.source !== 'BIOS released').map(e => e.date).sort()[0] ?? null;
  const cpuLower = cpu.firstSoldYear ? `${cpu.firstSoldYear}-01-01` : null;
  // Best estimate: a strong date if there is one, otherwise the earliest evidence that the machine was in use; the range is bounded by the processor (cannot be older) and that date (cannot be newer).
  const bestDate = strong?.date ?? firstUse;
  const age = bestDate ? round1(yearsBetween(new Date(bestDate), now)) : null;
  const ageMax = cpuLower ? round1(yearsBetween(new Date(cpuLower), now)) : null;
  const confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN' = strong ? 'HIGH' : bestDate && ev.filter(e => e.weight === 'medium').length >= 2 ? 'MEDIUM' : bestDate ? 'LOW' : 'UNKNOWN';
  return { evidence: ev, inServiceSince: bestDate, ageYears: age, ageUpperBoundYears: ageMax, confidence, cpu,
    note: !bestDate ? 'Not enough dated evidence on this computer to estimate its age. Enter the purchase date to fix this.' : `Estimated from ${strong ? (strong.source === 'Purchase date' ? 'the recorded purchase date' : 'the date its built-in screen was made') : 'the earliest evidence that the computer was in use'}${ageMax != null && age != null && ageMax > age + 0.5 ? `; it cannot be older than ${ageMax} years because of its processor` : ''}.` };
}

// ---- parts ----------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface UpgradeOption { title: string; spec: string; why: string; costKey?: string; qty?: number; labourHours?: number }
export interface Part {
  id: string; kind: string; label: string; facts: { label: string; value: string }[];
  risk: Risk; riskReasons: string[]; lifespan: string; action: string | null; upgrades: UpgradeOption[]; firstSeen?: string | null; ageYears?: number | null;
}
const fact = (label: string, value: unknown): { label: string; value: string } | null => (value == null || value === '' ? null : { label, value: String(value) });
const facts = (...f: ({ label: string; value: string } | null)[]) => f.filter((x): x is { label: string; value: string } => !!x);

export interface Context { purchaseDate: string | null; purchaseCost: number | null; ramPeakPercent: number | null; cpuAvgPercent: number | null; now: Date; history: { at: Date; healthPercent: number | null }[]; coolingEvidence: { throttleEvents: number; maxIdleTempC: number | null } }

export function buildParts(a: Obj, ctx: Context, age: ReturnType<typeof ageAnalysis>): Part[] {
  const parts: Part[] = []; const now = ctx.now; const form = a.system?.formFactor ?? 'unknown';
  const machineAge = age.ageYears;

  // Processor
  const cpu = age.cpu; const c = a.cpu ?? {};
  const cpuRisk: string[] = []; if (ctx.coolingEvidence.throttleEvents > 0) cpuRisk.push(`${ctx.coolingEvidence.throttleEvents} times in the last 7 days Windows slowed the processor to protect it from heat`);
  parts.push({ id: 'cpu', kind: 'Processor', label: c.name ?? 'Processor', firstSeen: null, ageYears: cpu.firstSoldYear ? round1(now.getFullYear() - cpu.firstSoldYear) : null,
    facts: facts(fact('Cores / threads', c.cores ? `${c.cores} / ${c.logical}` : null), fact('Maximum speed', c.maxMhz ? `${(c.maxMhz / 1000).toFixed(2)} GHz` : null), fact('Socket', c.socket), fact('Cache', c.l3Kb ? `${Math.round(c.l3Kb / 1024)} MB L3` : null), fact('Generation', cpu.note), fact('Windows 11 support', cpu.windows11 == null ? 'Not determined' : cpu.windows11 ? 'Supported' : 'Not supported by Microsoft')),
    risk: cpuRisk.length ? 'WATCH' : 'LOW', riskReasons: cpuRisk.length ? cpuRisk : ['Processors rarely fail on their own; the usual cause of trouble is heat from dust or dried thermal paste.'],
    lifespan: 'A processor outlasts the computer around it. It becomes the limit through age (software demands, Windows support) rather than wear.',
    action: cpu.windows11 === false ? 'This processor is not supported by Windows 11. It cannot be upgraded in a laptop; on a desktop only a newer motherboard and processor together would change that.' : null,
    upgrades: form === 'desktop' && c.socket ? [{ title: `Processor upgrade (socket ${c.socket})`, spec: `Only processors that fit socket ${c.socket} and that the motherboard's BIOS and chipset list as supported. Check the motherboard maker's supported-processor list before buying.`, why: 'Possible on desktops; limited to the same socket.' }] : [] });

  // Motherboard, firmware, security chip
  const b = a.bios ?? {}, bd = day(b.releaseDate); const biosAge = bd ? yearsBetween(bd, now) : null; const boardReasons: string[] = [];
  let boardRisk: Risk = 'LOW';
  if (b.tpm && b.tpm.present === false) { boardRisk = worst(boardRisk, 'WATCH'); boardReasons.push('No security chip (TPM) was found. Windows 11 requires TPM 2.0.'); }
  else if (b.tpm?.version && !String(b.tpm.version).startsWith('2')) { boardRisk = worst(boardRisk, 'WATCH'); boardReasons.push(`The security chip is version ${b.tpm.version}; Windows 11 requires 2.0.`); }
  if (b.secureBoot === false) boardReasons.push('Secure Boot is off or unavailable.');
  if (biosAge != null && biosAge >= RULES.biosWatchYears) { boardRisk = worst(boardRisk, 'WATCH'); boardReasons.push(`The firmware (BIOS) is dated ${bd!.toISOString().slice(0, 7)}, ${round1(biosAge)} years old. Check the manufacturer's support page for security updates.`); }
  parts.push({ id: 'board', kind: 'Motherboard and firmware', label: [a.board?.manufacturer, a.board?.product].filter(Boolean).join(' ') || 'Motherboard', firstSeen: null, ageYears: machineAge,
    facts: facts(fact('Board', [a.board?.manufacturer, a.board?.product].filter(Boolean).join(' ')), fact('Board serial', a.board?.serial), fact('System', [a.system?.manufacturer, a.system?.model].filter(Boolean).join(' ')), fact('Product number (SKU)', a.system?.sku), fact('Serial number', a.system?.serial), fact('BIOS', [b.vendor, b.version].filter(Boolean).join(' ')), fact('BIOS date', b.releaseDate), fact('Firmware mode', b.mode), fact('Secure Boot', b.secureBoot == null ? 'Unknown' : b.secureBoot ? 'On' : 'Off'), fact('Security chip (TPM)', b.tpm == null ? 'Unknown (readable only with administrator rights)' : b.tpm.present ? `Version ${b.tpm.version ?? '?'}${b.tpm.enabled === false ? ', turned off' : ''} (${b.tpm.manufacturer ?? 'unknown maker'})` : 'Not found')),
    risk: boardRisk, riskReasons: boardReasons.length ? boardReasons : ['Nothing measured points at a problem. A motherboard fault shows up as crashes, failed starts or hardware errors, none of which were found.'],
    lifespan: 'The motherboard is the part that decides how long the computer is worth keeping: it fixes the processor, the memory type and what Windows will run. Boards typically last as long as the computer; capacitors and power circuits are the usual age failures.',
    action: boardRisk !== 'LOW' ? 'Update the BIOS if the maker offers one; turn on the security chip and Secure Boot in firmware settings if they are off.' : null, upgrades: [] });

  // Memory
  const m = a.memory ?? {}; const mods: Obj[] = m.modules ?? []; const totalBytes = mods.reduce((s, x) => s + (x.capacityBytes ?? 0), 0);
  const totalGb = gb(totalBytes) ?? 0; const memReasons: string[] = []; let memRisk: Risk = 'LOW';
  const wheaMem = num(a.diagnostics?.whea?.events30d) ?? 0; const memTestFail = (a.diagnostics?.memory?.diagnosticResults ?? []).find((r: Obj) => r.passed === false);
  if (memTestFail) { memRisk = 'CRITICAL'; memReasons.push(`Windows' memory test reported errors on ${String(memTestFail.at).slice(0, 10)}.`); }
  if (wheaMem > 0) { memRisk = worst(memRisk, 'WATCH'); memReasons.push(`${wheaMem} hardware error(s) were logged by Windows in 30 days (these can come from memory, the processor or the board).`); }
  const busy = ctx.ramPeakPercent != null && ctx.ramPeakPercent >= RULES.ramBusyPercent;
  if (totalGb < RULES.ramComfortableGb) memReasons.push(`${totalGb} GB is below the ${RULES.ramComfortableGb} GB that current Windows and browsers need to run comfortably.`);
  if (busy) { memRisk = worst(memRisk, 'WATCH'); memReasons.push(`Memory use reached ${Math.round(ctx.ramPeakPercent!)}% on this computer, so programs are competing for space.`); }
  const type = mods[0]?.type ?? null, formF = mods[0]?.formFactor ?? null, speed = Math.max(0, ...mods.map(x => x.configuredMhz ?? x.speedMhz ?? 0)) || null;
  const free = Math.max(0, (m.slotsTotal ?? 0) - (m.slotsUsed ?? mods.length)); const soldered = /^LP/i.test(String(type ?? '')) || (m.slotsTotal != null && free === 0 && mods.some((x: Obj) => /soldered|onboard/i.test(`${x.slot} ${x.bank}`)));
  const maxGb = gb(m.maxCapacityBytes); const upgrades: UpgradeOption[] = [];
  const wantGb = totalGb < 8 ? 8 : totalGb < 16 && (busy || totalGb < 8) ? 16 : null;
  if (wantGb && type) {
    const add = wantGb - totalGb;
    if (soldered) upgrades.push({ title: 'Memory cannot be upgraded', spec: `${type} memory is built into this machine.`, why: 'Soldered memory cannot be added to or replaced. The only fix is a different computer.' });
    else if (free > 0 && add > 0) upgrades.push({ title: `Add ${add} GB of memory`, spec: `${type} ${formF ?? 'module'}${speed ? `, ${speed} MT/s` : ''}${mods[0]?.voltageMv ? `, ${(mods[0].voltageMv / 1000).toFixed(1)} V` : ''}, matching the ${mods.length} module${mods.length === 1 ? '' : 's'} already fitted${mods[0]?.manufacturer ? ` (${mods[0].manufacturer} ${mods[0].partNumber ?? ''})`.trimEnd() : ''}. ${free} free slot${free === 1 ? '' : 's'}${maxGb ? `; the BIOS reports a ${maxGb} GB limit` : ''}.`, why: `Brings the computer to ${wantGb} GB.`, costKey: `ram_${String(type).toLowerCase()}`, qty: Math.ceil(add / 8), labourHours: 0.5 });
    else if (free === 0) upgrades.push({ title: `Replace the memory with ${wantGb} GB`, spec: `${type} ${formF ?? 'module'}${speed ? ` at ${speed} MT/s or faster` : ''}; every slot is in use, so the existing modules are replaced${maxGb ? ` (BIOS-reported limit ${maxGb} GB)` : ''}.`, why: `Memory slots are full at ${totalGb} GB.`, costKey: `ram_${String(type).toLowerCase()}`, qty: Math.ceil(wantGb / 8), labourHours: 0.5 });
  }
  parts.push({ id: 'memory', kind: 'Memory (RAM)', label: mods.length ? `${totalGb} GB ${type ?? ''} ${formF ?? ''}`.replace(/\s+/g, ' ').trim() : 'Memory', firstSeen: null, ageYears: machineAge,
    facts: facts(fact('Total', `${totalGb} GB`), fact('Slots', m.slotsTotal != null ? `${m.slotsUsed ?? mods.length} of ${m.slotsTotal} used` : null), fact('Largest total the BIOS reports', maxGb ? `${maxGb} GB` : null), fact('Error correction', m.ecc ? 'ECC' : 'None'), ...mods.map((x, i) => fact(`Module ${i + 1}${x.slot ? ` (${x.slot})` : ''}`, [x.capacityBytes ? `${gb(x.capacityBytes)} GB` : null, x.type, x.formFactor, x.configuredMhz || x.speedMhz ? `${x.configuredMhz ?? x.speedMhz} MT/s` : null, x.manufacturer, x.partNumber, x.serial ? `serial ${x.serial}` : null].filter(Boolean).join(', ')))),
    risk: memRisk === 'LOW' && totalGb < RULES.ramComfortableGb ? 'WATCH' : memRisk, riskReasons: memReasons.length ? memReasons : ['No memory errors were recorded and the amount is adequate for the way this computer is used.'],
    lifespan: 'Memory has no wearing parts: modules rarely fail with age. They stop being enough, not stop working. When they do fail it shows as random crashes and blue screens, and Windows\' memory test confirms it.',
    action: memReasons.length && upgrades[0] && !/cannot/i.test(upgrades[0].title) ? upgrades[0].title : null, upgrades });

  // Storage
  const disks: Obj[] = a.diagnostics?.storage?.disks ?? []; const smart: Obj[] = a.diagnostics?.storage?.ataSmart ?? [];
  disks.forEach((d, i) => {
    const reading = diskReadingOf(d); const cond = diskCondition(reading, []);
    const hours = reading.powerOnHours; const years = hours != null ? round1(hours / 8766) : null; const reasons = [...cond.evidence]; let risk = fromCondition(cond.condition);
    const isHdd = d.mediaType === 'HDD';
    if (isHdd && years != null) {
      if (years >= RULES.hddWorryYears) { risk = worst(risk, 'HIGH'); reasons.push(`It has been running for ${years} years (${Math.round(hours!).toLocaleString('en-US')} hours). Mechanical drives fail much more often after about ${RULES.hddWorryYears} years of running.`); }
      else if (years >= RULES.hddWatchYears) { risk = worst(risk, 'WATCH'); reasons.push(`It has been running for ${years} years. Failure rates of mechanical drives start to climb after about ${RULES.hddWatchYears} years.`); }
    }
    const sizeGb = d.sizeBytes ? Math.round(d.sizeBytes / 1e9) : null; const up: UpgradeOption[] = [];
    if (isHdd) up.push({ title: 'Replace the hard disk with an SSD', spec: `${d.busType === 'NVMe' ? 'NVMe' : '2.5-inch SATA'} solid-state drive of at least ${sizeGb && sizeGb > 600 ? 512 : 256} GB. ${sizeGb ? `The current disk is ${sizeGb} GB.` : ''} Clone the existing disk, then fit the SSD.`, why: 'An SSD makes an older computer feel new, uses less power and has no moving parts to fail.', costKey: 'ssd_256gb', qty: 1, labourHours: 1.5 });
    else if (cond.condition === 'REPLACEMENT_ADVISED' || cond.condition === 'CRITICAL' || cond.condition === 'DEGRADED') up.push({ title: 'Replace the drive', spec: `${d.busType ?? 'same-interface'} SSD with at least the same capacity (${sizeGb ?? '?'} GB). Back up first.`, why: cond.action, costKey: 'ssd_256gb', qty: 1, labourHours: 1.5 });
    parts.push({ id: `disk-${i}`, kind: d.mediaType === 'HDD' ? 'Hard disk' : d.busType === 'NVMe' ? 'NVMe SSD' : 'Solid-state drive', label: `${d.model ?? 'Disk'}${sizeGb ? ` ${sizeGb} GB` : ''}`, firstSeen: (a.evidence?.deviceFirstInstalled ?? []).find((x: Obj) => x.cls === 'DiskDrive' && String(x.name ?? '').includes(String(d.model ?? '').slice(0, 8)))?.firstInstalled ?? null, ageYears: years,
      facts: facts(fact('Model', d.model), fact('Type', `${d.mediaType ?? 'Unknown'} on ${d.busType ?? 'unknown interface'}`), fact('Capacity', sizeGb ? `${sizeGb} GB` : null), fact('Windows health status', d.health), fact('Time powered on', hours != null ? `${Math.round(hours).toLocaleString('en-US')} hours (${years} years)` : null), fact('Temperature', reading.temperatureC != null ? `${reading.temperatureC} °C` : null), fact('Wear used', reading.wearPercent != null ? `${reading.wearPercent}%` : null), fact('Uncorrected read/write errors', reading.uncorrectedErrors), fact('Spare capacity left', reading.spareLeftPercent != null ? `${reading.spareLeftPercent}%` : null), fact('Failure warning from the drive (SMART)', smart.find(s => s.predictFailure === true) ? 'The drive is predicting its own failure' : smart.length ? 'None' : null)),
      risk, riskReasons: reasons.length ? reasons : ['The drive reports itself healthy and no errors were found.'],
      lifespan: isHdd ? 'Mechanical hard disks wear out through use: expect a dependable life of roughly 3 to 5 years of running time, sometimes more. They fail without much warning, so backups matter.' : 'Solid-state drives wear by the amount of data written: they last until their wear reaches 100%, usually many years for office use. They can still fail suddenly from a controller fault.',
      action: risk === 'CRITICAL' || risk === 'HIGH' ? cond.action : null, upgrades: up });
  });

  // Graphics, screens
  for (const [i, g] of (a.gpus ?? []).entries() as IterableIterator<[number, Obj]>) {
    const dd = day(g.driverDate); const dAge = dd ? round1(yearsBetween(dd, now)) : null; const reasons: string[] = []; let risk: Risk = 'LOW';
    if (dAge != null && dAge >= RULES.driverWatchYears) { risk = 'WATCH'; reasons.push(`The graphics driver is ${dAge} years old (${g.driverDate}). Newer drivers fix crashes, screen glitches and security problems.`); }
    parts.push({ id: `gpu-${i}`, kind: 'Graphics', label: g.name ?? 'Graphics', ageYears: null, facts: facts(fact('Maker', g.vendor), fact('Driver', `${g.driverVersion ?? '?'} (${g.driverDate ?? 'date unknown'})`), fact('Video memory', g.vramBytes && g.vramBytes > 0 ? `${gb(g.vramBytes)} GB` : 'Shared with system memory'), fact('Current picture', g.width ? `${g.width}×${g.height} at ${g.hz} Hz` : null)),
      risk, riskReasons: reasons.length ? reasons : ['Nothing points at a graphics problem.'], lifespan: 'Graphics chips rarely wear out; dedicated cards fail from heat and fan wear. In a laptop the graphics are part of the board and cannot be replaced separately.', action: reasons.length ? 'Update the graphics driver from the manufacturer or Windows Update.' : null, upgrades: [] });
  }
  for (const [i, mo] of (a.monitors ?? []).entries() as IterableIterator<[number, Obj]>) {
    const made = mo.year ? new Date(weekDate(mo.year, mo.week)) : null; const mAge = made ? round1(yearsBetween(made, now)) : null; const reasons: string[] = []; let risk: Risk = 'LOW';
    if (mAge != null && mAge >= RULES.displayWatchYears) { risk = 'WATCH'; reasons.push(`This screen was made ${mAge} years ago. Backlights dim and colours shift with age.`); }
    parts.push({ id: `display-${i}`, kind: mo.builtIn ? 'Built-in screen' : 'Monitor', label: mo.name ?? `${mo.manufacturerCode} ${mo.productCode}`.trim(), ageYears: mAge, firstSeen: made ? made.toISOString().slice(0, 10) : null,
      facts: facts(fact('Maker code', mo.manufacturerCode), fact('Model code', mo.productCode), fact('Size', mo.sizeInches ? `${mo.sizeInches} inches` : null), fact('Made', mo.year ? `week ${mo.week ?? '?'} of ${mo.year}` : null), fact('Serial number', mo.serial)),
      risk, riskReasons: reasons.length ? reasons : ['No problem is measurable from the computer. A screen\'s brightness and colour wear cannot be read by software.'], lifespan: 'LCD backlights typically last 30,000 to 60,000 hours (about 5 to 10 years of daily use) before the picture dims. Screens fail from the backlight or the cable more than the panel itself.', action: null, upgrades: [] });
  }

  // Battery
  if (a.battery) {
    const bat = a.battery; const bc = batteryCondition({ designCapacityMWh: bat.designMWh, fullChargeCapacityMWh: bat.fullChargeMWh, cycleCount: bat.cycleCount }, ctx.history);
    const reasons = [...(bc?.evidence ?? [])]; let risk: Risk = bc ? fromCondition(bc.condition) : 'UNKNOWN'; const bAge = bat.manufactureDate ? round1(yearsBetween(new Date(bat.manufactureDate), now)) : null;
    if (bAge != null && bAge >= RULES.batteryAgeReplaceYears) { risk = worst(risk, 'HIGH'); reasons.push(`The battery was made ${bAge} years ago; lithium batteries lose capacity with age even when unused.`); } else if (bAge != null && bAge >= RULES.batteryAgeWatchYears) risk = worst(risk, 'WATCH');
    if (bat.cycleCount != null && bat.cycleCount >= RULES.batteryCycleReplace) { risk = worst(risk, 'HIGH'); reasons.push(`${bat.cycleCount} charge cycles; most laptop batteries are rated for about 300 to 800.`); } else if (bat.cycleCount != null && bat.cycleCount >= RULES.batteryCycleWatch) risk = worst(risk, 'WATCH');
    const wear = bat.wearPercent; if (wear != null && wear >= 100 - RULES.batteryReplacePercent) risk = worst(risk, 'HIGH'); else if (wear != null && wear >= 100 - RULES.batteryWatchPercent) risk = worst(risk, 'WATCH');
    parts.push({ id: 'battery', kind: 'Battery', label: bat.name ?? 'Battery', ageYears: bAge, firstSeen: bat.manufactureDate ?? null,
      facts: facts(fact('Maker', bat.manufacturer), fact('Model', bat.name), fact('Serial number', bat.serial), fact('Chemistry', bat.chemistry), fact('Made', bat.manufactureDate), fact('Designed capacity', bat.designMWh ? `${Math.round(bat.designMWh / 1000 * 10) / 10} Wh` : null), fact('Capacity today', bat.fullChargeMWh ? `${Math.round(bat.fullChargeMWh / 1000 * 10) / 10} Wh${wear != null ? ` (${round1(100 - wear)}% of new)` : ''}` : null), fact('Charge cycles', bat.cycleCount)),
      risk, riskReasons: reasons.length ? reasons : ['Capacity is close to new.'], lifespan: 'Laptop batteries typically keep useful capacity for 2 to 4 years or 300 to 800 charge cycles. Below 60% of new capacity they are worth replacing.',
      action: risk === 'HIGH' || risk === 'CRITICAL' ? 'Replace the battery with the maker\'s part for this model.' : null,
      upgrades: risk === 'HIGH' || risk === 'CRITICAL' ? [{ title: 'Replace the battery', spec: `Original-equipment battery for ${[a.system?.manufacturer, a.system?.model].filter(Boolean).join(' ') || 'this model'}${bat.name ? ` (battery ${bat.name})` : ''}, ${bat.designMWh ? Math.round(bat.designMWh / 1000) + ' Wh' : 'same capacity'}.`, why: 'Restores a full day of use.', costKey: 'battery_laptop', qty: 1, labourHours: 0.5 }] : [] });
  }

  // Cooling (measured through its effects: age, temperature, throttling)
  const coolYears = form === 'laptop' || form === 'all-in-one' ? RULES.coolingServiceLaptopYears : RULES.coolingServiceDesktopYears; const coolReasons: string[] = []; let coolRisk: Risk = 'LOW';
  if (machineAge != null && machineAge >= coolYears) { coolRisk = 'WATCH'; coolReasons.push(`The computer is about ${machineAge} years old. After ${coolYears} years or so the fans are clogged with dust and the thermal paste has dried out.`); }
  if (ctx.coolingEvidence.maxIdleTempC != null && ctx.coolingEvidence.maxIdleTempC >= RULES.idleHotC) { coolRisk = worst(coolRisk, 'HIGH'); coolReasons.push(`Temperatures of ${ctx.coolingEvidence.maxIdleTempC} °C were measured while the computer was not busy.`); }
  if (ctx.coolingEvidence.throttleEvents > 0) { coolRisk = worst(coolRisk, 'HIGH'); coolReasons.push(`Windows slowed the processor ${ctx.coolingEvidence.throttleEvents} times in 7 days to keep it from overheating.`); }
  parts.push({ id: 'cooling', kind: 'Cooling (fans, vents, thermal paste)', label: 'Cooling system', ageYears: machineAge, facts: facts(fact('Hottest idle temperature seen', ctx.coolingEvidence.maxIdleTempC != null ? `${ctx.coolingEvidence.maxIdleTempC} °C` : 'No reading'), fact('Heat slow-downs in 7 days', ctx.coolingEvidence.throttleEvents)),
    risk: coolRisk, riskReasons: coolReasons.length ? coolReasons : ['Temperatures are normal and the computer has not been slowed by heat. Fan and paste wear cannot be measured directly; this part is judged from age and temperature.'], lifespan: 'Fans and thermal paste are the most neglected parts. Dust and dried paste slowly raise temperatures, which shortens the life of everything else. A service every 2 to 3 years is normal.',
    action: coolRisk === 'WATCH' || coolRisk === 'HIGH' ? 'Open the computer, clean the fans and vents, and replace the thermal paste.' : null,
    upgrades: coolRisk === 'WATCH' || coolRisk === 'HIGH' ? [{ title: 'Cooling service', spec: 'Clean fans and vents, replace thermal paste on the processor, check the fan spins up. Workshop job; no part needed unless a fan is noisy or stuck.', why: 'Lowers temperatures, cuts fan noise and protects the other parts.', costKey: 'thermal_service', qty: 1, labourHours: 1.5 }] : [] });

  // Network
  for (const [i, n] of (a.network ?? []).entries() as IterableIterator<[number, Obj]>) {
    const wifiGen = n.wireless ? (/\bAX\d|Wi-Fi 6|802\.11ax/i.test(n.name) ? 6 : /\bAC\b|Wireless-AC|802\.11ac|Wi-Fi 5/i.test(n.name) ? 5 : /Wireless-N|802\.11n|\bN\s?\d{4}/i.test(n.name) ? 4 : null) : null;
    parts.push({ id: `net-${i}`, kind: n.wireless ? 'Wi-Fi adapter' : 'Network adapter', label: n.name ?? 'Network adapter', ageYears: null, facts: facts(fact('Hardware address (MAC)', n.mac), fact('Speed', n.speedMbps ? `${n.speedMbps} Mb/s` : null), fact('Wi-Fi generation', wifiGen ? `Wi-Fi ${wifiGen}` : null), fact('Maker', n.manufacturer)),
      risk: wifiGen === 4 ? 'WATCH' : 'LOW', riskReasons: wifiGen === 4 ? ['This is an older Wi-Fi 4 card: slower and weaker security options than current cards.'] : ['No problem found.'], lifespan: 'Network adapters rarely wear out; wireless cards become obsolete before they fail.', action: wifiGen === 4 ? 'Replace the Wi-Fi card with a Wi-Fi 6 card if the laptop allows it.' : null, upgrades: [] });
  }
  return parts;
}

// ---- Windows support -----------------------------------------------------------------------------------------------------------------------------------------------------
export function windowsReadiness(a: Obj) {
  const cpu = cpuInfo(a.cpu?.name); const ram = (a.memory?.modules ?? []).reduce((s: number, x: Obj) => s + (x.capacityBytes ?? 0), 0) || a.system?.totalPhysicalMemoryBytes || 0;
  const sysDisk = (a.diagnostics?.storage?.disks ?? [])[0]; const tpm = a.bios?.tpm;
  const checks = [
    { name: 'Processor (Windows 11 supported list)', ok: cpu.windows11, value: cpu.note },
    { name: 'Security chip TPM 2.0', ok: tpm == null ? null : tpm.present ? String(tpm.version ?? '').startsWith('2') && tpm.enabled !== false : false, value: tpm?.present ? `Version ${tpm.version ?? '?'}${tpm.enabled === false ? ', turned off' : ''}` : 'Not found' },
    { name: 'Secure Boot capable (UEFI firmware)', ok: a.bios?.mode == null ? null : a.bios.mode === 'UEFI', value: a.bios?.mode ?? 'Unknown' },
    { name: 'At least 4 GB of memory', ok: ram ? ram >= 4 * 2 ** 30 : null, value: ram ? `${gb(ram)} GB` : 'Unknown' },
    { name: 'At least 64 GB of storage', ok: sysDisk?.sizeBytes ? sysDisk.sizeBytes >= 64e9 : null, value: sysDisk?.sizeBytes ? `${Math.round(sysDisk.sizeBytes / 1e9)} GB` : 'Unknown' },
    { name: '64-bit processor', ok: a.cpu?.architecture ? a.cpu.architecture !== 'x86' : null, value: a.cpu?.architecture ?? 'Unknown' },
  ];
  const build = Number(a.os?.build ?? 0); const onWin10 = build > 0 && build < 22000;
  const ready = checks.every(c => c.ok === true) ? true : checks.some(c => c.ok === false) ? false : null;
  return { checks, windows11Ready: ready, runningWindows10: onWin10, supportNote: onWin10 ? 'Windows 10 stopped receiving regular security updates on 14 October 2025. This computer runs Windows 10, so it only receives updates if it was enrolled in Microsoft\'s paid Extended Security Updates, which Viro cannot see.' : null };
}

// ---- life stage, repair or replace ---------------------------------------------------------------------------------------------------------------------------------------------------
export interface PriceBook { currency: string; source: 'entered' | 'reference'; labourPerHour: number; items: Record<string, number>; newPc: Record<string, number> }
export const REFERENCE_PRICE_BOOK: PriceBook = {
  currency: 'USD', source: 'reference', labourPerHour: 30,
  items: { ram_ddr3: 20, ram_ddr4: 25, ram_ddr5: 35, ram_lpddr4: 0, ssd_256gb: 40, ssd_512gb: 55, ssd_1tb: 80, ssd_2tb: 150, battery_laptop: 60, thermal_service: 15, os_reinstall: 10 },
  newPc: { laptop: 700, desktop: 600, 'all-in-one': 900, server: 2500, unknown: 700 },
};

export function lifeStage(ageYears: number | null, form: string) {
  const design = RULES.lifeYears[form] ?? RULES.lifeYears.unknown!;
  if (ageYears == null) return { stage: 'Unknown', designLifeYears: design, remainingYears: null as null | [number, number], basis: 'The age of this computer could not be established, so its remaining life is not estimated.' };
  const stage = ageYears < 1 ? 'New' : ageYears < design * 0.5 ? 'Prime' : ageYears < design * 0.8 ? 'Mature' : ageYears < design * 1.1 ? 'Ageing' : 'Past its typical life';
  const rem = Math.max(0, design - ageYears);
  return { stage, designLifeYears: design, remainingYears: [round1(Math.max(0, rem - 1)), round1(rem + 1)] as [number, number], basis: `A ${form === 'unknown' ? 'computer' : form} typically gives about ${design} years of dependable service; this one is ${ageYears} years old.` };
}

export interface CostLine { part: string; title: string; parts: number; labour: number; total: number; priced: boolean }
export function costAnalysis(parts: Part[], form: string, ageYears: number | null, purchaseCost: number | null, win: ReturnType<typeof windowsReadiness>, book: PriceBook | null) {
  if (!book) return { priced: false as const, reasoning: ['No price book is set for this organization. Set prices once (or load the reference prices) and every computer\'s repair, replacement and value figures appear.'] };
  const price = (k: string | undefined) => (k && book.items[k] != null ? book.items[k]! : null);
  const lines: CostLine[] = [];
  for (const p of parts) for (const u of p.upgrades) {
    if (!u.costKey || /cannot be upgraded/i.test(u.title)) continue;
    const unit = price(u.costKey); const labour = (u.labourHours ?? 0) * book.labourPerHour;
    lines.push({ part: p.kind, title: u.title, parts: unit != null ? unit * (u.qty ?? 1) : 0, labour, total: (unit != null ? unit * (u.qty ?? 1) : 0) + labour, priced: unit != null });
  }
  // Only the recommended work counts: parts judged WATCH or worse, or a cheap upgrade the report itself recommends.
  const wanted = lines.filter(l => parts.some(p => p.kind === l.part && p.upgrades.some(u => u.title === l.title) && (p.risk !== 'LOW' || /memory/i.test(p.kind))));
  const repairTotal = Math.round(wanted.reduce((s, l) => s + l.total, 0) * 100) / 100;
  const replacement = book.newPc[form] ?? book.newPc.unknown ?? null; const migration = 2 * book.labourPerHour;
  const base = purchaseCost ?? (replacement != null ? replacement * 0.9 : null);
  const residual = base != null && ageYears != null ? Math.round(Math.max(RULES.residualFloor, Math.pow(1 - RULES.residualDecay, ageYears)) * base) : null;
  const stage = lifeStage(ageYears, form); const reasoning: string[] = [];
  const criticalParts = parts.filter(p => p.risk === 'CRITICAL' || (p.risk === 'HIGH' && /disk|battery|solid|nvme/i.test(p.kind)));
  const share = replacement ? repairTotal / replacement : null;
  let decision: 'KEEP' | 'REPAIR' | 'REPLACE' | 'UNDECIDED' = 'UNDECIDED';
  if (replacement == null) reasoning.push('No replacement price is set for this type of computer.');
  else {
    reasoning.push(`Repairs recommended: ${wanted.length ? wanted.map(l => `${l.title} (${book.currency} ${l.total})`).join('; ') : 'none'}. Total ${book.currency} ${repairTotal}.`);
    reasoning.push(`A comparable new ${form === 'unknown' ? 'computer' : form} costs ${book.currency} ${replacement} (plus about ${book.currency} ${migration} to move files and programs).`);
    if (residual != null) reasoning.push(`This computer is worth about ${book.currency} ${residual} today (${purchaseCost != null ? 'from its recorded purchase cost' : 'estimated from the price of a new one'}, losing ${Math.round(RULES.residualDecay * 100)}% a year, never below ${Math.round(RULES.residualFloor * 100)}%).`);
    const endOfLine = win.windows11Ready === false && win.runningWindows10;
    if (endOfLine) reasoning.push('It cannot run Windows 11 and Windows 10 no longer receives regular security updates: it can be used offline or in a limited role, but is not safe for normal use on a network.');
    const pastLife = stage.stage === 'Past its typical life';
    if (endOfLine || (pastLife && (criticalParts.length > 0 || (share ?? 0) > RULES.repairShareOfNew))) decision = 'REPLACE';
    else if (repairTotal === 0 && criticalParts.length === 0) decision = 'KEEP';
    else if ((share ?? 1) <= RULES.repairShareOfNew && (stage.remainingYears == null || stage.remainingYears[1] >= 1.5)) decision = 'REPAIR';
    else if (criticalParts.length > 0 && (share ?? 1) > RULES.repairShareOfNew) decision = 'REPLACE';
    else decision = repairTotal > 0 ? 'REPAIR' : 'KEEP';
    if (pastLife && decision === 'REPAIR') reasoning.push(`The computer is past its typical life at ${ageYears} years: the repairs are small enough to be worth doing now, but a replacement of about ${book.currency} ${replacement} should be budgeted for within about ${stage.remainingYears?.[1] ?? 1} year(s).`);
    if (share != null && repairTotal > 0) reasoning.push(`The repairs cost ${Math.round(share * 100)}% of a new computer; the rule is to repair when that is ${Math.round(RULES.repairShareOfNew * 100)}% or less${pastLife ? '' : ' and the machine has at least a year and a half left'}.`);
  }
  const unpriced = lines.filter(l => !l.priced).map(l => l.title);
  if (unpriced.length) reasoning.push(`No price is set for: ${unpriced.join(', ')}. Those are not in the total.`);
  return { priced: true as const, currency: book.currency, priceSource: book.source, lines: wanted, repairTotal, replacementCost: replacement, migrationCost: migration, residualValue: residual, decision, reasoning, lifeStage: stage };
}

// ---- the whole report ----------------------------------------------------------------------------------------------------------------------------------------------------------
export function buildReport(a: Obj, ctx: Context, book: PriceBook | null) {
  const age = ageAnalysis(a, ctx.purchaseDate, ctx.now); const parts = buildParts(a, ctx, age); const win = windowsReadiness(a);
  const form = a.system?.formFactor ?? 'unknown'; const stage = lifeStage(age.ageYears, form);
  const cost = costAnalysis(parts, form, age.ageYears, ctx.purchaseCost, win, book);
  const top = parts.filter(p => RISK_RANK[p.risk] >= RISK_RANK.WATCH).sort((x, y) => RISK_RANK[y.risk] - RISK_RANK[x.risk]);
  const gaps = (a.unavailable ?? []).map((u: Obj) => `${u.component}: ${u.reason}`);
  if (!a.battery && form === 'laptop') gaps.push('Battery: a laptop battery was not found or could not be read.');
  return {
    generatedAt: ctx.now.toISOString(), collectedAt: a.collectedAt,
    identity: { manufacturer: a.system?.manufacturer ?? null, model: a.system?.model ?? null, family: a.system?.family ?? null, serial: a.system?.serial ?? null, uuid: a.system?.uuid ?? null, formFactor: form, chassis: a.system?.chassis ?? [], os: a.os?.caption ?? null, osBuild: a.os?.build ? `${a.os.build}${a.os.ubr ? '.' + a.os.ubr : ''}` : null },
    age, lifeStage: stage, windows: win, parts, headline: top.map(p => ({ part: p.kind, label: p.label, risk: p.risk, why: p.riskReasons[0] })), cost,
    maintenance: a.maintenance ?? {}, gaps,
  };
}

// ---- change detection ------------------------------------------------------------------------------------------------------------------------------------------------------
export interface ComponentId { kind: string; id: string; label: string; detail: Obj }
export function componentIds(a: Obj): ComponentId[] {
  const o: ComponentId[] = [];
  const push = (kind: string, id: string | null | undefined, label: string, detail: Obj) => { if (id) o.push({ kind, id, label, detail }); };
  push('board', a.board?.serial ?? (a.board?.product ? `${a.board.manufacturer}|${a.board.product}` : null), [a.board?.manufacturer, a.board?.product].filter(Boolean).join(' ') || 'Motherboard', a.board ?? {});
  push('cpu', a.cpu?.name ? `${a.cpu.name}|${a.cpu.id ?? ''}` : null, a.cpu?.name ?? 'Processor', a.cpu ?? {});
  for (const m of a.memory?.modules ?? []) push('memory', (m.serial && !/^0+$/.test(m.serial)) ? m.serial : `${m.partNumber ?? m.manufacturer}|${m.capacityBytes}|${m.slot}`, `${gb(m.capacityBytes) ?? '?'} GB ${m.type ?? ''} ${m.manufacturer ?? ''} ${m.partNumber ?? ''}`.replace(/\s+/g, ' ').trim(), m);
  for (const d of a.diagnostics?.storage?.disks ?? []) push('disk', `${d.model}|${d.sizeBytes}`, `${d.model} ${d.sizeBytes ? Math.round(d.sizeBytes / 1e9) + ' GB' : ''}`.trim(), d);
  for (const g of a.gpus ?? []) push('gpu', g.name, g.name, g);
  for (const mo of a.monitors ?? []) push('display', mo.serial ?? `${mo.manufacturerCode}|${mo.productCode}|${mo.year}|${mo.week}`, mo.name ?? `${mo.manufacturerCode} ${mo.productCode}`, mo);
  if (a.battery) push('battery', a.battery.serial ?? a.battery.name, a.battery.name ?? 'Battery', a.battery);
  for (const n of a.network ?? []) push('network', n.mac, n.name ?? 'Network adapter', n);
  return o;
}
export function diffAnatomy(before: Obj | null, after: Obj) {
  if (!before) return [];
  const b = componentIds(before), a = componentIds(after); const changes: { kind: string; change: 'added' | 'removed' | 'replaced'; label: string; before?: Obj; after?: Obj }[] = [];
  const bk = new Map(b.map(x => [`${x.kind}|${x.id}`, x])), ak = new Map(a.map(x => [`${x.kind}|${x.id}`, x]));
  const gone = b.filter(x => !ak.has(`${x.kind}|${x.id}`)), came = a.filter(x => !bk.has(`${x.kind}|${x.id}`));
  for (const n of came) { const i = gone.findIndex(g => g.kind === n.kind); if (i >= 0) { const g = gone.splice(i, 1)[0]!; changes.push({ kind: n.kind, change: 'replaced', label: `${g.label} → ${n.label}`, before: g.detail, after: n.detail }); } else changes.push({ kind: n.kind, change: 'added', label: n.label, after: n.detail }); }
  for (const g of gone) changes.push({ kind: g.kind, change: 'removed', label: g.label, before: g.detail });
  return changes;
}
