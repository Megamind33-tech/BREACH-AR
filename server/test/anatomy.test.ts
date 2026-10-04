import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startHarness } from './helpers.js';
import { ageAnalysis, buildReport, cpuInfo, costAnalysis, diffAnatomy, lifeStage, windowsReadiness, REFERENCE_PRICE_BOOK, RULES, type Context } from '../src/anatomy-engine.js';

const NOW = new Date('2026-10-01T12:00:00Z');
const ctx = (over: Partial<Context> = {}): Context => ({ purchaseDate: null, purchaseCost: null, ramPeakPercent: null, cpuAvgPercent: null, now: NOW, history: [], coolingEvidence: { throttleEvents: 0, maxIdleTempC: null }, ...over });

/** A realistic laptop reading: 6-year-old 8 GB machine with one free memory slot, a hard disk and a worn battery. */
const laptop = (over: any = {}): any => ({
  version: 1, collectedAt: '2026-10-01T10:00:00Z',
  system: { manufacturer: 'Dell Inc.', model: 'Latitude 5400', serial: 'ABC1234', formFactor: 'laptop', chassis: ['Notebook'], totalPhysicalMemoryBytes: 8 * 2 ** 30 },
  bios: { vendor: 'Dell Inc.', version: '1.14.2', releaseDate: '2023-03-10', mode: 'UEFI', secureBoot: true, tpm: { present: true, enabled: true, version: '2.0', manufacturer: 'INTC' } },
  board: { manufacturer: 'Dell Inc.', product: '0XYZ12', serial: '/ABC/CN123/' },
  cpu: { name: 'Intel(R) Core(TM) i5-8365U CPU @ 1.60GHz', id: 'BFEBFBFF000806EC', cores: 4, logical: 8, maxMhz: 1896, socket: 'U3E1', l3Kb: 6144, architecture: 'x64' },
  memory: { slotsTotal: 2, slotsUsed: 1, maxCapacityBytes: 32 * 2 ** 30, ecc: false, modules: [{ slot: 'ChannelA-DIMM0', capacityBytes: 8 * 2 ** 30, configuredMhz: 2400, speedMhz: 2400, manufacturer: 'Samsung', partNumber: 'M471A1K43CB1-CTD', serial: 'A1B2C3D4', type: 'DDR4', formFactor: 'SODIMM', voltageMv: 1200 }] },
  gpus: [{ name: 'Intel(R) UHD Graphics 620', vendor: 'Intel', driverVersion: '27.20.100.8935', driverDate: '2022-01-12', vramBytes: 1073741824, width: 1920, height: 1080, hz: 60 }],
  monitors: [{ name: null, manufacturerCode: 'LGD', productCode: '05F3', serial: null, year: 2020, week: 14, sizeInches: 14, builtIn: true }],
  network: [{ name: 'Intel(R) Wi-Fi 6 AX200 160MHz', mac: 'AA:BB:CC:00:11:22', speedMbps: 866, wireless: true, manufacturer: 'Intel Corporation' }],
  battery: { name: 'DELL 4GVMP', manufacturer: 'SMP', serial: '1234', chemistry: 'Lithium-ion', manufactureDate: '2020-03-02', designMWh: 60000, fullChargeMWh: 33000, cycleCount: 640, wearPercent: 45 },
  os: { caption: 'Microsoft Windows 11 Pro', build: '26200', installedAt: '2024-06-01' },
  evidence: { windowsInstalls: [{ date: '2020-05-20', product: 'Windows 10 Pro', build: '18363' }], currentWindowsInstall: '2024-06-01', profiles: [{ createdAt: '2020-05-21' }], setupApiLogStart: '2020-05-19', deviceFirstInstalled: [{ name: 'ST1000LM035', cls: 'DiskDrive', firstInstalled: '2020-05-19' }] },
  maintenance: { lastWindowsUpdateInstalled: '2026-09-20', defenderFullScan: '2026-08-01' },
  diagnostics: { storage: { disks: [{ index: 0, model: 'ST1000LM035-1RK172', busType: 'SATA', mediaType: 'HDD', health: 'Healthy', sizeBytes: 1_000_204_886_016, reliability: { powerOnHours: 41000, temperatureC: 38, readErrorsUncorrected: 0, writeErrorsUncorrected: 0 } }], ataSmart: [{ instance: 'x', predictFailure: false, attributes: [] }] }, whea: { events30d: 0 }, cpu: { thermalThrottleEvents7d: 0 }, thermal: { zones: [{ name: 'TZ0', tempC: 51 }] }, memory: { diagnosticResults: [] } },
  unavailable: [], ...over,
});

