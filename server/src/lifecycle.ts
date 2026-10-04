import { CONDITION_RANK, type Condition } from './condition.js';

/**
 * Hardware recommendations and the lifecycle decision. Both are explainable rules over recorded facts. Viro states what it could and could
 * not verify: compatibility that cannot be established is reported as LOW confidence with the unknowns listed, never as fact, and no
 * remaining life or failure date is ever quoted.
 */
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
export interface Recommendation {
  kind: 'ram' | 'storage' | 'battery' | 'cooling';
  title: string; why: string[]; current: string; recommended: string; expectedConfiguration?: string;
  compatibility: { confidence: Confidence; evidence: string[]; unknowns: string[] };
  verification: string;
}

const MEM_TYPE: Record<number, string> = { 20: 'DDR', 21: 'DDR2', 24: 'DDR3', 26: 'DDR4', 34: 'DDR5' };
const FORM: Record<number, string> = { 8: 'DIMM', 12: 'SODIMM' };
const GB = 2 ** 30;
const gb = (b: number) => `${Math.round((b / GB) * 10) / 10} GB`.replace('.0 GB', ' GB');

/** Whether the computer's memory is short, from measurements Viro already made. */
export interface MemoryNeed { lowRam: boolean; pressure: boolean }

export function ramRecommendation(hw: any, need: MemoryNeed): Recommendation | null {
  if (!need.lowRam && !need.pressure) return null;
  const mods: any[] = Array.isArray(hw?.memoryModules) ? hw.memoryModules : [];
  const total = typeof hw?.ramBytes === 'number' ? hw.ramBytes : mods.reduce((a, m) => a + (m.capacityBytes ?? 0), 0);
  const why = [need.lowRam ? `This computer has ${gb(total)} of memory, which is below what current Windows work needs.` : '', need.pressure ? 'Memory use was measured near its limit during normal work.' : ''].filter(Boolean);
  const unknowns: string[] = [], evidence: string[] = [];
  if (mods.length === 0) return { kind: 'ram', title: 'Memory upgrade', why, current: `${gb(total)} (module details not reported)`, recommended: 'Not determined', compatibility: { confidence: 'LOW', evidence: [], unknowns: ['Windows did not report individual memory modules. The memory may be soldered to the board, in which case it cannot be upgraded.'] }, verification: 'Technician or OEM verification required before purchase.' };
  const type = MEM_TYPE[mods[0]?.memoryType as number] ?? null, form = FORM[mods[0]?.formFactor as number] ?? null;
  const speed = Math.max(0, ...mods.map(m => m.speedMhz ?? 0)) || null;
  const slots = typeof hw?.memoryArray?.slots === 'number' ? hw.memoryArray.slots : null;
  const max = typeof hw?.memoryArray?.maxCapacityBytes === 'number' ? hw.memoryArray.maxCapacityBytes : null;
  if (type) evidence.push(`Installed memory type: ${type}`); else unknowns.push('memory type could not be read');
  if (form) evidence.push(`Form factor: ${form}`); else unknowns.push('form factor (laptop SODIMM or desktop DIMM) could not be read');
  if (speed) evidence.push(`Installed speed: ${speed} MHz`);
  if (slots != null) evidence.push(`${slots} memory slots reported by the firmware, ${mods.length} in use`); else unknowns.push('the number of memory slots could not be read');
  if (max != null) evidence.push(`Firmware-reported maximum: ${gb(max)}`); else unknowns.push('the maximum supported memory could not be verified automatically. Technician/OEM verification required');
  const largest = Math.max(...mods.map(m => m.capacityBytes ?? 0));
  const free = slots != null ? slots - mods.length : null;
  const spec = [type, form, speed ? `${speed} MHz` : null].filter(Boolean).join(' ');
  let recommended: string, expected: string | undefined, conf: Confidence;
  if (free != null && free >= 1 && largest > 0) {
    const add = Math.max(largest, total < 8 * GB ? 4 * GB : 8 * GB);
    const after = total + add;
    recommended = `Add 1 × ${gb(add)} ${spec}`.trim();
    expected = `${gb(after)} total${mods.length === 1 && add === largest ? ' (two matching modules usually run in dual-channel; slot pairing should be confirmed)' : ''}`;
    if (max != null && after > max) { recommended = `Replace modules with larger ones (adding ${gb(add)} would exceed the firmware maximum of ${gb(max)})`; expected = undefined; conf = 'MEDIUM'; }
    else conf = type && form && slots != null && max != null ? 'HIGH' : type && form ? 'MEDIUM' : 'LOW';
  } else if (free === 0) {
    recommended = `Replace the ${mods.length} installed module${mods.length === 1 ? '' : 's'} with larger ones of the same ${spec || 'type'}; all slots are in use`;
    expected = max != null ? `Up to ${gb(max)} (firmware-reported maximum)` : undefined; conf = type && form ? 'MEDIUM' : 'LOW';
  } else { recommended = `Add memory of the same type (${spec || 'unknown type'}); free slots could not be determined`; conf = 'LOW'; }
  return { kind: 'ram', title: 'Memory upgrade', why, current: `${mods.length} × ${mods.map(m => gb(m.capacityBytes ?? 0)).join(' + ')} ${spec}`.trim(), recommended, expectedConfiguration: expected, compatibility: { confidence: conf, evidence, unknowns },
    verification: conf === 'HIGH' ? 'Slot and type data were read from the computer. Confirm the exact part number against the OEM specification when ordering.' : 'Technician verification required before purchase.' };
}

