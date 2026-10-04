// Records a real "using Viro" walkthrough: it drives the actual Windows-app interface (Care/ui/index.html with the sample-data bridge) like a person would, with a visible
// cursor and short step captions, and joins the frames into a 1920x1080 video. This shows the product in use; it is not an advertisement.
// Usage: node tools/ui-preview/demo.mjs [--fps 20] [--out ../../docs/video]      writes viro-usage-demo.mp4 (silent) and viro-usage-events.json (for the soundtrack)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), agentRoot = join(here, '..', '..'), repo = join(agentRoot, '..');
const WebSocket = createRequire(join(repo, 'server', 'package.json'))('ws');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const FPS = +arg('fps', 20), OUT = arg('out', join(repo, 'docs', 'video')); mkdirSync(OUT, { recursive: true });
const VW = 1366, VH = 768, DSF = 1920 / VW;                         // 1366x768 css pixels at 1.406x = 1920x1080
const ui = pathToFileURL(join(agentRoot, 'src', 'Viro.Agent', 'Care', 'ui', 'index.html')).href;
const mock = readFileSync(join(here, 'mock-bridge.js'), 'utf8');
const logo = 'data:image/png;base64,' + readFileSync(join(repo, 'server', 'public', 'logo.png')).toString('base64');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const profile = mkdtempSync(join(tmpdir(), 'viro-demo-')), frames = join(profile, 'frames'); mkdirSync(frames);
const port = 9540 + Math.floor(Math.random() * 100);
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(profile, 'p')}`, '--headless=new', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--allow-file-access-from-files'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl; for (let i = 0; i < 60 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* starting */ } if (!wsUrl) await sleep(300); }
const ws = new WebSocket(wsUrl); await new Promise(r => ws.on('open', r));
let nextId = 1; const waiting = new Map(); ws.on('message', m => { const d = JSON.parse(m); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; waiting.set(id, d => d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result)); ws.send(JSON.stringify({ id, method, params })); });
const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: DSF, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__start='overview';window.__scenario='plus';` + mock });
await send('Page.navigate', { url: ui }); await sleep(2800);

// the film overlay: cursor, step caption, and title / end cards
await js(`(() => {
  const st = document.createElement('style'); st.textContent = \`
  #dcur{position:fixed;left:0;top:0;width:30px;height:30px;z-index:99999;pointer-events:none;transform:translate(-4px,-3px);filter:drop-shadow(0 3px 5px rgba(0,0,0,.6))}
  #dring{position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #5fe0a8;z-index:99998;pointer-events:none;opacity:0}
  #dcap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99997;display:flex;align-items:center;gap:16px;max-width:1120px;padding:16px 26px 16px 18px;border-radius:16px;background:rgba(6,18,13,.92);border:1px solid rgba(95,224,168,.35);box-shadow:0 18px 50px rgba(0,0,0,.55);color:#fff;font:600 21px/1.35 Inter,"Segoe UI",system-ui,sans-serif;opacity:0;transition:opacity .35s}
  #dcap b{flex:none;width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:#5fe0a8;color:#04231a;font-size:19px;font-weight:800}
  #dcap span{color:rgba(255,255,255,.72);font-weight:500}
  .dcard{position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;background:radial-gradient(70% 55% at 80% 105%,rgba(37,170,115,.38) 0,transparent 70%),#07120e;color:#fff;font-family:Inter,"Segoe UI",system-ui,sans-serif;text-align:center;opacity:0;transition:opacity .5s;pointer-events:none}
  .dcard img{width:96px;height:96px;border-radius:24px}.dcard h1{font-size:64px;font-weight:600;letter-spacing:-.04em;line-height:1.05}.dcard h1 em{font-style:normal;color:#5fe0a8}.dcard p{font-size:26px;color:rgba(255,255,255,.66);max-width:900px;line-height:1.4}.dcard u{text-decoration:none;color:#fff;font-weight:600}\`;
  document.head.appendChild(st);
  document.body.insertAdjacentHTML('beforeend', '<svg id="dcur" viewBox="0 0 24 24"><path d="M3 2l15 9-6.5 1.600L8.500 19z" fill="#fff" stroke="#07120e" stroke-width="1.600" stroke-linejoin="round"/></svg><div id="dring"></div><div id="dcap"><b id="dn"></b><div id="dt"></div></div>'
    + '<div class="dcard" id="dstart"><img src="${logo}" alt=""><h1>Viro WorkCare,<br><em>in use.</em></h1><p>A short walk through the Windows app: fix a PC, check its parts, and get ready for a new one.</p></div>'
    + '<div class="dcard" id="dend"><img src="${logo}" alt=""><h1>Try it on your own PC.</h1><p>The free scan needs no account.<br><u>workcare.viro3.online</u></p></div>');
  window.__cap = (n, head, rest) => { const c = document.getElementById('dcap'); if (!head) { c.style.opacity = 0; return; } document.getElementById('dn').textContent = n; document.getElementById('dt').innerHTML = head + (rest ? ' <span>' + rest + '</span>' : ''); c.style.opacity = 1; };
  window.__cur = (x, y) => { const c = document.getElementById('dcur'); c.style.left = x + 'px'; c.style.top = y + 'px'; const r = document.getElementById('dring'); r.style.left = x + 'px'; r.style.top = y + 'px'; };
  window.__ring = () => { const r = document.getElementById('dring'); r.animate([{ opacity: .9, transform: 'scale(.5)' }, { opacity: 0, transform: 'scale(1.7)' }], { duration: 450, easing: 'ease-out' }); };
  window.__card = (id, on) => { document.getElementById(id).style.opacity = on ? 1 : 0; };
  window.__cur(1100, 700);
})()`);

