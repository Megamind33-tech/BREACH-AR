import QRCode from 'qrcode';
import { esc } from './certificate-pages.js';

type Obj = Record<string, any>;
const day = (s: unknown) => (typeof s === 'string' ? s.slice(0, 10) : '');
const longDay = (s: unknown) => { const d = new Date(String(s)); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); };
const num = (n: unknown) => (typeof n === 'number' ? n.toLocaleString('en-US') : '');
const money = (cur: string, n: number | null | undefined) => (n == null ? 'not priced' : `${esc(cur)}&nbsp;${num(n)}`);
const STATUS: Record<string, [string, string]> = { LOW: ['Good', 'ok'], WATCH: ['Watch', 'warn'], HIGH: ['Replace soon', 'bad'], CRITICAL: ['Replace now', 'bad'], UNKNOWN: ['Not measured', 'na'] };
const RATING: Record<string, { word: string; cls: string }> = { SOUND: { word: 'Sound', cls: 'ok' }, FAIR: { word: 'Fair', cls: 'warn' }, POOR: { word: 'Not recommended', cls: 'bad' } };
const TERMS = '/site/terms.html#certificates';

const CSS = `:root{--ink:#14201a;--mute:#5a6a62;--line:#d5ddd8;--green:#0b5d3f;--ok:#14794d;--warn:#a86a0a;--bad:#b3302a;--na:#78867f}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:#e7ebe8;color:var(--ink);font:14.5px/1.55 "Segoe UI",system-ui,sans-serif}
.tools{max-width:794px;margin:18px auto 0;padding:0 8px;display:flex;justify-content:flex-end}.tools button{height:38px;border:1px solid var(--line);background:#fff;border-radius:8px;padding:0 16px;font:inherit;font-weight:600;cursor:pointer;color:var(--ink)}
.sheet{position:relative;width:794px;max-width:calc(100% - 16px);margin:12px auto 40px;background:#fff;box-shadow:0 1px 2px rgba(10,40,28,.18),0 18px 50px -20px rgba(10,40,28,.35)}
.sheet::before{content:"";position:absolute;inset:12px;border:2px solid var(--green);pointer-events:none}.sheet::after{content:"";position:absolute;inset:18px;border:.75px solid #8fb9a5;pointer-events:none}
.in{position:relative;padding:50px 54px 44px}
.head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:16px;border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:12px}.brand img{width:44px;height:44px;border-radius:10px}
.brand b{display:block;font-size:17px;letter-spacing:.01em}.brand span{display:block;font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--mute)}
.no{text-align:right;font-size:11.5px;color:var(--mute);letter-spacing:.06em;text-transform:uppercase}.no b{display:block;font:600 14px/1.3 "Cascadia Mono",Consolas,monospace;color:var(--ink);letter-spacing:.04em;text-transform:none}
.banner{margin:16px 0 0;padding:10px 14px;border-radius:6px;font-weight:600;text-align:center}.banner.warn{background:#fbf0d9;color:#8a5a0f}.banner.bad{background:#fbe3df;color:#8f261f}
h1{font:400 36px/1.1 Georgia,"Times New Roman",serif;text-align:center;letter-spacing:.035em;margin:30px 0 4px;text-transform:uppercase}
.orn{display:flex;align-items:center;gap:12px;justify-content:center;margin:8px auto 10px;max-width:320px;color:var(--green)}.orn i{flex:1;height:1px;background:#8fb9a5}.orn s{width:7px;height:7px;background:var(--green);transform:rotate(45deg);display:block}
.lead{text-align:center;font:italic 15.5px/1.5 Georgia,serif;color:var(--mute);margin:0 auto 22px;max-width:560px}
.subject{border:1px solid var(--line);border-radius:4px;padding:18px 22px;background:#fafcfb}.subject .k{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
.subject h2{font:400 27px/1.2 Georgia,serif;margin:4px 0 6px}.specs{color:var(--mute);font-size:13.5px}.meta{display:flex;flex-wrap:wrap;gap:6px 26px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line);font-size:12.5px;color:var(--mute)}.meta b{color:var(--ink);font-weight:600}
.assess{display:grid;grid-template-columns:1fr 150px;gap:20px;align-items:center;margin:22px 0 4px}.assess .k{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
.assess .word{font:400 34px/1.1 Georgia,serif;margin:2px 0 8px}.word.ok{color:var(--ok)}.word.warn{color:var(--warn)}.word.bad{color:var(--bad)}.assess ul{margin:0;padding-left:18px}.assess li{margin:3px 0}.assess .why{color:var(--mute);font-size:13.5px;margin-bottom:6px}
.seal{width:140px;height:140px;margin:0 auto}
.figs{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);margin:20px 0 6px}.figs>div{padding:13px 14px;border-left:1px solid var(--line)}.figs>div:first-child{border-left:0}
.figs .k{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute)}.figs .v{font:400 17.5px/1.3 Georgia,serif;margin-top:3px}.figs .s{font-size:11.5px;color:var(--mute);line-height:1.35}
h3{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--green);margin:26px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--green)}
table{width:100%;border-collapse:collapse;font-size:13.5px}th{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);font-weight:600;text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}td{padding:8px;border-bottom:1px solid #e6ece8;vertical-align:top}
td.r,th.r{text-align:right;white-space:nowrap}td.k{color:var(--mute);width:38%}tr.total td{font-weight:700;border-top:1px solid var(--ink);border-bottom:0}
.st{display:inline-flex;align-items:center;gap:6px;font-weight:600;white-space:nowrap}.st::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}.st.ok{color:var(--ok)}.st.warn{color:var(--warn)}.st.bad{color:var(--bad)}.st.na{color:var(--na)}
.note{font-size:12.5px;color:var(--mute);margin:8px 0 0}ol.check{margin:0;padding-left:20px}ol.check li{margin:5px 0}
.verify{display:grid;grid-template-columns:116px 1fr;gap:22px;align-items:center;margin-top:28px;padding:18px 20px;border:1px solid var(--line);background:#fafcfb}.verify svg{display:block;width:110px;height:110px}
.verify h4{margin:0 0 4px;font:400 17px/1.2 Georgia,serif}.verify p{margin:2px 0;font-size:13px;color:var(--mute)}.verify .code{font:600 15px/1.4 "Cascadia Mono",Consolas,monospace;color:var(--ink);letter-spacing:.06em}
form.sn{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px}form.sn input{height:38px;border:1px solid var(--line);border-radius:6px;padding:0 10px;font:inherit;min-width:220px;flex:1}form.sn button{height:38px;border:0;border-radius:6px;background:var(--green);color:#fff;font:inherit;font-weight:600;padding:0 16px;cursor:pointer}#res{margin-top:6px;font-weight:600;flex-basis:100%}
.sign{display:flex;justify-content:space-between;gap:20px;margin-top:26px;padding-top:14px;border-top:1px solid var(--ink);font-size:12.5px}.sign b{display:block;font:400 17px/1.2 Georgia,serif;font-style:italic}.sign span{color:var(--mute)}
.fine{margin-top:16px;font-size:11.5px;color:var(--mute);line-height:1.5}.fine a{color:var(--green)}
.foot{margin-top:18px;padding-top:12px;border-top:1px solid var(--line);text-align:center;font-size:11px;color:var(--mute);letter-spacing:.02em}
details{margin-top:14px}summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--green)}
@media (max-width:640px){.in{padding:34px 24px 30px}h1{font-size:26px}.assess{grid-template-columns:1fr}.seal{order:-1}.figs{grid-template-columns:1fr 1fr}.figs>div:nth-child(3){border-left:0}.figs>div:nth-child(n+3){border-top:1px solid var(--line)}.verify{grid-template-columns:1fr}.head{flex-direction:column;align-items:flex-start}.no{text-align:left}.sign{flex-direction:column}}
@media print{@page{size:A4;margin:9mm}body{background:#fff}.tools,form.sn,details,.noprint{display:none!important}.sheet{box-shadow:none;margin:0;width:auto;max-width:none}.in{padding:34px 38px}h3,.figs,.verify,tr,.assess{break-inside:avoid}}`;

