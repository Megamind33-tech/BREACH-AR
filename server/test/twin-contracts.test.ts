import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, tally, worst, RULES } from '../src/twin/rules.js';
import { DiagnosticFinding, PcInventory, DeviceSummary, ScanProgress, ComputeStatus, SCHEMA_VERSION } from '../src/twin/contracts.js';
import { render } from '../scripts/twin-export.js';

const packages = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages');
const vectors = JSON.parse(readFileSync(join(packages, 'health-rules', 'vectors.json'), 'utf8'));

test('every shared vector produces exactly the expected findings (ids, severities, evidence types, listed evidence)', () => {
  for (const c of vectors.cases) {
    const { findings } = evaluate(c.input);
    assert.deepEqual(findings.map(f => [f.id, f.severity, f.evidenceType]), c.expect.map((e: any) => [e.id, e.severity, e.evidenceType]), c.name);
    for (const e of c.expect) {
      const f = findings.find(x => x.id === e.id)!;
      for (const [k, v] of Object.entries(e.evidence)) {
        const got = f.evidence.find(x => x.name === k)?.value;
        assert.ok(typeof v === 'number' ? Math.abs((got as number) - v) < 1e-9 : got === v, `${c.name}: ${e.id} evidence ${k} = ${v}, got ${got}`);
      }
    }
    for (const f of findings) assert.doesNotThrow(() => DiagnosticFinding.parse(f), c.name);
  }
});

test('the directive example: a battery at 71 percent is attention, measured, with design and full-charge evidence and no urgency claim', () => {
  const { findings } = evaluate({ schemaVersion: 1, battery: { designWh: 54.1, fullChargeWh: 38.4 } });
  const b = findings.find(f => f.id === 'battery.capacity')!;
  assert.equal(b.severity, 'attention'); assert.equal(b.evidenceType, 'measured');
  assert.match(b.summary, /71%/); assert.match(b.recommendedAction ?? '', /not yet urgent/i);
  assert.deepEqual(b.evidence.map(e => e.name), ['designCapacityWh', 'fullChargeCapacityWh', 'capacityPercent']);
});

test('unreadable inputs are skipped and reported, never turned into findings; no rule predicts a failure date', () => {
  const r = evaluate({ schemaVersion: 1 }); assert.deepEqual(r.findings, []); assert.ok(r.skipped.includes('battery.capacity'));
  const all = JSON.stringify(RULES).toLowerCase();
  for (const bad of ['days remaining', 'will fail in', 'guarantee']) assert.ok(!all.includes(bad), bad);
  assert.equal(worst(evaluate({ schemaVersion: 1, security: { defenderEnabled: false } }).findings), 'critical');
  assert.deepEqual(tally(evaluate(vectors.cases[0].input).findings), { passed: 5, attention: 1, critical: 0 });
});

test('inventory and payload schemas accept real shapes, ignore unknown fields and reject a wrong schema version', () => {
  assert.doesNotThrow(() => PcInventory.parse({ ...vectors.cases[0].input, extraFieldFromANewerVersion: 1 }));
  assert.throws(() => PcInventory.parse({ ...vectors.cases[0].input, schemaVersion: 2 }));
  const now = new Date().toISOString();
  assert.doesNotThrow(() => DeviceSummary.parse({ schemaVersion: SCHEMA_VERSION, deviceId: 'd1', timestamp: now, source: 'server', kind: 'pc', name: 'Office PC', status: 'attention', headline: 'Storage is almost full', freshness: 'recent', isThisDevice: false }));
  assert.throws(() => DeviceSummary.parse({ schemaVersion: SCHEMA_VERSION, deviceId: 'd1', timestamp: 'yesterday', source: 'server', kind: 'pc', name: 'x', status: 'healthy', headline: 'x', freshness: 'live' }), 'timestamps must be ISO');
  assert.doesNotThrow(() => ScanProgress.parse({ schemaVersion: SCHEMA_VERSION, deviceId: 'd1', timestamp: now, source: 'quickcheck', scanId: 's', stages: [{ id: 'cpu', label: 'Processor', state: 'done' }, { id: 'storage', label: 'Storage', state: 'running' }], completedStages: 1, totalStages: 2, finished: false }));
  assert.doesNotThrow(() => ComputeStatus.parse({ schemaVersion: SCHEMA_VERSION, deviceId: 'd1', timestamp: now, source: 'server', available: true, enabledByPolicy: true, state: 'running', consentRecorded: true, canPause: true, canResume: false }));
});

test('the checked-in JSON Schemas and rules.json are exactly what the TypeScript source exports (so Kotlin and C# build against current files)', () => {
  for (const [rel, text] of Object.entries(render())) {
    const p = join(packages, rel); assert.ok(existsSync(p), `${rel} is missing: run "npx tsx scripts/twin-export.ts" in server/`);
    assert.equal(readFileSync(p, 'utf8'), text, `${rel} is stale: run "npx tsx scripts/twin-export.ts" in server/`);
  }
});
