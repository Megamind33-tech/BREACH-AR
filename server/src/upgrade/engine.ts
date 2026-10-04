/**
 * Phases 5 and 6: candidate generation, constraint validation, performance prediction, scoring and confidence, then the customer-facing recommendation set.
 * Layers stay separate: normalize -> compat/ram/resolvers (validate) -> candidates (combine) -> score -> report (present). Nothing is recommended that failed validation.
 */
import { normalizeMachine, type NormalMachine } from './normalize.js';
import { analyseRam, type RamAnalysis, type RamOption } from './ram.js';
import { storageOptions, coolingOptions, type Benefit, type SimpleOption } from './resolvers.js';
import { cpuPath, evaluateCpuCandidate, installedScore, type CpuCandidateResult, type Stage } from './compat.js';
import { defaultProviders, type Providers } from './providers.js';
import { emptyContext, type UpgradeContext } from './context.js';
import { UPGRADE_CONFIG as cfg } from './config.js';
import { thermalState } from './thermal.js';
import { lifeStage } from '../anatomy-engine.js';

type Obj = Record<string, any>;
export type RecClass = 'ESSENTIAL' | 'HIGH_VALUE' | 'OPTIONAL';
export interface Cost { currency: string; parts: number | null; labour: number | null; total: number | null; priced: boolean }
export interface Recommendation {
  id: string; class: RecClass; component: 'cpu' | 'memory' | 'storage' | 'cooling'; title: string; summary: string; benefit: Benefit;
  compatibility: { status: 'VERIFIED' | 'VERIFIED_AFTER_BIOS_UPDATE' | 'VERIFIED_WITH_CONDITIONS'; text: string; checks: Stage[] };
  installation: { effort: string; requirements: string[]; bios: string; cooling: string };
  expected: { text: string; lowPercent: number | null; highPercent: number | null; basis: string };
  confidence: { compatibility: number; performance: number; overall: number; lowerBecause: string[] };
  why: string[]; cost: Cost | null; part: Obj | null; dependsOn: string[];
}
export interface NotRecommended { title: string; decision: string; text: string; reasons: string[]; unlockedBy: string | null }
export interface Bundle { id: string; title: string; members: string[]; expectedText: string; confidence: number; cost: Cost | null }

const pct = (n: number | null | undefined) => (n == null ? null : Math.round(n));
const range = (lo: number | null, hi: number | null) => (lo == null || hi == null ? null : `+${Math.max(0, Math.round(lo))}–${Math.round(hi)}%`);

function costOf(ctx: UpgradeContext, priceKey: string | null, qty: number, hours: number): Cost | null {
  const b = ctx.prices; if (!b) return null;
  const unit = priceKey ? b.items[priceKey] : null; const parts = unit != null ? unit * qty : null; const labour = hours * b.labourPerHour;
  return { currency: b.currency, parts, labour, total: parts != null ? Math.round((parts + labour) * 100) / 100 : null, priced: parts != null };
}

export interface BuildOptions { providers?: Providers; internal?: boolean }

