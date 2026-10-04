/**
 * Data providers behind interfaces, so the sources of hardware knowledge can change (a manufacturer feed, a purchased database, verified WorkCare outcomes)
 * without rewriting the recommendation engine. The defaults below use only the built-in public rules in platform-data.ts and answer "unknown" for anything
 * that needs board-specific knowledge. Providers are synchronous: the routes load what they need (benchmarks, outcomes) before the engine runs.
 */
import { CHIPSETS, CPU_CATALOG, SOCKET_MEMORY, chipsetRule, type CatalogCpu } from './platform-data.js';
import type { NormalBoard, NormalCpu } from './normalize.js';

export type Verdict = 'yes' | 'no' | 'unknown';
export interface SupportAnswer { verdict: Verdict; basis: string; confidence: number; needsBios: boolean | null; source: string }
export interface BiosAnswer { required: boolean | null; minimumVersion: string | null; latestKnown: string | null; source: string }
export interface OutcomeStats { successes: number; failures: number; medianGain: number | null; medianTempChangeC: number | null }
export type Metrics = Record<string, number>;

export interface MotherboardCompatibilityProvider { supports(board: NormalBoard, installed: NormalCpu, candidate: CatalogCpu): SupportAnswer }
export interface CpuSpecificationProvider { identify(cpu: NormalCpu): CatalogCpu | null; candidatesFor(socket: string): CatalogCpu[] }
export interface MemorySpecificationProvider { socketMemory(socket: string | null): { types: string[]; channels: number } | null }
export interface BiosSupportProvider { biosFor(board: NormalBoard, candidate: CatalogCpu, support: SupportAnswer): BiosAnswer }
export interface BenchmarkProvider { baseline(): Metrics | null }
export interface WorkCareOutcomeProvider { outcomes(board: NormalBoard, fromCpu: string | null, toCpu: string): OutcomeStats | null }
export interface Providers { board: MotherboardCompatibilityProvider; cpu: CpuSpecificationProvider; memory: MemorySpecificationProvider; bios: BiosSupportProvider; benchmark: BenchmarkProvider; outcomes: WorkCareOutcomeProvider }

/** What the public chipset tables can prove, and nothing more. */
export class BuiltInBoardProvider implements MotherboardCompatibilityProvider {
  supports(board: NormalBoard, installed: NormalCpu, c: CatalogCpu): SupportAnswer {
    const rule = chipsetRule(board.chipset);
    if (rule) {
      if (rule.socket !== c.socket) return { verdict: 'no', basis: `Chipset ${rule.chipset} is for socket ${rule.socket}, not ${c.socket}.`, confidence: 0.99, needsBios: null, source: 'chipset table' };
      if (rule.unsupported?.includes(c.generation)) return { verdict: 'no', basis: rule.note ?? `${rule.chipset} does not support this generation.`, confidence: 0.95, needsBios: null, source: 'chipset table' };
      if (rule.native.includes(c.generation)) return { verdict: 'yes', basis: `Chipset ${rule.chipset} supports this generation as released.`, confidence: 0.97, needsBios: false, source: 'chipset table' };
      if (rule.withBios.includes(c.generation)) return { verdict: 'yes', basis: `Chipset ${rule.chipset} supports this generation after a BIOS update.`, confidence: 0.9, needsBios: true, source: 'chipset table' };
      return { verdict: 'no', basis: `Chipset ${rule.chipset} is not listed as supporting this generation.`, confidence: 0.92, needsBios: null, source: 'chipset table' };
    }
    // Unknown chipset (an OEM board code, say). The processor already installed proves one thing only: the platform takes that generation.
    if (installed.generation != null && installed.vendor === c.vendor && installed.generation === c.generation && installed.socket === c.socket)
      return { verdict: 'yes', basis: 'The installed processor is of the same generation and socket, so this board takes this generation. The board\'s chipset itself could not be read.', confidence: 0.88, needsBios: false, source: 'installed processor' };
    return { verdict: 'unknown', basis: 'COMPATIBILITY NOT YET VERIFIED: the board\'s chipset is not known and this processor is of a different generation from the one installed.', confidence: 0, needsBios: null, source: 'none' };
  }
}
export class BuiltInCpuProvider implements CpuSpecificationProvider {
  identify(cpu: NormalCpu): CatalogCpu | null {
    if (!cpu.vendor || !cpu.model || !cpu.generation) return null;
    const digits = cpu.model.replace(/[A-Z]+$/, ''); const suffix = cpu.model.slice(digits.length);
    // Variants with a different TDP or features (K, T, S, X, G ...) are not the catalog's 65 W parts: do not claim their specification.
    if (cpu.vendor === 'Intel') { if (/^(K|KF|F|T|S|X|TE)$/.test(suffix) && suffix !== 'F') return null; return CPU_CATALOG.find(c => c.vendor === 'Intel' && c.model === digits) ?? null; }
    return CPU_CATALOG.find(c => c.vendor === 'AMD' && c.model.replace('Ryzen ', '').replace(/^\d\s/, '') === cpu.model) ?? null;
  }
  candidatesFor(socket: string) { return CPU_CATALOG.filter(c => c.socket === socket); }
}
export class BuiltInMemoryProvider implements MemorySpecificationProvider { socketMemory(s: string | null) { return s ? SOCKET_MEMORY[s] ?? null : null; } }
export class BuiltInBiosProvider implements BiosSupportProvider {
  /** Exact minimum BIOS versions are board specific and are NOT in the built-in tables, so they are never stated unless a verified source supplies one. */
  biosFor(board: NormalBoard, _c: CatalogCpu, s: SupportAnswer): BiosAnswer {
    return { required: s.needsBios, minimumVersion: null, latestKnown: null, source: s.needsBios === null ? 'not verified' : s.needsBios ? 'chipset table (version not verified)' : 'chipset table' };
  }
}
export class FixedBenchmarkProvider implements BenchmarkProvider { constructor(private readonly m: Metrics | null) {} baseline() { return this.m; } }
export class OutcomeTable implements WorkCareOutcomeProvider {
  constructor(private readonly rows: { boardKey: string; fromCpu: string | null; toCpu: string; successes: number; failures: number; medianGain: number | null; medianTempChangeC: number | null }[] = []) {}
  outcomes(board: NormalBoard, fromCpu: string | null, toCpu: string): OutcomeStats | null {
    const key = boardKey(board); const r = this.rows.find(x => x.boardKey === key && x.toCpu === toCpu && (x.fromCpu == null || fromCpu == null || x.fromCpu === fromCpu));
    return r ? { successes: r.successes, failures: r.failures, medianGain: r.medianGain, medianTempChangeC: r.medianTempChangeC } : null;
  }
}
export const boardKey = (b: NormalBoard) => [b.manufacturer, b.model].filter(Boolean).join(' ').toLowerCase();

export function defaultProviders(over: Partial<Providers> = {}): Providers {
  return { board: new BuiltInBoardProvider(), cpu: new BuiltInCpuProvider(), memory: new BuiltInMemoryProvider(), bios: new BuiltInBiosProvider(), benchmark: new FixedBenchmarkProvider(null), outcomes: new OutcomeTable(), ...over };
}
export { CHIPSETS };
