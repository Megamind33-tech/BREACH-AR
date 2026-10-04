// Renders the 40-second Viro WorkCare demo video (vertical 1080x1920, 30 fps) from an HTML timeline: headless Chrome steps the page frame by frame, ffmpeg joins the frames.
// Usage: node scripts/video.mjs [--fps 30] [--seconds 40]     writes ../docs/video/viro-demo-40s.mp4 (+ poster.png)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url)), PUB = join(here, '..', 'public'), OUT = join(here, '..', '..', 'docs', 'video');
mkdirSync(OUT, { recursive: true });
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const FPS = arg('fps', 30), SECONDS = arg('seconds', 40);
const b64 = (p, mime) => `data:${mime};base64,${readFileSync(join(PUB, p)).toString('base64')}`;
const FONT = b64('fonts/inter-latin-wght-normal.woff2', 'font/woff2'), LOGO = b64('logo.png', 'image/png');
const tick = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#5fe0a8" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.500"/></svg>';
const lap = c => `<div class="lap ${c}"><div class="scr"><i></i><i></i><i></i></div><div class="base"></div></div>`;

const css = `@font-face{font-family:Inter;src:url(${FONT}) format('woff2');font-weight:100 900}
*{box-sizing:border-box;margin:0;padding:0}html,body{width:1080px;height:1920px;background:#07120e;overflow:hidden;font-family:Inter,sans-serif;color:#fff}
#stage{position:relative;width:1080px;height:1920px;overflow:hidden;background:radial-gradient(70% 45% at 80% 108%,rgba(37,170,115,.40) 0,transparent 70%),radial-gradient(60% 35% at 0% 0%,rgba(95,224,168,.12) 0,transparent 65%),#07120e}
#stage::before{content:'';position:absolute;inset:34px;border:1px solid rgba(255,255,255,.09);border-radius:34px;z-index:5;pointer-events:none}
.logo{position:absolute;left:84px;top:96px;display:flex;align-items:center;gap:16px;font-size:30px;font-weight:600;z-index:6}.logo img{width:50px;height:50px;border-radius:13px}.logo b{font-weight:800}
/* the small corner logo steps aside when the big one arrives in the closing scene, so there is never more than one */
.logo{animation:logoout .4s linear 34.6s both}@keyframes logoout{to{opacity:0}}
.prog{position:absolute;left:84px;right:84px;bottom:70px;height:4px;border-radius:2px;background:rgba(255,255,255,.1);z-index:6}.prog i{display:block;height:100%;width:100%;transform-origin:left;background:linear-gradient(90deg,#2bb67f,#7fe3b5);animation:prog ${SECONDS}s linear 0s both}
@keyframes prog{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.sc{position:absolute;inset:0;padding:0 84px;opacity:0;animation:scene var(--d) linear var(--s) both;--ease:cubic-bezier(.2,.8,.2,1)}
.sc.last{animation-name:scenelast}
@keyframes scene{0%{opacity:0}6%{opacity:1}93%{opacity:1}100%{opacity:0}}
@keyframes scenelast{0%{opacity:0}8%{opacity:1}100%{opacity:1}}
.in{opacity:0;transform:translateY(46px);animation:rise .9s var(--ease) calc(var(--s) + var(--a,0s)) both}
@keyframes rise{to{opacity:1;transform:none}}
.pop{opacity:0;transform:scale(.6);animation:pop .7s cubic-bezier(.2,1.3,.4,1) calc(var(--s) + var(--a,0s)) both}
@keyframes pop{to{opacity:1;transform:none}}
.grow{transform-origin:left;transform:scaleX(0);animation:grow 1.4s var(--ease) calc(var(--s) + var(--a,0s)) both}
@keyframes grow{to{transform:scaleX(1)}}
.top{position:absolute;left:84px;right:84px}
h1{font-weight:600;letter-spacing:-.045em;line-height:1.03;font-size:112px}h1 span{color:rgba(255,255,255,.46)}h1 em{font-style:normal;color:#5fe0a8}
.eyebrow{font-size:26px;letter-spacing:.18em;text-transform:uppercase;color:#5fe0a8;font-weight:600}
.cap{color:rgba(255,255,255,.64);font-size:38px;line-height:1.35}
.card{border:1px solid rgba(255,255,255,.14);border-radius:30px;background:linear-gradient(160deg,rgba(255,255,255,.08),rgba(255,255,255,.02));padding:52px 56px}
/* scene 1 */
.s1 h1{position:absolute;left:84px;top:600px;font-size:150px}.s1 .cap{position:absolute;left:84px;top:1150px;font-size:44px}
/* scene 2: scan */
.s2 h1{position:absolute;left:84px;top:300px;font-size:104px}.scan{position:absolute;left:84px;right:84px;top:700px}.scan .row{display:flex;justify-content:space-between;align-items:center;padding:30px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:42px}.scan .row span{color:rgba(255,255,255,.62)}.scan .row b{display:flex;align-items:center;gap:16px;font-weight:600}
.sweep{position:absolute;left:84px;right:84px;top:660px;height:3px;background:linear-gradient(90deg,transparent,#5fe0a8,transparent);box-shadow:0 0 40px 10px rgba(95,224,168,.35);opacity:0;animation:sweep 4.2s ease-in-out calc(var(--s) + .4s) both}
@keyframes sweep{0%{opacity:0;transform:translateY(0)}10%{opacity:1}90%{opacity:1}100%{opacity:0;transform:translateY(660px)}}
/* scenes 3 to 6 share a headline size that fits the width */
.s3 h1,.s4 h1,.s5 h1,.s6 h1{font-size:94px}
/* scene 3: proof */
.s3 h1{position:absolute;left:84px;top:260px}.s3 .card{position:absolute;left:84px;right:84px;top:800px}
.big{display:flex;align-items:baseline;gap:16px;line-height:.9}.big b{font-size:260px;font-weight:600;letter-spacing:-.06em;background:linear-gradient(180deg,#fff,#7fe3b5);-webkit-background-clip:text;color:transparent}.big u{text-decoration:none;font-size:80px;color:#5fe0a8;font-weight:600}
.r{margin-top:48px}.r span{display:block;color:rgba(255,255,255,.6);font-size:32px;margin-bottom:6px}.r em{font-style:normal;font-size:60px;font-weight:600;color:rgba(255,255,255,.6)}.r em b{color:#fff}.r em i{font-style:normal;color:#5fe0a8;margin:0 10px}
.bar{position:relative;height:14px;border-radius:7px;background:rgba(255,255,255,.08);margin-top:16px;overflow:hidden}.bar s{position:absolute;left:0;top:0;bottom:0;border-radius:7px}.bar s.o{background:rgba(255,255,255,.22)}.bar s.n{background:linear-gradient(90deg,#2bb67f,#7fe3b5)}
.undo{position:absolute;left:84px;top:1700px;font-size:38px;color:#5fe0a8}
/* scene 4: verdict */
.s4 h1{position:absolute;left:84px;top:260px}.s4 .card{position:absolute;left:84px;right:84px;top:780px}
.v{font-size:190px;font-weight:600;letter-spacing:-.05em;line-height:1;background:linear-gradient(180deg,#fff,#7fe3b5);-webkit-background-clip:text;color:transparent}
.s4 ul{list-style:none;margin-top:30px;border-top:1px solid rgba(255,255,255,.12)}.s4 li{display:flex;justify-content:space-between;padding:22px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:38px}.s4 li span{color:rgba(255,255,255,.55)}.s4 li b{font-weight:600}
/* scene 5: certificate */
.s5 h1{position:absolute;left:84px;top:260px}
.paper{position:absolute;left:84px;right:84px;top:780px;background:#f7f2e8;color:#16241d;border-radius:24px;padding:60px 64px;box-shadow:0 50px 100px rgba(0,0,0,.55)}
.paper .ph{display:flex;justify-content:space-between;font-size:24px;letter-spacing:.2em;color:#6a756f;font-weight:600}.paper h3{font-family:Georgia,serif;font-weight:400;font-size:70px;margin:22px 0 14px}.rule{height:3px;background:#12231b}
.paper .k{font-size:24px;letter-spacing:.16em;text-transform:uppercase;color:#6a756f;margin-top:26px}.pvrow{display:flex;justify-content:space-between;align-items:center}.pv{font-family:Georgia,serif;font-size:62px;color:#9a5b00;margin:6px 0 14px}
.seal{width:150px;height:150px;border-radius:50%;border:4px solid #0b6b49;display:grid;place-items:center;color:#0b6b49;position:relative;transform:rotate(-12deg)}.seal::before{content:'';position:absolute;inset:10px;border-radius:50%;border:2px solid #0b6b49}.seal b{font-size:22px;letter-spacing:.18em}
.paper li{list-style:none;display:flex;justify-content:space-between;padding:20px 0;border-bottom:1px solid #d9d2c2;font-size:34px}.paper li span{color:#5f6a64}.paper li b{font-weight:600}
.paper ul{border-top:1px solid #cfc8b8}
/* scene 6: move */
.s6 h1{position:absolute;left:84px;top:260px}
.pair{position:absolute;left:84px;right:84px;top:860px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px}
.lap{display:flex;flex-direction:column;align-items:center}.lap .scr{width:250px;height:170px;border-radius:14px 14px 5px 5px;border:4px solid rgba(255,255,255,.28);padding:20px;display:flex;flex-direction:column;gap:12px;background:rgba(255,255,255,.03)}
.lap .scr i{display:block;height:14px;border-radius:7px;background:rgba(255,255,255,.18)}.lap .scr i:nth-child(2){width:70%}.lap .scr i:nth-child(3){width:45%}.lap .base{width:300px;height:14px;border-radius:0 0 16px 16px;background:rgba(255,255,255,.28)}
.lap.old{opacity:.5;transform:scale(.9)}.lap.new .scr{border-color:#5fe0a8;box-shadow:0 0 70px rgba(95,224,168,.4);background:rgba(95,224,168,.07)}.lap.new .scr i{background:rgba(95,224,168,.5)}.lap.new .base{background:#5fe0a8}
.chips{display:flex;flex-direction:column;gap:14px}.chips em{font-style:normal;display:flex;align-items:center;gap:12px;font-size:36px;font-weight:500;padding:10px 24px 10px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05)}.chips svg{width:34px;height:34px}
.lbl{position:absolute;left:84px;right:84px;top:1170px;display:flex;justify-content:space-between;color:rgba(255,255,255,.5);font-size:30px;letter-spacing:.04em;padding:0 40px}
.s6 .cap{position:absolute;left:84px;top:1400px}
/* scene 7: call to action */
.s7 .big7{position:absolute;left:84px;right:84px;top:420px}.s7 h1{font-size:140px}
.s7 .logo7{display:flex;align-items:center;gap:22px;font-size:44px;font-weight:600;margin-bottom:60px}.s7 .logo7 img{width:92px;height:92px;border-radius:24px}.s7 .logo7 b{font-weight:800}
.btn{display:inline-block;margin-top:70px;padding:40px 80px;border-radius:999px;background:#5fe0a8;color:#04231a;font-size:56px;font-weight:700;letter-spacing:-.01em;box-shadow:0 0 90px rgba(95,224,168,.45)}
.url{margin-top:56px;font-size:60px;font-weight:600;letter-spacing:-.02em}.small{margin-top:30px;font-size:30px;line-height:1.5;color:rgba(255,255,255,.62)}`;

