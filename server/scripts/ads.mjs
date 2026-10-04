// Renders the Viro WorkCare ad set to PNG (feed 1080x1080 and story 1080x1920). The visuals are drawn here, large and legible, rather than shrunk screenshots.
// Usage: node scripts/ads.mjs   (needs Chrome; writes ../docs/ads/*.png and ../docs/ads/index.html)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url)), PUB = join(here, '..', 'public'), OUT = join(here, '..', '..', 'docs', 'ads');
mkdirSync(OUT, { recursive: true }); for (const f of readdirSync(OUT)) if (f.endsWith('.png')) rmSync(join(OUT, f));
const b64 = (p, mime) => `data:${mime};base64,${readFileSync(join(PUB, p)).toString('base64')}`;
const FONT = b64('fonts/inter-latin-wght-normal.woff2', 'font/woff2'), LOGO = b64('logo.png', 'image/png');

const check = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#5fe0a8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.500"/></svg>';
const laptop = (cls) => `<div class="lap ${cls}"><div class="scr"><i></i><i></i><i></i></div><div class="base"></div></div>`;

const ADS = [
  { id: 'slow-pc', angle: 'Everyday owners: fix and prove',
    h: 'Fix it.<br><span>Then see the proof.</span>',
    visual: `<div class="card proof">
      <div class="big"><b>11.8</b><u>GB</u></div><p class="cap">given back to this PC, measured before and after</p>
      <div class="rows">
        <div class="r"><span>Memory in use</span><em>71% <i>→</i> <b>52%</b></em><div class="bar"><s style="width:71%"></s><s class="n" style="width:52%"></s></div></div>
        <div class="r"><span>Start-up programs</span><em>14 <i>→</i> <b>8</b></em><div class="bar"><s style="width:100%"></s><s class="n" style="width:57%"></s></div></div>
      </div></div>`,
    note: 'Every change can be undone.' },
  { id: 'worth-it', angle: 'Whole-PC check: is it worth fixing',
    h: 'Is it worth fixing?<br><span>Now you will know.</span>',
    visual: `<div class="card verdict">
      <p class="eyebrow">Example reading</p>
      <div class="v">Repair it.</div><p class="cap">The repairs cost 18% of a comparable new PC.</p>
      <ul><li><span>Age</span><b>about 6.7 years</b></li><li><span>Battery</span><b>86% of its original capacity</b></li><li><span>Cooling</span><b>service due</b></li><li><span>Memory</span><b>upgrade to 16 GB</b></li></ul></div>`,
    note: 'Every part read. One clear answer.' },
  { id: 'new-pc', angle: 'Viro Move: change PC without losing anything',
    h: 'New PC.<br><span>Nothing left behind.</span>',
    visual: `<div class="card move">
      <div class="pair">${laptop('old')}<div class="chips"><em>${check}Files</em><em>${check}Programs</em><em>${check}Wallpaper</em><em>${check}Wi-Fi</em></div>${laptop('new')}</div>
      <div class="lbl"><span>Old PC</span><span>New PC, after you sign in</span></div></div>`,
    note: 'Encrypted before it leaves your PC.' },
  { id: 'buying-used', angle: 'Used-PC buyers and shops: the certificate',
    h: 'Know what<br><span>you are buying.</span>',
    visual: `<div class="paper"><div class="ph"><span>VIRO WORKCARE</span><span>Example</span></div>
      <h3>Certificate of Inspection</h3><div class="rule"></div>
      <p class="k">Overall assessment</p><div class="pvrow"><div class="pv">Budget for some work</div><div class="seal"><b>VERIFIED</b></div></div>
      <ul><li><span>Age (estimated)</span><b>about 6.5 years</b></li><li><span>Battery</span><b>55% of design capacity</b></li><li><span>Drive</span><b>41,000 hours powered on</b></li><li><span>Fair price</span><b>stated, with the work to expect</b></li></ul>
      </div>`,
    note: 'Signed by Viro. Sent only to the buyer.' },
];