const STD_SIZES = [256, 512, 1024, 2048, 4096];
export function storageRecommendation(hw: any, sys: { hdd: boolean; sizeBytes: number | null; usedBytes: number | null; condition: Condition; lowSpace: boolean } | null): Recommendation | null {
  if (!sys || !(sys.hdd || sys.lowSpace || CONDITION_RANK[sys.condition] >= CONDITION_RANK.REPLACEMENT_ADVISED)) return null;
  const why: string[] = [];
  if (sys.hdd) why.push('Windows runs from a mechanical hard disk. This is the largest single slowdown software cannot remove.');
  if (sys.lowSpace) why.push('The system drive is nearly full even after safe cleanup.');
  if (CONDITION_RANK[sys.condition] >= CONDITION_RANK.REPLACEMENT_ADVISED) why.push(`The drive's condition is ${sys.condition.replace(/_/g, ' ').toLowerCase()}.`);
  const disk = (hw?.disks ?? [])[0]; const bus: any[] = Array.isArray(hw?.storageBus) ? hw.storageBus : [];
  const bd = bus.find(b => b.sizeBytes && sys.sizeBytes && Math.abs(b.sizeBytes - sys.sizeBytes) < 0.03 * sys.sizeBytes) ?? bus[0];
  const iface = bd?.busType === 17 ? 'NVMe' : bd?.busType === 11 ? 'SATA' : /nvme/i.test(disk?.model ?? '') ? 'NVMe' : null;
  const need = Math.max(256, Math.ceil(((sys.usedBytes ?? 0) * 1.5) / GB));
  const cap = STD_SIZES.find(s => s >= need) ?? 4096;
  const unknowns = ['the physical form factor (M.2 2280, M.2 2242, 2.5-inch) cannot be read from Windows; confirm from the OEM specification or by inspection', 'the platform model data needed to verify compatibility is not available to Viro'];
  const evidence: string[] = [];
  if (iface) evidence.push(`Current drive interface: ${iface}`); else unknowns.unshift('the drive interface (NVMe or SATA) could not be read');
  if (disk?.model) evidence.push(`Current drive: ${disk.model}${sys.sizeBytes ? ' ' + Math.round(sys.sizeBytes / 1e9) + ' GB' : ''}`);
  return { kind: 'storage', title: sys.hdd ? 'Replace the hard disk with an SSD' : 'Storage replacement', why, current: `${disk?.model ?? 'System drive'}${sys.sizeBytes ? ' ' + Math.round(sys.sizeBytes / 1e9) + ' GB' : ''}${sys.hdd ? ' (mechanical)' : ''}`,
    recommended: `${cap >= 1024 ? cap / 1024 + ' TB' : cap + ' GB'} ${iface ?? 'SSD'} SSD, same form factor as the current drive`, expectedConfiguration: `Migration by disk cloning, then keep the old drive until the copy is verified`,
    compatibility: { confidence: iface ? 'MEDIUM' : 'LOW', evidence, unknowns }, verification: 'Technician verification required before purchase: form factor and platform compatibility are not verified by Viro.' };
}

export function batteryRecommendation(model: string | null, b: { condition: Condition; healthPercent: number | null; cycles: number | null } | null): Recommendation | null {
  if (!b || CONDITION_RANK[b.condition] < CONDITION_RANK.REPLACEMENT_ADVISED) return null;
  return { kind: 'battery', title: 'Battery replacement', why: [b.healthPercent != null ? `The battery holds ${b.healthPercent}% of its design capacity.` : 'The battery is worn.', ...(b.cycles != null ? [`${b.cycles} charge cycles recorded.`] : [])],
    current: b.healthPercent != null ? `${b.healthPercent}% of design capacity` : 'worn', recommended: `OEM replacement battery for ${model ?? 'this model'}`, compatibility: { confidence: 'MEDIUM', evidence: model ? [`Computer model: ${model}`] : [], unknowns: ['the battery part number is not readable from Windows'] },
    verification: 'Match the part number printed on the battery or in the OEM parts list before ordering.' };
}

/* ---------------------------------------------------------------------------------------------------------------------------------
 * Lifecycle
 * ------------------------------------------------------------------------------------------------------------------------------- */
export type LifecycleAction = 'KEEP' | 'MAINTAIN' | 'UPGRADE' | 'REPAIR' | 'MONITOR' | 'REPLACE';
export interface LifecycleInput {
  ageYears: number | null; ageConfidence: string; health: number | null; healthChange30d: number | null;
  storage: Condition; systemDisk: 'SSD' | 'HDD' | 'unknown'; battery: Condition | null; hardwareConstraints: string[]; osUnsupported: boolean;
  interventions12m: number; downtimeMinutes12m: number; serviceCost12m: number; purchaseCost: number | null; activeSoftwareIncidents: number;
}