function seal(state: string, cls: string): string {
  const colour = state === 'valid' ? '#14794d' : state === 'expired' ? '#78867f' : '#b3302a';       // the seal speaks for authenticity; the verdict has its own colour
  const word = state === 'valid' ? 'VERIFIED' : state === 'expired' ? 'EXPIRED' : state === 'revoked' ? 'WITHDRAWN' : 'NOT VALID';
  return `<svg class="seal" viewBox="0 0 140 140" role="img" aria-label="${word}"><defs><path id="arc" d="M70 70 m-52 0 a52 52 0 1 1 104 0 a52 52 0 1 1 -104 0"/></defs>
  <circle cx="70" cy="70" r="66" fill="none" stroke="${colour}" stroke-width="2.5"/><circle cx="70" cy="70" r="60" fill="none" stroke="${colour}" stroke-width=".8" stroke-dasharray="2 3"/><circle cx="70" cy="70" r="40" fill="${colour}" fill-opacity=".07" stroke="${colour}" stroke-width="1.5"/>
  <text font-family="Georgia,serif" font-size="11" letter-spacing="3" fill="${colour}"><textPath href="#arc" startOffset="2%">VIRO WORKCARE · INSPECTION ·</textPath></text>
  ${state === 'valid' ? `<path d="M54 64l10 10 22-24" fill="none" stroke="${colour}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>` : `<text x="70" y="76" text-anchor="middle" font-family="Georgia,serif" font-size="13" font-weight="700" fill="${colour}">${word}</text>`}
  ${state === 'valid' ? `<text x="70" y="97" text-anchor="middle" font-family="Georgia,serif" font-size="10.5" letter-spacing="2" fill="${colour}">${word}</text>` : ''}</svg>`;
}

export async function certificateDocument(v: Obj | null, rawCode: string, baseUrl: string): Promise<string> {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Viro certificate of inspection</title><meta name="robots" content="noindex"><style>${CSS}</style></head><body>`;
  if (!v) {
    return head + `<div class="sheet" style="margin-top:60px"><div class="in"><div class="head"><div class="brand"><img src="/logo.png" alt=""><div><b>Viro WorkCare</b><span>Orange Mobility Solutions</span></div></div></div>
      ${rawCode ? '<div class="banner bad">No certificate matches this code</div><p class="note" style="text-align:center">Check the code in your email. A certificate that did not come to you from Viro by email cannot be confirmed, whatever a paper or screenshot says.</p>' : ''}
      <h1 style="font-size:26px">Check a certificate</h1><p class="lead">Enter the code from the email Viro sent you.</p>
      <form class="sn" style="justify-content:center" onsubmit="location.href='/verify/'+encodeURIComponent(code.value.trim());return false"><input id="code" name="code" placeholder="VIRO-XXXX-XXXX-XXXX" autocomplete="off" style="max-width:300px"><button>Check</button></form></div></div></body></html>`;
  }
  const s: Obj = v.statement, m: Obj = s.machine ?? {}, c: Obj | null = s.costs ?? null, cond: Obj = s.condition ?? {};
  const rating = RATING[s.verdict?.rating] ?? RATING.FAIR!; const state: string = v.state;
  const link = `${baseUrl}/verify/${encodeURIComponent(rawCode)}`;
  const qr = await QRCode.toString(link, { type: 'svg', margin: 0, width: 110, color: { dark: '#0b3d2b', light: '#ffffff' } });
  const specs = [m.formFactor, m.cpu, m.ramGb ? m.ramGb + ' GB memory' : null, ...(m.storage ?? []).map((d: Obj) => [d.sizeGb ? d.sizeGb + ' GB' : null, d.type].filter(Boolean).join(' ')), m.os ? `${m.os}${m.osBuild ? ' (build ' + m.osBuild + ')' : ''}` : null].filter(Boolean).join(' · ');
  const banner = state === 'expired' ? '<div class="banner warn">This certificate has expired. Ask the seller for a new inspection.</div>' : state === 'revoked' ? `<div class="banner bad">This certificate was withdrawn by Viro${v.revokeReason ? ': ' + esc(v.revokeReason) : ''}. Do not rely on it.</div>` : state === 'invalid' ? '<div class="banner bad">This document does not verify. It may have been altered. Do not rely on it.</div>' : '';
  const parts: Obj[] = s.parts ?? [];

  const costTable = c ? (c.workSoon ?? []).length
    ? `<table><tr><th>Work to expect</th><th class="r">Parts</th><th class="r">Labour</th><th class="r">Total</th></tr>${c.workSoon.map((w: Obj) => `<tr><td>${esc(w.title)}</td><td class="r">${w.priced ? money(c.currency, w.parts) : '–'}</td><td class="r">${money(c.currency, w.labour)}</td><td class="r"><b>${w.priced ? money(c.currency, w.total) : 'not priced'}</b></td></tr>`).join('')}<tr class="total"><td>Total</td><td></td><td></td><td class="r">${money(c.currency, c.workSoonTotal ?? 0)}</td></tr></table>`
    : '<p>No repairs or replacements are expected soon.</p>' : '';

  return head + `<div class="tools"><button onclick="window.print()">Print or save as PDF</button></div><div class="sheet"><div class="in">
  <div class="head"><div class="brand"><img src="/logo.png" alt=""><div><b>Viro WorkCare</b><span>Orange Mobility Solutions</span></div></div><div class="no">Certificate No.<b>${esc(String(v.id).slice(0, 8).toUpperCase())}</b></div></div>
  ${banner}
  <h1>Certificate of Inspection</h1><div class="orn"><i></i><s></s><i></i></div><p class="lead">Independent technical assessment of a used computer</p>
  <div class="subject"><div class="k">Computer inspected</div><h2>${esc([m.manufacturer, m.model].filter(Boolean).join(' ') || 'Computer')}</h2><div class="specs">${esc(specs)}</div>
    <div class="meta"><span>Serial number ends <b>${esc(m.serialLast4 ?? 'not reported')}</b></span><span>Inspected <b>${esc(longDay(s.inspectedAt))}</b></span><span>Issued <b>${esc(longDay(s.issuedAt))}</b></span><span>Valid until <b>${esc(longDay(s.expiresAt))}</b></span>${s.issuedFor ? `<span>Issued to <b>${esc(s.issuedFor)}</b></span>` : ''}${s.listedBy ? `<span>Managed by <b>${esc(s.listedBy)}</b></span>` : ''}</div></div>
  ${s.verdict ? `<div class="assess"><div><div class="k">Overall assessment</div><div class="word ${rating.cls}">${esc(rating.word)}</div><div class="why">${esc(s.verdict.label)}</div><ul>${(s.verdict.reasons ?? []).map((r: string) => `<li>${esc(r)}</li>`).join('')}</ul></div>${seal(state, rating.cls)}</div>` : ''}
  <div class="figs"><div><div class="k">Age (estimated)</div><div class="v">${s.age?.years != null ? 'about ' + esc(s.age.years) + ' years' : 'unknown'}</div><div class="s">${s.age?.inServiceSince ? 'in use since ' + esc(s.age.inServiceSince) + ', ' + esc(String(s.age.confidence ?? '').toLowerCase()) + ' confidence' : ''}</div></div>
    <div><div class="k">Dependable life left</div><div class="v">${s.life?.remainingYears ? esc(s.life.remainingYears[0]) + ' to ' + esc(s.life.remainingYears[1]) + ' years' : 'not estimated'}</div><div class="s">${esc(String(s.life?.stage ?? '').toLowerCase())}</div></div>
    ${c ? `<div><div class="k">Value today (estimate)</div><div class="v">${c.fairPriceRange ? money(c.currency, c.fairPriceRange[0]) + ' to ' + num(c.fairPriceRange[1]) : 'n/a'}</div><div class="s">used price for this age and condition</div></div><div><div class="k">Work to expect</div><div class="v">${money(c.currency, c.workSoonTotal ?? 0)}</div><div class="s">a comparable new one: ${money(c.currency, c.newEquivalent)}</div></div>` : ''}</div>
  ${c ? `<h3>Repairs and what they may cost</h3>${costTable}<p class="note">Estimates for planning from ${esc(c.priceSource)}; they are not quotes.</p>` : ''}
  ${parts.length ? `<h3>Condition of each part</h3><table><tr><th>Part</th><th>Finding</th><th class="r">Status</th></tr>${parts.map(p => { const [t, k] = STATUS[p.risk] ?? STATUS.UNKNOWN!; return `<tr><td><b>${esc(p.kind)}</b><br><span style="color:var(--mute);font-size:12.5px">${esc(p.label)}</span></td><td>${(p.why ?? []).map((w: string) => esc(w)).join(' ')}${p.action ? `<br><i>${esc(p.action)}</i>` : ''}</td><td class="r"><span class="st ${k}">${t}</span></td></tr>`; }).join('')}</table>` : ''}
  <h3>Windows and security</h3><table><tr><td class="k">Windows 11</td><td><span class="st ${s.windows?.windows11Ready === true ? 'ok' : s.windows?.windows11Ready === false ? 'bad' : 'na'}">${s.windows?.windows11Ready === true ? 'Can run Windows 11' : s.windows?.windows11Ready === false ? 'Cannot run Windows 11' : 'Not determined'}</span></td></tr>${s.windows?.note ? `<tr><td class="k">Support</td><td>${esc(s.windows.note)}</td></tr>` : ''}</table>
  <h3>Condition on the day</h3><table>${[...(cond.drives ?? []).map((d: Obj) => [d.model ?? 'Drive', [d.health, d.wearPercent != null ? `${d.wearPercent}% worn` : null, d.powerOnHours != null ? `${num(Math.round(d.powerOnHours))} hours powered on` : null].filter(Boolean).join(', ') || 'no health data']), ...(cond.battery ? [['Battery', `${cond.battery.wearPercent ?? '?'}% of capacity lost, ${cond.battery.cycles ?? '?'} charge cycles`]] : []), ['Viro health score', cond.healthScore != null ? `${cond.healthScore} out of 100` : null], ['Open problems', (cond.openIssues ?? []).length ? cond.openIssues.join('; ') : 'none recorded']].filter(r => r[1] != null).map(r => `<tr><td class="k">${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}</table>
  <h3>History of the computer</h3><table>${(s.history?.facts ?? []).map((f: Obj) => `<tr><td class="k">${esc(f.label)}</td><td>${esc(f.value)} <span style="color:var(--mute);font-size:12px">(${esc(f.basis)})</span></td></tr>`).join('')}</table>
  ${(s.checklist ?? []).length ? `<h3 class="noprint">Before you pay</h3><ol class="check noprint">${s.checklist.map((x: string) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
  <div class="verify"><div>${qr}</div><div><h4>Verify this certificate</h4><p>Scan the code, or open <b>${esc(baseUrl.replace(/^https?:\/\//, ''))}/verify</b> and enter</p><p class="code">${esc(rawCode.toUpperCase())}</p>
    ${s.binding?.serialCheck ? `<form class="sn" onsubmit="check(event)"><input id="sn" placeholder="Serial number of the computer in front of you" autocomplete="off"><button>Check it matches</button><div id="res"></div></form>` : `<p>${esc(s.binding?.note ?? '')}</p>`}</div></div>
  <div class="sign"><div><b>Viro WorkCare</b><span>Digitally signed by Viro on ${esc(longDay(s.issuedAt))}</span></div><div style="text-align:right"><span>Signature ${v.signatureValid ? '<b style="font:600 12.5px/1.2 sans-serif;font-style:normal;color:var(--ok);display:inline">verified</b>' : '<b style="font:600 12.5px/1.2 sans-serif;font-style:normal;color:var(--bad);display:inline">NOT verified</b>'}<br>Key ${esc(v.keyId)}</span></div></div>
  <p class="fine">This certificate records what Viro measured on the date of inspection. It is not a warranty, and values and costs are estimates. It is issued, and may be relied on, only under the <a href="${TERMS}">Viro certificate terms</a>.</p>
  <div class="foot">Orange Mobility Solutions · 18 Mukuni Road, Kansenshi, Ndola, Copperbelt Province, Zambia · info@viro3.online · +260 976 092 585 · PACRA no. 320241014086</div>
  </div></div>
  <script>async function check(e){e.preventDefault();var r=await fetch('/api/v1/verify/${esc(encodeURIComponent(rawCode))}/check-serial',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({serial:document.getElementById('sn').value})});var j=await r.json();var el=document.getElementById('res');if(!r.ok){el.textContent=j.error||'Could not check';el.style.color='#b3302a'}else if(j.match){el.textContent='Matches: this certificate belongs to this computer.';el.style.color='#14794d'}else{el.textContent='Does NOT match. This certificate is not for this computer.';el.style.color='#b3302a'}}</script></body></html>`;
}
