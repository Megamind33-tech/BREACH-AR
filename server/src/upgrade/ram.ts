/**
 * Phase 3: memory topology and upgrade resolver. It looks at each module, works out the channel arrangement (or says it cannot), finds real problems
 * (single channel, mismatched or slow modules) and proposes only what the board can take. Capacity is recommended only when usage justifies it.
 */
import type { NormalMachine, NormalDimm } from './normalize.js';
import type { Providers } from './providers.js';
import type { UpgradeContext } from './context.js';
import { UPGRADE_CONFIG as cfg } from './config.js';

export type ChannelMode = 'single' | 'dual' | 'unknown' | 'soldered' | 'none';
export interface RamIssue { code: string; text: string; severity: 'info' | 'low' | 'medium' | 'high' }
export interface RamPart { type: string; formFactor: string | null; capacityGB: number; quantity: number; minMTs: number | null; voltageV: number | null; matchWith: string | null; label: string }
export interface RamOption {
  id: string; title: string; why: string; benefit: 'MEMORY_BANDWIDTH' | 'CAPACITY' | 'BANDWIDTH_AND_CAPACITY' | 'CONFIGURATION'; part: RamPart | null; resultingGB: number | null; resultingConfig: string; priceKey: string | null; labourHours: number;
  effort: string; confidence: number; essential: boolean; gain: { low: number | null; high: number | null; basis: string };
}
export interface RamAnalysis { mode: ChannelMode; modeBasis: string; description: string; issues: RamIssue[]; options: RamOption[]; capacityNeed: { established: boolean; text: string }; confidence: number }

const STANDARD = [4, 8, 16, 32, 64, 128];