test('processors are identified from their model number and unknown ones are not guessed', () => {
  assert.deepEqual([cpuInfo('Intel(R) Core(TM) i3-10110U CPU @ 2.10GHz').generation, cpuInfo('Intel(R) Core(TM) i3-10110U CPU @ 2.10GHz').firstSoldYear, cpuInfo('Intel(R) Core(TM) i3-10110U CPU @ 2.10GHz').windows11], [10, 2019, true]);
  assert.equal(cpuInfo('Intel(R) Core(TM) i5-7200U CPU @ 2.50GHz').windows11, false);          // 7th generation: not on Microsoft's list
  assert.equal(cpuInfo('Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz').generation, 6);
  assert.deepEqual([cpuInfo('AMD Ryzen 5 3500U with Radeon Vega Mobile Gfx').generation, cpuInfo('AMD Ryzen 5 3500U with Radeon Vega Mobile Gfx').windows11], [3, true]);
  assert.equal(cpuInfo('AMD Ryzen 7 1700 Eight-Core Processor').windows11, false);
  const odd = cpuInfo('Intel(R) Pentium(R) CPU G4560 @ 3.50GHz');
  assert.equal(odd.windows11, null); assert.equal(odd.firstSoldYear, null); assert.match(odd.note, /not assumed/);
});

test('age: a strong date wins, otherwise the earliest evidence of use, bounded by the processor; every date carries its meaning', () => {
  const a = ageAnalysis(laptop(), null, NOW);
  assert.equal(a.evidence.find(e => e.source === 'Built-in screen made')!.weight, 'strong');
  assert.equal(a.inServiceSince, '2020-04-04');                                                 // the screen's own week of manufacture (week 14 of 2020), not the BIOS or a reinstall
  assert.equal(a.ageYears, 6.5); assert.equal(a.confidence, 'HIGH'); assert.equal(a.ageUpperBoundYears, 9.7);   // cannot be older than the first year its processor generation was sold (2017)
  assert.ok(!a.evidence.some(e => e.source === 'BIOS released' && e.weight !== 'weak'), 'a BIOS date is never used to date the machine');
  const bought = ageAnalysis(laptop(), '2020-06-01', NOW); assert.equal(bought.inServiceSince, '2020-06-01'); assert.equal(bought.evidence.find(e => e.source === 'Purchase date')!.weight, 'strong');
  // no panel and no purchase date: the earliest Windows install is used, with lower confidence
  const weak = ageAnalysis(laptop({ monitors: [], battery: null }), null, NOW); assert.equal(weak.inServiceSince, '2020-05-19'); assert.notEqual(weak.confidence, 'HIGH');
  // nothing dated at all: it says so
  const none = ageAnalysis({ cpu: { name: 'Something' } }, null, NOW); assert.equal(none.ageYears, null); assert.equal(none.confidence, 'UNKNOWN'); assert.match(none.note, /Enter the purchase date/);
});