const css = `@font-face{font-family:Inter;src:url(${FONT}) format('woff2');font-weight:100 900}
*{box-sizing:border-box;margin:0;padding:0}html,body{background:#06100c}
.ad{position:relative;overflow:hidden;width:1080px;font-family:Inter,sans-serif;color:#fff;display:flex;flex-direction:column;justify-content:space-between;padding:84px 84px 72px;
  background:radial-gradient(70% 55% at 80% 105%,rgba(37,170,115,.38) 0,transparent 70%),radial-gradient(60% 40% at 0% 0%,rgba(95,224,168,.10) 0,transparent 65%),#07120e}
.ad::before{content:'';position:absolute;inset:34px;border:1px solid rgba(255,255,255,.09);border-radius:34px;pointer-events:none}
.sq{height:1080px}.st{height:1920px;padding-top:140px;padding-bottom:120px}
.top{display:flex;align-items:center;gap:16px;font-size:26px;font-weight:600;letter-spacing:-.01em;color:rgba(255,255,255,.92)}.top img{width:46px;height:46px;border-radius:12px}.top b{font-weight:800}
h1{font-weight:600;letter-spacing:-.045em;line-height:1.02;font-size:92px;color:#fff}h1 span{color:rgba(255,255,255,.46)}
.st h1{font-size:104px}
.mid{display:flex;flex-direction:column;gap:46px}.st .mid{gap:80px}
.bot{display:flex;justify-content:space-between;align-items:flex-end;color:rgba(255,255,255,.62);font-size:24px;letter-spacing:.01em}.bot b{color:#fff;font-weight:600;font-size:27px;letter-spacing:0}.st .bot{font-size:30px;flex-direction:column;align-items:flex-start;gap:16px}.st .bot b{font-size:34px}
.note{color:#5fe0a8}
.card{border:1px solid rgba(255,255,255,.14);border-radius:28px;background:linear-gradient(160deg,rgba(255,255,255,.075),rgba(255,255,255,.02));padding:44px 48px;backdrop-filter:blur(8px)}
.st .card{padding:64px 64px}
.eyebrow{font-size:20px;letter-spacing:.18em;text-transform:uppercase;color:#5fe0a8;font-weight:600;margin-bottom:12px}
.cap{color:rgba(255,255,255,.62);font-size:26px;line-height:1.35}.st .cap{font-size:34px}
/* proof */
.proof{display:grid;grid-template-columns:auto 1fr;gap:6px 56px;align-items:center}.big{display:flex;align-items:baseline;gap:12px;line-height:.9}
.big b{font-size:168px;font-weight:600;letter-spacing:-.06em;background:linear-gradient(180deg,#fff,#7fe3b5);-webkit-background-clip:text;color:transparent}.big u{text-decoration:none;font-size:54px;color:#5fe0a8;font-weight:600}
.proof .cap{grid-column:1;max-width:340px;font-size:23px}.rows{grid-column:2;grid-row:1 / span 2;display:flex;flex-direction:column;gap:34px}
.r span{display:block;color:rgba(255,255,255,.6);font-size:22px;margin-bottom:6px}.r em{font-style:normal;font-size:44px;font-weight:600;letter-spacing:-.02em;color:rgba(255,255,255,.6)}.r em b{color:#fff}.r em i{font-style:normal;color:#5fe0a8;margin:0 6px}
.bar{position:relative;height:10px;border-radius:6px;background:rgba(255,255,255,.08);margin-top:12px}.bar s{position:absolute;left:0;top:0;bottom:0;border-radius:6px;background:rgba(255,255,255,.22)}.bar s.n{background:linear-gradient(90deg,#2bb67f,#7fe3b5)}
.st .proof{grid-template-columns:1fr;gap:30px}.st .proof .cap{max-width:none;grid-column:1}.st .rows{grid-column:1;grid-row:auto}.st .big b{font-size:230px}.st .r em{font-size:58px}.st .r span{font-size:28px}
/* verdict */
.v{font-size:112px;font-weight:600;letter-spacing:-.05em;line-height:1;background:linear-gradient(180deg,#fff,#7fe3b5);-webkit-background-clip:text;color:transparent;margin-bottom:10px}
.verdict{padding-top:34px;padding-bottom:30px}.verdict ul{list-style:none;margin-top:22px;border-top:1px solid rgba(255,255,255,.12)}.verdict li{display:flex;justify-content:space-between;gap:20px;padding:11px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:25px}.verdict li span{color:rgba(255,255,255,.55)}.verdict li b{font-weight:600}
.st .v{font-size:190px}.st .verdict li{font-size:34px;padding:22px 0}
/* move */
.move{padding-bottom:36px}.pair{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:20px}
.lap{display:flex;flex-direction:column;align-items:center}.lap .scr{width:210px;height:140px;border-radius:12px 12px 4px 4px;border:3px solid rgba(255,255,255,.28);padding:16px;display:flex;flex-direction:column;gap:10px;background:rgba(255,255,255,.03)}
.lap .scr i{display:block;height:12px;border-radius:6px;background:rgba(255,255,255,.18)}.lap .scr i:nth-child(2){width:70%}.lap .scr i:nth-child(3){width:45%}
.lap .base{width:250px;height:12px;border-radius:0 0 14px 14px;background:rgba(255,255,255,.28)}
.lap.old{opacity:.5;transform:scale(.9)}.lap.new .scr{border-color:#5fe0a8;box-shadow:0 0 60px rgba(95,224,168,.35);background:rgba(95,224,168,.07)}.lap.new .scr i{background:rgba(95,224,168,.5)}.lap.new .base{background:#5fe0a8}
.chips{display:flex;flex-direction:column;gap:10px}.chips em{font-style:normal;display:flex;align-items:center;gap:10px;font-size:26px;font-weight:500;padding:8px 18px 8px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05)}.chips svg{width:26px;height:26px}
.lbl{display:flex;justify-content:space-between;margin-top:24px;color:rgba(255,255,255,.5);font-size:22px;letter-spacing:.04em;padding:0 28px}
.st .lap .scr{width:250px;height:170px}.st .lap .base{width:300px}.st .chips em{font-size:32px}.st .lbl{font-size:28px}.st .pair{gap:10px}
/* paper certificate */
.paper{position:relative;background:#f7f2e8;color:#16241d;border-radius:20px;padding:44px 52px 40px;box-shadow:0 40px 90px rgba(0,0,0,.55)}
.ph{display:flex;justify-content:space-between;font-size:18px;letter-spacing:.2em;color:#6a756f;font-weight:600}
.paper h3{font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:48px;letter-spacing:-.01em;margin:18px 0 12px;color:#12231b}.rule{height:2px;background:#12231b;opacity:.8;width:100%}
.paper .k{font-size:17px;letter-spacing:.16em;text-transform:uppercase;color:#6a756f;margin-top:22px}.pv{font-family:Georgia,serif;font-size:50px;color:#9a5b00;margin:4px 0 12px}
.paper ul{list-style:none;border-top:1px solid #cfc8b8}.paper li{display:flex;justify-content:space-between;gap:18px;padding:12px 0;border-bottom:1px solid #d9d2c2;font-size:24px}.paper li span{color:#5f6a64}.paper li b{font-weight:600;text-align:right}
.pvrow{display:flex;justify-content:space-between;align-items:center;gap:16px}.seal{flex:none;position:relative;margin:-6px 4px 0 0;width:104px;height:104px;border-radius:50%;border:3px solid #0b6b49;display:grid;place-items:center;color:#0b6b49;transform:rotate(-12deg);opacity:.9}.seal::before{content:'';position:absolute;inset:8px;border-radius:50%;border:1px solid #0b6b49}.seal b{font-size:15px;letter-spacing:.16em}
.st .paper{padding:60px 64px 54px}.st .paper h3{font-size:66px}.st .paper li{font-size:32px;padding:18px 0}.st .ph{font-size:22px}.st .paper .k{font-size:22px}.st .seal{width:130px;height:130px}.st .seal b{font-size:18px}.st .pv{font-size:56px}`;

