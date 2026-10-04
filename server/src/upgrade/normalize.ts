/**
 * Phase 1: Hardware Normalizer. Turns the raw strings Windows reports into canonical records. Nothing downstream reads a raw string.
 * Every field that cannot be established is null (never a guess), and each record carries a `notes` list saying what was inferred and from what.
 */
type Obj = Record<string, any>;

export interface NormalCpu {
  raw: string | null; vendor: 'Intel' | 'AMD' | null; family: string | null; model: string | null; generation: number | null; architecture: string | null;
  socket: string | null; cores: number | null; threads: number | null; mobile: boolean | null; soldered: boolean | null; notes: string[];
}
export interface NormalBoard {
  manufacturer: string | null; model: string | null; chipset: string | null; oem: boolean; formFactor: string | null; slots: number | null; maxMemoryGB: number | null;
  bios: { vendor: string | null; version: string | null; releaseDate: string | null }; revision: string | null; notes: string[];
}
export interface NormalDimm {
  slot: string | null; channel: string | null; capacityGB: number | null; type: string | null; formFactor: string | null; ratedMTs: number | null; configuredMTs: number | null;
  voltageV: number | null; manufacturer: string | null; partNumber: string | null; serial: string | null; ecc: boolean | null;
}
export interface NormalDisk { model: string | null; kind: 'HDD' | 'SATA SSD' | 'NVMe SSD' | 'Unknown'; bus: string | null; sizeGB: number | null; health: string | null; system: boolean; smartWarning: boolean; smartDetail: string[]; powerOnHours: number | null; wearPercent: number | null }
export interface NormalGpu { name: string | null; vendor: string | null; integrated: boolean | null; vramGB: number | null; driverVersion: string | null }
export interface NormalMachine {
  cpu: NormalCpu; board: NormalBoard; memory: { dimms: NormalDimm[]; slotsTotal: number | null; slotsUsed: number | null; maxGB: number | null; totalGB: number | null };
  disks: NormalDisk[]; gpus: NormalGpu[]; formFactor: 'desktop' | 'laptop' | 'all-in-one' | 'small-form-factor' | 'unknown'; os: { caption: string | null; build: string | null };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() && !/^(to be filled|default string|system product name|o\.?e\.?m|n\/a|none|unknown)/i.test(v.trim()) ? v.trim() : null);

// ---- processors ----------------------------------------------------------------------------------------------------------------------------------
const INTEL_ARCH: Record<number, string> = { 2: 'Sandy Bridge', 3: 'Ivy Bridge', 4: 'Haswell', 5: 'Broadwell', 6: 'Skylake', 7: 'Kaby Lake', 8: 'Coffee Lake', 9: 'Coffee Lake Refresh', 10: 'Comet Lake', 11: 'Rocket Lake', 12: 'Alder Lake', 13: 'Raptor Lake', 14: 'Raptor Lake Refresh' };
const INTEL_SOCKET: Record<number, string> = { 2: 'LGA1155', 3: 'LGA1155', 4: 'LGA1150', 6: 'LGA1151', 7: 'LGA1151', 8: 'LGA1151-2', 9: 'LGA1151-2', 10: 'LGA1200', 11: 'LGA1200', 12: 'LGA1700', 13: 'LGA1700', 14: 'LGA1700' };
const INTEL_MOBILE = /^(U|Y|H|HK|HQ|HX|G\d|P|M|UE|E)$/i;
const AMD_MOBILE = /^(U|H|HS|HX|C|E)$/i;

