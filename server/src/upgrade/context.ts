import type { PriceBook } from '../anatomy-engine.js';
import type { Metrics } from './providers.js';
export interface UpgradeContext {
  now: Date; ramPeakPercent: number | null; cpuAvgPercent: number | null; systemUsedGB: number | null; ageYears: number | null;
  thermal: { throttleEvents7d: number | null; maxIdleTempC: number | null };
  /** Latest controlled measurements for this computer (see agent job benchmark.upgrade), if any. */
  benchmark: Metrics | null;
  windows: { running11: boolean; running10: boolean; ready11: boolean | null };
  prices: PriceBook | null;
  /** Evidence of workloads that could benefit from a graphics upgrade. None is collected yet, so GPU upgrades are never offered without it. */
  workload: { gpuBound: boolean | null };
}
export const emptyContext = (now = new Date()): UpgradeContext => ({ now, ramPeakPercent: null, cpuAvgPercent: null, systemUsedGB: null, ageYears: null, thermal: { throttleEvents7d: null, maxIdleTempC: null }, benchmark: null, windows: { running11: false, running10: false, ready11: null }, prices: null, workload: { gpuBound: null } });
