#!/usr/bin/env node
// Guards the "NO VPS MINING" rule from the mining directive at build time: the server image must never contain a mining binary,
// mining startup script, or Stratum client. The mining executable belongs exclusively to the Windows endpoint package.
// Usage: node scripts/check-no-miner-in-image.mjs [path-to-built-image-dir-or-tar-listing]
// Exit 0 = clean. Exit 1 = a forbidden name was found; CI must fail the build.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_NAMES = [/^xmrig(\.exe)?$/i, /^xmr-?stak(\.exe)?$/i, /^vltrig(\.exe)?$/i, /^minerd(\.exe)?$/i, /^cpuminer(\.exe)?$/i, /randomx.*\.(so|dll)$/i];
const FORBIDDEN_IN_SCRIPTS = [/stratum\+(tcp|ssl|tls)/i, /--donate-level/i, /\brx\/0\b/i, /pool\.hashvault\./i, /\bcryptonight\b/i];
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.sh', '.ps1', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function main(root) {
  const problems = [];
  for (const path of walk(root)) {
    const name = path.split(/[\\/]/).pop() ?? '';
    if (FORBIDDEN_NAMES.some(rx => rx.test(name))) { problems.push(`forbidden binary name: ${path}`); continue; }
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    if (!SCAN_EXT.has(ext)) continue;
    let text; try { text = readFileSync(path, 'utf8'); } catch { continue; }
    for (const rx of FORBIDDEN_IN_SCRIPTS) if (rx.test(text)) problems.push(`forbidden content (${rx}): ${path}`);
  }
  return problems;
}

const root = process.argv[2] ?? join(process.cwd(), 'dist');
const stat = (() => { try { return statSync(root); } catch { return null; } })();
if (!stat) { console.log(`check-no-miner-in-image: nothing at ${root} yet (ok if this runs before build); skipping`); process.exit(0); }
const problems = main(root);
if (problems.length) {
  console.error('check-no-miner-in-image: the server image must never contain a mining component. Found:');
  for (const p of problems) console.error('  - ' + p);
  console.error('The mining executable belongs exclusively to the Windows endpoint package (agent/), never the server build.');
  process.exit(1);
}
console.log(`check-no-miner-in-image: clean (${root})`);
process.exit(0);