const body = `
<div id="stage">
  <div class="logo"><img src="${LOGO}" alt=""><span>Viro <b>WorkCare</b></span></div>

  <div class="sc s1" style="--s:0s;--d:4s">
    <h1 class="in" style="--a:.2s">Slow PC?<br><span>Is it worth fixing?</span></h1>
    <p class="cap in" style="--a:1.4s">Or is it time to replace it?</p>
  </div>

  <div class="sc s2" style="--s:4s;--d:6s">
    <h1 class="in" style="--a:.1s">Viro checks<br><span>the whole PC.</span></h1>
    <div class="sweep"></div>
    <div class="scan">
      <div class="row in" style="--a:.9s"><span>Temporary files</span><b>11.8 GB ${tick}</b></div>
      <div class="row in" style="--a:1.5s"><span>Start-up programs</span><b>14 ${tick}</b></div>
      <div class="row in" style="--a:2.1s"><span>Memory in use</span><b>71% ${tick}</b></div>
      <div class="row in" style="--a:2.7s"><span>Battery</span><b>86% ${tick}</b></div>
      <div class="row in" style="--a:3.3s"><span>Drive health</span><b>Good ${tick}</b></div>
      <div class="row in" style="--a:3.9s"><span>Cooling</span><b>Service due ${tick}</b></div>
    </div>
  </div>

  <div class="sc s3" style="--s:10s;--d:7s">
    <h1 class="in" style="--a:.1s">Fix it.<br><span>Then see the proof.</span></h1>
    <div class="card">
      <div class="big pop" style="--a:.9s"><b id="gb">0.0</b><u>GB</u></div>
      <p class="cap in" style="--a:1.2s;font-size:32px">given back to this PC, measured before and after</p>
      <div class="r in" style="--a:1.7s"><span>Memory in use</span><em>71% <i>→</i> <b>52%</b></em><div class="bar"><s class="o" style="width:71%"></s><s class="n grow" style="width:52%;--a:2.2s"></s></div></div>
      <div class="r in" style="--a:2.6s"><span>Start-up programs</span><em>14 <i>→</i> <b>8</b></em><div class="bar"><s class="o" style="width:100%"></s><s class="n grow" style="width:57%;--a:3.1s"></s></div></div>
    </div>
    <p class="undo in" style="--a:4.6s">Every change can be undone.</p>
  </div>

  <div class="sc s4" style="--s:17s;--d:7s">
    <h1 class="in" style="--a:.1s">Is it worth fixing?<br><span>Now you will know.</span></h1>
    <div class="card">
      <p class="eyebrow in" style="--a:.6s">Example reading</p>
      <ul>
        <li class="in" style="--a:1s"><span>Age</span><b>about 6.7 years</b></li>
        <li class="in" style="--a:1.6s"><span>Battery</span><b>86% of its original capacity</b></li>
        <li class="in" style="--a:2.2s"><span>Cooling</span><b>service due</b></li>
        <li class="in" style="--a:2.8s"><span>Memory</span><b>upgrade to 16 GB</b></li>
      </ul>
      <div class="v pop" style="--a:3.8s;margin-top:40px">Repair it.</div>
      <p class="cap in" style="--a:4.2s;font-size:32px">The repairs cost 18% of a comparable new PC.</p>
    </div>
  </div>

  <div class="sc s5" style="--s:24s;--d:6s">
    <h1 class="in" style="--a:.1s">Buying used?<br><span>Know what you are buying.</span></h1>
    <div class="paper in" style="--a:.8s">
      <div class="ph"><span>VIRO WORKCARE</span><span>Example</span></div>
      <h3>Certificate of Inspection</h3><div class="rule"></div>
      <p class="k">Overall assessment</p>
      <div class="pvrow"><div class="pv">Budget for some work</div><div class="seal pop" style="--a:2.6s"><b>VERIFIED</b></div></div>
      <ul>
        <li><span>Age (estimated)</span><b>about 6.5 years</b></li><li><span>Battery</span><b>55% of design capacity</b></li><li><span>Drive</span><b>41,000 hours on</b></li><li><span>Fair price</span><b>stated, with the work to expect</b></li>
      </ul>
    </div>
  </div>

  <div class="sc s6" style="--s:30s;--d:5s">
    <h1 class="in" style="--a:.1s">New PC.<br><span>Nothing left behind.</span></h1>
    <div class="pair">
      ${lap('old').replace('class="lap old"', 'class="lap old in" style="--a:.6s"')}
      <div class="chips">
        <em class="in" style="--a:1.2s">${tick}Files</em><em class="in" style="--a:1.6s">${tick}Programs</em><em class="in" style="--a:2s">${tick}Wallpaper</em><em class="in" style="--a:2.4s">${tick}Wi-Fi</em>
      </div>
      ${lap('new').replace('class="lap new"', 'class="lap new pop" style="--a:2.8s"')}
    </div>
    <div class="lbl in" style="--a:.8s"><span>Old PC</span><span>New PC, after you sign in</span></div>
    <p class="cap in" style="--a:3.4s">Encrypted before it leaves your PC.</p>
  </div>

  <div class="sc s7 last" style="--s:35s;--d:5s">
    <div class="big7">
      <div class="logo7 in" style="--a:.2s"><img src="${LOGO}" alt=""><span>Viro <b>WorkCare</b></span></div>
      <h1 class="in" style="--a:.5s">Fix it.<br>Prove it.<br><span>Check the whole PC.</span></h1>
      <div class="btn pop" style="--a:1.4s">Download free</div>
      <p class="url in" style="--a:1.9s">workcare.viro3.online</p>
      <p class="small in" style="--a:2.4s">The free scan needs no account. Viro Care from K 250 a year.<br>Windows 10 and 11 · Pay by Airtel Money or cash</p>
    </div>
  </div>
  <div class="prog"><i></i></div>
</div>`;

