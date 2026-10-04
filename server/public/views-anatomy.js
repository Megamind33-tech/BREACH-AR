'use strict';
/* Computer anatomy: every part, how old it is and how it is judged, what it would take to repair or upgrade it, and whether it is worth it. Nothing here is invented:
   each line shows the measurement or rule behind it, and what could not be read is listed as not known. */

const RISK_TEXT = { LOW: 'No concern', WATCH: 'Watch', HIGH: 'Likely to cause trouble', CRITICAL: 'Failing or failed', UNKNOWN: 'Not measurable' };
const RISK_PILL = { LOW: 'healthy', WATCH: 'attention', HIGH: 'critical', CRITICAL: 'critical', UNKNOWN: 'unknown' };
const DECISION_TEXT = { KEEP: 'Keep it', REPAIR: 'Repair it', REPLACE: 'Replace it', UNDECIDED: 'Not decided' };
const DECISION_PILL = { KEEP: 'healthy', REPAIR: 'attention', REPLACE: 'critical', UNDECIDED: 'unknown' };
const WEIGHT_TEXT = { strong: 'Strong evidence', medium: 'Medium evidence', weak: 'Only shows it was in use by then' };
const cur = (c, v) => v == null ? '—' : `${c} ${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const yrs = v => v == null ? 'Not known' : `${v} year${v === 1 ? '' : 's'}`;

NAV.splice(NAV.findIndex(n => n[0] === 'reports'), 0, ['anatomy', 'Anatomy']);
ICON_PATHS.anatomy = '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>';

function partCard(p, cc) {
  return `<div class="card part"><div class="toggle-row"><h2 style="margin:0">${esc(p.kind)}</h2><span class="pill ${RISK_PILL[p.risk]}">${esc(RISK_TEXT[p.risk])}</span></div>
    <p style="margin:6px 0 2px"><b>${esc(p.label)}</b>${p.ageYears != null ? ` <span class="mute">· about ${yrs(p.ageYears)} old${p.firstSeen ? `, first seen ${esc(p.firstSeen)}` : ''}</span>` : ''}</p>
    <ul style="margin:6px 0">${p.riskReasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
    <details><summary>Everything read from this part (${p.facts.length})</summary><dl>${p.facts.map(f => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('')}</dl></details>
    ${p.lifespan ? `<p class="mute" style="margin:8px 0 0"><b>How this part ages:</b> ${esc(p.lifespan)}</p>` : ''}
    ${p.upgrades.length ? `<div style="margin-top:8px"><b>Compatible solution${p.upgrades.length === 1 ? '' : 's'}</b>${p.upgrades.map(u => {
      const line = cc?.lines?.find(l => l.part === p.kind && l.title === u.title);
      return `<div class="issue">${line ? `<span class="pts">${esc(cur(cc.currency, line.total))}</span>` : ''}<b>${esc(u.title)}</b><small>${esc(u.spec)}</small><small>${esc(u.why)}</small></div>`;
    }).join('')}</div>` : ''}</div>`;
}

function costCard(c) {
  if (!c.priced) return `<div class="card"><h2>Repair or replace: what it would cost</h2><p class="note" style="margin:0">${esc((c.reasoning ?? ['No prices are set.'])[0])}</p>${can('admin') ? '<div class="actions"><a class="btn" href="#/anatomy?prices=1">Set prices</a></div>' : ''}</div>`;
  return `<div class="card"><div class="toggle-row"><h2 style="margin:0">Repair or replace: what it would cost</h2><span class="pill ${DECISION_PILL[c.decision]}">${esc(DECISION_TEXT[c.decision])}</span></div>
    ${c.priceSource === 'reference' ? `<p class="note" style="margin:8px 0">These prices are typical figures loaded as a starting point, not quotes from your market. ${can('admin') ? '<a href="#/anatomy?prices=1">Enter your own prices</a> to make this exact.' : 'An administrator can enter local prices.'}</p>` : ''}
    <div class="kv">${kv('Repairs recommended', cur(c.currency, c.repairTotal))}${kv('A comparable new computer', cur(c.currency, c.replacementCost))}${kv('Moving to a new one', cur(c.currency, c.migrationCost))}${kv('Worth today', cur(c.currency, c.residualValue))}</div>
    ${c.lines.length ? `<table><thead><tr><th>Work</th><th>Parts</th><th>Labour</th><th>Total</th></tr></thead><tbody>${c.lines.map(l => `<tr><td>${esc(l.title)}</td><td>${esc(cur(c.currency, l.parts))}</td><td>${esc(cur(c.currency, l.labour))}</td><td>${esc(cur(c.currency, l.total))}</td></tr>`).join('')}</tbody></table>` : ''}
    <h3>How this was decided</h3><ul>${c.reasoning.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>`;
}

function ageCard(r) {
  const a = r.age, s = r.lifeStage;
  return `<div class="card"><h2>Age and life</h2>
    <div class="facts"><div class="fact"><b>${a.ageYears == null ? '—' : esc(yrs(a.ageYears))}</b><span>Age</span></div><div class="fact"><b>${esc(a.inServiceSince ?? '—')}</b><span>In service since</span></div><div class="fact"><b>${esc(s.stage)}</b><span>Life stage</span></div><div class="fact"><b>${s.remainingYears ? s.remainingYears[0] + '–' + s.remainingYears[1] + ' years' : '—'}</b><span>Likely remaining</span></div></div>
    <p class="mute" style="margin:8px 0 0">${esc(a.note)} <span class="pill ${a.confidence === 'HIGH' ? 'healthy' : a.confidence === 'MEDIUM' ? 'attention' : 'unknown'}">${esc(CONF_TEXT[a.confidence] ?? a.confidence)}</span></p>
    <p class="mute" style="margin:4px 0 0">${esc(s.basis)}</p>
    <details><summary>The dated evidence (${a.evidence.length})</summary>${a.evidence.map(e => `<div class="issue"><span class="pts">${esc(e.date)}</span><b>${esc(e.source)}</b> <span class="mute">${esc(WEIGHT_TEXT[e.weight])}</span><small>${esc(e.meaning)}</small></div>`).join('')}</details></div>`;
}

function windowsCard(w) {
  return `<div class="card"><div class="toggle-row"><h2 style="margin:0">Windows 11 readiness</h2><span class="pill ${w.windows11Ready === true ? 'healthy' : w.windows11Ready === false ? 'critical' : 'unknown'}">${w.windows11Ready === true ? 'Ready' : w.windows11Ready === false ? 'Not eligible' : 'Cannot tell yet'}</span></div>
    ${w.supportNote ? `<p class="note" style="margin:8px 0">${esc(w.supportNote)}</p>` : ''}
    ${w.checks.map(c => `<div class="issue"><span class="pts"><span class="pill ${c.ok === true ? 'healthy' : c.ok === false ? 'critical' : 'unknown'}">${c.ok === true ? 'Met' : c.ok === false ? 'Not met' : 'Unknown'}</span></span>${esc(c.name)}<small>${esc(c.value)}</small></div>`).join('')}</div>`;
}

function historyCard(d) {
  return `<div class="card"><h2>Changes and service history</h2>
    ${d.changes.length ? `<h3 style="margin-top:0">Parts that appeared, left or were swapped</h3>${d.changes.map(c => `<div class="issue"><span class="pts">${esc(day(c.detected_at))}</span><b>${esc(c.label)}</b> <span class="mute">${esc(c.change)}</span></div>`).join('')}<p class="mute">These are what Viro saw change between readings. Whether it was a repair or an upgrade is for a person to record below.</p>` : '<p class="mute" style="margin:0 0 8px">No part changes seen since Viro began reading this computer. Earlier changes cannot be known unless someone records them.</p>'}
    <h3>Recorded services</h3>${d.service.length ? d.service.map(e => `<div class="issue"><span class="pts">${esc(day(e.occurred_at))}</span><b>${esc(e.service_type)}</b>${e.reason ? ' · ' + esc(e.reason) : ''}<small>${esc([e.technician ? 'By ' + e.technician : '', e.cost != null ? 'cost ' + e.cost : ''].filter(Boolean).join(' · '))}</small></div>`).join('') : '<p class="mute" style="margin:0">No service recorded. Add one from the computer\'s page so the last RAM, disk or cleaning date is known.</p>'}</div>`;
}

function maintenanceCard(m) {
  const row = (l, v) => `<dt>${esc(l)}</dt><dd>${esc(v ?? 'Not recorded')}</dd>`;
  return `<div class="card"><h2>Upkeep Windows has on record</h2><dl>${row('Last Windows update installed', m.lastWindowsUpdateInstalled)}${row('Last Defender quick scan', m.defenderQuickScan)}${row('Last Defender full scan', m.defenderFullScan)}${row('Defender signatures updated', m.defenderSignaturesUpdated)}${row('Last memory test', m.lastMemoryTest)}${row('Last disk check', m.lastDiskCheck)}${row('Stability index (30 days, of 10)', m.reliabilityIndex30d)}</dl></div>`;
}

async function anatomyReport(main, id) {
  const d = await api(`/api/v1/devices/${id}/anatomy`);
  if (!d.available) {
    main.innerHTML = `<a class="back" href="#/anatomy">&larr; Hardware</a><h1 data-eyebrow="HARDWARE / DETAILS">${esc(d.hostname)}</h1><div class="card"><p class="mute" style="margin:0">${esc(d.note)}</p>${can('technician') ? '<div class="actions"><button id="collect">Collect now</button></div>' : ''}</div>`;
    $('#collect')?.addEventListener('click', async () => { try { await post(`/api/v1/devices/${id}/anatomy/collect`); toast('Collecting. This takes up to a minute.'); poll(8000); } catch (e) { fail(e); } });
    poll(8000); return;
  }
  const r = d.report, i = r.identity;
  main.innerHTML = `<a class="back noprint" href="#/anatomy">&larr; Hardware</a>
    <div class="toggle-row"><h1 style="margin:0">${esc(d.hostname)}</h1><span class="noprint"><button class="ghost sm" onclick="print()">Print report</button> ${can('technician') ? '<button class="ghost sm" id="collect">Refresh readings</button>' : ''}</span></div>
    <div class="mute">${esc((i.manufacturer && i.model && i.model.toLowerCase().startsWith(i.manufacturer.toLowerCase()) ? [i.model] : [i.manufacturer, i.model]).filter(Boolean).join(' '))} · serial ${esc(i.serial ?? 'not readable')} · ${esc(i.os ?? '')} · read ${esc(when(r.collectedAt))}</div>
    ${r.headline.length ? `<div class="card"><h2>What needs attention, most serious first</h2>${r.headline.map(h => `<div class="issue"><span class="pts"><span class="pill ${RISK_PILL[h.risk]}">${esc(RISK_TEXT[h.risk])}</span></span><b>${esc(h.part)}</b> <span class="mute">${esc(h.label)}</span><small>${esc(h.why)}</small></div>`).join('')}</div>` : '<div class="card"><h2>What needs attention</h2><p class="mute" style="margin:0">Nothing measurable points at a problem.</p></div>'}
    ${costCard(r.cost)}${ageCard(r)}${windowsCard(r.windows)}
    <h2 style="margin-top:20px">Every part</h2>${r.parts.map(p => partCard(p, r.cost.priced ? r.cost : null)).join('')}
    ${maintenanceCard(r.maintenance)}${historyCard(d)}
    ${r.gaps.length ? `<div class="card"><h2>What could not be read</h2><ul>${r.gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div>` : ''}
    <p class="mute">Ages and risks are computed from measurements and the documented rules above; where a figure cannot be known it says so instead of guessing. <a class="noprint" href="#/upgrades/${esc(id)}">Upgrade advice</a> · <a class="noprint" href="#/computers/${esc(id)}">Open the computer</a></p>`;
  $('#collect')?.addEventListener('click', async () => { try { await post(`/api/v1/devices/${id}/anatomy/collect`); toast('Reading started. Refresh in a minute.'); } catch (e) { fail(e); } });
  poll(60000);
}

const PRICE_LABELS = { ram_ddr3: 'Memory module, DDR3 (per module)', ram_ddr4: 'Memory module, DDR4 (per module)', ram_ddr5: 'Memory module, DDR5 (per module)', ssd_256gb: 'SSD, 256 GB', ssd_512gb: 'SSD, 512 GB', ssd_1tb: 'SSD, 1 TB', battery_laptop: 'Laptop battery', thermal_service: 'Cooling service (cleaning and thermal paste)' };

async function priceBook(main) {
  const r = await api('/api/v1/price-book'); const b = r.priceBook ?? r.reference; const items = { ...r.reference.items, ...(r.priceBook?.items ?? {}) }; const np = { ...r.reference.newPc, ...(r.priceBook?.newPc ?? {}) };
  main.innerHTML = `<a class="back" href="#/anatomy">&larr; Hardware</a><h1 data-eyebrow="HARDWARE / PRICE BOOK">Prices</h1><p class="lead">What parts, labour and a replacement computer cost in your market. Repair-or-replace verdicts are computed from these.</p>
    <div class="card"><p class="${r.priceBook?.source === 'entered' ? 'mute' : 'note'}" style="margin:0 0 10px">${r.priceBook?.source === 'entered' ? 'These are the prices your organization entered.' : r.priceBook ? 'These are typical reference figures, not your market prices. Change them and save to make them yours.' : 'No prices are set. Load reference figures to start, then correct them to your market.'}</p>
      <form id="pb"><div class="row2"><div><label>Currency (3 letters)</label><input name="currency" value="${esc(b.currency)}" pattern="[A-Z]{3}" required></div><div><label>Labour per hour</label><input name="labour" type="number" min="0" step="any" value="${esc(b.labourPerHour)}" required></div></div>
      <h3>Parts</h3><div class="row2">${Object.keys(items).map(k => `<div><label>${esc(PRICE_LABELS[k] ?? k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()))}</label><input data-item="${esc(k)}" type="number" min="0" step="any" value="${esc(items[k])}"></div>`).join('')}</div>
      <h3>A comparable new computer</h3><div class="row2">${Object.keys(np).map(k => `<div><label>${esc(k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()))}</label><input data-newpc="${esc(k)}" type="number" min="0" step="any" value="${esc(np[k])}"></div>`).join('')}</div>
      <div class="actions">${can('admin') ? '<button type="submit">Save prices</button><button type="button" class="ghost" id="loadref">Load reference figures</button>' : '<span class="mute">Only an administrator can change prices.</span>'}</div></form></div>`;
  $('#pb')?.addEventListener('submit', async e => {
    e.preventDefault();
    const items = {}, newPc = {}; $$('[data-item]').forEach(i => { if (i.value !== '') items[i.dataset.item] = +i.value; }); $$('[data-newpc]').forEach(i => { if (i.value !== '') newPc[i.dataset.newpc] = +i.value; });
    try { await api('/api/v1/price-book', { method: 'PUT', body: JSON.stringify({ currency: e.target.currency.value.toUpperCase(), labourPerHour: +e.target.labour.value, items, newPc }) }); toast('Prices saved.'); location.hash = '#/anatomy'; } catch (x) { fail(x); }
  });
  $('#loadref')?.addEventListener('click', async () => { try { await post('/api/v1/price-book/reference'); toast('Reference figures loaded. They are labelled as such until you change them.'); reroute(); } catch (x) { fail(x); } });
}

VIEWS.anatomy = async (main, arg) => {
  if (arg) return anatomyReport(main, arg);
  if (new URLSearchParams(location.hash.split('?')[1] ?? '').get('prices')) return priceBook(main);
  const f = await api('/api/v1/anatomy/fleet');
  const worst = { UNKNOWN: -1, LOW: 0, WATCH: 1, HIGH: 2, CRITICAL: 3 };
  main.innerHTML = `<h1>Hardware</h1><p class="lead">Components, age and wear for every computer. Read from the machine, daily.</p>
    <div class="bar-tools"><a class="btn ghost sm" href="#/anatomy?prices=1">Prices</a></div>
    ${f.computers.length ? `<table><thead><tr><th>Computer</th><th>Model</th><th>Age</th><th>Life stage</th><th>Worst part</th><th>Windows 11</th><th>Advice</th><th class="hide-sm">Main concerns</th></tr></thead><tbody>${f.computers.sort((a, b) => worst[b.worst] - worst[a.worst]).map(c => `<tr class="row" data-id="${esc(c.id)}"><td><span class="nowrap">${esc(c.hostname)}</span></td><td>${esc(c.model)}</td><td>${c.ageYears == null ? '—' : esc(yrs(c.ageYears))}</td><td>${esc(c.stage)}</td><td><span class="pill ${RISK_PILL[c.worst]}">${esc(RISK_TEXT[c.worst])}</span></td><td>${c.windows11Ready === true ? 'Ready' : c.windows11Ready === false ? 'Not eligible' : '—'}</td><td>${c.decision ? `<span class="pill ${DECISION_PILL[c.decision]}">${esc(DECISION_TEXT[c.decision])}</span>${c.repairTotal != null ? `<small>${esc(cur(f.currency, c.repairTotal))}</small>` : ''}` : '<span class="mute">No prices</span>'}</td><td class="hide-sm">${esc(c.headline.join(' · '))}</td></tr>`).join('')}</tbody></table>`
      : emptyState('anatomy', 'No readings yet', 'Each computer sends its anatomy about ten minutes after it starts, and once a day after that. Open a computer to collect it now.')}`;
  $$('tr.row').forEach(tr => tr.onclick = () => location.hash = '#/anatomy/' + tr.dataset.id);
  poll(60000);
};

/* A short card on each computer's own page, linking to the full report. */
EXTRA_DEVICE_HOOKS.push(async (main, d) => {
  const low = $('#care-low'); if (!low) return;
  let box = $('#anatomy-card');
  if (!box) { box = document.createElement('div'); box.id = 'anatomy-card'; low.before(box); }
  try {
    const a = await api(`/api/v1/devices/${d.id}/anatomy`);
    box.innerHTML = a.available ? `<div class="card"><div class="toggle-row"><h2 style="margin:0">Anatomy</h2><a class="btn sm" href="#/anatomy/${esc(d.id)}">Full report</a></div>
        <p class="mute" style="margin:8px 0 0">${a.report.age.ageYears != null ? `About ${esc(yrs(a.report.age.ageYears))} old · ` : ''}${esc(a.report.lifeStage.stage)}${a.report.cost.priced ? ` · advice: <b>${esc(DECISION_TEXT[a.report.cost.decision])}</b>` : ''}</p>${a.report.headline[0] ? `<p style="margin:6px 0 0">${esc(a.report.headline[0].part)}: ${esc(a.report.headline[0].why)}</p>` : ''}</div>`
      : `<div class="card"><div class="toggle-row"><h2 style="margin:0">Anatomy</h2><a class="btn ghost sm" href="#/anatomy/${esc(d.id)}">Open</a></div><p class="mute" style="margin:8px 0 0">Not collected yet.</p></div>`;
  } catch { box.innerHTML = ''; }
});
