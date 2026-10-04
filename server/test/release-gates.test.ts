import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPAIR_RECIPES } from '../src/catalog.js';
import { scoreHealth } from '../src/health.js';
import { verdict, verification } from '../src/security-incidents.js';
import { decideGate } from '../src/healthgate.js';
import { protectionOf } from '../src/protection.js';
import { autoAllowed, AGGRESSIVE_RECIPES } from '../src/policies.js';

/**
 * The first-release gate: production must not ship if any of these is false. Each test names the rule it enforces.
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() && !/^(bin|obj|node_modules)$/.test(e.name) ? walk(join(d, e.name)) : [join(d, e.name)]);

test('GATE: malware remediation that cannot verify its result is never reported as resolved', () => {
  assert.equal(verdict({ threatGone: true, scanClean: null, noLinkedPersistence: true, protectionHealthy: true, policyRestored: true }), 'unverifiable');
  const v = verification({ scan: { id: 's', status: 'failed', result: null, error: 'x' }, status: { id: 't', status: 'completed', result: { threats: [], engineIsDefender: true }, error: null }, inspect: { id: 'i', status: 'completed', result: { findings: [] }, error: null } }, 'T');
  assert.notEqual(verdict(v), 'clean');
});

test('GATE: a hot, failing, infected or ransomware-hit PC never computes, and compute is lowest priority', () => {
  assert.equal(decideGate([{ code: 'hardware.cooling', status: 'HARDWARE_ACTION_REQUIRED', impact: 'medium', remedy: 'hardware' }]).gate, 'BLOCK');
  assert.equal(decideGate([{ code: 'hardware.disk_unhealthy', status: 'HARDWARE_ACTION_REQUIRED', impact: 'high', remedy: 'hardware' }]).gate, 'BLOCK');
  assert.equal(decideGate([], [{ status: 'INVESTIGATING', threat_type: 'malware' }]).gate, 'BLOCK');
  assert.equal(decideGate([], [{ status: 'DETECTED', threat_type: 'ransomware' }]).gate, 'BLOCK');
  assert.equal(decideGate([], [{ status: 'VERIFYING', threat_type: 'malware' }]).gate, 'PAUSE');
});

test('GATE: the default compute policy does not run on battery, and the signed policy carries that default', () => {
  const src = read(join(here, '..', 'src', 'compute.ts'));
  assert.match(src, /allowOnBattery: z\.boolean\(\)\.default\(false\)/); assert.match(src, /allowOnBattery: s\?\.allowOnBattery \?\? false/);
  const agent = read(join(here, '..', '..', 'agent', 'src', 'Viro.Compute', 'PolicyEngine.cs'));
  assert.match(agent, /B\("allowOnBattery", false\)/); assert.match(agent, /if \(!p\.AllowOnBattery && s\.OnBattery == true\) return No\("on-battery"/);
  assert.match(agent, /if \(heat == ThermalLevel\.Critical\) return No\("thermal-blocked"/, 'heat is checked before anything else about the person or schedule');
});

test('GATE: nothing in the health score is invented; an empty report measures nothing', () => {
  const r = scoreHealth({ collectedAt: new Date().toISOString() } as any);
  assert.equal(r.deductions.length, 0, 'no data means no findings, not made-up ones'); assert.ok(r.notMeasured.length > 3, 'and it says what it could not measure');
  const none = protectionOf({}); assert.ok(none.controls.every(c => c.state === 'unknown'), 'security state is never fabricated'); assert.equal(none.score, null);
});

test('GATE: risky repairs always need a person; only reversible or harmless ones may run by themselves', () => {
  for (const [id, r] of Object.entries(REPAIR_RECIPES)) {
    if (r.risk === 'review') for (const level of ['SAFE', 'BALANCED', 'AGGRESSIVE'] as const) assert.equal(autoAllowed({ jobType: 'repair.run', params: { recipe: id }, label: '' }, level), level === 'AGGRESSIVE' && AGGRESSIVE_RECIPES.has(id), `${id} must not run automatically at ${level} (only the documented reversible AGGRESSIVE exception may)`);
  }
  for (const id of ['security.remove-persistence', 'security.restore-hosts', 'privacy.block-extension', 'protect.ransomware-block']) assert.equal((REPAIR_RECIPES as any)[id].risk, 'review', id);
});

test('GATE: every repair recipe in the catalog is covered by a test, and the agent implements exactly the catalog', () => {
  const tests = [...walk(here), ...walk(join(here, '..', '..', 'agent', 'tests'))].filter(f => /\.(ts|cs)$/.test(f) && !f.endsWith('release-gates.test.ts')).map(read).join('\n');
  const untested = Object.keys(REPAIR_RECIPES).filter(id => !tests.includes(`"${id}"`) && !tests.includes(`'${id}'`));
  assert.deepEqual(untested, [], 'recipes without a single test mention');
  const agentIds = new Set([...walk(join(here, '..', '..', 'agent', 'src')).filter(f => f.endsWith('.cs')).map(read).join('\n').matchAll(/\b(?:Id => |Id = |SecurityRecipe\(|PolicyRecipe\(|Pref\(|DefenderPreferenceRecipe\()"([a-z]+\.[a-z0-9-]+)"/g)].map(m => m[1]));
  const missing = Object.keys(REPAIR_RECIPES).filter(id => !agentIds.has(id)); assert.deepEqual(missing, [], 'catalog recipes the agent does not implement');
});

test('GATE: popups and notices use fixed text; Control cannot send arbitrary text or commands to a PC', () => {
  const jobs = read(join(here, '..', 'src', 'jobs.ts'));
  assert.match(jobs, /'ui\.notify'.*z\.enum\(\['storage-failing'\]\)/s);
  assert.doesNotMatch(jobs, /powershell|cmd\.exe|Invoke-Expression/i, 'no job type takes a command line');
});