test('each part is judged from measurements and documented rules, with the reason and the compatible upgrade', () => {
  const r = buildReport(laptop(), ctx({ ramPeakPercent: 93 }), REFERENCE_PRICE_BOOK);
  const by = (id: string) => r.parts.find(p => p.id === id)!;
  // hard disk: 41,000 hours is 4.7 years, past the watch line of 3 years
  assert.equal(by('disk-0').risk, 'WATCH'); assert.match(by('disk-0').riskReasons.join(' '), /4\.7 years/); assert.match(by('disk-0').upgrades[0]!.title, /SSD/);
  // battery: 55% of new capacity and 640 cycles
  assert.ok(['HIGH', 'CRITICAL'].includes(by('battery').risk)); assert.match(by('battery').facts.map(f => f.value).join(' '), /55% of new/); assert.match(by('battery').upgrades[0]!.spec, /Latitude 5400/);
  // memory: 8 GB with one free DDR4 SODIMM slot on a busy machine: add 8 GB of the same kind
  const mem = by('memory'); assert.equal(mem.risk, 'WATCH'); assert.match(mem.upgrades[0]!.title, /Add 8 GB/);
  assert.match(mem.upgrades[0]!.spec, /DDR4 SODIMM, 2400 MT\/s.*1\.2 V.*Samsung.*1 free slot.*32 GB/);
  assert.equal(by('cpu').risk, 'LOW'); assert.match(by('cpu').facts.map(f => f.value).join(' '), /generation 8/);
  assert.equal(by('cooling').risk, 'WATCH'); assert.match(by('cooling').riskReasons[0]!, /6\.5 years old/);        // old laptop: a service is due, judged from age
  assert.ok(by('display-0').facts.some(f => f.value.includes('week 14 of 2020')));
  assert.ok(r.headline.length >= 3 && r.headline[0]!.risk !== 'LOW');
});

test('memory advice never offers what the machine cannot take', () => {
  const soldered = buildReport(laptop({ memory: { slotsTotal: 0, slotsUsed: 1, modules: [{ slot: 'Onboard', capacityBytes: 4 * 2 ** 30, type: 'LPDDR4', formFactor: 'Unknown', configuredMhz: 3200 }] } }), ctx(), null);
  const m = soldered.parts.find(p => p.id === 'memory')!; assert.match(m.upgrades[0]!.title, /cannot be upgraded/); assert.equal(m.risk, 'WATCH');
  const full = buildReport(laptop({ memory: { slotsTotal: 2, slotsUsed: 2, modules: [{ slot: 'A', capacityBytes: 2 ** 31, type: 'DDR3', formFactor: 'SODIMM', configuredMhz: 1600 }, { slot: 'B', capacityBytes: 2 ** 31, type: 'DDR3', formFactor: 'SODIMM', configuredMhz: 1600 }] } }), ctx(), null);
  assert.match(full.parts.find(p => p.id === 'memory')!.upgrades[0]!.title, /Replace the memory with 8 GB/);
  const fine = buildReport(laptop({ memory: { slotsTotal: 2, slotsUsed: 2, modules: [{ slot: 'A', capacityBytes: 8 * 2 ** 30, type: 'DDR4', formFactor: 'SODIMM' }, { slot: 'B', capacityBytes: 8 * 2 ** 30, type: 'DDR4', formFactor: 'SODIMM' }] } }), ctx(), null);
  assert.equal(fine.parts.find(p => p.id === 'memory')!.upgrades.length, 0); assert.equal(fine.parts.find(p => p.id === 'memory')!.risk, 'LOW');
});

test('serious findings come only from measurements: drive self-warnings, failed memory tests, errors', () => {
  const dying = buildReport(laptop({ diagnostics: { ...laptop().diagnostics, storage: { disks: [{ model: 'WD10', mediaType: 'HDD', busType: 'SATA', health: 'Unhealthy', sizeBytes: 1e12, reliability: { powerOnHours: 9000, readErrorsUncorrected: 14 } }], ataSmart: [{ predictFailure: true }] } } }), ctx(), null);
  assert.ok(['HIGH', 'CRITICAL'].includes(dying.parts.find(p => p.id === 'disk-0')!.risk));
  const badRam = buildReport(laptop({ diagnostics: { ...laptop().diagnostics, memory: { diagnosticResults: [{ at: '2026-09-01T00:00:00Z', passed: false }] } } }), ctx(), null);
  assert.equal(badRam.parts.find(p => p.id === 'memory')!.risk, 'CRITICAL');
  const healthy = buildReport(laptop({ diagnostics: { ...laptop().diagnostics, storage: { disks: [{ model: 'SAMSUNG SSD', mediaType: 'SSD', busType: 'NVMe', health: 'Healthy', sizeBytes: 5e11, reliability: { powerOnHours: 3000, wearPercent: 4 } }], ataSmart: [] } } }), ctx(), null);
  assert.equal(healthy.parts.find(p => p.id === 'disk-0')!.risk, 'LOW');
});

