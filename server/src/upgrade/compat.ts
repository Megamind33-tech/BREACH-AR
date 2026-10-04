/**
 * Phase 2: the motherboard-anchored CPU compatibility pipeline. A candidate must pass EVERY mandatory stage; the first failed stage decides the outcome and every
 * stage is still recorded so "view why" can show exactly what was checked. Unknown is not a pass: a stage that cannot be verified lowers confidence or blocks.
 */
import { modelScore, type CatalogCpu } from './platform-data.js';
import type { NormalMachine } from './normalize.js';
import type { Providers } from './providers.js';
import { UPGRADE_CONFIG } from './config.js';
import { thermalState } from './thermal.js';
import type { UpgradeContext } from './context.js';

export type StageStatus = 'pass' | 'fail' | 'unknown' | 'n/a';
export interface Stage { id: string; label: string; status: StageStatus; detail: string; confidence: number }
export type CpuDecision = 'INSTALL' | 'BIOS_UPDATE_REQUIRED' | 'REQUIRES_COOLING' | 'DO_NOT_INSTALL' | 'NOT_VERIFIED' | 'NO_MEANINGFUL_GAIN' | 'NOT_REPLACEABLE';
export interface CpuCandidateResult {
  candidate: CatalogCpu; stages: Stage[]; decision: CpuDecision; verdictText: string; requirements: string[];
  bios: { current: string | null; required: boolean | null; minimumVersion: string | null; action: string };
  gain: { single: number | null; multi: number | null; lowMulti: number | null; highMulti: number | null; basis: string };
  compatibilityConfidence: number; blockedAt: string | null;
}

export function installedScore(m: NormalMachine, p: Providers) {
  const cat = p.cpu.identify(m.cpu);
  if (cat) { const s = modelScore(cat); return s ? { ...s, basis: `specification of the installed ${cat.vendor} ${cat.model}`, confidence: 0.9, tdpW: cat.tdpW } : null; }
  const mhz = m.cpu.raw && /(\d\.\d+)\s*GHz/i.exec(m.cpu.raw); const ghz = mhz ? Number(mhz[1]) : null;
  if (m.cpu.cores && m.cpu.threads && ghz && m.cpu.architecture) {
    const s = modelScore({ cores: m.cpu.cores, threads: m.cpu.threads, baseGHz: ghz, boostGHz: ghz, architecture: m.cpu.architecture });
    if (s) return { ...s, basis: 'estimated from the detected core count and rated clock', confidence: 0.7, tdpW: null as number | null };
  }
  return null;
}

/** How much more sustained electrical work a candidate does than the installed processor (cores x all-core clock). Nominal TDP hides boost power, so a big jump is not treated as 'the same power class'. */
function powerStep(m: NormalMachine, c: CatalogCpu, installed: ReturnType<typeof installedScore>): number {
  const cs = modelScore(c); if (!cs || !installed) return 1;
  return cs.multi / installed.multi;
}

export function cpuPath(m: NormalMachine): { replaceable: boolean | null; reason: string } {
  if (m.cpu.soldered) return { replaceable: false, reason: `This is a mobile processor (${m.cpu.model}), normally soldered to the board. It cannot be replaced.` };
  if (m.formFactor === 'laptop' || m.formFactor === 'all-in-one') return { replaceable: false, reason: `This is a ${m.formFactor} computer: its processor is normally soldered or not accessible for replacement.` };
  if (!m.cpu.socket) return { replaceable: null, reason: 'The processor\'s socket could not be established, so replacement options are not assessed.' };
  return { replaceable: true, reason: `Socket ${m.cpu.socket}.` };
}

const stage = (id: string, label: string, status: StageStatus, detail: string, confidence = 1): Stage => ({ id, label, status, detail, confidence });