export function buildUpgradeReport(a: Obj, ctxIn: Partial<UpgradeContext> = {}, opts: BuildOptions = {}) {
  const ctx: UpgradeContext = { ...emptyContext(ctxIn.now), ...ctxIn };
  const p = opts.providers ?? defaultProviders();
  const m = normalizeMachine(a);
  const gaps: string[] = [];
  if (!m.board.model) gaps.push('The motherboard model could not be read.');
  if (!m.board.chipset) gaps.push(m.board.oem ? `This is an OEM board (${m.board.manufacturer} ${m.board.model}); its chipset is not stated by the name and not assumed.` : 'The chipset could not be identified.');
  if (!m.board.revision) gaps.push('The board revision is not reported by Windows.');
  if (!m.cpu.socket && m.cpu.soldered !== true && m.formFactor !== 'laptop') gaps.push('The processor socket could not be established.');
  gaps.push('The power supply rating and the installed cooler cannot be read by software.');
  if (ctx.benchmark == null) gaps.push('No controlled performance baseline has been measured on this computer yet.');
  if (ctx.ramPeakPercent == null) gaps.push('No memory-usage history is available yet, so memory capacity need is not established.');

  const ram = analyseRam(m, ctx, p);
  const th = thermalState(ctx);
  const path = cpuPath(m);
  const ctxCool: UpgradeContext = { ...ctx, thermal: { throttleEvents7d: 0, maxIdleTempC: ctx.thermal.maxIdleTempC != null ? Math.min(ctx.thermal.maxIdleTempC, 60) : null }, benchmark: ctx.benchmark ? { ...ctx.benchmark, cpuSustainedRatio: 1, peakTempC: Math.min(ctx.benchmark.peakTempC ?? 0, 80) } : null };

  // ---- CPU candidates (only when the processor is replaceable and its socket is known)
  const cpuResults: CpuCandidateResult[] = []; const cpuFixed: CpuCandidateResult[] = [];
  if (path.replaceable && m.cpu.socket) for (const c of p.cpu.candidatesFor(m.cpu.socket)) {
    if (p.cpu.identify(m.cpu)?.id === c.id) continue;   // the processor it already has
    cpuResults.push(evaluateCpuCandidate(m, c, ctx, p)); cpuFixed.push(evaluateCpuCandidate(m, c, ctxCool, p));
  }
  const installed = installedScore(m, p);

  // ---- individual options, validated
  const recs: Recommendation[] = []; const notRecommended: NotRecommended[] = [];
  const coolOpts = coolingOptions(m, ctx); const storOpts = storageOptions(m, ctx);
  const coolId = coolOpts[0]?.id ?? null;

  const lowerBecause = (stages: Stage[], extra: string[] = []) => [...stages.filter(s => s.status === 'unknown').map(s => s.detail), ...extra];

  for (const o of coolOpts) recs.push(simpleRec(o, ctx, m));
  for (const o of storOpts) recs.push(simpleRec(o, ctx, m));
  for (const o of ram.options) recs.push(ramRec(o, ram, ctx));

  const verified = cpuResults.filter(r => r.decision === 'INSTALL' || r.decision === 'BIOS_UPDATE_REQUIRED');
  const needCooling = cpuResults.filter(r => r.decision === 'REQUIRES_COOLING');
  const pickBest = (xs: CpuCandidateResult[]) => xs.slice().sort((x, y) => (y.gain.multi ?? -99) * y.compatibilityConfidence - (x.gain.multi ?? -99) * x.compatibilityConfidence)[0] ?? null;
  const bestCpu = pickBest(verified);
  if (bestCpu) recs.push(cpuRec(bestCpu, ctx, m, null));
  // a processor that is only blocked by heat becomes valid together with the cooling service
  if (!bestCpu || true) {
    const fixedOk = cpuFixed.filter((r, i) => cpuResults[i]!.decision === 'REQUIRES_COOLING' && (r.decision === 'INSTALL' || r.decision === 'BIOS_UPDATE_REQUIRED'));
    const bestFixed = pickBest(fixedOk);
    if (bestFixed && coolId && (!bestCpu || (bestFixed.gain.multi ?? 0) > (bestCpu.gain.multi ?? 0) + 5)) recs.push(cpuRec(bestFixed, ctx, m, coolId));
    else if (needCooling.length && !bestFixed) { const r = needCooling[0]!; notRecommended.push({ title: `Processor upgrade (${r.candidate.vendor} ${r.candidate.model})`, decision: r.decision, text: r.verdictText, reasons: r.stages.filter(s => s.status === 'fail').map(s => s.detail), unlockedBy: coolId }); }
  }
  // candidates that were examined and rejected, summarised honestly (best few, by why)
  const rejected = cpuResults.filter(r => r.decision === 'DO_NOT_INSTALL' || r.decision === 'NOT_VERIFIED' || r.decision === 'NO_MEANINGFUL_GAIN');
  const groups = new Map<string, CpuCandidateResult[]>(); for (const r of rejected) { const k = `${r.decision}|${r.stages.find(s => s.status !== 'pass' && s.status !== 'n/a')?.detail ?? ''}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  for (const rs of [...groups.values()].sort((x, y) => y.length - x.length).slice(0, 4)) {
    const r = rs[0]!; const names = rs.slice(0, 4).map(x => `${x.candidate.vendor} ${x.candidate.model}`).join(', ');
    notRecommended.push({ title: `Processors: ${names}${rs.length > 4 ? ` and ${rs.length - 4} more` : ''}`, decision: r.decision, text: r.verdictText, reasons: [...r.stages.filter(s => s.status === 'fail'), ...r.stages.filter(s => s.status === 'unknown' && !['revision', 'economics'].includes(s.id))].map(s => s.detail).slice(0, 3), unlockedBy: null });
  }
  if (!path.replaceable) notRecommended.unshift({ title: 'Processor upgrade', decision: 'NOT_REPLACEABLE', text: path.replaceable === false ? 'THE PROCESSOR CANNOT BE REPLACED' : 'NOT ENOUGH VERIFIED INFORMATION', reasons: [path.reason], unlockedBy: null });

  // ---- classes
  for (const r of recs) r.class = r.class === 'ESSENTIAL' ? 'ESSENTIAL' : (r.expected.highPercent ?? 0) >= cfg.strongGainPercent || r.benefit === 'SYSTEM_RESPONSIVENESS' ? 'HIGH_VALUE' : 'OPTIONAL';
  // minimum benefit: nothing optional below the threshold is shown
  const shown = recs.filter(r => r.class === 'ESSENTIAL' || r.benefit === 'SYSTEM_RESPONSIVENESS' || r.benefit === 'CONFIGURATION' || (r.expected.highPercent ?? 100) >= cfg.minGainPercent);
  const order = { ESSENTIAL: 0, HIGH_VALUE: 1, OPTIONAL: 2 } as const;
  const scored = shown.map(r => ({ r, score: scoreOf(r, installed, ctx, m) })).sort((x, y) => order[x.r.class] - order[y.r.class] || y.score - x.score);
  const finalRecs = scored.map(s => s.r);

  // ---- combinations (internal search; only a few beneficial, valid bundles are surfaced)
  const bundles = makeBundles(scored.map(s => s.r), ctx, m);

  // ---- replacement or upgrade
  const form = m.formFactor === 'unknown' ? 'unknown' : m.formFactor === 'small-form-factor' ? 'desktop' : m.formFactor;
  const replacement = replacementDecision(finalRecs, bundles, ctx, form, path.replaceable, m);
  const opportunity = grade(finalRecs, replacement, ctx);
  const essential = finalRecs.filter(r => r.class === 'ESSENTIAL').length;
  const health = essential ? 'Needs attention' : th.state === 'throttling' || ram.issues.some(i => i.severity === 'high') ? 'Fair' : 'Good';
  const best = finalRecs[0] && replacement.action !== 'REPLACE_MACHINE' ? finalRecs.find(r => r.class === 'ESSENTIAL') ?? finalRecs.find(r => r.class === 'HIGH_VALUE') ?? finalRecs[0]! : null;

  const report = {
    generatedAt: ctx.now.toISOString(), collectedAt: a.collectedAt ?? null,
    machine: {
      form: m.formFactor, cpu: { name: m.cpu.raw, family: m.cpu.family, model: m.cpu.model, generation: m.cpu.generation, architecture: m.cpu.architecture, socket: m.cpu.socket, cores: m.cpu.cores, threads: m.cpu.threads, notes: m.cpu.notes },
      board: { manufacturer: m.board.manufacturer, model: m.board.model, chipset: m.board.chipset, oem: m.board.oem, bios: m.board.bios, notes: m.board.notes },
      memory: { description: ram.description, mode: ram.mode, modeBasis: ram.modeBasis, slots: m.memory.slotsTotal, slotsUsed: m.memory.slotsUsed, maxGB: m.memory.maxGB, issues: ram.issues, capacityNeed: ram.capacityNeed.text, modules: m.memory.dimms },
      storage: m.disks.map(d => ({ model: d.model, kind: d.kind, sizeGB: d.sizeGB, health: d.health, system: d.system })), graphics: m.gpus.map(g => ({ name: g.name, integrated: g.integrated })),
    },
    health, essentialCount: essential, cpuPath: path,
    best: best?.id ?? null, recommendations: finalRecs, bundles, notRecommended, replacement, opportunity,
    notAssessed: [
      ...(ctx.workload.gpuBound == null ? [{ item: 'Graphics upgrade', reason: 'A graphics card is only recommended when a graphics-bound workload is detected (rendering, CAD, video or compute work). None has been observed on this computer.' }] : []),
      { item: 'Power supply', reason: 'The wattage cannot be read by software; it matters for processor and graphics changes.' },
    ],
    gaps, baseline: { measured: ctx.benchmark != null, text: ctx.benchmark ? 'Controlled measurements exist for this computer; predictions are checked against them after installation.' : 'Run the controlled baseline measurement to raise the confidence of every performance prediction and to prove the result of an upgrade afterwards.' },
  };
  return opts.internal ? { ...report, internal: { scores: scored.map(s => ({ id: s.r.id, score: s.score })), cpuResults: cpuResults.map(r => ({ model: r.candidate.model, decision: r.decision, stages: r.stages, confidence: r.compatibilityConfidence })), weights: cfg.weights } } : report;
  void lowerBecause;
}

// ---- builders -----------------------------------------------------------------------------------------------------------------------------------------
function simpleRec(o: SimpleOption, ctx: UpgradeContext, m: NormalMachine): Recommendation {
  const c = costOf(ctx, o.priceKey, 1, o.labourHours);
  return { id: o.id, class: o.essential ? 'ESSENTIAL' : 'OPTIONAL', component: o.component, title: o.title, summary: o.why, benefit: o.benefit,
    compatibility: { status: 'VERIFIED', text: o.component === 'storage' ? 'Fits any computer with a SATA drive; the interface matches what is installed.' : 'No compatibility question: a service, not a part.', checks: [] },
    installation: { effort: o.effort, requirements: o.requirements, bios: 'No update required', cooling: 'Not affected' },
    expected: { text: o.gain.low == null ? o.gain.basis : `${range(o.gain.low, o.gain.high)} — ${o.gain.basis}`, lowPercent: o.gain.low, highPercent: o.gain.high ?? (o.benefit === 'SYSTEM_RESPONSIVENESS' ? 100 : null), basis: o.gain.basis },
    confidence: { compatibility: o.confidence, performance: o.benefit === 'RELIABILITY' ? 0.95 : 0.85, overall: Math.round(o.confidence * (o.benefit === 'RELIABILITY' ? 0.95 : 0.85) * 100) / 100, lowerBecause: [] },
    why: [o.why], cost: c, part: { spec: o.spec }, dependsOn: [] };
  void m;
}
function ramRec(o: RamOption, ram: RamAnalysis, ctx: UpgradeContext): Recommendation {
  const c = costOf(ctx, o.priceKey, o.part?.quantity ?? 1, o.labourHours);
  const lb: string[] = []; if (ram.mode === 'unknown') lb.push('The slot arrangement could not be confirmed.'); if (ctx.ramPeakPercent == null) lb.push('No memory-usage history yet.'); if (!o.part?.matchWith && o.part) lb.push('The existing module\'s part number is not available for an exact match.');
  const perf = o.benefit === 'CONFIGURATION' ? 0.7 : ram.capacityNeed.established || o.benefit !== 'CAPACITY' ? 0.85 : 0.7;
  return { id: o.id, class: o.essential ? 'ESSENTIAL' : 'OPTIONAL', component: 'memory', title: o.title, summary: o.why, benefit: o.benefit,
    compatibility: { status: 'VERIFIED', text: o.part ? `Same type${o.part.formFactor ? ' and form' : ''} as the installed memory (${o.part.type}); the board reports ${ram.description.includes('dual') ? 'two channels' : 'a free slot'}.` : 'A setting only.', checks: [] },
    installation: { effort: o.effort, requirements: o.part ? [`Buy: ${o.part.label}${o.part.matchWith ? `, ideally the same make as ${o.part.matchWith}` : ''}.`, 'Switch off and unplug before fitting.'] : ['Enter the BIOS setup.'], bios: 'No update required', cooling: 'Not affected' },
    expected: { text: o.gain.low != null ? `${range(o.gain.low, o.gain.high)} — ${o.gain.basis}` : o.gain.basis, lowPercent: o.gain.low, highPercent: o.gain.high ?? (o.benefit === 'CAPACITY' ? 30 : null), basis: o.gain.basis },
    confidence: { compatibility: o.confidence, performance: perf, overall: Math.round(o.confidence * perf * 100) / 100, lowerBecause: lb }, why: [o.why, ram.capacityNeed.text, ...(o.id === 'ram-second-channel' ? ['Capacity is not increased beyond what usage justifies.'] : [])].filter(Boolean), cost: c,
    part: o.part ? { ...o.part, resultingConfig: o.resultingConfig } : null, dependsOn: [] };
}
function cpuRec(r: CpuCandidateResult, ctx: UpgradeContext, m: NormalMachine, coolId: string | null): Recommendation {
  const c = r.candidate; const cost = costOf(ctx, `cpu_${c.id}`, 1, 1);
  const unknownStages = r.stages.filter(s => s.status === 'unknown').map(s => s.detail);
  const perf = Math.round((ctx.benchmark ? 0.85 : 0.72) * 100) / 100;
  const biosNeeded = r.decision === 'BIOS_UPDATE_REQUIRED';
  return { id: `cpu-${c.id}${coolId ? '+cooling' : ''}`, class: 'OPTIONAL', component: 'cpu', title: `Processor: ${c.name} (${c.cores} cores, ${c.threads} threads)`, summary: `Replace the ${m.cpu.family ?? 'current'} ${m.cpu.model ?? ''} with a ${c.cores}-core, ${c.threads}-thread processor on the same socket (${c.socket}).`, benefit: 'COMPUTATIONAL',
    compatibility: { status: biosNeeded ? 'VERIFIED_AFTER_BIOS_UPDATE' : coolId ? 'VERIFIED_WITH_CONDITIONS' : 'VERIFIED', text: r.verdictText + (r.stages.find(s => s.id === 'chipset')?.detail ? ` ${r.stages.find(s => s.id === 'chipset')!.detail}` : ''), checks: r.stages },
    installation: { effort: 'Replace the processor; reapply thermal paste', requirements: [...(coolId ? ['Complete the cooling service first, then re-measure.'] : []), ...r.requirements], bios: r.bios.action + (r.bios.required === true ? (r.bios.minimumVersion ? ` (BIOS ${r.bios.minimumVersion} or later; installed ${r.bios.current ?? 'unknown'})` : ` (installed ${r.bios.current ?? 'unknown'})`) : ''), cooling: coolId ? 'Cooling service required first' : 'Existing cooler acceptable (same power class)' },
    expected: { text: r.gain.lowMulti != null ? `${range(r.gain.lowMulti, r.gain.highMulti)} multi-thread, ${r.gain.single != null ? `${Math.round(r.gain.single)}% single-thread` : ''}`.replace(/,\s*$/, '') : 'Not predicted', lowPercent: r.gain.lowMulti, highPercent: r.gain.highMulti, basis: r.gain.basis },
    confidence: { compatibility: r.compatibilityConfidence, performance: perf, overall: Math.round(r.compatibilityConfidence * perf * 100) / 100, lowerBecause: unknownStages },
    why: [`${r.stages.find(s => s.id === 'chipset')?.detail ?? ''}`, r.gain.basis, ...(m.memory.dimms[0]?.configuredMTs && m.memory.dimms[0].configuredMTs > c.memory.maxMTs ? [`This processor supports memory up to ${c.memory.maxMTs} MT/s; the installed memory will run at that speed.`] : [])].filter(Boolean), cost, part: { cpu: `${c.vendor} ${c.model}`, id: c.id, socket: c.socket, tdpW: c.tdpW, cores: c.cores, threads: c.threads }, dependsOn: coolId ? [coolId] : [] };
}

function scoreOf(r: Recommendation, installed: ReturnType<typeof installedScore>, ctx: UpgradeContext, m: NormalMachine): number {
  const w = cfg.weights; const mid = ((r.expected.lowPercent ?? 0) + (r.expected.highPercent ?? r.expected.lowPercent ?? 0)) / 2;
  const gain = Math.max(r.benefit === 'SYSTEM_RESPONSIVENESS' ? 40 : 0, r.class === 'ESSENTIAL' ? 50 : 0, mid) / 100;
  const life = ctx.ageYears != null ? Math.min(1, Math.max(0.3, (lifeStage(ctx.ageYears, m.formFactor).remainingYears?.[1] ?? 3) / 3)) : 0.8;
  const newPc = ctx.prices?.newPc?.[m.formFactor] ?? ctx.prices?.newPc?.unknown ?? null;
  const costEff = r.cost?.total != null && newPc ? Math.min(2, Math.max(0.2, (gain + 0.2) / Math.max(0.05, r.cost.total / newPc))) : 1;
  const tdpDelta = r.component === 'cpu' ? Math.max(0, ((r.part?.tdpW as number) ?? 65) - (installed?.tdpW ?? 65)) : 0;
  const thermal = 1 + tdpDelta / 65 + (r.dependsOn.length ? 0.2 : 0), power = 1 + tdpDelta / 100, complexity = 1 + (r.installation.bios.startsWith('Update') ? 0.5 : 0) + (r.component === 'cpu' ? 0.25 : 0) + (r.cost?.labour ? 0.1 : 0);
  return (gain ** w.performance * r.confidence.overall ** w.compatibility * 1 * costEff ** w.cost * life ** w.platformLife) / (thermal ** w.thermal * power ** w.power * complexity ** w.complexity);
}

function makeBundles(recs: Recommendation[], ctx: UpgradeContext, m: NormalMachine): Bundle[] {
  const out: Bundle[] = []; const by = (id: string) => recs.find(r => r.id === id);
  const cpu = recs.find(r => r.component === 'cpu'); const ramR = recs.find(r => r.component === 'memory' && r.benefit !== 'CONFIGURATION'); const sto = recs.find(r => r.component === 'storage'); const cool = recs.find(r => r.component === 'cooling');
  const mk = (id: string, title: string, members: Recommendation[]) => {
    if (members.length < 2) return; const ids = members.map(x => x.id); for (const x of members) for (const d of x.dependsOn) if (!ids.includes(d) && by(d)) return;
    const total = members.every(x => x.cost?.total != null) ? members.reduce((s, x) => s + x.cost!.total!, 0) : null;
    out.push({ id, title, members: ids, expectedText: members.map(x => x.title.split(':')[0]).join(' + '), confidence: Math.round(members.reduce((s, x) => s * x.confidence.overall, 1) * 100) / 100, cost: ctx.prices ? { currency: ctx.prices.currency, parts: null, labour: null, total: total != null ? Math.round(total * 100) / 100 : null, priced: total != null } : null });
  };
  mk('ram+ssd', 'Memory and SSD together', [ramR, sto].filter(Boolean) as Recommendation[]);
  mk('cpu+ram', 'Processor and memory together', [cpu, ramR].filter(Boolean) as Recommendation[]);
  mk('cpu+cool', 'Processor with cooling service', [cpu, cool].filter(Boolean) as Recommendation[]);
  mk('cool+ram', 'Cooling service and memory together', [cool, ramR].filter(Boolean) as Recommendation[]);
  const all = [cpu, ramR, sto, cool].filter(Boolean) as Recommendation[]; if (all.length >= 3) mk('all', 'Complete refresh', all);
  void m; return out.filter((b, i, a) => a.findIndex(x => x.members.join() === b.members.join()) === i);
}

function replacementDecision(recs: Recommendation[], bundles: Bundle[], ctx: UpgradeContext, form: string, replaceable: boolean | null, m: NormalMachine) {
  const reasons: string[] = []; const priced = recs.every(r => r.cost?.total != null) && recs.length > 0;
  const upgradeCost = priced ? recs.filter(r => r.class !== 'OPTIONAL').reduce((s, r) => s + r.cost!.total!, 0) : null;
  const newPc = ctx.prices?.newPc?.[form] ?? ctx.prices?.newPc?.unknown ?? null;
  const eol = ctx.windows.ready11 === false && ctx.windows.running10;
  const ceiling = Math.max(0, ...recs.filter(r => r.component === 'cpu').map(r => r.expected.highPercent ?? 0));
  const stage = lifeStage(ctx.ageYears, form);
  let action: 'UPGRADE' | 'REPLACE_MACHINE' | 'DO_NOT_UPGRADE' | 'NO_UPGRADE_NEEDED' = recs.length ? 'UPGRADE' : 'NO_UPGRADE_NEEDED';
  if (eol && !recs.some(r => r.component === 'cpu')) { action = 'REPLACE_MACHINE'; reasons.push('The computer cannot run Windows 11 and Windows 10 no longer receives regular security updates, and no processor upgrade on this platform changes that.'); }
  else if (stage.stage === 'Past its typical life' && upgradeCost != null && newPc != null && upgradeCost > newPc * 0.35 && recs.some(r => r.class === 'ESSENTIAL' && r.benefit === 'RELIABILITY')) { action = 'REPLACE_MACHINE'; reasons.push(`The computer is past its typical life (${ctx.ageYears} years), a part is failing, and the essential work costs ${Math.round(upgradeCost)} — ${Math.round((upgradeCost / newPc) * 100)}% of a new computer (${newPc}).`); }
  if (upgradeCost != null && newPc != null && upgradeCost > newPc * 0.5 && ceiling < 40) { action = 'DO_NOT_UPGRADE'; reasons.push(`Essential and high-value work costs ${Math.round(upgradeCost)} — more than half the price of a new computer (${newPc}) — for a platform whose remaining headroom is limited.`); }
  if (action === 'UPGRADE' && stage.stage === 'Past its typical life') reasons.push(`The computer is past its typical life (${ctx.ageYears} years). The work below is worth doing only while it stays cheap relative to a replacement; keep a replacement in the budget.`);
  if (action === 'UPGRADE') reasons.push(upgradeCost != null && newPc != null ? `Essential and high-value work costs ${Math.round(upgradeCost)}, ${Math.round((upgradeCost / newPc) * 100)}% of a new computer (${newPc}).` : 'Prices are not set, so cost cannot be compared with replacement.');
  if (action === 'NO_UPGRADE_NEEDED') reasons.push('Nothing measurable would be improved enough to justify spending money.');
  void bundles; void m;
  return { action, text: ({ UPGRADE: 'UPGRADE', REPLACE_MACHINE: 'REPLACE THIS COMPUTER', DO_NOT_UPGRADE: 'DO NOT UPGRADE THIS MACHINE', NO_UPGRADE_NEEDED: 'NO UPGRADE NEEDED' })[action], reasons, upgradeCost: upgradeCost != null ? Math.round(upgradeCost) : null, replacementCost: newPc, platformCeilingPercent: ceiling || null };
}

function grade(recs: Recommendation[], rep: ReturnType<typeof replacementDecision>, ctx: UpgradeContext) {
  const top = Math.max(0, ...recs.map(r => r.expected.highPercent ?? 0)); const ess = recs.some(r => r.class === 'ESSENTIAL'); const resp = recs.some(r => r.benefit === 'SYSTEM_RESPONSIVENESS');
  let g: 'A' | 'B' | 'C' | 'D' | 'E'; let text: string;
  if (rep.action === 'REPLACE_MACHINE' || rep.action === 'DO_NOT_UPGRADE') { g = 'E'; text = 'Replacement recommended: upgrading is not economical for this machine.'; }
  else if (top >= 40 || (ess && resp)) { g = 'A'; text = 'Excellent upgrade opportunity.'; } else if (top >= cfg.strongGainPercent || ess || resp) { g = 'B'; text = 'Strong opportunity.'; }
  else if (top >= cfg.minGainPercent) { g = 'C'; text = 'Moderate opportunity.'; } else { g = 'D'; text = 'Limited opportunity: the computer is already adequate for what it does.'; }
  void ctx; return { grade: g, text };
}
export { pct };
