// Photographs every page of the Windows app's interface, using the real Care/ui/index.html and a pretend bridge with sample data (mock-bridge.js).
// Usage:  node tools/ui-preview/preview.mjs --tag after [--pages overview,space] [--width 1240 --height 800] [--scenario attention|healthy]
// Output: tools/ui-preview/out/<tag>-<page>.png        (needs Chrome or Edge; uses the `ws` package from ../server)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = join(here, '..', '..');
const WebSocket = createRequire(join(agentRoot, '..', 'server', 'package.json'))('ws');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const tag = arg('tag', 'shot'), width = +arg('width', 1240), height = +arg('height', 800), scenario = arg('scenario', 'attention');
const ALL = ['overview', 'security', 'updates', 'swupdates', 'stability', 'performance', 'slow', 'apps', 'installed', 'space', 'startup', 'memory', 'workspace', 'activity', 'undo'];
const pages = arg('pages', ALL.join(',')).split(',').filter(Boolean);
const OUT = join(here, 'out'); mkdirSync(OUT, { recursive: true });
const ui = pathToFileURL(join(agentRoot, 'src', 'Viro.Agent', 'Care', 'ui', 'index.html')).href;
const mock = readFileSync(join(here, 'mock-bridge.js'), 'utf8');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!CHROME) throw new Error('no Chrome or Edge found');
const profile = mkdtempSync(join(tmpdir(), 'viro-ui-'));
const port = 9340 + Math.floor(Math.random() * 100);
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const finish = () => { try { chrome.kill(); } catch { /* gone */ } setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* temp */ } }, 1500); };
process.on('exit', finish);

let wsUrl; for (let i = 0; i < 60 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* starting */ } if (!wsUrl) await sleep(500); }
if (!wsUrl) throw new Error('Chrome did not start');
const ws = new WebSocket(wsUrl); await new Promise(r => ws.on('open', r));
let nextId = 1; const waiting = new Map(); ws.on('message', m => { const d = JSON.parse(m); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; waiting.set(id, d => d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result)); ws.send(JSON.stringify({ id, method, params })); });
const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'script error'); return r.result.value; };

await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
const errors = [];
ws.on('message', m => { const d = JSON.parse(m); if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
await send('Runtime.enable');
for (const page of pages) {
  const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__start=${JSON.stringify(page)};window.__scenario=${JSON.stringify(scenario)};` + mock });
  await send('Page.navigate', { url: ui }); await sleep(2600);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${tag}-${page}.png`), Buffer.from(data, 'base64'));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  console.log('wrote', `${tag}-${page}.png`);
}
if (errors.length) console.log('SCRIPT ERRORS:\n' + [...new Set(errors)].join('\n'));
ws.close(); finish(); process.exit(errors.length ? 1 : 0);