export function evaluateCpuCandidate(m: NormalMachine, c: CatalogCpu, ctx: UpgradeContext, p: Providers): CpuCandidateResult {
  const stages: Stage[] = []; const requirements: string[] = []; const cfg = UPGRADE_CONFIG;
  const installed = installedScore(m, p); const cat = p.cpu.identify(m.cpu); const th = thermalState(ctx);

  // 1 socket
  stages.push(m.cpu.socket == null ? stage('socket', 'Same socket', 'unknown', 'The installed processor\'s socket could not be established.', 0) : m.cpu.socket === c.socket ? stage('socket', 'Same socket', 'pass', `Both use ${c.socket}.`) : stage('socket', 'Same socket', 'fail', `The board takes ${m.cpu.socket}; this processor needs ${c.socket}.`, 0));
  // 2 chipset and 3 revision
  const sup = p.board.supports(m.board, m.cpu, c);
  stages.push(sup.verdict === 'yes' ? stage('chipset', 'Chipset supports it', 'pass', sup.basis, sup.confidence) : sup.verdict === 'no' ? stage('chipset', 'Chipset supports it', 'fail', sup.basis, 0) : stage('chipset', 'Chipset supports it', 'unknown', sup.basis, 0));
  stages.push(m.board.revision ? stage('revision', 'Board revision supported', 'pass', `Revision ${m.board.revision}.`, 0.99) : stage('revision', 'Board revision supported', 'unknown', 'The board revision is not reported by Windows. Revisions of the same board can differ in processor support.', m.board.oem ? 0.97 : 0.94));
  // 4 BIOS
  const bios = p.bios.biosFor(m.board, c, sup);
  const biosStage = sup.verdict !== 'yes' ? stage('bios', 'BIOS supports it', 'unknown', 'Not assessed: compatibility itself is not established.', 0)
    : bios.required === false ? stage('bios', 'BIOS supports it', 'pass', 'No BIOS update is needed for this processor.', 0.99)
    : bios.required === true ? stage('bios', 'BIOS supports it', 'unknown', bios.minimumVersion ? `Needs BIOS ${bios.minimumVersion} or later; the board has ${m.board.bios.version ?? 'an unknown version'}.` : `A BIOS update is needed first. The exact minimum version for this board was not verified: check the manufacturer\'s processor support list for ${m.board.model ?? 'this board'} (installed: ${m.board.bios.version ?? 'unknown'}).`, bios.minimumVersion ? 0.99 : 0.85)
    : stage('bios', 'BIOS supports it', 'unknown', 'Whether the installed BIOS supports this processor could not be verified.', 0.8);
  stages.push(biosStage);
  // 5 power delivery and TDP
  const instTdp = installed?.tdpW ?? null;
  if (instTdp == null) stages.push(stage('power', 'Power delivery and TDP', c.tdpW <= 65 ? 'unknown' : 'fail', c.tdpW <= 65 ? 'The installed processor\'s power rating is not known; this one is rated 65 W or less.' : `This processor is rated ${c.tdpW} W and the board\'s power delivery and supply cannot be read, so it is not recommended.`, c.tdpW <= 65 ? 0.9 : 0));
  else if (c.tdpW <= instTdp && powerStep(m, c, installed) > cfg.powerStepLimit) {
    const ratio = Math.round(powerStep(m, c, installed) * 100) / 100;
    stages.push(m.board.oem ? stage('power', 'Power delivery and TDP', 'fail', `The rated power is the same (${c.tdpW} W) but this processor has about ${Math.round((ratio - 1) * 100)}% more cores and clock to feed, and draws far more than its rating while boosting. Office-class computers (OEM boards, small supplies and coolers) are built around the original processor, and the supply and cooler cannot be read by software. It is only possible if the supply and cooler are verified in the case.`, 0)
      : stage('power', 'Power delivery and TDP', 'unknown', `Rated ${c.tdpW} W like the installed processor, but it has about ${Math.round((ratio - 1) * 100)}% more cores and clock and boosts well above its rating. The supply and the board's power delivery cannot be read; check them before buying.`, 0.85));
  }
  else if (c.tdpW <= instTdp) stages.push(stage('power', 'Power delivery and TDP', 'pass', `${c.tdpW} W, no more than the installed processor's ${instTdp} W, so the existing power delivery and supply already carry it. The supply's own rating cannot be read.`, 0.97));
  else stages.push(stage('power', 'Power delivery and TDP', 'fail', `${c.tdpW} W is more than the installed ${instTdp} W. The board's power delivery and the supply cannot be read by software, so a higher-power processor is not recommended without them being verified.`, 0));
  // 6 cooling
  if (c.tdpW > (instTdp ?? 65)) stages.push(stage('cooling', 'Cooling capacity', 'fail', `A cooler rated for at least ${c.tdpW} W is required, and the existing cooler cannot be identified.`, 0));
  else if (th.state === 'throttling' || th.state === 'hot') stages.push(stage('cooling', 'Cooling capacity', 'fail', `The computer already runs too hot for the processor it has (${th.reasons.join('; ')}). A faster processor would throttle sooner.`, 0));
  else if (th.state === 'unknown') stages.push(stage('cooling', 'Cooling capacity', 'unknown', 'No temperature or throttling information is available yet.', 0.93));
  else stages.push(stage('cooling', 'Cooling capacity', 'pass', `No heat limiting seen (${th.reasons.join('; ') || 'temperatures normal'}). Same power class as the installed processor.`, 0.97));
  // 7 operating system and memory
  const win11 = c.vendor === 'Intel' ? c.generation >= 8 : c.generation >= 2;
  const installedWin11 = m.cpu.generation == null ? null : m.cpu.vendor === 'Intel' ? m.cpu.generation >= 8 : m.cpu.generation >= 2;
  stages.push(ctx.windows.running11 && !win11 && installedWin11 !== false ? stage('os', 'Operating system support', 'fail', 'This processor is not on the Windows 11 supported list and Windows 11 is installed on a supported one.', 0) : stage('os', 'Operating system support', 'pass', win11 ? 'Supported by Windows 11.' : installedWin11 === false ? 'Not on the Windows 11 list, which is also true of the installed processor, so this is no worse.' : 'Supported by Windows 10 only.', 1));
  const ramType = m.memory.dimms[0]?.type ?? null;
  stages.push(!ramType ? stage('memtype', 'Memory type', 'unknown', 'The installed memory type could not be read.', 0.9) : ramType === c.memory.type ? stage('memtype', 'Memory type', 'pass', `Installed ${ramType} is what this processor uses.`) : stage('memtype', 'Memory type', 'fail', `The computer has ${ramType}; this processor uses ${c.memory.type}.`, 0));
  // 8 gain
  const cs = modelScore(c); let single: number | null = null, multi: number | null = null, lowMulti: number | null = null, highMulti: number | null = null; let basis = 'No installed-processor figures to compare with.';
  if (installed && cs) {
    single = Math.round((cs.single / installed.single - 1) * 1000) / 10; multi = Math.round((cs.multi / installed.multi - 1) * 1000) / 10;
    const band = cfg.uncertaintyBand; lowMulti = Math.round(((cs.multi * (1 - band)) / installed.multi - 1) * 1000) / 10; highMulti = Math.round(((cs.multi * (1 + band)) / installed.multi - 1) * 1000) / 10;
    basis = `Predicted from published specifications (${installed.basis}); a range, because it is a model until this computer is measured.`;
    const o = p.outcomes.outcomes(m.board, m.cpu.model, c.model);
    if (o && o.successes >= cfg.outcomesMinInstalls && o.medianGain != null) { multi = Math.round(o.medianGain * 1000) / 10; lowMulti = Math.round(o.medianGain * 850) / 10; highMulti = Math.round(o.medianGain * 1150) / 10; basis = `Observed on ${o.successes} verified WorkCare installations on this board (median improvement ${multi}%).`; }
  }
  const best = Math.max(single ?? -100, multi ?? -100);
  stages.push(!installed || !cs ? stage('gain', 'Meaningful performance gain', 'unknown', 'The installed processor\'s performance could not be established, so no benefit can be proven.', 0)
    : best >= cfg.minGainPercent ? stage('gain', 'Meaningful performance gain', 'pass', `Predicted ${single}% single-thread and ${multi}% multi-thread (${lowMulti}% to ${highMulti}%).`, installed.confidence)
    : stage('gain', 'Meaningful performance gain', 'fail', `Predicted gain of ${Math.max(single ?? 0, multi ?? 0)}% is below the ${cfg.minGainPercent}% that justifies the cost and effort.`, 0));
  // 9 economics
  const price = ctx.prices?.items?.[`cpu_${c.id}`]; const newPc = ctx.prices?.newPc?.desktop ?? ctx.prices?.newPc?.unknown ?? null;
  stages.push(price == null ? stage('economics', 'Economically rational', 'unknown', 'No price has been entered for this processor.', 0.95)
    : newPc != null && price + (ctx.prices?.labourPerHour ?? 0) > newPc * cfg.maxCostShare && best < 60 ? stage('economics', 'Economically rational', 'fail', `Costs more than ${Math.round(cfg.maxCostShare * 100)}% of a new computer for a gain under 60%.`, 0)
    : stage('economics', 'Economically rational', 'pass', `${price} for a predicted ${multi ?? single}% gain.`, 1));

  const failed = stages.find(s => s.status === 'fail'); const unknown = stages.filter(s => s.status === 'unknown');
  const conf = stages.reduce((a, s) => a * (s.status === 'fail' ? 0 : s.status === 'n/a' ? 1 : s.status === 'unknown' ? s.confidence : s.confidence), 1);
  let decision: CpuDecision; let text: string; let blockedAt: string | null = failed?.id ?? null;
  const chipsetUnknown = stages.find(s => s.id === 'chipset')!.status === 'unknown' || stages.find(s => s.id === 'socket')!.status === 'unknown';
  if (chipsetUnknown && failed && failed.id !== 'gain' && failed.id !== 'socket' && failed.id !== 'chipset') { decision = 'NOT_VERIFIED'; text = 'COMPATIBILITY NOT YET VERIFIED'; blockedAt = 'chipset'; }
  else if (failed) {
    decision = failed.id === 'gain' ? 'NO_MEANINGFUL_GAIN' : failed.id === 'cooling' && c.tdpW <= (instTdp ?? 65) ? 'REQUIRES_COOLING' : 'DO_NOT_INSTALL';
    text = decision === 'REQUIRES_COOLING' ? 'NOT RECOMMENDED WITH THE CURRENT COOLING. Fix the heat problem first.' : decision === 'NO_MEANINGFUL_GAIN' ? 'REJECTED: the improvement is too small to justify the cost.' : 'DO NOT INSTALL';
    if (decision === 'REQUIRES_COOLING') requirements.push('Clean the cooling system and renew the thermal paste, then re-measure before reconsidering.');
  } else if (chipsetUnknown) { decision = 'NOT_VERIFIED'; text = 'COMPATIBILITY NOT YET VERIFIED'; blockedAt = 'chipset'; }
  else if (stages.find(s => s.id === 'bios')!.detail.startsWith('Needs') || bios.required === true) { decision = 'BIOS_UPDATE_REQUIRED'; text = 'UPDATE THE BIOS BEFORE INSTALLATION'; requirements.push(bios.minimumVersion ? `Update the BIOS to ${bios.minimumVersion} or later before fitting the processor.` : `Update the BIOS to the manufacturer's current version before fitting the processor, and confirm ${c.vendor} ${c.model} is on the board's support list.`); }
  else if (stages.find(s => s.id === 'gain')!.status === 'unknown') { decision = 'NOT_VERIFIED'; text = 'NOT ENOUGH VERIFIED INFORMATION'; blockedAt = 'gain'; }
  else { decision = 'INSTALL'; text = 'COMPATIBLE: direct replacement'; }
  if (decision !== 'DO_NOT_INSTALL' && decision !== 'NOT_VERIFIED') { requirements.push('Fit with the computer switched off and unplugged; reapply thermal paste.'); if (m.cpu.socket && m.cpu.socket !== c.socket) requirements.push('Socket mismatch.'); }
  void unknown;
  return { candidate: c, stages, decision, verdictText: text, requirements, bios: { current: m.board.bios.version, required: bios.required, minimumVersion: bios.minimumVersion, action: bios.required === true ? 'Update before installation' : bios.required === false ? 'No update required' : 'Not verified' },
    gain: { single, multi, lowMulti, highMulti, basis }, compatibilityConfidence: Math.round(conf * 100) / 100, blockedAt };
}
