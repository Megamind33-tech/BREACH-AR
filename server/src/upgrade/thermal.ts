import { UPGRADE_CONFIG as cfg } from './config.js';
import type { UpgradeContext } from './context.js';
/** A faster processor that throttles is not an upgrade: judge the cooling from what was measured. */
export function thermalState(ctx: UpgradeContext): { state: 'ok' | 'throttling' | 'hot' | 'unknown'; reasons: string[] } {
  const reasons: string[] = []; const t = ctx.thermal; const b = ctx.benchmark;
  const known = t.throttleEvents7d != null || t.maxIdleTempC != null || b?.cpuSustainedRatio != null || b?.peakTempC != null;
  if (!known) return { state: 'unknown', reasons };
  let state: 'ok' | 'throttling' | 'hot' = 'ok';
  if ((t.throttleEvents7d ?? 0) > 0) { state = 'throttling'; reasons.push(`${t.throttleEvents7d} heat slow-downs in 7 days`); }
  if (b?.cpuSustainedRatio != null && b.cpuSustainedRatio < cfg.sustainedRatioFloor) { state = 'throttling'; reasons.push(`sustained speed fell to ${Math.round(b.cpuSustainedRatio * 100)}% under load`); }
  if (t.maxIdleTempC != null && t.maxIdleTempC >= cfg.tempHotIdleC) { if (state === 'ok') state = 'hot'; reasons.push(`${t.maxIdleTempC} °C at idle`); }
  if (b?.peakTempC != null && b.peakTempC >= cfg.tempHotLoadC) { if (state === 'ok') state = 'hot'; reasons.push(`${b.peakTempC} °C under load`); }
  if (state === 'ok') { if (t.maxIdleTempC != null) reasons.push(`${t.maxIdleTempC} °C at idle`); if (b?.peakTempC != null) reasons.push(`${b.peakTempC} °C peak under load`); }
  return { state, reasons };
}