const html = `<!doctype html><meta charset="utf-8"><style>${css}</style><body>${body}<script>
window.seek = t => { document.getAnimations().forEach(a => { a.pause(); a.currentTime = t * 1000; });
  const ease = x => 1 - Math.pow(1 - x, 3); const g = document.getElementById('gb'); const p = Math.min(1, Math.max(0, (t - 10.9) / 1.6)); g.textContent = (11.8 * ease(p)).toFixed(1); };
</script></body>`;

const dir = mkdtempSync(join(tmpdir(), 'viro-video-')), page = join(dir, 'index.html'); writeFileSync(page, html);
const PORT = 9471;
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [`--remote-debugging-port=${PORT}`, `--user-data-dir=${join(dir, 'profile')}`, '--headless=new', '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms)); await sleep(2500);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.on('open', r));
let id = 1; const w = new Map(); ws.on('message', m => { const d = JSON.parse(m); if (d.id && w.has(d.id)) { w.get(d.id)(d.result); w.delete(d.id); } });
const send = (m, p = {}) => new Promise(r => { const i = id++; w.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file:///' + page.replace(/\\/g, '/') }); await sleep(1500);

const frames = join(dir, 'frames'); mkdirSync(frames);
const total = FPS * SECONDS;
for (let f = 0; f < total; f++) {
  await send('Runtime.evaluate', { expression: `seek(${(f / FPS).toFixed(4)})` });
  const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 94, clip: { x: 0, y: 0, width: 1080, height: 1920, scale: 1 } });
  writeFileSync(join(frames, String(f).padStart(5, '0') + '.jpg'), Buffer.from(s.data, 'base64'));
  if (f % 150 === 0) console.log(`frame ${f}/${total}`);
}
for (const [name, t] of [['poster-hook', 1.5], ['poster-proof', 14], ['poster-cta', 38.5]]) {
  await send('Runtime.evaluate', { expression: `seek(${t})` });
  const s = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1080, height: 1920, scale: 1 } });
  writeFileSync(join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
}
chrome.kill();
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'slow', '-movflags', '+faststart', join(OUT, 'viro-demo-40s.mp4')]);
try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
console.log('done', join(OUT, 'viro-demo-40s.mp4')); process.exit(0);
