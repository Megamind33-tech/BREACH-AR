/** Storage and cooling resolvers. Storage keeps "feels faster" (system responsiveness) separate from "computes faster" (processor throughput): an SSD does the first, never the second. */
import type { NormalMachine } from './normalize.js';
import type { UpgradeContext } from './context.js';
import { thermalState } from './thermal.js';
import { UPGRADE_CONFIG as cfg } from './config.js';

export type Benefit = 'SYSTEM_RESPONSIVENESS' | 'COMPUTATIONAL' | 'MEMORY_BANDWIDTH' | 'CAPACITY' | 'BANDWIDTH_AND_CAPACITY' | 'RELIABILITY' | 'THERMAL' | 'CONFIGURATION';
export interface SimpleOption { id: string; component: 'storage' | 'cooling'; title: string; why: string; benefit: Benefit; essential: boolean; priceKey: string | null; labourHours: number; effort: string; spec: string; confidence: number; requirements: string[]; gain: { low: number | null; high: number | null; basis: string } }

export function storageOptions(m: NormalMachine, ctx: UpgradeContext): SimpleOption[] {
  const out: SimpleOption[] = []; const sys = m.disks.find(d => d.system) ?? m.disks[0]; if (!sys) return out;
  const used = ctx.systemUsedGB; const target = used != null ? Math.max(240, Math.ceil((used * 1.3) / 120) * 120) : null;
  const size = target == null ? '256 GB or larger' : target <= 256 ? '256 GB' : target <= 512 ? '512 GB' : target <= 1000 ? '1 TB' : '2 TB';
  const key = target == null || target <= 256 ? 'ssd_256gb' : target <= 512 ? 'ssd_512gb' : target <= 1000 ? 'ssd_1tb' : 'ssd_2tb';
  const interfaceNote = sys.kind === 'NVMe SSD' ? 'M.2 NVMe' : 'a 2.5-inch SATA SSD (works in any computer that has a SATA drive; an M.2 NVMe drive is faster only if the board has a free M.2 slot, which software cannot detect)';
  if (sys.smartWarning) out.push({ id: 'storage-failing', component: 'storage', title: `Replace the failing system drive with ${sys.kind === 'NVMe SSD' ? 'an NVMe' : 'a SATA'} SSD (${size})`, benefit: 'RELIABILITY', essential: true, priceKey: key, labourHours: 1.5, effort: 'Back up first, then clone or reinstall',
    spec: `${size} ${interfaceNote}`, why: `The drive's own self-monitoring has recorded ${sys.smartDetail.length ? sys.smartDetail.join(', ') : 'faults'}${/healthy/i.test(sys.health ?? '') ? ' (Windows still calls it "Healthy", but it does not read these counters)' : ''}. That is a recognised early warning of drive failure: back up now and replace it.`, confidence: 0.96, requirements: ['Back up the important files now, before anything else.', 'Clone the drive or reinstall Windows on the new one.'], gain: { low: null, high: null, basis: 'Removes the risk of losing the data on the failing drive.' } });
  else if (sys.kind === 'HDD') out.push({ id: 'storage-ssd', component: 'storage', title: `Replace the system hard disk with ${size === '256 GB or larger' ? 'an SSD' : 'a ' + size + ' SSD'}`, benefit: 'SYSTEM_RESPONSIVENESS', essential: false, priceKey: key, labourHours: 1.5, effort: 'Clone the drive or reinstall Windows',
    spec: `${size} ${interfaceNote}`, why: 'Windows runs from a mechanical disk. Start-up, program launching and everyday responsiveness are limited by it.', confidence: 0.95, requirements: ['Back up first.', 'A 3.5-inch bay may need a mounting bracket for a 2.5-inch SSD.'],
    gain: { low: null, high: null, basis: 'Typically a large improvement in start-up time and program loading. This is responsiveness: it does not raise processor computing speed.' } });
  else if (sys.kind === 'SATA SSD' || sys.kind === 'NVMe SSD') { if ((sys.wearPercent ?? 0) >= 80) out.push({ id: 'storage-worn', component: 'storage', title: 'Replace the worn SSD', benefit: 'RELIABILITY', essential: true, priceKey: key, labourHours: 1, effort: 'Clone the drive', spec: `${size}`, why: `The SSD has used ${sys.wearPercent}% of its rated writes.`, confidence: 0.9, requirements: ['Back up first.'], gain: { low: null, high: null, basis: 'Reliability.' } }); }
  return out;
}

export function coolingOptions(m: NormalMachine, ctx: UpgradeContext): SimpleOption[] {
  const th = thermalState(ctx); if (th.state === 'ok' || th.state === 'unknown') return [];
  const severe = th.state === 'throttling';
  return [{ id: 'cooling-service', component: 'cooling', title: 'Clean the cooling system and renew the thermal paste', benefit: 'THERMAL', essential: severe, priceKey: 'thermal_service', labourHours: m.formFactor === 'laptop' ? 1.5 : 1, effort: 'Workshop job',
    spec: 'Clean fans and vents, new thermal paste on the processor; check the fan spins up; replace the fan if noisy or stuck.', why: `The computer runs hot (${th.reasons.join('; ')}). ${severe ? 'Windows is already slowing the processor to protect it, so the computer is running slower than it should.' : ''}`.trim(), confidence: 0.9,
    requirements: ['Do this before any processor upgrade.'], gain: { low: null, high: null, basis: 'Removing heat slowdowns restores the speed the processor already has; temperatures usually fall noticeably.' } }];
}

export const cfgRef = cfg;