// ---- recorder ----
let n = 0, t = 0; const events = [];
const shot = async () => { const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 92 }); writeFileSync(join(frames, String(n++).padStart(5, '0') + '.jpg'), Buffer.from(s.data, 'base64')); t = n / FPS; };
const hold = async sec => { for (let i = 0; i < Math.round(sec * FPS); i++) { await shot(); } };
const ease = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
let cx = 1100, cy = 700;
const moveTo = async (x, y, sec = .9) => { const x0 = cx, y0 = cy, k = Math.max(1, Math.round(sec * FPS)); for (let i = 1; i <= k; i++) { const e = ease(i / k); await js(`__cur(${x0 + (x - x0) * e},${y0 + (y - y0) * e})`); await shot(); } cx = x; cy = y; };
const FIND = `window.__find = sel => sel.startsWith('text:') ? [...document.querySelectorAll('button,.nav')].find(b => b.textContent.trim().includes(sel.slice(5))) : document.querySelector(sel);`;
await js(FIND);
const center = async sel => js(`(() => { const e = __find(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + Math.min(r.width / 2, 60), r.top + r.height / 2]; })()`);
const click = async (sel, label) => {
  const p = await center(sel); if (!p) throw new Error('not found: ' + sel);
  await moveTo(p[0], p[1], .9); await js('__ring()'); events.push({ t: +t.toFixed(2), type: 'click', label }); await hold(.25);
  await js(`__find(${JSON.stringify(sel)}).click()`);
};
const cap = async (num, head, rest) => { await js(`__cap(${JSON.stringify(num)}, ${JSON.stringify(head)}, ${JSON.stringify(rest ?? '')})`); events.push({ t: +t.toFixed(2), type: 'step', label: head }); };
const scroll = async (to, sec) => { const from = await js(`document.getElementById('view').scrollTop`), k = Math.round(sec * FPS); for (let i = 1; i <= k; i++) { await js(`document.getElementById('view').scrollTop = ${from + (to - from) * ease(i / k)}`); await shot(); } };

// 0. title card
await js(`__card('dstart', true)`); await sleep(700); await hold(2.6); await js(`__card('dstart', false)`); await hold(.7);
// 1. overview
await cap('1', 'Open Viro.', 'Your PC at a glance: health, space, memory and start-up.'); await hold(3.2);
// 2. Fix my PC
await cap('2', 'Press Fix my PC.', 'Viro says exactly what it will do first.');
await click('#fixall', 'fixall'); await hold(2.4);
await click('.modal [data-y]', 'confirm'); await sleep(900); await hold(.8);
await cap('3', 'Every fix is measured and checked.', 'Before and after, and each one can be undone.'); events.push({ t: +t.toFixed(2), type: 'result', label: 'fixed' }); await hold(4.2);
// 3. installed programs
await cap('4', 'See what takes space.', 'Sizes for every program. Stubborn ones can be removed, with undo.');
await click('text:Installed programs', 'page'); await sleep(900); await hold(1.2); await scroll(180, 2.6); await hold(1);
// 4. PC report
await cap('5', 'Read every part of the PC.', 'Age, battery, drive and cooling, and whether to repair or replace.');
await click('text:PC report', 'page'); await sleep(900); await hold(1.4); await scroll(380, 3.4); await hold(1);
// 5. Move
await cap('6', 'Changing PC? Back up first.', 'Files, settings, wallpaper and programs, encrypted before they leave.');
await click('text:Viro Move', 'page'); await sleep(900); await hold(4.2);
// 6. weekly care
await cap('7', 'Set weekly care.', 'Safe fixes run by themselves, and a report arrives by email.');
await click('text:Weekly care', 'page'); await sleep(900); await hold(3.4);
// 7. end card
await js(`__cap('')`); await hold(.4); await js(`__card('dend', true)`); await sleep(600); await hold(3.4);
events.push({ t: +t.toFixed(2), type: 'end' });

chrome.kill();
const out = join(OUT, 'viro-usage-demo.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%05d.jpg'), '-vf', `scale=1920:1080:flags=lanczos,fps=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', out]);
writeFileSync(join(OUT, 'viro-usage-events.json'), JSON.stringify({ seconds: +t.toFixed(2), events }, null, 1));
try { rmSync(profile, { recursive: true, force: true }); } catch { /* temp */ }
console.log('wrote', out, t.toFixed(1) + 's'); process.exit(0);