export function normalizeCpu(a: Obj): NormalCpu {
  const raw = str(a.cpu?.name); const notes: string[] = [];
  const out: NormalCpu = { raw, vendor: null, family: null, model: null, generation: null, architecture: null, socket: null, cores: num(a.cpu?.cores), threads: num(a.cpu?.logical), mobile: null, soldered: null, notes };
  if (!raw) { notes.push('The processor name could not be read.'); return out; }
  const intel = /i([3579])[\s-]*(\d{4,5})([A-Z]{0,2}\d?)\b/i.exec(raw.replace(/\(R\)|\(TM\)/gi, ' '));
  if ((/intel/i.test(raw) || !/amd|ryzen/i.test(raw)) && intel) {
    const digits = intel[2]!; const gen = digits.length === 5 || digits[0] === '1' ? Number(digits.slice(0, 2)) : Number(digits[0]); const suffix = intel[3]!.toUpperCase();
    out.vendor = 'Intel'; out.family = `Core i${intel[1]}`; out.model = digits + suffix; out.generation = gen; out.architecture = INTEL_ARCH[gen] ?? null;
    out.mobile = INTEL_MOBILE.test(suffix); out.soldered = out.mobile;
    if (!out.mobile) out.socket = INTEL_SOCKET[gen] ?? null;
    notes.push(`Intel Core generation ${gen} read from the model number ${digits}${suffix}.`);
    if (gen === 11 && out.mobile) { out.architecture = 'Tiger Lake'; }
    if (out.mobile) notes.push(`The "${suffix}" suffix marks a mobile processor, normally soldered to the board and not replaceable.`);
    return out;
  }
  const amd = /ryzen\s*([3579])\s*(?:pro\s*)?(\d{4})([A-Z0-9]{0,3})\b/i.exec(raw);
  if (/amd/i.test(raw) && amd) {
    const model = amd[2]!; const suffix = amd[3]!.toUpperCase(); const series = Number(model[0]); const mobile = AMD_MOBILE.test(suffix);
    out.vendor = 'AMD'; out.family = `Ryzen ${amd[1]}`; out.model = model + suffix; out.generation = series; out.mobile = mobile; out.soldered = mobile;
    let arch: string | null = ({ 1: 'Zen', 2: 'Zen+', 3: 'Zen 2', 4: 'Zen 2', 5: 'Zen 3', 7: 'Zen 4', 8: 'Zen 4', 9: 'Zen 5' } as Record<number, string>)[series] ?? null;
    if (series === 3 && /G/.test(suffix) && Number(model) <= 3400) arch = 'Zen+';
    if (mobile && series === 3) arch = Number(model) <= 3750 ? 'Zen+' : 'Zen 2';
    if (mobile && series === 5 && Number(model) <= 5500) arch = 'Zen 2';
    out.architecture = arch;
    if (!mobile) out.socket = series <= 5 ? 'AM4' : 'AM5';
    notes.push(`AMD Ryzen ${series}000-series model ${model}${suffix} read from the name.`);
    if (mobile) notes.push(`The "${suffix}" suffix marks a mobile processor, normally soldered to the board.`);
    return out;
  }
  out.vendor = /intel/i.test(raw) ? 'Intel' : /amd/i.test(raw) ? 'AMD' : null;
  notes.push('The processor model could not be matched to a known generation. Its socket and platform are not assumed.');
  return out;
}

// ---- motherboards ---------------------------------------------------------------------------------------------------------------------------------
const CHIPSETS = ['H110', 'B150', 'H170', 'Z170', 'Q150', 'Q170', 'B250', 'H270', 'Z270', 'Q250', 'Q270', 'H310', 'B360', 'B365', 'H370', 'Z370', 'Q370', 'Z390', 'H410', 'B460', 'H470', 'Z490', 'Q470', 'W480', 'H510', 'B560', 'H570', 'Z590', 'H610', 'B660', 'H670', 'Z690', 'B760', 'Z790',
  'A320', 'B350', 'X370', 'A520', 'B450', 'X470', 'B550', 'X570', 'A620', 'B650', 'X670', 'B840', 'B850', 'X870', 'H61', 'H81', 'H87', 'B85', 'Z87', 'Z97', 'H97', 'B75', 'Z77', 'H67', 'Z68', 'P67', 'H55'] as const;
const MAKER: [RegExp, string][] = [[/hewlett|^hp\b/i, 'HP'], [/dell/i, 'Dell'], [/lenovo/i, 'Lenovo'], [/gigabyte/i, 'Gigabyte'], [/asus/i, 'ASUS'], [/micro-?star|\bmsi\b/i, 'MSI'], [/asrock/i, 'ASRock'], [/acer/i, 'Acer'], [/fujitsu/i, 'Fujitsu'], [/biostar/i, 'Biostar'], [/intel/i, 'Intel'], [/supermicro/i, 'Supermicro']];
const OEMS = new Set(['HP', 'Dell', 'Lenovo', 'Acer', 'Fujitsu']);

