/**
 * Built-in platform knowledge: public, stable facts about sockets, chipsets and processors. This is the ONLY place such facts live, each table says where its
 * facts come from, and anything not listed here is "not verified" downstream, never assumed. Facts that depend on a particular board's BIOS version are NOT
 * here: they come from a BiosSupportProvider (manufacturer data or verified WorkCare outcomes), because inventing a minimum BIOS version is how people brick boards.
 */
export interface ChipsetRule {
  chipset: string; socket: string; family: 'Intel' | 'AMD';
  /** CPU generations the chipset supports natively with early BIOS; `withBios` need a BIOS update whose exact version is board-specific. */
  native: number[]; withBios: number[]; unsupported?: number[]; memory: ('DDR3' | 'DDR4' | 'DDR5')[]; note?: string;
}
const R = (chipset: string, socket: string, family: 'Intel' | 'AMD', native: number[], withBios: number[], memory: ChipsetRule['memory'], extra: Partial<ChipsetRule> = {}): ChipsetRule => ({ chipset, socket, family, native, withBios, memory, ...extra });

/** Source: Intel ARK and AMD product pages (public chipset/processor support lists). */
export const CHIPSETS: ChipsetRule[] = [
  ...['H110', 'B150', 'H170', 'Z170', 'Q150', 'Q170'].map(c => R(c, 'LGA1151', 'Intel', [6], [7], ['DDR4'])),
  ...['B250', 'H270', 'Z270', 'Q250', 'Q270'].map(c => R(c, 'LGA1151', 'Intel', [6, 7], [], ['DDR4'])),
  ...['H310', 'B360', 'B365', 'H370', 'Z370', 'Q370'].map(c => R(c, 'LGA1151-2', 'Intel', [8], [9], ['DDR4'], { note: 'The 9th generation needs a BIOS update on this chipset.' })),
  ...['Z390'].map(c => R(c, 'LGA1151-2', 'Intel', [8, 9], [], ['DDR4'])),
  ...['H410', 'B460'].map(c => R(c, 'LGA1200', 'Intel', [10], [], ['DDR4'], { unsupported: [11], note: 'Intel does not support the 11th generation on this chipset.' })),
  ...['H470', 'Z490', 'Q470', 'W480'].map(c => R(c, 'LGA1200', 'Intel', [10], [11], ['DDR4'])),
  ...['H510', 'B560', 'H570', 'Z590'].map(c => R(c, 'LGA1200', 'Intel', [10, 11], [], ['DDR4'])),
  ...['A320', 'B350', 'X370'].map(c => R(c, 'AM4', 'AMD', [1, 2], [3, 5], ['DDR4'], { note: 'Ryzen 3000 and 5000 need a BIOS update; some A320 boards cannot take Ryzen 5000 at all (BIOS chip size).' })),
  ...['B450', 'X470'].map(c => R(c, 'AM4', 'AMD', [1, 2], [3, 5], ['DDR4'], { note: 'Ryzen 3000 and 5000 need a BIOS update on many boards.' })),
  ...['A520', 'B550', 'X570'].map(c => R(c, 'AM4', 'AMD', [3], [1, 2, 5], ['DDR4'], { note: 'Ryzen 5000 may need a BIOS update on boards made before late 2020.' })),
  ...['A620', 'B650', 'X670'].map(c => R(c, 'AM5', 'AMD', [7], [8, 9], ['DDR5'])),
];
export const chipsetRule = (c: string | null) => (c ? CHIPSETS.find(x => x.chipset === c.toUpperCase()) ?? null : null);

/** Memory each socket's controller can take. Source: processor datasheets. */
export const SOCKET_MEMORY: Record<string, { types: string[]; channels: number }> = {
  LGA1151: { types: ['DDR4'], channels: 2 }, 'LGA1151-2': { types: ['DDR4'], channels: 2 }, LGA1200: { types: ['DDR4'], channels: 2 }, AM4: { types: ['DDR4'], channels: 2 }, AM5: { types: ['DDR5'], channels: 2 },
  LGA1155: { types: ['DDR3'], channels: 2 }, LGA1150: { types: ['DDR3'], channels: 2 }, LGA1700: { types: ['DDR4', 'DDR5'], channels: 2 },
};