export function analyseRam(m: NormalMachine, ctx: UpgradeContext, p: Providers): RamAnalysis {
  const d = m.memory.dimms; const issues: RamIssue[] = []; const options: RamOption[] = []; let conf = 0.95;
  const plat = p.memory.socketMemory(m.cpu.socket); const channels = plat?.channels ?? (m.formFactor === 'laptop' ? 2 : null);
  if (!d.length) return { mode: 'unknown', modeBasis: 'No memory modules could be read.', description: 'Memory could not be read.', issues, options, capacityNeed: { established: false, text: 'Memory could not be read.' }, confidence: 0.3 };
  const soldered = m.memory.slotsTotal === 0 || d.every(x => /^LPDDR/.test(x.type ?? '')) || d.every(x => !x.formFactor && (x.slot ?? '').toLowerCase().includes('onboard'));
  const total = m.memory.totalGB ?? 0;
  // ---- channel arrangement
  let mode: ChannelMode; let basis: string;
  if (soldered) { mode = 'soldered'; basis = 'The memory is soldered to the board.'; }
  else if (d.length === 1) { mode = 'single'; basis = 'Only one module is installed.'; }
  else {
    const chs = d.map(x => x.channel);
    if (chs.every(Boolean)) { const n = new Set(chs).size; mode = n >= 2 ? 'dual' : 'single'; basis = `Slot labels name channels ${[...new Set(chs)].join(' and ')}.`; }
    else if (m.memory.slotsTotal === 2) { mode = 'dual'; basis = 'A two-slot board puts one module on each channel.'; }
    else { mode = 'unknown'; basis = 'Windows does not say which slots the modules are in, so the channel arrangement cannot be confirmed.'; conf -= 0.12; }
  }
  if (mode === 'unknown' && d.length >= 2) issues.push({ code: 'channel-unverified', text: 'The modules are probably running as a pair, but which slots they occupy cannot be read. Check against the motherboard manual.', severity: 'info' });
  const sameCap = new Set(d.map(x => x.capacityGB)).size === 1; const kit = sameCap ? `${d.length} × ${d[0]!.capacityGB ?? '?'} GB` : d.map(x => `${x.capacityGB ?? '?'} GB`).join(' + ');
  const desc = `${kit} ${d[0]!.type ?? ''} ${d[0]!.configuredMTs ?? d[0]!.ratedMTs ?? ''}${d[0]!.configuredMTs || d[0]!.ratedMTs ? ' MT/s' : ''}`.replace(/\s+/g, ' ').trim() + ` (${mode === 'dual' ? 'dual-channel' : mode === 'single' ? 'single-channel' : mode === 'soldered' ? 'soldered' : 'channel arrangement not confirmed'})`;
  // ---- real problems
  const types = new Set(d.map(x => x.type).filter(Boolean)); if (types.size > 1) issues.push({ code: 'mixed-type', text: 'Different memory types are installed together.', severity: 'high' });
  const caps = new Set(d.map(x => x.capacityGB)); if (d.length > 1 && caps.size > 1) issues.push({ code: 'mixed-capacity', text: `Modules of different sizes (${[...caps].join(' and ')} GB): part of the memory runs single-channel.`, severity: 'medium' });
  const rated = d.map(x => x.ratedMTs).filter((x): x is number => x != null), conf2 = d.map(x => x.configuredMTs).filter((x): x is number => x != null);
  if (new Set(conf2).size > 1) issues.push({ code: 'mixed-speed', text: 'Modules run at different speeds; all run at the slowest.', severity: 'medium' });
  if (rated.length && conf2.length && Math.max(...conf2) < Math.min(...rated) * 0.93) issues.push({ code: 'below-rated', text: `The memory is rated ${Math.min(...rated)} MT/s but runs at ${Math.max(...conf2)} MT/s. A BIOS memory profile (XMP/DOCP) may be off, or the processor limits it.`, severity: 'low' });
  if (mode === 'single' && !soldered && d.length === 1) issues.push({ code: 'single-channel', text: 'One module means single-channel operation: memory bandwidth is about half of what the platform provides.', severity: 'medium' });
  const need = capacityNeed(total, ctx);

  const free = m.memory.slotsTotal != null && m.memory.slotsUsed != null ? m.memory.slotsTotal - m.memory.slotsUsed : null;
  const max = m.memory.maxGB; const mod = d[0]!; const type = mod.type; const form = mod.formFactor;
  const matchSpec = [mod.manufacturer, mod.partNumber].filter(Boolean).join(' ') || null;
  const canTake = !!type && plat?.types.includes(type) !== false;
  if (soldered) { issues.push({ code: 'soldered', text: 'The memory is soldered to the board and cannot be upgraded.', severity: 'info' }); return { mode, modeBasis: basis, description: desc, issues, options, capacityNeed: need, confidence: conf }; }

  // A. fill the second channel with a matching module
  if (mode === 'single' && d.length === 1 && free != null && free >= 1 && canTake && channels && channels >= 2 && mod.capacityGB) {
    const newTotal = total + mod.capacityGB; const withinMax = max == null || newTotal <= max;
    if (withinMax) {
      const capHelps = need.established ? newTotal >= need.targetGB! : true;
      options.push({ id: 'ram-second-channel', title: `Add 1 × ${mod.capacityGB} GB ${type} matching the installed module`, benefit: need.established && need.targetGB! > total ? 'BANDWIDTH_AND_CAPACITY' : 'MEMORY_BANDWIDTH',
        why: `Memory is single-channel (${basis.toLowerCase()}). A matching second module runs both channels, up to doubling memory bandwidth${need.established && need.targetGB! > total ? ` and gives the ${newTotal} GB this computer's usage calls for` : ''}.`,
        part: { type: type!, formFactor: form, capacityGB: mod.capacityGB, quantity: 1, minMTs: mod.ratedMTs ?? mod.configuredMTs, voltageV: mod.voltageV, matchWith: matchSpec, label: `${mod.capacityGB} GB ${type} ${form ?? ''} ${mod.ratedMTs ?? ''} MT/s`.replace(/\s+/g, ' ').trim() },
        resultingGB: newTotal, resultingConfig: `${newTotal} GB dual-channel`, priceKey: priceKeyFor(type), labourHours: 0.5, effort: 'Fit in the empty slot; no settings to change', confidence: capHelps ? 0.93 : 0.9, essential: false,
        gain: { low: 8, high: 35, basis: 'Memory bandwidth can double; the real-world gain depends on the work (graphics from shared memory and heavy multitasking gain most). Verified by measurement after installation.' } });
    }
  }
  // B. capacity that usage justifies
  if (need.established && total < need.targetGB!) {
    const target = need.targetGB!; const perModule = channels && channels >= 2 ? target / 2 : target;
    const cap = max != null ? max : null;
    if (cap != null && target > cap) issues.push({ code: 'board-limit', text: `Usage calls for ${target} GB but the board reports a ${cap} GB limit.`, severity: 'info' });
    else if (canTake && !options.some(o => o.id === 'ram-second-channel' && o.resultingGB! >= target)) {
      const addN = mod.capacityGB ? (target - total) / mod.capacityGB : NaN;
      if (free != null && mode !== 'single' && mod.capacityGB && Number.isInteger(addN) && addN >= 1 && addN <= free && new Set(d.map(x => x.capacityGB)).size === 1 && (d.length + addN) % 2 === 0) {
        const add = addN;
        options.push({ id: 'ram-add-modules', title: `Add ${add} × ${mod.capacityGB} GB ${type}${form ? ' ' + form : ''}`, benefit: 'CAPACITY', why: `Memory use peaks at ${ctx.ramPeakPercent}% of ${total} GB. ${target} GB keeps it below ${Math.round(cfg.ramHeadroom * 100)}%.`, part: { type: type!, formFactor: form, capacityGB: mod.capacityGB, quantity: add, minMTs: mod.ratedMTs, voltageV: mod.voltageV, matchWith: matchSpec, label: `${mod.capacityGB} GB ${type} ${form ?? ''} ${mod.ratedMTs ?? ''} MT/s`.replace(/\s+/g, ' ').trim() },
          resultingGB: total + add * mod.capacityGB, resultingConfig: `${total + add * mod.capacityGB} GB`, priceKey: priceKeyFor(type), labourHours: 0.5, effort: 'Fit in empty slots', confidence: 0.9, essential: need.critical, gain: { low: null, high: null, basis: 'Removes memory pressure: fewer stalls and less paging to disk.' } });
      } else if (type) {
        const each = perModule >= 4 ? perModule : target; const qty = channels && channels >= 2 ? 2 : 1;
        if (free == null || m.memory.slotsTotal == null || m.memory.slotsTotal >= qty)
          options.push({ id: 'ram-replace-kit', title: `Replace the memory with ${qty} × ${each} GB ${type}${form ? ' ' + form : ''} (${each * qty} GB)`, benefit: mode === 'single' ? 'BANDWIDTH_AND_CAPACITY' : 'CAPACITY', why: `Memory use peaks at ${ctx.ramPeakPercent}% of ${total} GB and the free slots cannot reach ${target} GB with the installed module size.`,
            part: { type, formFactor: form, capacityGB: each, quantity: qty, minMTs: mod.ratedMTs, voltageV: mod.voltageV, matchWith: null, label: `${qty} × ${each} GB ${type} ${form ?? ''} kit, ${mod.ratedMTs ?? 'same or higher'} MT/s`.replace(/\s+/g, ' ').trim() },
            resultingGB: each * qty, resultingConfig: `${each * qty} GB ${qty > 1 ? 'dual-channel' : ''}`.trim(), priceKey: priceKeyFor(type), labourHours: 0.5, effort: 'Replace the modules (old ones can be kept as spares)', confidence: 0.88, essential: need.critical, gain: { low: null, high: null, basis: 'Removes memory pressure.' } });
      }
    }
  }
  // C. free configuration fix
  if (issues.some(i => i.code === 'below-rated') && !m.board.oem)
    options.push({ id: 'ram-profile', title: 'Turn on the memory speed profile in the BIOS (XMP/DOCP)', why: issues.find(i => i.code === 'below-rated')!.text, benefit: 'CONFIGURATION', part: null, resultingGB: total, resultingConfig: desc, priceKey: null, labourHours: 0.25, effort: 'BIOS setting, no parts', confidence: 0.75, essential: false, gain: { low: 2, high: 8, basis: 'Small bandwidth gain.' } });
  if (issues.some(i => i.code === 'mixed-type')) conf -= 0.2;
  return { mode, modeBasis: basis, description: desc, issues, options, capacityNeed: need, confidence: Math.max(0.3, conf) };
}

