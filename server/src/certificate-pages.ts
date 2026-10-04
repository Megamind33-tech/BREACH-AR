/** The buyer-facing pages and email for the Viro certificate. Everything printed here comes from the signed statement; nothing is added at display time. */
type Obj = Record<string, any>;

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const day = (s: unknown) => (typeof s === 'string' ? s.slice(0, 10) : '');
const num = (n: unknown) => (typeof n === 'number' ? n.toLocaleString('en-US') : '');
const money = (cur: string, n: number | null | undefined) => (n == null ? 'not priced' : `${esc(cur)} ${num(n)}`);
const RISK: Record<string, [string, string]> = { LOW: ['Good', 'ok'], WATCH: ['Keep an eye on it', 'warn'], HIGH: ['Replace soon', 'bad'], CRITICAL: ['Replace now', 'bad'], UNKNOWN: ['Not measured', 'na'] };
const VERDICT: Record<string, { cls: string; head: string }> = { SOUND: { cls: 'ok', head: 'Sound' }, FAIR: { cls: 'warn', head: 'Fair' }, POOR: { cls: 'bad', head: 'Not recommended' } };

export function certificateEmail(s: Obj, code: string, link: string): string {
  const m = s.machine ?? {}, c = s.costs;
  return [
    'A seller asked Viro to inspect a computer for you. Viro read the computer itself and signed what it found.', '',
    `Computer: ${[m.manufacturer, m.model].filter(Boolean).join(' ') || 'not reported'}${m.serialLast4 ? ` (serial ends ${m.serialLast4})` : ''}`,
    `Verdict: ${s.verdict?.label ?? ''}`, ...(s.verdict?.reasons ?? []).map((r: string) => `  - ${r}`), '',
    ...(s.age?.years != null ? [`Age: about ${s.age.years} years (${String(s.age.confidence ?? '').toLowerCase()} confidence). Remaining dependable life: ${s.life?.remainingYears ? `${s.life.remainingYears[0]} to ${s.life.remainingYears[1]} years` : 'not estimated'}.`] : []),
    ...(c ? [`Work to expect: ${c.currency} ${c.workSoonTotal ?? 0}. Worth about ${c.currency} ${c.valueToday ?? '?'} today (fair price range ${c.fairPriceRange ? `${c.fairPriceRange[0]} to ${c.fairPriceRange[1]}` : 'not estimated'}). A comparable new one: ${c.currency} ${c.newEquivalent ?? '?'}. Estimates from ${c.priceSource}.`] : []), '',
    `Your certificate code: ${code}`, `Read the full certificate and check it: ${link}`, `Valid until ${day(s.expiresAt)}.`, '',
    'On the day, enter the computer\'s serial number on the certificate page. It must match.', '',
    `This email came from Viro. The seller was not sent this code and cannot change what it says. ${s.notice ?? ''}`,
  ].join('\n');
}