export function normalizeBoard(a: Obj): NormalBoard {
  const notes: string[] = []; const rawMaker = str(a.board?.manufacturer) ?? str(a.system?.manufacturer);
  const manufacturer = rawMaker ? (MAKER.find(([r]) => r.test(rawMaker))?.[1] ?? rawMaker) : null;
  const model = str(a.board?.product);
  const text = `${model ?? ''} ${str(a.system?.model) ?? ''}`.toUpperCase();
  const token = CHIPSETS.find(c => new RegExp(`(^|[^A-Z0-9])${c}([^0-9]|$)`).test(text) || new RegExp(`[-_ ]${c}[A-Z]?(?=[-_ ]|$)`).test(text) || new RegExp(`[A-Z]{1,3}-?${c}[A-Z0-9-]*`).test(text)) ?? null;
  const oem = !!manufacturer && OEMS.has(manufacturer);
  if (token) notes.push(`Chipset ${token} read from the board name.`);
  else notes.push(oem ? 'This is an OEM board: its name is a code and does not state the chipset. The chipset is not assumed.' : 'The chipset could not be read from the board name.');
  const fam = str(a.system?.formFactor) ?? '';
  return {
    manufacturer, model, chipset: token, oem, formFactor: fam || null, slots: num(a.memory?.slotsTotal), maxMemoryGB: a.memory?.maxCapacityBytes ? Math.round(a.memory.maxCapacityBytes / 2 ** 30) : null,
    bios: { vendor: str(a.bios?.vendor), version: str(a.bios?.version), releaseDate: str(a.bios?.releaseDate) }, revision: str(a.board?.version) ?? str(a.board?.revision), notes,
  };
}

// ---- memory ---------------------------------------------------------------------------------------------------------------------------------------
export function channelOf(slot: string | null): string | null {
  if (!slot) return null;
  const a = /channel\s*([A-D])/i.exec(slot) ?? /DIMM[_-]?([A-D])\d?\b/i.exec(slot) ?? /(?:^|[^A-Z])([A-D])[12]?$/.exec(slot.toUpperCase().replace(/DIMM\d*/g, m => m));
  return a ? a[1]!.toUpperCase() : null;
}
export function normalizeMemory(a: Obj) {
  const dimms: NormalDimm[] = (a.memory?.modules ?? []).map((m: Obj): NormalDimm => {
    const t = str(m.type); const type = t ? (/lpddr5/i.test(t) ? 'LPDDR5' : /lpddr4/i.test(t) ? 'LPDDR4' : /ddr5/i.test(t) ? 'DDR5' : /ddr4/i.test(t) ? 'DDR4' : /ddr3/i.test(t) ? 'DDR3' : /ddr2/i.test(t) ? 'DDR2' : t) : null;
    return { slot: str(m.slot), channel: channelOf(str(m.slot)), capacityGB: m.capacityBytes ? Math.round(m.capacityBytes / 2 ** 30) : null, type, formFactor: str(m.formFactor) && /so-?dimm/i.test(m.formFactor) ? 'SODIMM' : str(m.formFactor) && /dimm/i.test(m.formFactor) ? 'DIMM' : null,
      ratedMTs: num(m.speedMhz), configuredMTs: num(m.configuredMhz), voltageV: m.voltageMv ? Math.round(m.voltageMv) / 1000 : null, manufacturer: str(m.manufacturer), partNumber: str(m.partNumber), serial: str(m.serial), ecc: typeof a.memory?.ecc === 'boolean' ? a.memory.ecc : null };
  });
  const total = dimms.reduce((s, d) => s + (d.capacityGB ?? 0), 0);
  return { dimms, slotsTotal: num(a.memory?.slotsTotal), slotsUsed: num(a.memory?.slotsUsed), maxGB: a.memory?.maxCapacityBytes ? Math.round(a.memory.maxCapacityBytes / 2 ** 30) : null, totalGB: total || null };
}