export function lifecycleAssessment(i: LifecycleInput) {
  const age = i.ageYears, old = age != null && age >= 5;
  const signals: { weight: number; text: string }[] = [];
  const storageBad = CONDITION_RANK[i.storage] >= CONDITION_RANK.REPLACEMENT_ADVISED, batteryBad = i.battery != null && CONDITION_RANK[i.battery] >= CONDITION_RANK.REPLACEMENT_ADVISED;
  if (storageBad) signals.push({ weight: old ? 2 : 1, text: `The storage drive needs replacing (${i.storage.replace(/_/g, ' ').toLowerCase()})${old ? ' on an older computer' : ''}.` });
  if (batteryBad) signals.push({ weight: old && storageBad ? 2 : 1, text: 'The battery needs replacing.' });
  if (i.interventions12m >= 6) signals.push({ weight: 2, text: `${i.interventions12m} interventions in the last 12 months.` });
  if (i.health != null && i.health < 55) signals.push({ weight: 2, text: `Health is ${i.health} out of 100.` });
  if (i.healthChange30d != null && i.healthChange30d <= -15) signals.push({ weight: 1, text: `Health fell ${Math.abs(i.healthChange30d)} points in 30 days.` });
  if (i.osUnsupported) signals.push({ weight: 2, text: 'The installed Windows version no longer receives security updates.' });
  if (i.downtimeMinutes12m >= 16 * 60) signals.push({ weight: 1, text: `${Math.round(i.downtimeMinutes12m / 6) / 10} hours of recorded downtime in 12 months.` });
  if (i.purchaseCost && i.purchaseCost > 0) { const r = i.serviceCost12m / i.purchaseCost; if (r >= 0.6) signals.push({ weight: 2, text: `Service cost in 12 months is ${Math.round(r * 100)}% of the purchase cost.` }); else if (r >= 0.4) signals.push({ weight: 1, text: `Service cost in 12 months is ${Math.round(r * 100)}% of the purchase cost.` }); }
  if (i.hardwareConstraints.length && old) signals.push({ weight: 1, text: `Hardware limits (${i.hardwareConstraints.join(', ')}) on an older computer.` });
  const score = signals.reduce((a, s) => a + s.weight, 0);

  let action: LifecycleAction; const reasons: string[] = signals.map(s => s.text);
  if (score >= 4) action = 'REPLACE';
  else if (i.hardwareConstraints.length && !storageBad && !batteryBad) { action = 'UPGRADE'; reasons.unshift(`Hardware limits hold performance back (${i.hardwareConstraints.join(', ')}), and a part upgrade addresses them.`); }
  else if ((storageBad || batteryBad) && (age == null || age < 5)) { action = 'REPAIR'; reasons.unshift('A single worn part needs replacing; the rest of the computer is in good condition.'); }
  else if (i.activeSoftwareIncidents > 0 || (i.health != null && i.health < 80)) { action = 'MAINTAIN'; reasons.unshift('Software problems are being handled; the hardware is serviceable.'); }
  else if ((i.healthChange30d != null && i.healthChange30d <= -10) || CONDITION_RANK[i.storage] >= CONDITION_RANK.WATCH) { action = 'MONITOR'; reasons.unshift('Nothing needs replacing yet, but the condition is getting worse.'); }
  else { action = 'KEEP'; reasons.unshift('Performance is adequate and no component shows wear that needs action.'); if (i.systemDisk === 'SSD') reasons.push('The system drive is an SSD.'); if (i.interventions12m <= 2) reasons.push(i.interventions12m === 0 ? 'No repairs needed in the last 12 months.' : `Only ${i.interventions12m === 1 ? 'one repair' : 'two repairs'} in the last 12 months.`); if (!i.osUnsupported) reasons.push('Windows security support is current.'); }
  const condition = action === 'REPLACE' ? 'REPLACEMENT ADVISED' : action === 'KEEP' ? (old ? 'AGING BUT SERVICEABLE' : 'HEALTHY') : action === 'MONITOR' || (i.healthChange30d != null && i.healthChange30d <= -10) ? 'DEGRADING' : 'AGING BUT SERVICEABLE';
  const known = (i.ageYears != null ? 1 : 0) + (i.storage !== 'NOT_MEASURED' ? 1 : 0) + (i.health != null ? 1 : 0);
  return {
    action, condition, reasons, score, confidence: (known >= 3 && i.ageConfidence !== 'LOW' ? 'HIGH' : known >= 2 ? 'MEDIUM' : 'LOW') as Confidence,
    cost: { serviceCost12m: i.serviceCost12m, purchaseCost: i.purchaseCost, downtimeHours12m: Math.round(i.downtimeMinutes12m / 6) / 10, interventions12m: i.interventions12m },
    note: 'This is a recommendation from recorded facts. Viro does not predict when a computer will fail.',
  };
}