/**
 * Instruction throughput per clock relative to Intel Skylake (= 1.00). ROUNDED public figures (vendor-stated generation-over-generation gains), used only
 * for the first prediction before a machine has been measured. They are why predictions are ranges, and why measured outcomes replace them.
 */
export const IPC: Record<string, number> = { Skylake: 1, 'Kaby Lake': 1, 'Coffee Lake': 1, 'Coffee Lake Refresh': 1, 'Comet Lake': 1, 'Rocket Lake': 1.19, 'Alder Lake': 1.4, Zen: 0.8, 'Zen+': 0.85, 'Zen 2': 0.98, 'Zen 3': 1.15, 'Zen 4': 1.3 };

export interface CatalogCpu { id: string; name: string; vendor: 'Intel' | 'AMD'; model: string; generation: number; architecture: string; socket: string; cores: number; threads: number; baseGHz: number; boostGHz: number; tdpW: number; memory: { type: string; maxMTs: number }; igpu: boolean }
const TIER: Record<string, string> = { '6100': 'i3', '7100': 'i3', '8100': 'i3', '10100': 'i3', '9900': 'i9', '10900': 'i9', '6700': 'i7', '7700': 'i7', '8700': 'i7', '9700': 'i7', '10700': 'i7', '11700': 'i7' };
const I = (model: string, generation: number, architecture: string, socket: string, cores: number, threads: number, baseGHz: number, boostGHz: number, tdpW: number, maxMTs: number, igpu = true): CatalogCpu =>
  ({ id: `intel-${model.toLowerCase()}`, name: `Intel Core ${TIER[model] ?? 'i5'}-${model}`, vendor: 'Intel', model, generation, architecture, socket, cores, threads, baseGHz, boostGHz, tdpW, memory: { type: 'DDR4', maxMTs }, igpu });
const A = (model: string, generation: number, architecture: string, socket: string, cores: number, threads: number, baseGHz: number, boostGHz: number, tdpW: number, maxMTs: number, type = 'DDR4', igpu = false): CatalogCpu =>
  ({ id: `amd-${model.toLowerCase().replace(/\s+/g, '')}`, name: `AMD ${model}`, vendor: 'AMD', model, generation, architecture, socket, cores, threads, baseGHz, boostGHz, tdpW, memory: { type, maxMTs }, igpu });