// ---- storage and graphics ----------------------------------------------------------------------------------------------------------------------------
export function normalizeDisks(a: Obj): NormalDisk[] {
  const disks: Obj[] = a.diagnostics?.storage?.disks ?? [];
  // The drive's own failure prediction, or any non-zero raw count of reallocated (5), uncorrectable (187, 198) or pending (197) sectors.
  const NAMES: Record<number, string> = { 5: 'reallocated sectors', 187: 'uncorrectable errors', 197: 'pending sectors', 198: 'offline uncorrectable sectors' };
  const smartDetail: string[] = []; let smartBad = false;
  for (const s of a.diagnostics?.storage?.ataSmart ?? []) { if (s.predictFailure === true) { smartBad = true; smartDetail.push('the drive predicts its own failure'); } for (const x of s.attributes ?? []) if (NAMES[x.id] && (x.raw ?? 0) > 0) { smartBad = true; smartDetail.push(`${x.raw} ${NAMES[x.id]}`); } }
  return disks.map((d, i): NormalDisk => {
    const media = String(d.mediaType ?? ''), bus = String(d.busType ?? ''), model = str(d.model) ?? '';
    const kind: NormalDisk['kind'] = /nvme/i.test(bus) || /nvme|pc sn|sn\d{3}/i.test(model) ? 'NVMe SSD' : /ssd|solid/i.test(media) || /\bssd\b/i.test(model) ? (/nvme/i.test(bus) ? 'NVMe SSD' : 'SATA SSD') : /hdd|rotat|fixed hard/i.test(media) || /^(ST|WD\d|WDC|HGST|TOSHIBA (DT|MQ)|HTS|MQ)/i.test(model) ? 'HDD' : 'Unknown';
    const r = d.reliability ?? {};
    return { model: model || null, kind, bus: bus || null, sizeGB: d.sizeBytes ? Math.round(d.sizeBytes / 1e9) : null, health: str(d.health), system: i === 0, smartDetail, smartWarning: smartBad || /unhealthy|warning/i.test(String(d.health ?? '')) || (num(r.readErrorsUncorrected) ?? 0) > 0 || (num(r.writeErrorsUncorrected) ?? 0) > 0, powerOnHours: num(r.powerOnHours), wearPercent: num(r.wearPercent) };
  });
}
export function normalizeGpus(a: Obj): NormalGpu[] {
  return (a.gpus ?? []).map((g: Obj): NormalGpu => { const name = str(g.name); const vendor = name ? (/nvidia|geforce|quadro|rtx|gtx/i.test(name) ? 'NVIDIA' : /amd|radeon/i.test(name) ? 'AMD' : /intel/i.test(name) ? 'Intel' : null) : null;
    return { name, vendor, integrated: name ? (/uhd|iris|hd graphics|vega \d|radeon\(tm\) graphics|radeon graphics/i.test(name) && !/rx|rtx|gtx/i.test(name)) : null, vramGB: g.vramBytes ? Math.round(g.vramBytes / 2 ** 30 * 10) / 10 : null, driverVersion: str(g.driverVersion) }; });
}

export function normalizeMachine(a: Obj): NormalMachine {
  const chassis = [str(a.system?.formFactor), ...(a.system?.chassis ?? [])].filter(Boolean).join(' ').toLowerCase();
  const formFactor = /laptop|notebook|portable|convertible|tablet/.test(chassis) ? 'laptop' : /all.?in.?one/.test(chassis) ? 'all-in-one' : /small|mini|sff|slim|lunch/.test(chassis) ? 'small-form-factor' : /desktop|tower|microtower|minitower/.test(chassis) ? 'desktop' : 'unknown';
  return { cpu: normalizeCpu(a), board: normalizeBoard(a), memory: normalizeMemory(a), disks: normalizeDisks(a), gpus: normalizeGpus(a), formFactor, os: { caption: str(a.os?.caption), build: str(a.os?.build) } };
}
