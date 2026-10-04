// Renders the Viro WorkCare ad set to PNG (feed 1080x1080 and story 1080x1920) from the same screenshots and brand as the site.
// Usage: node scripts/ads.mjs   (needs Chrome; writes ../docs/ads/*.png and ../docs/ads/index.html)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url)), PUB = join(here, '..', 'public'), OUT = join(here, '..', '..', 'docs', 'ads');
mkdirSync(OUT, { recursive: true });
const b64 = (p, mime) => `data:${mime};base64,${readFileSync(join(PUB, p)).toString('base64')}`;
const FONT = b64('fonts/inter-latin-wght-normal.woff2', 'font/woff2'), LOGO = b64('logo.png', 'image/png');
const IMG = n => b64(`site/img/${n}.webp`, 'image/webp');
const SIZE = { app_fix: [1016, 818], app_report: [1016, 1195], app_move: [1016, 1052], cert_inspection: [850, 1230] };

const ADS = [
  { id: 'slow-pc', img: 'app-fix', stacked: true, tag: 'Slow PC?', h: 'Slow PC? <em>Fix it.</em> Then see the proof.', sub: 'Viro clears the leftovers, shows you the before and after, and lets you undo anything.', cta: 'Download free', angle: 'Everyday owners' },
  { id: 'worth-it', img: 'app-report', tag: 'Worth fixing?', h: 'Is your PC <em>worth fixing?</em>', sub: 'Viro reads every part, tells you its real age and what it is worth, and gives one clear answer.', cta: 'Check my PC free', angle: 'Whole-PC check' },
  { id: 'new-pc', img: 'app-move', tag: 'New laptop?', h: 'New laptop? <em>Take everything with you.</em>', sub: 'Files, programs, wallpaper and Wi-Fi. Sign in on the new PC and it is all back.', cta: 'See Viro Move', angle: 'Viro Move' },
  { id: 'buying-used', img: 'cert-inspection', tag: 'Buying used?', h: 'Buying a used laptop? <em>Ask for the Viro certificate.</em>', sub: 'Real battery, real drive, real age and a fair price. Signed, and checked by the buyer.', cta: 'Learn more', angle: 'Used-PC buyers and shops' },
];

const css = `@font-face{font-family:Inter;src:url(${FONT}) format('woff2');font-weight:100 900}
*{box-sizing:border-box;margin:0;padding:0}html,body{background:#0b2a20}
.ad{position:relative;overflow:hidden;font-family:Inter,sans-serif;color:#fff;background:radial-gradient(120% 90% at 85% 10%,#14805a 0,#0d4a35 38%,#0a2a20 80%)}
.ad::after{content:'';position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.07) 1.5px,transparent 1.6px);background-size:34px 34px;opacity:.55;pointer-events:none}
.logo{display:flex;align-items:center;gap:14px;font-weight:600;letter-spacing:-.01em;position:relative;z-index:2}.logo img{width:54px;height:54px;border-radius:14px}.logo b{font-weight:800}
.tag{display:inline-block;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#7fe3b5;position:relative;z-index:2}
h1{font-weight:800;letter-spacing:-.035em;line-height:1.04;position:relative;z-index:2}h1 em{font-style:normal;color:#7fe3b5}
.sub{color:rgba(255,255,255,.82);line-height:1.4;position:relative;z-index:2}
.shot{position:absolute;z-index:1;filter:drop-shadow(0 28px 50px rgba(0,0,0,.55));border-radius:14px}
.cta{position:relative;z-index:2;display:inline-block;background:#fff;color:#0b4d37;font-weight:800;border-radius:999px}
.foot{position:absolute;left:0;right:0;bottom:0;z-index:3;background:rgba(5,22,16,.78);display:flex;align-items:center;justify-content:space-between;color:rgba(255,255,255,.88);font-weight:500}
.foot b{color:#fff;font-weight:700}
/* feed 1080 x 1080 */
.sq{width:1080px;height:1080px}.sq .logo{position:absolute;left:64px;top:56px;font-size:30px}
.sq .tag{position:absolute;left:64px;top:158px;font-size:22px}
.sq h1{position:absolute;left:64px;top:206px;width:520px;font-size:72px}
.sq .sub{position:absolute;left:64px;top:560px;width:470px;font-size:29px}
.sq .cta{position:absolute;left:64px;top:810px;padding:22px 44px;font-size:30px}
.sq .shot{left:590px;top:492px;width:440px;height:auto;transform:translateY(-50%)}
.sq.stacked h1{width:950px;top:206px;font-size:74px}.sq.stacked .sub{top:392px;width:900px}.sq.stacked .cta{top:790px}
.sq.stacked .shot{left:480px;top:540px;width:540px;transform:none;border-radius:12px}
.sq .foot{height:96px;padding:0 64px;font-size:23px}
/* story 1080 x 1920 */
.st{width:1080px;height:1920px}.st .logo{position:absolute;left:72px;top:96px;font-size:34px}
.st .tag{position:absolute;left:72px;top:238px;font-size:26px}
.st h1{position:absolute;left:72px;top:292px;width:936px;font-size:104px}
.st .sub{position:absolute;left:72px;top:690px;width:900px;font-size:38px}
.st .shot{left:50%;transform:translateX(-50%);top:880px;height:700px}
.st.stacked .shot{top:960px;height:690px}
.st .cta{position:absolute;left:72px;top:1640px;padding:28px 60px;font-size:38px}
.st .foot{height:150px;padding:0 72px;font-size:28px;flex-direction:column;align-items:flex-start;justify-content:center;gap:6px}`;