/** Source: Intel ARK / AMD product specifications (core and thread counts, base and boost clocks, TDP, memory support). Desktop, non-hybrid parts only. */
export const CPU_CATALOG: CatalogCpu[] = [
  I('6100', 6, 'Skylake', 'LGA1151', 2, 4, 3.7, 3.7, 51, 2133), I('6400', 6, 'Skylake', 'LGA1151', 4, 4, 2.7, 3.3, 65, 2133), I('6500', 6, 'Skylake', 'LGA1151', 4, 4, 3.2, 3.6, 65, 2133), I('6600', 6, 'Skylake', 'LGA1151', 4, 4, 3.3, 3.9, 65, 2133), I('6700', 6, 'Skylake', 'LGA1151', 4, 8, 3.4, 4.0, 65, 2133),
  I('7100', 7, 'Kaby Lake', 'LGA1151', 2, 4, 3.9, 3.9, 51, 2400), I('7400', 7, 'Kaby Lake', 'LGA1151', 4, 4, 3.0, 3.5, 65, 2400), I('7500', 7, 'Kaby Lake', 'LGA1151', 4, 4, 3.4, 3.8, 65, 2400), I('7600', 7, 'Kaby Lake', 'LGA1151', 4, 4, 3.5, 4.1, 65, 2400), I('7700', 7, 'Kaby Lake', 'LGA1151', 4, 8, 3.6, 4.2, 65, 2400),
  I('8100', 8, 'Coffee Lake', 'LGA1151-2', 4, 4, 3.6, 3.6, 65, 2400), I('8400', 8, 'Coffee Lake', 'LGA1151-2', 6, 6, 2.8, 4.0, 65, 2666), I('8500', 8, 'Coffee Lake', 'LGA1151-2', 6, 6, 3.0, 4.1, 65, 2666), I('8700', 8, 'Coffee Lake', 'LGA1151-2', 6, 12, 3.2, 4.6, 65, 2666),
  I('9400', 9, 'Coffee Lake Refresh', 'LGA1151-2', 6, 6, 2.9, 4.1, 65, 2666), I('9500', 9, 'Coffee Lake Refresh', 'LGA1151-2', 6, 6, 3.0, 4.4, 65, 2666), I('9600', 9, 'Coffee Lake Refresh', 'LGA1151-2', 6, 6, 3.1, 4.6, 65, 2666), I('9700', 9, 'Coffee Lake Refresh', 'LGA1151-2', 8, 8, 3.0, 4.7, 65, 2666), I('9900', 9, 'Coffee Lake Refresh', 'LGA1151-2', 8, 16, 3.1, 5.0, 65, 2666),
  I('10100', 10, 'Comet Lake', 'LGA1200', 4, 8, 3.6, 4.3, 65, 2666), I('10400', 10, 'Comet Lake', 'LGA1200', 6, 12, 2.9, 4.3, 65, 2666), I('10500', 10, 'Comet Lake', 'LGA1200', 6, 12, 3.1, 4.5, 65, 2666), I('10600', 10, 'Comet Lake', 'LGA1200', 6, 12, 3.3, 4.8, 65, 2666), I('10700', 10, 'Comet Lake', 'LGA1200', 8, 16, 2.9, 4.8, 65, 2933), I('10900', 10, 'Comet Lake', 'LGA1200', 10, 20, 2.8, 5.2, 65, 2933),
  I('11400', 11, 'Rocket Lake', 'LGA1200', 6, 12, 2.6, 4.4, 65, 3200), I('11500', 11, 'Rocket Lake', 'LGA1200', 6, 12, 2.7, 4.6, 65, 3200), I('11700', 11, 'Rocket Lake', 'LGA1200', 8, 16, 2.5, 4.9, 65, 3200),
  A('Ryzen 5 1600', 1, 'Zen', 'AM4', 6, 12, 3.2, 3.6, 65, 2667), A('Ryzen 5 2600', 2, 'Zen+', 'AM4', 6, 12, 3.4, 3.9, 65, 2933), A('Ryzen 7 2700', 2, 'Zen+', 'AM4', 8, 16, 3.2, 4.1, 65, 2933),
  A('Ryzen 5 3600', 3, 'Zen 2', 'AM4', 6, 12, 3.6, 4.2, 65, 3200), A('Ryzen 7 3700X', 3, 'Zen 2', 'AM4', 8, 16, 3.6, 4.4, 65, 3200), A('Ryzen 9 3900X', 3, 'Zen 2', 'AM4', 12, 24, 3.8, 4.6, 105, 3200),
  A('Ryzen 5 5600', 5, 'Zen 3', 'AM4', 6, 12, 3.5, 4.4, 65, 3200), A('Ryzen 5 5600X', 5, 'Zen 3', 'AM4', 6, 12, 3.7, 4.6, 65, 3200), A('Ryzen 7 5700X', 5, 'Zen 3', 'AM4', 8, 16, 3.4, 4.6, 65, 3200), A('Ryzen 7 5800X', 5, 'Zen 3', 'AM4', 8, 16, 3.8, 4.7, 105, 3200),
  A('Ryzen 5 7600', 7, 'Zen 4', 'AM5', 6, 12, 3.8, 5.1, 65, 5200, 'DDR5', true), A('Ryzen 7 7700', 7, 'Zen 4', 'AM5', 8, 16, 3.8, 5.3, 65, 5200, 'DDR5', true),
];

/** Sustained-throughput model: first-principles estimate from published specifications, intentionally conservative, ALWAYS shown as a range until the machine is measured. */
export function modelScore(c: { cores: number; threads: number; baseGHz: number; boostGHz: number; architecture: string }) {
  const ipc = IPC[c.architecture]; if (ipc == null) return null;
  const smt = c.threads > c.cores ? 1.25 : 1;                          // two threads on one core give roughly a quarter more throughput
  const allCore = c.baseGHz + 0.6 * (c.boostGHz - c.baseGHz);         // sustained all-core clocks sit between base and boost
  return { single: Math.round(c.boostGHz * ipc * 100) / 100, multi: Math.round(c.cores * smt * allCore * ipc * 100) / 100 };
}