export function certificateEmailHtml(s: Obj, code: string, link: string, baseUrl: string): string {
  const m = s.machine ?? {}, c = s.costs, v = VERDICT[s.verdict?.rating] ?? VERDICT.FAIR!;
  const colour = { ok: '#14794d', warn: '#a86a0a', bad: '#b3302a' }[v.cls]!;
  const serif = "Georgia,'Times New Roman',serif";
  const row = (k: string, val: string) => `<tr><td style="padding:9px 0;border-top:1px solid #e1e8e4;color:#5a6a62;width:46%">${esc(k)}</td><td style="padding:9px 0;border-top:1px solid #e1e8e4"><b>${val}</b></td></tr>`;
  const work = (c?.workSoon ?? []).slice(0, 5).map((w: Obj) => `<tr><td style="padding:7px 0;border-top:1px solid #e1e8e4">${esc(w.title)}</td><td style="padding:7px 0;border-top:1px solid #e1e8e4;text-align:right;white-space:nowrap">${w.priced ? money(c.currency, w.total) : 'not priced'}</td></tr>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#e7ebe8"><div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:0 auto;padding:22px 12px;color:#14201a">
  <div style="background:#fff;border:2px solid #0b5d3f;outline:1px solid #8fb9a5;outline-offset:-7px;padding:34px 36px">
    <table role="presentation" style="width:100%;border-collapse:collapse"><tr><td style="width:46px"><img src="${esc(baseUrl)}/logo.png" width="40" height="40" alt="" style="border-radius:9px;display:block"></td><td style="padding-left:12px"><b style="font-size:16px">Viro WorkCare</b><br><span style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#5a6a62">Orange Mobility Solutions</span></td><td style="text-align:right;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#5a6a62">Certificate of Inspection</td></tr></table>
    <div style="border-top:1px solid #d5ddd8;margin:16px 0 20px"></div>
    <div style="font:italic 15px/1.5 ${serif};color:#5a6a62;text-align:center">You have been sent a certificate for a used computer.</div>
    <div style="font:400 26px/1.2 ${serif};text-align:center;margin:12px 0 2px">${esc([m.manufacturer, m.model].filter(Boolean).join(' ') || 'Computer')}</div>
    <div style="text-align:center;color:#5a6a62;font-size:13.5px">${esc(m.cpu ?? '')}${m.ramGb ? ' · ' + esc(m.ramGb) + ' GB memory' : ''}${m.serialLast4 ? ' · serial ends ' + esc(m.serialLast4) : ''}</div>
    <div style="margin:22px 0;padding:16px 18px;border:1px solid #d5ddd8;background:#fafcfb;text-align:center"><div style="font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#5a6a62">Overall assessment</div><div style="font:400 30px/1.15 ${serif};color:${colour};margin:4px 0">${esc(v.head)}</div><div style="font-size:13.5px;color:#5a6a62">${esc(s.verdict?.label ?? '')}</div></div>
    <ul style="margin:0 0 18px;padding-left:18px">${(s.verdict?.reasons ?? []).map((r: string) => `<li style="margin:4px 0">${esc(r)}</li>`).join('')}</ul>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">${row('Age (estimated)', s.age?.years != null ? 'about ' + esc(s.age.years) + ' years' : 'unknown')}${row('Dependable life left', s.life?.remainingYears ? esc(s.life.remainingYears[0]) + ' to ' + esc(s.life.remainingYears[1]) + ' years' : 'not estimated')}${c ? row('Value today (estimate)', c.fairPriceRange ? esc(c.currency) + ' ' + num(c.fairPriceRange[0]) + ' to ' + num(c.fairPriceRange[1]) : 'n/a') + row('Work to expect', money(c.currency, c.workSoonTotal ?? 0)) : ''}</table>
    ${work ? `<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#0b5d3f;margin:22px 0 4px">Repairs and what they may cost</div><table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">${work}</table>` : ''}
    <div style="margin:26px 0 8px;padding:16px;border:1px solid #d5ddd8;background:#fafcfb;text-align:center"><div style="font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#5a6a62">Your certificate code</div><div style="font:600 21px/1.4 Consolas,'Cascadia Mono',monospace;letter-spacing:.06em;margin-top:4px">${esc(code)}</div></div>
    <p style="text-align:center;margin:18px 0"><a href="${esc(link)}" style="background:#0b5d3f;color:#fff;padding:13px 26px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Open the full certificate</a></p>
    <p style="color:#5a6a62;font-size:12.5px;margin:0;text-align:center">Valid until ${esc(day(s.expiresAt))}. On the day, enter the computer's serial number on the certificate page: it must match. This email came from Viro; the seller was not sent this code and cannot change what the certificate says.</p>
  </div>
  <p style="text-align:center;color:#78867f;font-size:11px;margin:14px 0 0">Orange Mobility Solutions · Ndola, Zambia · info@viro3.online</p></div></body></html>`;
}

export function verifyPage(v: Obj | null, rawCode: string): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Viro certificate</title><meta name="robots" content="noindex">
  <style>:root{--g:#1f9d5c;--ink:#14201a;--mute:#52645a;--line:#dfe8e2;--bg:#f3f7f4;--ok:#1f9d5c;--warn:#b7791f;--bad:#c0392b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "Segoe UI",system-ui,sans-serif}main{max-width:900px;margin:0 auto;padding:22px 16px 70px}
  .top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px}.brand img{width:34px;height:34px;border-radius:8px}.top small{color:var(--mute)}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:14px}.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}
  h1{font-size:26px;margin:0 0 2px;line-height:1.2}h2{font-size:12.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--mute);margin:0 0 12px}h3{font-size:15px;margin:14px 0 6px}
  .verdict{border-radius:14px;color:#fff;padding:20px 22px;margin-bottom:14px;display:grid;grid-template-columns:auto 1fr;gap:6px 22px;align-items:center}.verdict.ok{background:var(--ok)}.verdict.warn{background:var(--warn)}.verdict.bad{background:var(--bad)}
  .verdict .big{font-size:30px;font-weight:750;line-height:1}.verdict .sm{font-size:12px;letter-spacing:.09em;text-transform:uppercase;opacity:.9}.verdict ul{margin:0;padding-left:18px}.verdict li{margin:2px 0}
  .fig{border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:#fff}.fig .k{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute)}.fig .v{font-size:23px;font-weight:700;margin-top:2px}.fig .s{color:var(--mute);font-size:13px}
  table{width:100%;border-collapse:collapse}td,th{padding:8px 0;border-top:1px solid var(--line);vertical-align:top;text-align:left}tr:first-child td,tr:first-child th{border-top:0}td:first-child{color:var(--mute);width:42%}td.r,th.r{text-align:right;white-space:nowrap}
  .pill{display:inline-block;font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:99px;white-space:nowrap}.pill.ok{background:#e3f5ea;color:#17784a}.pill.warn{background:#fbf0d9;color:#8a5a0f}.pill.bad{background:#fbe3df;color:#a02f23}.pill.na{background:#eef2ef;color:var(--mute)}
  .tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:5px;background:#eef2ef;color:var(--mute);margin-left:6px;vertical-align:1px}.mute{color:var(--mute);font-size:13.5px}
  .part{border-top:1px solid var(--line);padding:12px 0}.part:first-of-type{border-top:0}.part .row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
  details{margin-top:6px}summary{cursor:pointer;font-weight:600;padding:6px 0}ul.check{margin:0;padding-left:20px}ul.check li{margin:5px 0}
  input{height:42px;border:1px solid var(--line);border-radius:8px;padding:0 12px;font:inherit;width:100%;max-width:320px}button{height:42px;border:0;border-radius:8px;background:var(--g);color:#fff;font:inherit;font-weight:600;padding:0 18px;cursor:pointer}button.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
  .badge{display:inline-flex;align-items:center;gap:8px;font-weight:650;padding:5px 12px;border-radius:99px}.badge.ok{background:#e3f5ea;color:#17784a}.badge.warn{background:#fbf0d9;color:#8a5a0f}.badge.bad{background:#fbe3df;color:#a02f23}
  @media (max-width:640px){.verdict{grid-template-columns:1fr}h1{font-size:22px}}@media print{body{background:#fff}.noprint,form{display:none}.card,.verdict{break-inside:avoid;box-shadow:none}details{display:block}details>*{display:block}}</style></head><body><main>
  <div class="top"><div class="brand"><img src="/logo.png" alt="">Viro WorkCare<small>&nbsp;Certificate of inspection</small></div><button class="ghost noprint" onclick="window.print()">Print or save as PDF</button></div>`;
  const tail = '</main></body></html>';
  if (!v) {
    const miss = rawCode ? '<div class="card"><span class="badge bad">No certificate matches this code</span><p class="mute">Check the code in your email. If you did not get one from Viro, treat a seller\'s paper or screenshot as unverified.</p></div>' : '';
    return head + miss + `<div class="card"><h2>Check a certificate</h2><form onsubmit="location.href='/verify/'+encodeURIComponent(code.value.trim());return false"><input id="code" name="code" placeholder="VIRO-XXXX-XXXX-XXXX" autocomplete="off"> <button>Check</button></form><p class="mute">Only a code from an email sent to you by Viro verifies. A forwarded copy can be read, but the code in your own email is what proves it is real.</p></div>` + tail;
  }
  const s: Obj = v.statement, m: Obj = s.machine ?? {}, c: Obj | null = s.costs ?? null, cond: Obj = s.condition ?? {};
  const state: Record<string, [string, string]> = { valid: ['ok', 'Genuine Viro certificate'], expired: ['warn', 'Genuine, but expired: ask for a new one'], revoked: ['bad', 'Withdrawn by Viro'], invalid: ['bad', 'This certificate does not verify'] };
  const [scls, slabel] = state[v.state] ?? state.invalid!;
  const vd = s.verdict ? VERDICT[s.verdict.rating] ?? VERDICT.FAIR! : null;
  const fig = (k: string, val: string, sub = '') => `<div class="fig"><div class="k">${esc(k)}</div><div class="v">${val}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  const rem = s.life?.remainingYears ? `${esc(s.life.remainingYears[0])}–${esc(s.life.remainingYears[1])} years` : 'not estimated';

  const out: string[] = [head];
  out.push(`<div class="card" style="padding:14px 18px"><span class="badge ${scls}">${scls === 'ok' ? '&#10003;' : '&#9888;'} ${esc(slabel)}</span> <span class="mute">&nbsp;Issued ${esc(day(s.issuedAt))} · valid until ${esc(day(s.expiresAt))} · inspected ${esc(day(s.inspectedAt))}${v.state === 'revoked' ? ` · ${esc(v.revokeReason ?? '')}` : ''}</span><div class="mute" style="margin-top:6px">Certificate ${esc(String(v.id).slice(0, 8).toUpperCase())}${s.issuedFor ? ` · issued to ${esc(s.issuedFor)}` : ''}${s.listedBy ? ` · computer managed by ${esc(s.listedBy)}` : ''}</div></div>`);
  out.push(`<div class="card"><h1>${esc([m.manufacturer, m.model].filter(Boolean).join(' ') || 'Computer')}</h1><div class="mute">${esc([m.formFactor, m.cpu, m.ramGb ? m.ramGb + ' GB memory' : null, ...(m.storage ?? []).map((d: Obj) => [d.sizeGb ? d.sizeGb + ' GB' : null, d.type].filter(Boolean).join(' ')), m.os].filter(Boolean).join(' · '))}${m.serialLast4 ? ` · serial ends ${esc(m.serialLast4)}` : ''}</div></div>`);
  if (vd) out.push(`<div class="verdict ${vd.cls}"><div><div class="sm">Verdict</div><div class="big">${esc(vd.head)}</div></div><div><div style="font-weight:600;margin-bottom:4px">${esc(s.verdict.label)}</div><ul>${(s.verdict.reasons ?? []).map((r: string) => `<li>${esc(r)}</li>`).join('')}</ul></div></div>`);
  out.push(`<div class="grid" style="margin-bottom:14px">${fig('Age (estimated)', s.age?.years != null ? `about ${esc(s.age.years)} years` : 'unknown', s.age?.inServiceSince ? `in use since ${esc(s.age.inServiceSince)} · ${esc(String(s.age.confidence ?? '').toLowerCase())} confidence` : '')}${fig('Dependable life left', rem, s.life?.stage ? `stage: ${esc(s.life.stage.toLowerCase())}` : '')}${c ? fig('Worth today (estimate)', c.fairPriceRange ? `${esc(c.currency)} ${num(c.fairPriceRange[0])}–${num(c.fairPriceRange[1])}` : 'n/a', 'used price for this age and condition') + fig('Work to expect', money(c.currency, c.workSoonTotal ?? 0), `a comparable new one: ${money(c.currency, c.newEquivalent)}`) : ''}</div>`);

  if (c) {
    out.push(`<div class="card"><h2>What it may cost you</h2>${(c.workSoon ?? []).length ? `<table><tr><th>Work to expect</th><th class="r">Parts</th><th class="r">Labour</th><th class="r">Total</th></tr>${c.workSoon.map((w: Obj) => `<tr><td style="color:inherit;width:auto">${esc(w.title)}</td><td class="r">${w.priced ? money(c.currency, w.parts) : '–'}</td><td class="r">${money(c.currency, w.labour)}</td><td class="r"><b>${w.priced ? money(c.currency, w.total) : 'not priced'}</b></td></tr>`).join('')}<tr><td style="color:inherit"><b>Total</b></td><td></td><td></td><td class="r"><b>${money(c.currency, c.workSoonTotal ?? 0)}</b></td></tr></table>` : '<p style="margin:0">No repairs or replacements are expected soon.</p>'}
      <details><summary>How these estimates were made</summary>${(c.reasoning ?? []).map((r: string) => `<p class="mute" style="margin:4px 0">${esc(r)}</p>`).join('')}<p class="mute">Prices: ${esc(c.priceSource)}, in ${esc(c.currency)}. They are for planning and bargaining, not a quote. A technician in your area can price the same work.</p></details></div>`);
  }

  const parts: Obj[] = s.parts ?? [];
  if (parts.length) out.push(`<div class="card"><h2>Part by part</h2>${parts.map(p => { const [t, k] = RISK[p.risk] ?? RISK.UNKNOWN!; return `<div class="part"><div class="row"><div><b>${esc(p.kind)}</b><div class="mute">${esc(p.label)}</div></div><span class="pill ${k}">${esc(t)}</span></div><div style="margin-top:6px">${(p.why ?? []).map((w: string) => `<div>${esc(w)}</div>`).join('')}${p.action ? `<div class="mute" style="margin-top:4px"><b>What to do:</b> ${esc(p.action)}</div>` : ''}</div></div>`; }).join('')}</div>`);

  out.push(`<div class="card"><h2>Windows and security</h2><p style="margin:0 0 8px"><span class="pill ${s.windows?.windows11Ready === true ? 'ok' : s.windows?.windows11Ready === false ? 'bad' : 'na'}">${s.windows?.windows11Ready === true ? 'Can run Windows 11' : s.windows?.windows11Ready === false ? 'Cannot run Windows 11' : 'Windows 11 support unknown'}</span> <span class="mute">Running ${esc(m.os ?? 'Windows')}${m.osBuild ? ` (build ${esc(m.osBuild)})` : ''}</span></p>${s.windows?.note ? `<p class="mute" style="margin:0 0 8px">${esc(s.windows.note)}</p>` : ''}<details><summary>Technician detail: Windows 11 checks</summary><table>${(s.windows?.checks ?? []).map((ch: Obj) => `<tr><td>${esc(ch.name)}</td><td><span class="pill ${ch.ok === true ? 'ok' : ch.ok === false ? 'bad' : 'na'}">${ch.ok === true ? 'Pass' : ch.ok === false ? 'Fail' : 'Unknown'}</span> ${esc(ch.value)}</td></tr>`).join('')}</table></details></div>`);

  out.push(`<div class="card"><h2>Condition on the day</h2><table>${[...(cond.drives ?? []).map((d: Obj) => [d.model ?? 'Drive', [d.health, d.wearPercent != null ? `${d.wearPercent}% worn` : null, d.powerOnHours != null ? `${num(Math.round(d.powerOnHours))} hours powered on` : null].filter(Boolean).join(' · ') || 'no health data']), ...(cond.battery ? [['Battery', `${cond.battery.wearPercent ?? '?'}% of its capacity lost · ${cond.battery.cycles ?? '?'} charge cycles`]] : []), ['Viro health score', cond.healthScore != null ? `${cond.healthScore} / 100` : null], ['Open problems', (cond.openIssues ?? []).length ? cond.openIssues.join('; ') : 'none recorded']].filter(r => r[1] != null).map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}</table></div>`);

  out.push(`<div class="card"><h2>How it has lived</h2><table>${(s.history?.facts ?? []).map((f: Obj) => `<tr><td>${esc(f.label)}</td><td>${esc(f.value)}<span class="tag">${esc(f.basis)}</span></td></tr>`).join('')}</table><details><summary>Timeline</summary><table>${(s.history?.timeline ?? []).map((t: Obj) => `<tr><td>${esc(t.date ?? 'date unknown')}</td><td>${esc(t.title)}<span class="tag">${esc(t.basis)}</span></td></tr>`).join('')}</table></details><details><summary>What this history cannot tell you</summary><ul class="mute">${(s.history?.limits ?? []).map((l: string) => `<li>${esc(l)}</li>`).join('')}</ul></details></div>`);

  if (parts.length) out.push(`<div class="card"><h2>For technicians</h2><details><summary>Measured facts and upgrade options for every part</summary>${parts.map(p => `<h3>${esc(p.kind)}</h3><table>${(p.facts ?? []).map((f: Obj) => `<tr><td>${esc(f.label)}</td><td>${esc(f.value)}</td></tr>`).join('')}</table>${p.lifespan ? `<p class="mute" style="margin:6px 0">${esc(p.lifespan)}</p>` : ''}${(p.upgrades ?? []).map((u: Obj) => `<p class="mute" style="margin:4px 0"><b>${esc(u.title)}:</b> ${esc(u.why)}</p>`).join('')}`).join('')}</details></div>`);

  if ((s.checklist ?? []).length) out.push(`<div class="card"><h2>Before you pay</h2><ul class="check">${s.checklist.map((x: string) => `<li>${esc(x)}</li>`).join('')}</ul>${s.binding?.serialCheck ? `<form style="margin-top:14px" onsubmit="check(event)"><div class="mute" style="margin-bottom:6px">${esc(s.binding.note)}</div><input id="sn" placeholder="Serial number of the computer in front of you" autocomplete="off"> <button>Check it matches</button><div id="res" style="margin-top:8px;font-weight:600"></div></form>` : `<p class="mute">${esc(s.binding?.note ?? '')}</p>`}</div>`);

  out.push(`<div class="card mute"><b>Signature</b> ${v.signatureValid ? 'verified' : '<b style="color:#c0392b">NOT verified</b>'} · key ${esc(v.keyId)}<br>${esc(s.notice ?? '')}<br>measured = read from the computer by Viro · observed = seen by Viro between two readings · recorded = entered by a person.</div>`);
  out.push(`<script>async function check(e){e.preventDefault();var r=await fetch('/api/v1/verify/${esc(encodeURIComponent(rawCode))}/check-serial',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({serial:document.getElementById('sn').value})});var j=await r.json();var el=document.getElementById('res');if(!r.ok){el.textContent=j.error||'Could not check';el.style.color='#c0392b'}else if(j.match){el.textContent='Matches: this certificate belongs to this computer.';el.style.color='#1f9d5c'}else{el.textContent='Does NOT match. This certificate is not for this computer.';el.style.color='#c0392b'}}</script>`);
  out.push(tail);
  return out.join('');
}