const html = (a, kind) => {
  const [w, h] = SIZE[a.img.replace('-', '_')];
  const ratio = w / h;
  return `<!doctype html><meta charset="utf-8"><style>${css}</style><body>
<div class="ad ${kind}${a.stacked ? ' stacked' : ''}">
  <div class="logo"><img src="${LOGO}" alt=""><span>Viro <b>WorkCare</b></span></div>
  <div class="tag">${a.tag}</div><h1>${a.h}</h1><p class="sub">${a.sub}</p>
  <img class="shot" src="${IMG(a.img)}" alt="" style="aspect-ratio:${ratio}">
  <div class="cta">${a.cta}</div>
  <div class="foot"><span><b>workcare.viro3.online</b></span><span>Windows 10 &amp; 11 · Pay by Airtel Money, MTN, bank or cash</span></div>
</div></body>`;
};

const PORT = 9461;
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [`--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ads-'))}`, '--headless=new', '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms)); await sleep(2500);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.on('open', r));
let id = 1; const w = new Map(); ws.on('message', m => { const d = JSON.parse(m); if (d.id && w.has(d.id)) { w.get(d.id)(d.result); w.delete(d.id); } });
const send = (m, p = {}) => new Promise(r => { const i = id++; w.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await send('Page.enable');
const index = [];
for (const a of ADS) for (const [kind, W, H, name] of [['sq', 1080, 1080, 'feed'], ['st', 1080, 1920, 'story']]) {
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const file = join(tmpdir(), `ad-${a.id}-${kind}.html`); writeFileSync(file, html(a, kind));
  await send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') }); await sleep(1200);
  const s = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  const out = `${a.id}-${name}.png`; writeFileSync(join(OUT, out), Buffer.from(s.data, 'base64')); index.push({ a, out, name });
}
writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Viro WorkCare ads</title><body style="font:15px Inter,system-ui;margin:24px;background:#f3f5f4"><h1>Viro WorkCare ad set</h1>${ADS.map(a => `<h2 style="margin:28px 0 8px">${a.tag} <small style="font-weight:400;color:#555">(${a.angle})</small></h2><div style="display:flex;gap:16px;align-items:flex-start"><img src="${a.id}-feed.png" style="height:420px"><img src="${a.id}-story.png" style="height:420px"></div>`).join('')}</body>`);
chrome.kill(); console.log(index.map(i => i.out).join('\n')); process.exit(0);
