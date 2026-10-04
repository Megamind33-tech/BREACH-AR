// Takes the product screenshots used on the marketing site, in the LIGHT theme, from the fictional demo school (scripts/site-demo.ts must be running).
// It drives a headless Chrome over the DevTools protocol (using the `ws` package Control already depends on) and writes WebP files to public/site/img/.
// Usage:  node scripts/site-screenshots.mjs        (needs Chrome and ffmpeg on this PC)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'public', 'site', 'img'); mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:8098', PORT = 9333;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!CHROME) throw new Error('no Chrome or Edge found');
const profile = mkdtempSync(join(tmpdir(), 'viro-shots-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const done = () => { try { chrome.kill(); } catch { /* already gone */ } setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* temp */ } }, 1500); };
process.on('exit', done);

async function connect() {
  for (let i = 0; i < 60; i++) { try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const page = list.find(t => t.type === 'page'); if (page) return page.webSocketDebuggerUrl; } catch { /* starting */ } await sleep(500); }
  throw new Error('Chrome did not start');
}
const ws = new WebSocket(await connect()); await new Promise(r => ws.on('open', r));
let nextId = 1; const waiting = new Map(); ws.on('message', m => { const d = JSON.parse(m); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; waiting.set(id, d => d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result)); ws.send(JSON.stringify({ id, method, params })); });
const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'script error'); return r.result.value; };

await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: BASE + '/about.html' }); await sleep(1500);        // any page on the origin, to set storage
// light theme, and a signed-in session for the demo owner (test credentials of the throw-away demo only)
const ids = await js(`(async () => {
  localStorage.setItem('viro_theme', 'light');
  const l = await (await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@demo.test', password: 'demo-local-pass-1' }) })).json();
  sessionStorage.setItem('viro_token', l.token);
  const d = await (await fetch('/api/v1/devices', { headers: { authorization: 'Bearer ' + l.token } })).json();
  return Object.fromEntries(d.devices.map(x => [x.hostname, x.id]));
})()`);

// The hero picture is a wide window; the others are a narrower window so the text stays readable when they are shown beside a paragraph.
async function shot(name, hash, { wait = 4500, before = '', width = 1060, height = 720 } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: BASE + '/' + (hash ? '#' + hash : '') }); await sleep(1200);
  await js(`document.documentElement.dataset.theme = 'light'`);
  await js(`location.hash = ${JSON.stringify(hash)}`); await sleep(wait);
  // the banner clip: show a good frame, still
  await js(`(async () => { const v = document.querySelector('video.hero-video'); if (v) { v.pause(); v.currentTime = 1.5; await new Promise(r => { v.addEventListener('seeked', r, { once: true }); setTimeout(r, 2500); }); } })()`);
  if (before) await js(before); await sleep(700);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const png = join(tmpdir(), `viro-${name}.png`); writeFileSync(png, Buffer.from(data, 'base64'));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-vf', 'scale=2000:-1', '-c:v', 'libwebp', '-quality', '84', '-compression_level', '6', join(OUT, `${name}.webp`)]);
  rmSync(png, { force: true }); console.log('wrote', name + '.webp');
}
const scrollTo = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) { e.scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); } })()`;

await shot('shot-overview', '#/overview', { width: 1440, height: 690 });
await shot('shot-computers', '#/computers');
await shot('shot-computer', '#/computers/' + ids['LIBRARY-03'], { wait: 7000 });
await shot('shot-remote', '#/computers/' + ids['LAB-PC-02'], { wait: 7000, before: scrollTo('.remote-bar') });
await shot('shot-hardware', '#/anatomy/' + ids['LAB-PC-02'], { wait: 6000 });
await shot('shot-upgrades', '#/upgrades/' + ids['LAB-PC-02'], { wait: 6000 });
await shot('shot-lifecycle', '#/lifecycle', { wait: 6000 });
await shot('shot-alerts', '#/alerts');
ws.close(); done(); process.exit(0);