test('Windows 11 readiness lists each requirement with its measured value, and Windows 10 is called out honestly', () => {
  const ok = windowsReadiness(laptop()); assert.equal(ok.windows11Ready, true); assert.equal(ok.runningWindows10, false);
  const old = windowsReadiness(laptop({ cpu: { name: 'Intel(R) Core(TM) i5-7200U', architecture: 'x64' }, os: { build: '19045' }, bios: { mode: 'UEFI', tpm: { present: false } } }));
  assert.equal(old.windows11Ready, false); assert.equal(old.runningWindows10, true); assert.match(old.supportNote!, /14 October 2025/);
  assert.deepEqual(old.checks.filter(c => c.ok === false).map(c => c.name), ['Processor (Windows 11 supported list)', 'Security chip TPM 2.0']);
  assert.equal(windowsReadiness({}).windows11Ready, null);                                         // nothing known: not "ready", not "unfit"
});

test('repair or replace: the numbers are shown, come from the price book, and do not appear when there is no price book', () => {
  assert.equal((buildReport(laptop(), ctx(), null).cost as any).priced, false);
  const r = buildReport(laptop(), ctx({ ramPeakPercent: 93, purchaseCost: 900 }), REFERENCE_PRICE_BOOK); const c: any = r.cost;
  assert.equal(c.priced, true); assert.equal(c.priceSource, 'reference'); assert.equal(c.replacementCost, 700);
  // add 8 GB (25) + 0.5 h (15) ; SSD (40) + 1.5 h (45); battery (60) + 0.5 h (15); cooling 15 + 1.5 h (45)
  assert.deepEqual(c.lines.map((l: any) => [l.title, l.total]).sort(), [['Add 8 GB of memory', 40], ['Cooling service', 60], ['Replace the battery', 75], ['Replace the hard disk with an SSD', 85]]);
  assert.equal(c.repairTotal, 260); assert.equal(c.decision, 'REPLACE');                             // 260 is 37% of 700, above the 35% line
  assert.equal(c.residualValue, Math.round(0.7 ** 6.5 * 900) > 90 ? Math.round(0.7 ** 6.5 * 900) : 90);
  assert.ok(c.reasoning.some((x: string) => /costs 37% of a new computer/.test(x) || /repairs cost 3\d% of a new computer/.test(x)));
});

test('a machine that cannot run a supported Windows and is worn out is advised to be replaced, with the reasons', () => {
  const a = laptop({ cpu: { name: 'Intel(R) Core(TM) i5-6200U', architecture: 'x64' }, os: { build: '19045' }, bios: { mode: 'UEFI', tpm: { present: false } }, monitors: [{ builtIn: true, year: 2016, week: 10 }], battery: null });
  const r: any = buildReport(a, ctx(), REFERENCE_PRICE_BOOK).cost;
  assert.equal(r.decision, 'REPLACE'); assert.ok(r.reasoning.some((x: string) => /cannot run Windows 11 and Windows 10 no longer receives/.test(x)));
  assert.equal(lifeStage(10.5, 'laptop').stage, 'Past its typical life'); assert.equal(lifeStage(0.5, 'laptop').stage, 'New'); assert.equal(lifeStage(null, 'laptop').remainingYears, null);
});