const html = (a, kind) => `<!doctype html><meta charset="utf-8"><style>${css}</style><body>
<div class="ad ${kind}">
  <div class="top"><img src="${LOGO}" alt=""><span>Viro <b>WorkCare</b></span></div>
  <div class="mid"><h1>${a.h}</h1>${a.visual}</div>
  <div class="bot"><span class="note">${a.note}</span><span><b>workcare.viro3.online</b></span></div>
</div></body>`;

const PORT = 9461;
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [`--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ads-'))}`, '--headless=new', '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms)); await sleep(2500);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.on('open', r));
let id = 1; const w = new Map(); ws.on('message', m => { const d = JSON.parse(m); if (d.id && w.has(d.id)) { w.get(d.id)(d.result); w.delete(d.id); } });
const send = (m, p = {}) => new Promise(r => { const i = id++; w.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await send('Page.enable');
const out = [];
for (const a of ADS) for (const [kind, W, H, name] of [['sq', 1080, 1080, 'feed'], ['st', 1080, 1920, 'story']]) {
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const file = join(tmpdir(), `ad-${a.id}-${kind}.html`); writeFileSync(file, html(a, kind));
  await send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') }); await sleep(1200);
  const over = (await send('Runtime.evaluate', { returnByValue: true, expression: `(()=>{const e=document.querySelector('.ad');return e.scrollHeight>e.clientHeight+1?e.scrollHeight-e.clientHeight:0})()` })).result.value;
  if (over) console.log('OVERFLOW', a.id, kind, over + 'px');
  const s = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  const f = `${a.id}-${name}.png`; writeFileSync(join(OUT, f), Buffer.from(s.data, 'base64')); out.push(f);
}
writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Viro WorkCare ads</title><body style="font:15px Inter,system-ui;margin:24px;background:#f3f5f4"><h1>Viro WorkCare ad set</h1>${ADS.map(a => `<h2 style="margin:28px 0 8px">${a.id} <small style="font-weight:400;color:#555">(${a.angle})</small></h2><div style="display:flex;gap:16px;align-items:flex-start"><img src="${a.id}-feed.png" style="height:420px"><img src="${a.id}-story.png" style="height:420px"></div>`).join('')}</body>`);
chrome.kill(); console.log(out.join('\n')); process.exit(0);