function priceKeyFor(type: string | null) { return type === 'DDR3' ? 'ram_ddr3' : type === 'DDR4' ? 'ram_ddr4' : type === 'DDR5' ? 'ram_ddr5' : null; }

export function capacityNeed(totalGB: number, ctx: UpgradeContext): { established: boolean; text: string; targetGB?: number; critical: boolean } {
  if (ctx.ramPeakPercent == null || !totalGB) return { established: false, critical: false, text: 'Memory capacity need is not established: it takes usage history from the computer. Capacity is only recommended when usage justifies it.' };
  const peakUsed = totalGB * ctx.ramPeakPercent / 100; const critical = ctx.ramPeakPercent >= cfg.ramCriticalPercent;
  if (ctx.ramPeakPercent <= cfg.ramHeadroom * 100) return { established: false, critical: false, text: `Memory use peaks at ${ctx.ramPeakPercent}% of ${totalGB} GB: capacity is adequate for the way this computer is used.` };
  const needed = peakUsed / cfg.ramHeadroom; const target = STANDARD.find(s => s >= needed) ?? STANDARD[STANDARD.length - 1]!;
  return { established: true, critical, targetGB: target, text: `Memory use peaks at ${ctx.ramPeakPercent}% of ${totalGB} GB (about ${Math.round(peakUsed * 10) / 10} GB). ${target} GB would keep the peak under ${Math.round(cfg.ramHeadroom * 100)}%.` };
}
export type { NormalDimm };