test('changes between two readings are found: a swapped drive, extra memory, a replaced battery; nothing is reported when nothing changed', () => {
  const before = laptop(); assert.deepEqual(diffAnatomy(before, laptop()), []);
  const after = laptop({ memory: { ...laptop().memory, slotsUsed: 2, modules: [...laptop().memory.modules, { slot: 'ChannelB-DIMM0', capacityBytes: 8 * 2 ** 30, type: 'DDR4', formFactor: 'SODIMM', serial: 'NEW99', manufacturer: 'Kingston' }] },
    battery: { ...laptop().battery, serial: '9999', name: 'DELL NEW', fullChargeMWh: 59000 }, diagnostics: { ...laptop().diagnostics, storage: { disks: [{ model: 'KINGSTON SSD', sizeBytes: 5e11, mediaType: 'SSD', busType: 'SATA' }], ataSmart: [] } } });
  const d = diffAnatomy(before, after);
  assert.deepEqual(d.map(x => `${x.kind}:${x.change}`).sort(), ['battery:replaced', 'disk:replaced', 'memory:added']);
  assert.equal(diffAnatomy(null, after).length, 0, 'the first reading has nothing to compare with');
});

// ---- the routes ----------------------------------------------------------------------------------------------------------------------------------------------------
let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54353); });
after(async () => { await h.stop(); });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
const PK = { 'x-platform-key': 'platform-key' }; const PW = 'correct horse battery';
async function org(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: PW, autopilot: false }, PK);
  const l = await post('/api/v1/auth/login', { email, password: PW }); return { id: r.json().organizationId as string, auth: { authorization: `Bearer ${l.json().token}` } };
}
async function enroll(o: { auth: Record<string, string> }, name: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, o.auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: 'G-' + randomBytes(6).toString('hex'), hostname: name, agentVersion: '0.1.0' });
  return { id: e.json().deviceId as string, auth: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } };
}

test('the agent reports its anatomy; the report, its history and the price book work, and another organization sees none of it', async () => {
  const a = await org('Anatomy Co', 'owner@anatomy.test'), b = await org('Other Anatomy', 'owner@other-anatomy.test');
  const pc = await enroll(a, 'WORK-LAPTOP');
  assert.equal((await get(`/api/v1/devices/${pc.id}/anatomy`, a.auth)).json().available, false);
  assert.equal((await post('/agent/v1/anatomy', laptop(), pc.auth)).statusCode, 201);
  const first = (await get(`/api/v1/devices/${pc.id}/anatomy`, a.auth)).json();
  assert.equal(first.available, true); assert.equal(first.report.identity.model, 'Latitude 5400'); assert.equal(first.report.cost.priced, false);
  assert.equal(first.changes.length, 0);

  // price book: reference prices can be loaded, entered prices replace them, and bad input is refused
  assert.equal((await put('/api/v1/price-book', { currency: 'usd', labourPerHour: 10, items: {}, newPc: {} }, a.auth)).statusCode, 400);
  assert.equal((await post('/api/v1/price-book/reference', {}, a.auth)).statusCode, 200);
  assert.equal((await get(`/api/v1/devices/${pc.id}/anatomy`, a.auth)).json().report.cost.priceSource, 'reference');
  assert.equal((await put('/api/v1/price-book', { currency: 'ZMW', labourPerHour: 150, items: { ram_ddr4: 600, ssd_256gb: 900, battery_laptop: 1200, thermal_service: 200 }, newPc: { laptop: 15000 } }, a.auth)).statusCode, 200);
  const priced = (await get(`/api/v1/devices/${pc.id}/anatomy`, a.auth)).json().report.cost;
  assert.equal(priced.currency, 'ZMW'); assert.equal(priced.priceSource, 'entered'); assert.equal(priced.replacementCost, 15000);

  // a later reading with a swapped battery and a new memory module is recorded as changes, once
  const changed = laptop({ memory: { ...laptop().memory, slotsUsed: 2, modules: [...laptop().memory.modules, { slot: 'B', capacityBytes: 8 * 2 ** 30, type: 'DDR4', formFactor: 'SODIMM', serial: 'NEW99' }] }, battery: { ...laptop().battery, serial: '9999', fullChargeMWh: 59000 }, collectedAt: '2026-10-02T10:00:00Z' });
  const r = await post('/agent/v1/anatomy', changed, pc.auth); assert.equal(r.json().changes, 2);
  assert.equal((await post('/agent/v1/anatomy', { ...changed, collectedAt: '2026-10-03T10:00:00Z' }, pc.auth)).json().changes, 0);       // nothing new: no duplicate history
  const after = (await get(`/api/v1/devices/${pc.id}/anatomy`, a.auth)).json(); assert.deepEqual(after.changes.map((c: any) => c.kind).sort(), ['battery', 'memory']);

  assert.equal((await get(`/api/v1/devices/${pc.id}/anatomy`, b.auth)).statusCode, 404);
  assert.equal((await get('/api/v1/anatomy/fleet', b.auth)).json().computers.length, 0);
  const fleet = (await get('/api/v1/anatomy/fleet', a.auth)).json(); assert.equal(fleet.computers.length, 1); assert.equal(fleet.computers[0].hostname, 'WORK-LAPTOP');
  assert.equal((await post('/agent/v1/anatomy', { nonsense: true }, pc.auth)).statusCode, 400);
});

