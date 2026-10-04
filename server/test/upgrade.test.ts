import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCpu, normalizeBoard, normalizeMachine } from '../src/upgrade/normalize.js';
import { evaluateCpuCandidate, cpuPath } from '../src/upgrade/compat.js';
import { analyseRam } from '../src/upgrade/ram.js';
import { buildUpgradeReport } from '../src/upgrade/engine.js';
import { defaultProviders, BuiltInBiosProvider, OutcomeTable, type BiosSupportProvider } from '../src/upgrade/providers.js';
import { CPU_CATALOG } from '../src/upgrade/platform-data.js';
import { emptyContext, type UpgradeContext } from '../src/upgrade/context.js';
import { verifyUpgrade, detectHardwareChange, summariseOutcomes } from '../src/upgrade/verify.js';
import { buildFleetPlan, groupKeyOf } from '../src/upgrade/fleet.js';
import { REFERENCE_PRICE_BOOK } from '../src/anatomy-engine.js';

const GB = 2 ** 30;
const fixture = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/upgrade/${n}`, import.meta.url), 'utf8'));
const ctx = (o: Partial<UpgradeContext> = {}): UpgradeContext => ({ ...emptyContext(new Date('2026-10-01T00:00:00Z')), windows: { running11: true, running10: false, ready11: true }, ...o });
const cand = (id: string) => CPU_CATALOG.find(c => c.id === id)!;

/** A desktop reading builder. SYNTHETIC fixtures are labelled as such: only the two JSON files are real readings. */
function pc(o: { cpu: string; cores: number; threads: number; mfr?: string; board?: string; bios?: string; mem?: { slot: string; gb: number; type?: string; mts?: number }[]; slots?: number; maxGB?: number; disk?: { model: string; media: string; bus?: string; gb?: number; bad?: boolean }; form?: string; extra?: any }) {
  return {
    version: 1, collectedAt: '2026-10-01T00:00:00Z', _fixture: { synthetic: true },
    system: { manufacturer: o.mfr ?? 'Gigabyte Technology Co., Ltd.', model: o.board ?? 'B250M-DS3H', formFactor: o.form ?? 'desktop', chassis: [o.form ?? 'Desktop'] },
    bios: { vendor: 'American Megatrends', version: o.bios ?? 'F4', releaseDate: '2017-02-01', mode: 'UEFI' }, board: { manufacturer: o.mfr ?? 'Gigabyte Technology Co., Ltd.', product: o.board ?? 'B250M-DS3H' },
    cpu: { name: o.cpu, cores: o.cores, logical: o.threads },
    memory: { slotsTotal: o.slots ?? 2, slotsUsed: (o.mem ?? []).length, maxCapacityBytes: (o.maxGB ?? 32) * GB, modules: (o.mem ?? [{ slot: 'DIMM1', gb: 8 }]).map(m => ({ slot: m.slot, capacityBytes: m.gb * GB, speedMhz: m.mts ?? 2400, configuredMhz: m.mts ?? 2400, type: m.type ?? 'DDR4', formFactor: 'DIMM', manufacturer: 'Kingston', partNumber: 'KVR24N17S8/8' })) },
    gpus: [{ name: 'Intel(R) HD Graphics 530' }], os: { caption: 'Microsoft Windows 11 Pro', build: '26100' },
    diagnostics: { storage: { disks: [{ model: o.disk?.model ?? 'WDC WD10EZEX', mediaType: o.disk?.media ?? 'HDD', busType: o.disk?.bus ?? 'SATA', health: 'Healthy', sizeBytes: (o.disk?.gb ?? 1000) * 1e9 }], ataSmart: o.disk?.bad ? [{ predictFailure: false, attributes: [{ id: 197, raw: 4 }] }] : [] } },
    ...o.extra,
  };
}
const i5_6500 = (over: any = {}) => pc({ cpu: 'Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz', cores: 4, threads: 4, board: 'Z170-A', mem: [{ slot: 'ChannelA-DIMM0', gb: 8, mts: 2133 }, { slot: 'ChannelB-DIMM0', gb: 8, mts: 2133 }], ...over });

// ---- normalization ------------------------------------------------------------------------------------------------------------------------------------
test('processor strings are normalised to one canonical record, and unreadable ones stay unknown', () => {
  for (const s of ['Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz', 'Intel Core i5 6500', 'I5-6500']) {
    const c = normalizeCpu({ cpu: { name: s, cores: 4, logical: 4 } });
    assert.deepEqual([c.vendor, c.family, c.model, c.generation, c.architecture, c.socket, c.mobile], ['Intel', 'Core i5', '6500', 6, 'Skylake', 'LGA1151', false], s);
  }
  assert.equal(normalizeCpu({ cpu: { name: 'GenuineIntel Family 6 Model 94 Stepping 3' } }).socket, null);
  const r = normalizeCpu({ cpu: { name: 'AMD Ryzen 5 3600 6-Core Processor' } }); assert.deepEqual([r.generation, r.architecture, r.socket], [3, 'Zen 2', 'AM4']);
  assert.equal(normalizeCpu({ cpu: { name: 'AMD Ryzen 7 7700 8-Core Processor' } }).socket, 'AM5');
  assert.equal(normalizeCpu({ cpu: { name: 'Intel(R) Core(TM) i5-1135G7 @ 2.40GHz' } }).soldered, true);
  assert.equal(normalizeCpu({ cpu: { name: 'AMD Ryzen 5 3500U with Radeon Vega Mobile Gfx' } }).socket, null);
});
test('boards: retail chipsets are read from the name, OEM codes are never turned into a chipset', () => {
  assert.equal(normalizeBoard({ board: { manufacturer: 'Gigabyte Technology Co., Ltd.', product: 'B250M-DS3H' } }).chipset, 'B250');
  assert.equal(normalizeBoard({ board: { manufacturer: 'ASUSTeK COMPUTER INC.', product: 'PRIME B450M-A' } }).chipset, 'B450');
  assert.equal(normalizeBoard({ board: { manufacturer: 'MSI', product: 'MAG B550 TOMAHAWK' } }).manufacturer, 'MSI');
  for (const [mfr, product] of [['HP', '8948'], ['Dell Inc.', '0Y7WYT'], ['LENOVO', '3130']]) { const b = normalizeBoard({ board: { manufacturer: mfr, product } }); assert.equal(b.chipset, null); assert.equal(b.oem, true); }
});

// ---- the CPU pipeline ----------------------------------------------------------------------------------------------------------------------------------
test('wrong socket is rejected, and a laptop or mobile processor has no replacement path at all', () => {
  const m = normalizeMachine(i5_6500()); const r = evaluateCpuCandidate(m, cand('intel-10400'), ctx(), defaultProviders());
  assert.equal(r.decision, 'DO_NOT_INSTALL'); assert.equal(r.stages.find(s => s.id === 'socket')!.status, 'fail');
  assert.equal(cpuPath(normalizeMachine(fixture('probook-430-g7.json'))).replaceable, false);
});
test('right socket, wrong chipset: the pipeline still says do not install', () => {
  const b460 = normalizeMachine(pc({ cpu: 'Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz', cores: 6, threads: 12, board: 'MAG B460M MORTAR', mem: [{ slot: 'DIMM_A1', gb: 8 }, { slot: 'DIMM_B1', gb: 8 }] }));
  const r = evaluateCpuCandidate(b460, cand('intel-11700'), ctx(), defaultProviders()); assert.equal(r.decision, 'DO_NOT_INSTALL'); assert.match(r.stages.find(s => s.id === 'chipset')!.detail, /does not support the 11th generation/);
  const eighth = evaluateCpuCandidate(normalizeMachine(i5_6500()), cand('intel-8400'), ctx(), defaultProviders()); assert.equal(eighth.stages.find(s => s.id === 'socket')!.status, 'fail');
});
test('BIOS dependency: the action is stated precisely, a minimum version is never invented, and a verified one is used when a provider has it', () => {
  const m = normalizeMachine(pc({ cpu: 'Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz', cores: 4, threads: 4, board: 'H110M-DS2', bios: 'F1', mem: [{ slot: 'DIMM1', gb: 8 }, { slot: 'DIMM2', gb: 8 }] }));
  const r = evaluateCpuCandidate(m, cand('intel-7700'), ctx(), defaultProviders());
  assert.equal(r.decision, 'BIOS_UPDATE_REQUIRED'); assert.equal(r.verdictText, 'UPDATE THE BIOS BEFORE INSTALLATION'); assert.equal(r.bios.minimumVersion, null); assert.match(r.requirements.join(' '), /manufacturer's current version/);
  assert.ok(!/F\d/.test(r.requirements.join(' ')), 'no BIOS version appears that no source supplied');
  const known: BiosSupportProvider = { biosFor: (b, c, s) => ({ ...new BuiltInBiosProvider().biosFor(b, c, s), minimumVersion: 'F6', source: 'manufacturer list (test)' }) };
  const r2 = evaluateCpuCandidate(m, cand('intel-7700'), ctx(), defaultProviders({ bios: known })); assert.match(r2.requirements.join(' '), /BIOS to F6 or later/); assert.ok(r2.compatibilityConfidence > r.compatibilityConfidence);
});
test('memory type mismatch rejects the processor; a 105 W part on a 65 W platform is rejected; a processor gain under the threshold is rejected', () => {
  const ddr3 = normalizeMachine(i5_6500({ extra: { memory: { slotsTotal: 2, slotsUsed: 1, maxCapacityBytes: 16 * GB, modules: [{ slot: 'DIMM1', capacityBytes: 8 * GB, type: 'DDR3', formFactor: 'DIMM', speedMhz: 1600, configuredMhz: 1600 }] } } }));
  assert.equal(evaluateCpuCandidate(ddr3, cand('intel-6700'), ctx(), defaultProviders()).stages.find(s => s.id === 'memtype')!.status, 'fail');
  const am4 = normalizeMachine(pc({ cpu: 'AMD Ryzen 5 3600 6-Core Processor', cores: 6, threads: 12, board: 'PRIME B550M-A', mem: [{ slot: 'DIMM_A1', gb: 8 }, { slot: 'DIMM_B1', gb: 8 }] }));
  assert.equal(evaluateCpuCandidate(am4, cand('amd-ryzen75800x'), ctx(), defaultProviders()).stages.find(s => s.id === 'power')!.status, 'fail');
  const tiny = evaluateCpuCandidate(normalizeMachine(i5_6500()), cand('intel-6600'), ctx(), defaultProviders()); assert.equal(tiny.decision, 'NO_MEANINGFUL_GAIN'); assert.match(tiny.verdictText, /REJECTED/);
});
test('thermal constraint: a hot computer is not offered a faster processor, except together with a cooling service', () => {
  const hot = ctx({ thermal: { throttleEvents7d: 9, maxIdleTempC: 86 } });
  const m = normalizeMachine(i5_6500()); const r = evaluateCpuCandidate(m, cand('intel-6700'), hot, defaultProviders());
  assert.equal(r.decision, 'REQUIRES_COOLING'); assert.match(r.verdictText, /NOT RECOMMENDED WITH THE CURRENT COOLING/);
  const rep: any = buildUpgradeReport(i5_6500(), hot);
  const cpu = rep.recommendations.find((x: any) => x.component === 'cpu'); assert.ok(cpu, 'offered together with cooling'); assert.deepEqual(cpu.dependsOn, ['cooling-service']); assert.equal(cpu.compatibility.status, 'VERIFIED_WITH_CONDITIONS');
  assert.equal(rep.recommendations.find((x: any) => x.id === 'cooling-service').class, 'ESSENTIAL');
});
test('a valid CPU upgrade on a retail board is recommended with an honest range, a direct-replacement note and confidence below 100%', () => {
  const rep: any = buildUpgradeReport(i5_6500());
  const cpu = rep.recommendations.find((x: any) => x.component === 'cpu'); assert.ok(cpu); assert.match(cpu.title, /Intel Core i7-(6700|7700)/);
  const sixth = rep.recommendations.find((x: any) => x.id === 'cpu-intel-6700'); if (sixth) assert.match(sixth.installation.bios, /No update required/); assert.ok(cpu.expected.lowPercent! > 10 && cpu.expected.highPercent! > cpu.expected.lowPercent!);
  assert.ok(cpu.confidence.overall < 0.9 && cpu.confidence.overall > 0.4); assert.match(cpu.expected.basis, /range|model|specifications/i);
  assert.ok(!JSON.stringify(rep).includes('weights'), 'scoring weights never reach the customer view');
});

// ---- memory ---------------------------------------------------------------------------------------------------------------------------------------------
test('single-channel memory is detected and fixed by a matching module, not by an arbitrary 32 or 64 GB', () => {
  const rep: any = buildUpgradeReport(pc({ cpu: 'Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz', cores: 4, threads: 4, board: 'Z170-A', mem: [{ slot: 'ChannelA-DIMM0', gb: 8, mts: 2400 }] }), ctx({ ramPeakPercent: 55 }));
  assert.equal(rep.machine.memory.mode, 'single'); const r = rep.recommendations.find((x: any) => x.id === 'ram-second-channel'); assert.ok(r);
  assert.match(r.title, /Add 1 × 8 GB DDR4/); assert.equal(r.part.resultingConfig, '16 GB dual-channel'); assert.equal(r.benefit, 'MEMORY_BANDWIDTH'); assert.ok(!rep.recommendations.some((x: any) => /32 GB|64 GB/.test(x.title)));
  assert.match(rep.machine.memory.issues.map((i: any) => i.text).join(' '), /single-channel/);
});
test('capacity is only recommended when usage justifies it, and never beyond what the board can take', () => {
  const quiet = analyseRam(normalizeMachine(i5_6500()), ctx({ ramPeakPercent: 40 }), defaultProviders()); assert.equal(quiet.options.length, 0); assert.match(quiet.capacityNeed.text, /adequate/);
  const noData = analyseRam(normalizeMachine(i5_6500()), ctx(), defaultProviders()); assert.equal(noData.capacityNeed.established, false);
  const limit = analyseRam(normalizeMachine(pc({ cpu: 'Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz', cores: 4, threads: 4, board: 'Z170-A', maxGB: 16, mem: [{ slot: 'ChannelA-DIMM0', gb: 8 }, { slot: 'ChannelB-DIMM0', gb: 8 }] })), ctx({ ramPeakPercent: 95 }), defaultProviders());
  assert.equal(limit.options.length, 0); assert.ok(limit.issues.some(i => i.code === 'board-limit'));
  const mixed = analyseRam(normalizeMachine(pc({ cpu: 'Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz', cores: 4, threads: 4, board: 'Z170-A', mem: [{ slot: 'ChannelA-DIMM0', gb: 8, mts: 2133 }, { slot: 'ChannelB-DIMM0', gb: 4, mts: 1600 }] })), ctx(), defaultProviders());
  assert.deepEqual(mixed.issues.map(i => i.code).sort(), ['mixed-capacity', 'mixed-speed']);
});
test('soldered memory has no upgrade, and unreadable slot placement is reported as unconfirmed rather than guessed', () => {
  const lap = buildUpgradeReport({ ...fixture('probook-430-g7.json'), memory: { slotsTotal: 0, slotsUsed: 1, modules: [{ slot: 'Onboard', capacityBytes: 8 * GB, type: 'LPDDR4', formFactor: 'Unknown', configuredMhz: 3200 }] } }, ctx({ ramPeakPercent: 95 })) as any;
  assert.ok(!lap.recommendations.some((x: any) => x.component === 'memory'));
  const four = analyseRam(normalizeMachine(pc({ cpu: 'Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz', cores: 4, threads: 4, board: 'Z170-A', slots: 4, mem: [{ slot: 'DIMM2', gb: 4 }, { slot: 'DIMM1', gb: 4 }] })), ctx(), defaultProviders());
  assert.equal(four.mode, 'unknown'); assert.match(four.modeBasis, /cannot be confirmed/);
});

// ---- storage, unknowns, replacement ---------------------------------------------------------------------------------------------------------------------
test('an SSD is sold as responsiveness, never as computing speed; a failing drive is essential', () => {
  const rep: any = buildUpgradeReport(i5_6500(), ctx({ systemUsedGB: 200 }));
  const ssd = rep.recommendations.find((x: any) => x.component === 'storage'); assert.equal(ssd.benefit, 'SYSTEM_RESPONSIVENESS'); assert.match(ssd.expected.basis, /does not raise processor computing speed/); assert.equal(ssd.class, 'HIGH_VALUE');
  const bad: any = buildUpgradeReport(i5_6500({ disk: { model: 'ST1000', media: 'HDD', bad: true } }), ctx({ systemUsedGB: 200 })); assert.equal(bad.recommendations[0].class, 'ESSENTIAL'); assert.equal(bad.recommendations[0].benefit, 'RELIABILITY'); assert.equal(bad.best, 'storage-failing');
});
test('UNKNOWN MEANS UNKNOWN: an OEM board is never guessed, and a graphics upgrade needs workload evidence', () => {
  const dell = pc({ cpu: 'Intel(R) Core(TM) i5-9500 CPU @ 3.00GHz', cores: 6, threads: 6, mfr: 'Dell Inc.', board: '0Y7WYT', mem: [{ slot: 'DIMM1', gb: 8 }, { slot: 'DIMM3', gb: 8 }] });
  const rep: any = buildUpgradeReport(dell); assert.equal(rep.machine.board.chipset, null); assert.match(rep.gaps.join(' '), /OEM board/);
  const bad = rep.notRecommended.filter((n: any) => n.decision === 'NOT_VERIFIED'); assert.ok(bad.length, 'later-generation parts are not verified'); assert.ok(bad.every((n: any) => /NOT YET VERIFIED|NOT ENOUGH/.test(n.text)));
  assert.ok(!rep.recommendations.some((x: any) => x.component === 'cpu' && /^cpu-intel-(10|11)/.test(x.id)));
  assert.ok(rep.notAssessed.some((n: any) => /Graphics/.test(n.item))); assert.ok(!JSON.stringify(rep.recommendations).match(/GeForce|Radeon RX|graphics card/i));
  const noBoard = buildUpgradeReport({ cpu: { name: 'Something Unknown' } }) as any; assert.equal(noBoard.recommendations.length, 0); assert.equal(noBoard.cpuPath.replaceable, null);
});
test('replacement: an ineligible, end-of-support machine is replaced; a cheap fix on an old eligible laptop is not called a replacement', () => {
  const old = buildUpgradeReport(pc({ cpu: 'Intel(R) Core(TM) i3-4130 CPU @ 3.40GHz', cores: 2, threads: 4, board: 'H81M-P33', mem: [{ slot: 'DIMM1', gb: 4, type: 'DDR3' }], extra: { os: { caption: 'Microsoft Windows 10 Pro', build: '19045' } } }), ctx({ windows: { running11: false, running10: true, ready11: false }, ageYears: 12 })) as any;
  assert.equal(old.replacement.action, 'REPLACE_MACHINE'); assert.equal(old.opportunity.grade, 'E'); assert.equal(old.best, null);
  const lap: any = buildUpgradeReport(fixture('probook-430-g7.json'), ctx({ ramPeakPercent: 93, thermal: { throttleEvents7d: 7, maxIdleTempC: 97 }, ageYears: 6.7, prices: REFERENCE_PRICE_BOOK })); assert.equal(lap.replacement.action, 'UPGRADE');
  const dear: any = buildUpgradeReport(pc({ cpu: 'Intel(R) Core(TM) i5-9500 CPU @ 3.00GHz', cores: 6, threads: 6, mfr: 'Dell Inc.', board: '0Y7WYT', mem: [{ slot: 'DIMM1', gb: 8 }, { slot: 'DIMM3', gb: 8 }], disk: { model: 'ST1', media: 'HDD', bad: true } }), ctx({ ageYears: 9, systemUsedGB: 200, prices: { ...REFERENCE_PRICE_BOOK, items: { ...REFERENCE_PRICE_BOOK.items, ssd_256gb: 380, ssd_512gb: 380, ram_ddr4: 100 }, newPc: { desktop: 600, unknown: 600 } } }));
  assert.equal(dear.replacement.action, 'DO_NOT_UPGRADE'); assert.match(dear.replacement.reasons.join(' '), /more than half/);
});

// ---- golden machines (real readings; a change to the logic must not break these) --------------------------------------------------------------------------
test('GOLDEN A: HP 290 G4 (real reading): fix the failing drive first, add matching memory, never a processor the supply and cooler cannot be verified for', () => {
  const rep: any = buildUpgradeReport(fixture('hp-290-g4.json'), ctx({ ramPeakPercent: 84, systemUsedGB: 814, thermal: { throttleEvents7d: 0, maxIdleTempC: 30 }, ageYears: 5 }));
  assert.equal(rep.machine.board.model, '8948'); assert.equal(rep.machine.board.chipset, null); assert.equal(rep.machine.cpu.socket, 'LGA1200');
  assert.equal(rep.recommendations[0].id, 'storage-failing'); assert.equal(rep.recommendations[0].class, 'ESSENTIAL'); assert.equal(rep.best, 'storage-failing');
  assert.ok(rep.recommendations.some((r: any) => r.id === 'ram-add-modules' && /Add 2 × 4 GB DDR4/.test(r.title)));
  assert.ok(!rep.recommendations.some((r: any) => r.component === 'cpu'), 'FORBIDDEN: any processor recommendation on this OEM office board');
  const names = rep.notRecommended.map((n: any) => n.title).join(' '); assert.match(names, /10700/); assert.match(names, /11[47]00/);
  assert.ok(!rep.recommendations.some((r: any) => /GPU|graphics/i.test(r.title)));
});
test('GOLDEN B: HP ProBook 430 G7 (real reading): cooling and memory, no processor, no replacement while Windows 11 runs', () => {
  const rep: any = buildUpgradeReport(fixture('probook-430-g7.json'), ctx({ ramPeakPercent: 93, thermal: { throttleEvents7d: 7, maxIdleTempC: 97.1 }, ageYears: 6.7 }));
  assert.equal(rep.cpuPath.replaceable, false); assert.deepEqual(rep.recommendations.map((r: any) => r.id).sort(), ['cooling-service', 'ram-replace-kit']);
  assert.match(rep.recommendations.find((r: any) => r.id === 'ram-replace-kit').title, /2 × 8 GB DDR4 SODIMM/); assert.notEqual(rep.replacement.action, 'REPLACE_MACHINE'); assert.equal(rep.best, 'cooling-service');
});

// ---- verification, learning, fleet --------------------------------------------------------------------------------------------------------------------
test('post-upgrade: the swap is detected, before and after are compared, and the result is judged against the prediction', () => {
  const before = pc({ cpu: 'Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz', cores: 4, threads: 4, board: 'Z170-A' }), after = pc({ cpu: 'Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz', cores: 4, threads: 8, board: 'Z170-A' });
  const changes = detectHardwareChange(before, after); assert.deepEqual(changes.map(c => `${c.kind}:${c.change}`), ['cpu:replaced']);
  const v = verifyUpgrade({ changes, before: { cpuSingleScore: 100, cpuMultiScore: 400, cpuSustainedScore: 380, peakTempC: 74, memBandwidthMBs: 20000 }, after: { cpuSingleScore: 110, cpuMultiScore: 600, cpuSustainedScore: 560, peakTempC: 70, memBandwidthMBs: 20100 }, predicted: { lowPercent: 25, highPercent: 55 }, newHardwareErrors: 0, newCrashes: 0 });
  assert.equal(v.verdict, 'VERIFIED'); assert.equal(v.stability, 'PASS'); assert.equal(v.vsPrediction, 'WITHIN'); assert.equal(v.temperatureChangeC, -4); assert.ok(v.overallPercent! > 25 && v.overallPercent! < 55); assert.ok(!v.rows.find(r => r.metric === 'memBandwidthMBs' && r.result === 'improved'));
  assert.match(v.headline[0]!, /UPGRADE VERIFIED/);
  assert.equal(verifyUpgrade({ changes, before: { cpuMultiScore: 400 }, after: { cpuMultiScore: 401 } }).verdict, 'NO_IMPROVEMENT');
  assert.equal(verifyUpgrade({ changes, before: { cpuMultiScore: 400 }, after: { cpuMultiScore: 300 } }).verdict, 'REGRESSION');
  assert.equal(verifyUpgrade({ changes, before: null, after: { cpuMultiScore: 500 } }).verdict, 'INCONCLUSIVE');
  assert.equal(verifyUpgrade({ changes, before: { cpuMultiScore: 400 }, after: { cpuMultiScore: 600 }, newHardwareErrors: 2 }).success, false);
});
test('a measurement taken while the computer was busy can verify an improvement but can never prove none or a regression', () => {
  const changes = [{ kind: 'cpu', change: 'replaced', label: 'x' }];
  const slow = verifyUpgrade({ changes, before: { cpuMultiScore: 400 }, after: { cpuMultiScore: 300 }, noisy: true }); assert.equal(slow.verdict, 'INCONCLUSIVE');
  const flat = verifyUpgrade({ changes, before: { cpuMultiScore: 400 }, after: { cpuMultiScore: 401 }, noisy: true }); assert.equal(flat.verdict, 'INCONCLUSIVE');
  const fast = verifyUpgrade({ changes, before: { cpuMultiScore: 400 }, after: { cpuMultiScore: 600 }, noisy: true }); assert.equal(fast.verdict, 'VERIFIED'); assert.match(fast.headline.join(' '), /busy/);
});
test('verified outcomes replace the model once enough installations agree, and one failure is not hidden', () => {
  const s = summariseOutcomes([{ success: true, gain: 40, tempChangeC: -3 }, { success: true, gain: 46, tempChangeC: -4 }, { success: true, gain: 43, tempChangeC: -3 }, { success: false, gain: null, tempChangeC: null }]);
  assert.deepEqual([s.successes, s.failures, s.medianGain, s.medianTempChangeC], [3, 1, 0.43, -3]);
  const rows = ['6700', '7700'].map(toCpu => ({ boardKey: 'gigabyte z170-a', fromCpu: '6500', toCpu, ...s })); const providers = defaultProviders({ outcomes: new OutcomeTable(rows) });
  const rep: any = buildUpgradeReport(i5_6500({ board: 'Z170-A' }), ctx(), { providers }); const cpu = rep.recommendations.find((x: any) => x.component === 'cpu');
  assert.match(cpu.expected.basis, /3 verified WorkCare installations/); assert.match(cpu.expected.text, /\+3[67]–50%/);
});
test('fleet: identical computers are grouped, categories are counted, and a bulk purchase plan is derived', () => {
  const mk = (id: string, a: any, c: Partial<UpgradeContext> = {}) => ({ deviceId: id, hostname: id, anatomy: a, report: buildUpgradeReport(a, ctx(c)) });
  const single = () => pc({ cpu: 'Intel(R) Core(TM) i5-6500 CPU @ 3.20GHz', cores: 4, threads: 4, board: 'Z170-A', mem: [{ slot: 'ChannelA-DIMM0', gb: 8, mts: 2400 }], disk: { model: 'Samsung SSD 860', media: 'SSD', gb: 500 } });
  const items = [mk('a1', single(), { ramPeakPercent: 80 }), mk('a2', single(), { ramPeakPercent: 80 }), mk('a3', single(), { ramPeakPercent: 80 }), mk('b1', fixture('hp-290-g4.json'), { systemUsedGB: 800 }), mk('c1', fixture('probook-430-g7.json'), { thermal: { throttleEvents7d: 5, maxIdleTempC: 90 } })];
  assert.equal(groupKeyOf(items[0]!.anatomy), groupKeyOf(items[1]!.anatomy)); assert.notEqual(groupKeyOf(items[0]!.anatomy), groupKeyOf(items[3]!.anatomy));
  const plan = buildFleetPlan(items); assert.equal(plan.analysed, 5); assert.equal(plan.groups[0]!.count, 3);
  const cats = Object.fromEntries(plan.categories.map(c => [c.category, c.count])); assert.equal(cats['Storage replacement'], 1); assert.equal(cats['Cooling issue'], 1);
  const part = plan.purchasePlan.find(p => /DDR4/.test(p.part) && p.compatibleSystems >= 3); assert.ok(part, 'the memory kit is counted across the three identical computers'); assert.equal(part!.quantity, 3);
});
