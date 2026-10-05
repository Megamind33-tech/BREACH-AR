import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

test('every script the console page loads exists, and together they parse (no syntax errors, no duplicate declarations)', () => {
  const html = readFileSync(join(pub, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]!);
  assert.ok(scripts.length >= 4, 'expected the app and its view files');
  for (const s of scripts) assert.ok(existsSync(join(pub, s)), `missing ${s}`);
  const all = scripts.map(s => readFileSync(join(pub, s), 'utf8')).join('\n');
  assert.doesNotThrow(() => new Function(all));
  for (const f of readdirSync(pub).filter(f => f.endsWith('.js'))) assert.ok(scripts.includes(f), `${f} exists but is not loaded by index.html`);
});

test('the console escapes untrusted text before putting it in the page', () => {
  const app = readFileSync(join(pub, 'app.js'), 'utf8');
  assert.match(app, /const esc = /);
  // every view module renders server data through esc(); a raw template interpolation of a known-hostile field would be a regression
  for (const f of ['app.js', 'views-extra.js', 'views-support.js', 'views-compute.js', 'views-webhooks.js', 'views-autopilot.js', 'views-install.js', 'views-care.js', 'views-fleet.js', 'views-protect.js', 'views-threats.js', 'views-mechanic.js']) {
    const src = readFileSync(join(pub, f), 'utf8');
    // dialog(title, ...) escapes its title itself, so lines that only build a dialog title are fine
    const bad = src.split('\n').filter(l => !/\bdialog\(/.test(l) && /\$\{\s*(hostname|d\.hostname|x\.hostname|s\.hostname|e\.message)\s*\}/.test(l));
    assert.deepEqual(bad, [], `${f} interpolates a hostname/message without esc()`);
  }
});

test('a driver card never repeats the manufacturer name when Windows already put it in the model string', () => {
  const src = readFileSync(join(pub, 'views-extra.js'), 'utf8');
  const m = src.match(/const driverName = u => \{[\s\S]*?\n\};/);
  assert.ok(m, 'driverName helper not found');
  const driverName = new Function(`${m![0]}\nreturn driverName;`)();
  assert.equal(driverName({ manufacturer: 'Realtek', model: 'Realtek(R) Audio' }), 'Realtek(R) Audio');
  assert.equal(driverName({ manufacturer: 'Intel', model: 'Intel(R) Wi-Fi 6 AX201 160MHz' }), 'Intel(R) Wi-Fi 6 AX201 160MHz');
  assert.equal(driverName({ manufacturer: 'Dell', model: 'Universal Audio Driver' }), 'Dell Universal Audio Driver');
  assert.equal(driverName({ manufacturer: null, model: null, title: 'Some Update' }), 'Some Update');
});
