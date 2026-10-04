import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHardware } from '../src/hardware.js';
import { scoreHealth, SnapshotSchema } from '../src/health.js';

const codes = (r: ReturnType<typeof analyzeHardware>) => r.findings.map(f => f.code);
const nvme = (over: object = {}) => ({ storage: { disks: [{ index: 0, model: 'Test NVMe', health: 'Healthy', nvme: { criticalWarning: 0, temperatureC: 40, availableSparePercent: 100, availableSpareThresholdPercent: 10, percentageUsed: 3, mediaErrors: 0, powerOnHours: 500, ...over } }] } });

test('healthy NVMe produces no findings and records what was checked', () => {
  const r = analyzeHardware(nvme());
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.findings, []);
  assert.ok(r.checked.some(c => c.startsWith('NVMe SMART')));
});

test('NVMe critical-warning bits, media errors, spare and life are each reported', () => {
  const r = analyzeHardware(nvme({ criticalWarning: 0b00101, mediaErrors: 7, percentageUsed: 100 }));
  assert.equal(r.verdict, 'critical');
  for (const c of ['storage.nvme_critical_1', 'storage.nvme_critical_4', 'storage.nvme_media_errors', 'storage.nvme_life']) assert.ok(codes(r).includes(c), c);
  assert.ok(!codes(r).includes('storage.nvme_critical_2'));
  assert.equal(analyzeHardware(nvme({ percentageUsed: 85 })).verdict, 'warning');
  assert.equal(analyzeHardware(nvme({ temperatureC: 82 })).verdict, 'critical');
});

test('unsafe shutdowns: informational at a moderate ratio, warning when most power cycles were unclean', () => {
  const info = analyzeHardware(nvme({ unsafeShutdowns: 469, powerCycles: 1963 }));
  assert.equal(info.findings[0]!.code, 'storage.unsafe_shutdowns');
  assert.equal(info.findings[0]!.severity, 'info');
  assert.match(info.findings[0]!.message, /24% of 1963 power cycles/);
  assert.equal(analyzeHardware(nvme({ unsafeShutdowns: 300, powerCycles: 400 })).verdict, 'warning');
  assert.deepEqual(analyzeHardware(nvme({ unsafeShutdowns: 10, powerCycles: 100 })).findings, []);
});

test('the directive scenario: SSD with uncorrectable errors is CRITICAL and drives the health status', () => {
  const r = analyzeHardware({ storage: { disks: [{ index: 0, model: 'ACCOUNTING SSD', health: 'Warning', reliability: { readErrorsUncorrected: 4 } }] } });
  assert.equal(r.verdict, 'critical');
  assert.match(r.findings.find(f => f.code === 'storage.uncorrectable')!.message, /4 uncorrectable/);
  const snap = SnapshotSchema.parse({ collectedAt: new Date().toISOString(), physicalDisks: [{ name: 'ACCOUNTING SSD', mediaType: 'SSD', health: 'Healthy', isSystem: true }] });
  const h = scoreHealth(snap, undefined, r);
  assert.equal(h.status, 'critical');
  assert.ok(h.deductions.some(d => d.code === 'hw.storage.uncorrectable' && d.remedy === 'hardware'));
});

test('a completed diagnosis supersedes coarser snapshot disk signals (no double counting)', () => {
  const snap = SnapshotSchema.parse({ collectedAt: new Date().toISOString(), physicalDisks: [{ name: 'D', health: 'Unhealthy', isSystem: true }] });
  assert.ok(scoreHealth(snap).deductions.some(d => d.code === 'hardware.disk_unhealthy'));
  const withHw = scoreHealth(snap, undefined, analyzeHardware(nvme()));
  assert.ok(!withHw.deductions.some(d => d.code.startsWith('hardware.disk_')));
});

test('ATA SMART: predict-failure and bad-sector attributes', () => {
  const r = analyzeHardware({ storage: { ataSmart: [{ predictFailure: true, attributes: [{ id: 5, raw: 250 }, { id: 197, raw: 3 }, { id: 9, raw: 9000 }] }] } });
  assert.equal(r.verdict, 'critical');
  for (const c of ['storage.smart_predict_failure', 'storage.reallocated', 'storage.smart_197']) assert.ok(codes(r).includes(c), c);
  assert.equal(r.findings.find(f => f.code === 'storage.reallocated')!.severity, 'critical');
});

test('disk I/O error events, filesystem corruption and WHEA hardware errors', () => {
  const r = analyzeHardware({ storage: { ioErrors: { days: 30, disk: { '7': 2, '11': 1, '153': 4 }, ntfsCorruption: 1 } }, whea: { events30d: 5, samples: [{ message: 'A corrected hardware error has occurred' }] } });
  for (const c of ['storage.bad_block', 'storage.controller_error', 'storage.io_retried', 'storage.fs_corruption', 'platform.whea']) assert.ok(codes(r).includes(c), c);
  assert.equal(r.findings.find(f => f.code === 'platform.whea')!.severity, 'critical');
  assert.equal(analyzeHardware({ whea: { events30d: 0 } }).verdict, 'ok');
});

test('memory: mixed module speeds are informational; a failed Windows Memory Diagnostic is critical', () => {
  const mixed = analyzeHardware({ memory: { modules: [{ speedMhz: 2667, configuredMhz: 2400 }, { speedMhz: 2400, configuredMhz: 2400 }] } });
  assert.deepEqual(codes(mixed), ['memory.mixed_speed']);
  assert.equal(mixed.verdict, 'ok', 'info does not raise the verdict');
  assert.equal(analyzeHardware({ memory: { diagnosticResults: [{ passed: false, at: '2026-09-01' }] } }).verdict, 'critical');
});

test('battery health uses design vs full-charge capacity; thermals are point-in-time readings', () => {
  assert.equal(analyzeHardware({ battery: { designCapacityMWh: 48000, fullChargeCapacityMWh: 39131, cycleCount: 408 } }).findings[0]!.code, 'battery.aging');
  assert.equal(analyzeHardware({ battery: { designCapacityMWh: 48000, fullChargeCapacityMWh: 20000 } }).verdict, 'critical');
  assert.equal(analyzeHardware({ thermal: { zones: [{ name: '\\_TZ.CPUZ', tempC: 72 }] } }).verdict, 'ok');
  assert.equal(analyzeHardware({ thermal: { zones: [{ name: '\\_TZ.CPUZ', tempC: 93 }] } }).verdict, 'critical');
  assert.equal(analyzeHardware({ cpu: { thermalThrottleEvents7d: 9 } }).findings[0]!.code, 'cpu.throttled');
});

test('unreadable components are reported as unavailable with the reason, never scored', () => {
  const r = analyzeHardware({ unavailable: [{ component: 'NVMe SMART', reason: 'access denied' }], storage: { disks: [{ index: 0, model: 'X', health: 'Healthy', nvmeError: 'access denied' }] } });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.unavailable.length, 2);
  assert.match(r.unavailable[0]!.reason, /access denied/);
  assert.equal(analyzeHardware({}).verdict, 'ok');
  assert.deepEqual(analyzeHardware({}).checked, []);
});