test('replace and budget: the fleet is sorted into replace, plan, repair and keep, with costs from the organization\'s own prices, and nobody else sees it', async () => {
  const a = await org('Budget Co', 'owner@budget.test'), b = await org('Other Budget', 'owner@other-budget.test');
  assert.deepEqual((await get('/api/v1/anatomy/budget', a.auth)).json().computers, [], 'no readings yet');
  const old = await enroll(a, 'OLD-LAPTOP'), young = await enroll(a, 'NEW-LAPTOP'), silent = await enroll(a, 'QUIET-PC');
  await put('/api/v1/price-book', { currency: 'ZMW', labourPerHour: 150, items: { ram_ddr4: 650, ssd_512gb: 1400, battery_laptop: 1500, thermal_service: 400, os_reinstall: 250 }, newPc: { laptop: 17500, desktop: 13500, unknown: 17500 } }, a.auth);
  await h.app.inject({ method: 'PATCH', url: `/api/v1/devices/${old.id}/purchase`, payload: { purchaseDate: '2016-03-01', purchaseCost: 9000 } as any, headers: a.auth });
  await h.app.inject({ method: 'PATCH', url: `/api/v1/devices/${young.id}/purchase`, payload: { purchaseDate: new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10), purchaseCost: 16000 } as any, headers: a.auth });
  await post('/agent/v1/anatomy', laptop(), old.auth);
  await post('/agent/v1/anatomy', laptop({ battery: { ...laptop().battery, fullChargeMWh: 59000, wearPercent: 2, cycleCount: 30 }, diagnostics: { storage: { disks: [{ ...laptop().diagnostics.storage.disks[0], mediaType: 'SSD', model: 'WD SSD 512', reliability: { powerOnHours: 500 } }] } } }), young.auth);
  const r = (await get('/api/v1/anatomy/budget', a.auth)).json();
  assert.equal(r.currency, 'ZMW'); assert.equal(r.priceSource, 'entered'); assert.equal(r.priced, true);
  assert.equal(r.assessed, 2); assert.equal(r.unread, 1, 'a computer that has not sent a reading is counted as unread, not guessed');
  const o = r.computers.find((c: any) => c.hostname === 'OLD-LAPTOP'), y = r.computers.find((c: any) => c.hostname === 'NEW-LAPTOP');
  assert.ok(['replace', 'plan'].includes(o.bucket), 'a ten-year-old laptop is to be replaced or planned for: ' + o.bucket);
  assert.equal(o.cost, 17500 + 300, 'the cost of a new laptop plus two hours of labour to move files');
  assert.ok(['keep', 'repair'].includes(y.bucket) && y.cost < 3000, 'a year-old laptop needs at most a small repair: ' + y.bucket + ' ' + y.cost);
  assert.equal(r.replaceNow.cost + r.plan.cost, 17800); assert.ok(r.fleetValue > 0);
  assert.equal(r.ageBands.reduce((n: number, x: any) => n + x.count, 0), 2);
  assert.equal(r.computers[0].hostname, 'OLD-LAPTOP', 'the most urgent comes first');
  assert.deepEqual((await get('/api/v1/anatomy/budget', b.auth)).json().computers, [], 'another organization sees nothing');
});
