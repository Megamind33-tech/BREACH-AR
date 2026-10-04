'use strict';
/* Hardware upgrade advice: what this exact computer can realistically accept, why, what else must change, and whether the upgrade actually worked.
   Customers see recommendations that passed validation, never the scoring internals. Anything not verified says so. */

const UP_CLASS = { ESSENTIAL: ['critical', 'Essential'], HIGH_VALUE: ['attention', 'High value'], OPTIONAL: ['unknown', 'Optional'] };
const UP_COMPAT = { VERIFIED: ['healthy', '✓ Verified'], VERIFIED_AFTER_BIOS_UPDATE: ['attention', '✓ Verified after a BIOS update'], VERIFIED_WITH_CONDITIONS: ['attention', '✓ Verified with conditions'] };
const UP_BENEFIT = { SYSTEM_RESPONSIVENESS: 'Makes the computer feel faster (start-up, opening programs). It does not raise processor speed.', COMPUTATIONAL: 'Raises how much work the processor gets done.', MEMORY_BANDWIDTH: 'Raises memory speed.', CAPACITY: 'Gives programs more memory to work with.', BANDWIDTH_AND_CAPACITY: 'More memory, and faster.', RELIABILITY: 'Protects against failure and data loss.', THERMAL: 'Lowers heat and removes heat slowdowns.', CONFIGURATION: 'A setting, no parts.' };
const UP_SHORT = { RELIABILITY: 'Protects your data', SYSTEM_RESPONSIVENESS: 'Faster start-up and program loading', THERMAL: 'Lower temperatures, no heat slowdowns', CAPACITY: 'Fewer stalls under load', CONFIGURATION: 'Small' };
const upMoney = c => c?.priced ? `${c.currency} ${Number(c.total).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : null;
const upPct = x => `${Math.round(x * 100)}%`;
const STAGE_PILL = { pass: ['healthy', 'Passed'], fail: ['critical', 'Failed'], unknown: ['unknown', 'Not verified'], 'n/a': ['unknown', 'Not applicable'] };

NAV.splice(NAV.findIndex(n => n[0] === 'reports'), 0, ['upgrades', 'Upgrades']);
ICON_PATHS.upgrades = '<path d="M12 19V6M7 11l5-5 5 5"/><path d="M5 20h14"/>';

function recCard(r, best) {
  const [pc, pl] = UP_CLASS[r.class]; const [cc, cl] = UP_COMPAT[r.compatibility.status] ?? ['unknown', r.compatibility.status];
  const cost = upMoney(r.cost);
  return `<div class="card rec${best ? ' best' : ''}" data-rec="${esc(r.id)}">
    <div class="toggle-row"><h2 style="margin:0">${best ? 'Best upgrade · ' : ''}${esc(r.title)}</h2><span class="pill ${pc}">${esc(pl)}</span></div>
    <p style="margin:8px 0 6px">${esc(r.summary)}</p>
    <div class="kv">${kv('Compatibility', cl.replace('✓ ', ''))}${kv('Expected improvement', r.expected.lowPercent != null && r.expected.highPercent != null ? `+${Math.max(0, Math.round(r.expected.lowPercent))}–${Math.round(r.expected.highPercent)}%` : (UP_SHORT[r.benefit] ?? 'See below'))}${kv('Installation', r.installation.effort)}${kv('Cooling', r.installation.cooling)}${kv('BIOS', r.installation.bios)}${kv('Confidence', upPct(r.confidence.overall))}${cost ? kv('Estimated cost', cost) : ''}</div>
    <p class="mute" style="margin:6px 0 0">${esc(UP_BENEFIT[r.benefit] ?? '')}</p>
    ${r.confidence.lowerBecause.length ? `<p class="mute" style="margin:4px 0 0">Confidence is lower because: ${esc(r.confidence.lowerBecause.join(' '))}</p>` : ''}
    <details><summary>View why</summary>
      ${r.why.map(w => `<p style="margin:6px 0">${esc(w)}</p>`).join('')}<p class="mute" style="margin:6px 0">${esc(r.expected.basis)}</p>
      ${r.compatibility.checks.length ? `<h3>What was checked</h3>${r.compatibility.checks.map(s => `<div class="issue"><span class="pts"><span class="pill ${STAGE_PILL[s.status][0]}">${STAGE_PILL[s.status][1]}</span></span>${esc(s.label)}<small>${esc(s.detail)}</small></div>`).join('')}` : `<p class="mute">${esc(r.compatibility.text)}</p>`}
    </details>
    <details><summary>Installation guide</summary>
      ${r.part?.spec ? `<p style="margin:6px 0"><b>Specification:</b> ${esc(r.part.spec)}</p>` : r.part?.label ? `<p style="margin:6px 0"><b>Buy:</b> ${esc(r.part.label)}${r.part.matchWith ? `, ideally the same make as ${esc(r.part.matchWith)}` : ''}${r.part.resultingConfig ? `. Result: ${esc(r.part.resultingConfig)}.` : ''}</p>` : r.part?.cpu ? `<p style="margin:6px 0"><b>Buy:</b> ${esc(r.part.cpu)} (socket ${esc(r.part.socket)}, ${esc(r.part.tdpW)} W)</p>` : ''}
      <ul>${r.installation.requirements.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details></div>`;
}

function verifyCard(v) {
  const res = v.result; const when = t => t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const names = (v.changes ?? []).map(c => c.label).join('; ');
  if (v.state === 'awaiting_measurement') return `<div class="card"><h2>Hardware change detected</h2><p style="margin:6px 0">${esc(names)}</p><p class="mute" style="margin:0">Detected ${esc(when(v.detected_at))}. The computer is being re-measured so the result can be compared with the earlier measurement.</p></div>`;
  if (!res) return `<div class="card"><h2>Hardware change detected</h2><p style="margin:6px 0">${esc(names)}</p><p class="mute" style="margin:0">The re-measurement could not be completed, so no improvement is claimed.</p></div>`;
  const pill = res.verdict === 'VERIFIED' ? 'healthy' : res.verdict === 'REGRESSION' ? 'critical' : 'attention';
  return `<div class="card"><div class="toggle-row"><h2 style="margin:0">${esc(res.headline[0])}</h2><span class="pill ${pill}">${esc(res.verdict.replace('_', ' ').toLowerCase())}</span></div>
    <p class="mute" style="margin:6px 0">${esc(names)} · ${esc(when(v.completed_at))}</p>
    ${res.rows.length ? `<table><thead><tr><th></th><th>Before</th><th>After</th><th>Change</th></tr></thead><tbody>${res.rows.map(r => `<tr><td>${esc(r.label)}</td><td>${esc(r.before)} ${esc(r.unit)}</td><td>${esc(r.after)} ${esc(r.unit)}</td><td><span class="pill ${r.result === 'improved' ? 'healthy' : r.result === 'worse' ? 'critical' : 'unknown'}">${r.result === 'unchanged' ? 'about the same' : (r.changePercent >= 0 ? '+' : '') + r.changePercent + '%'}</span></td></tr>`).join('')}</tbody></table>` : ''}
    <ul>${res.headline.slice(1).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
}

async function upgradeComputer(main, id) {
  const d = await api(`/api/v1/devices/${id}/upgrades`);
  if (!d.available) { main.innerHTML = `<a class="back" href="#/upgrades">&larr; Upgrades</a><h1 data-eyebrow="HARDWARE / UPGRADE PLAN">${esc(d.hostname)}</h1><div class="card"><p class="mute" style="margin:0">${esc(d.note)}</p><div class="actions"><a class="btn" href="#/anatomy/${esc(id)}">Open the hardware report</a></div></div>`; poll(15000); return; }
  const r = d.report, m = r.machine; const ess = r.recommendations.filter(x => x.class === 'ESSENTIAL'), high = r.recommendations.filter(x => x.class === 'HIGH_VALUE'), opt = r.recommendations.filter(x => x.class === 'OPTIONAL');
  const best = r.recommendations.find(x => x.id === r.best);
  const hp = r.health === 'Good' ? 'healthy' : r.health === 'Fair' ? 'attention' : 'critical';
  main.innerHTML = `<a class="back" href="#/upgrades">&larr; Upgrades</a>
    <div class="toggle-row"><h1 style="margin:0">${esc(d.hostname)}</h1><a class="btn ghost sm" href="#/anatomy/${esc(id)}">Hardware report</a></div>
    <div class="card"><h2>Your computer</h2>
      <dl><dt>Processor</dt><dd>${esc(m.cpu.name ?? 'Not read')}${m.cpu.socket ? ` · socket ${esc(m.cpu.socket)}` : ''}</dd>
      <dt>Motherboard</dt><dd>${esc([m.board.manufacturer, m.board.model].filter(Boolean).join(' ') || 'Not read')}${m.board.chipset ? ` · chipset ${esc(m.board.chipset)}` : m.board.oem ? ' · chipset not stated by this OEM board' : ''}</dd>
      <dt>BIOS</dt><dd>${esc(m.board.bios.version ?? 'Not read')}${m.board.bios.releaseDate ? ` (${esc(m.board.bios.releaseDate)})` : ''}</dd>
      <dt>Memory</dt><dd>${esc(m.memory.description)}${m.memory.slots != null ? ` · ${m.memory.slotsUsed ?? '?'} of ${m.memory.slots} slots${m.memory.maxGB ? `, up to ${m.memory.maxGB} GB` : ''}` : ''}</dd>
      <dt>Storage</dt><dd>${esc(m.storage.map(s => `${s.model ?? ''} (${s.kind}${s.sizeGB ? ', ' + s.sizeGB + ' GB' : ''})`).join('; ') || 'Not read')}</dd></dl>
      <p style="margin:8px 0 0"><b>System health:</b> <span class="pill ${hp}">${esc(r.health)}</span></p></div>
    ${r.replacement.action === 'REPLACE_MACHINE' || r.replacement.action === 'DO_NOT_UPGRADE' ? `<div class="card" style="border-left:3px solid var(--bad,#c33)"><h2>${esc(r.replacement.text)}</h2><ul>${r.replacement.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${best && ess.length === 0 ? recCard(best, true) : ''}
    ${ess.length ? `<h2 style="margin-top:20px">Do these first</h2>${ess.map(x => recCard(x, x.id === r.best)).join('')}` : ''}
    ${high.filter(x => x.id !== r.best).length ? `<h2 style="margin-top:20px">Other high-value improvements</h2>${high.filter(x => x.id !== r.best).map(x => recCard(x, false)).join('')}` : ''}
    ${opt.length ? `<h2 style="margin-top:20px">Optional</h2>${opt.map(x => recCard(x, false)).join('')}` : ''}
    ${!r.recommendations.length ? `<div class="card"><h2>${esc(r.replacement.text)}</h2><ul>${r.replacement.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${r.bundles.length ? `<div class="card"><h2>Worth doing together</h2>${r.bundles.map(b => `<div class="issue"><b>${esc(b.title)}</b>${upMoney(b.cost) ? `<span class="pts">${esc(upMoney(b.cost))}</span>` : ''}<small>${esc(b.expectedText)} · confidence ${upPct(b.confidence)}</small></div>`).join('')}</div>` : ''}
    ${r.notRecommended.length ? `<details class="card"><summary><b>Considered and not recommended</b> (${r.notRecommended.length})</summary>${r.notRecommended.map(n => `<div class="issue"><b>${esc(n.title)}</b> <span class="pill ${n.decision === 'NOT_VERIFIED' ? 'unknown' : 'critical'}">${esc(n.text)}</span>${n.reasons.map(x => `<small>${esc(x)}</small>`).join('')}${n.unlockedBy ? '<small>Possible together with the cooling service above.</small>' : ''}</div>`).join('')}</details>` : ''}
    <div class="card"><h2>Measured proof</h2><p class="mute" style="margin:0 0 8px">${esc(r.baseline.text)}</p>${can('technician') ? `<div class="actions"><button class="${r.baseline.measured ? 'ghost sm' : ''}" id="baseline">${r.baseline.measured ? 'Measure again' : 'Measure baseline'}</button></div>` : ''}</div>
    ${d.verifications.length ? `<h2 style="margin-top:20px">After upgrades</h2>${d.verifications.map(verifyCard).join('')}` : ''}
    <details class="card"><summary><b>What could not be verified</b></summary><ul>${r.gaps.map(x => `<li>${esc(x)}</li>`).join('')}</ul>${r.notAssessed.map(n => `<p style="margin:6px 0"><b>${esc(n.item)}:</b> ${esc(n.reason)}</p>`).join('')}</details>
    <p class="mute">Recommendations are built only from what was read from this computer and from published specifications. Predictions are ranges until the computer is measured; after a part is replaced WorkCare measures again and shows what really changed.</p>`;
  $('#baseline')?.addEventListener('click', async e => { e.target.disabled = true; try { await post(`/api/v1/devices/${id}/upgrades/baseline`); toast('Measurement started. It takes about a minute and needs the computer on mains power.'); } catch (x) { fail(x); e.target.disabled = false; } });
  poll(60000);
}

async function upgradeFleet(main) {
  const f = await api('/api/v1/upgrades/fleet'); const s = await api('/api/v1/upgrades/settings').catch(() => null);
  main.innerHTML = `<h1>Upgrades</h1><p class="lead">What each computer can physically accept. Unverified means unverified.</p>
    ${f.analysed ? `<div class="card"><h2>${f.analysed} computer${f.analysed === 1 ? '' : 's'} analysed${f.withoutReading ? ` · ${f.withoutReading} not read yet` : ''}</h2><div class="facts">${f.categories.map(c => `<div class="fact"><b>${c.count}</b><span>${esc(c.category)}</span></div>`).join('')}</div></div>
      ${f.purchasePlan.length ? `<div class="card"><h2>Purchase plan</h2><table><thead><tr><th>Part</th><th>Computers</th><th>Quantity</th><th>Priority</th><th>Confidence</th></tr></thead><tbody>${f.purchasePlan.map(p => `<tr><td>${esc(p.part)}</td><td>${p.compatibleSystems}</td><td>${p.quantity}</td><td><span class="pill ${UP_CLASS[p.priority][0]}">${esc(UP_CLASS[p.priority][1])}</span></td><td>${upPct(p.confidence)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <h3>Identical computers</h3><table><thead><tr><th>Model</th><th>Count</th><th>Result</th></tr></thead><tbody>${f.groups.map(g => `<tr class="row" data-id="${esc(g.systems[0].deviceId)}"><td>${esc(g.machine)}</td><td>${g.count}</td><td>${esc(g.category)}</td></tr>`).join('')}</tbody></table>
      <h3>Every computer</h3><table><thead><tr><th>Computer</th><th>Best next step</th><th>Opportunity</th></tr></thead><tbody>${f.computers.map(c => `<tr class="row" data-id="${esc(c.deviceId)}"><td><span class="nowrap">${esc(c.hostname)}</span></td><td>${esc(c.best ?? (c.action === 'REPLACE_MACHINE' ? 'Replace the computer' : 'None needed'))}</td><td>${esc(c.grade)}</td></tr>`).join('')}</tbody></table>`
      : emptyState('upgrades', 'No hardware readings yet', 'Each computer sends its full hardware reading once a day. Upgrade advice appears as soon as one arrives.')}
    ${s && can('admin') ? `<div class="card"><h2>Learning from real results</h2><label style="display:flex;gap:10px;align-items:flex-start"><input type="checkbox" id="share" ${s.shareOutcomes ? 'checked' : ''}><span>Let verified upgrade results from this organization improve predictions for other organizations. Only hardware facts are shared (board model, part, measured improvement); never computer names, people or files.</span></label></div>` : ''}`;
  $$('tr.row').forEach(tr => tr.onclick = () => location.hash = '#/upgrades/' + tr.dataset.id);
  $('#share')?.addEventListener('change', async e => { try { await api('/api/v1/upgrades/settings', { method: 'PUT', body: JSON.stringify({ shareOutcomes: e.target.checked }) }); toast(e.target.checked ? 'Verified results will help other organizations.' : 'Results stay within this organization.'); } catch (x) { e.target.checked = !e.target.checked; fail(x); } });
  poll(60000);
}

VIEWS.upgrades = async (main, arg) => arg ? upgradeComputer(main, arg) : upgradeFleet(main);

/* A pointer from the hardware report and from each computer's page. */
EXTRA_DEVICE_HOOKS.push(async (main, d) => {
  const low = $('#care-low'); if (!low) return;
  let box = $('#upgrade-card'); if (!box) { box = document.createElement('div'); box.id = 'upgrade-card'; low.before(box); }
  try {
    const u = await api(`/api/v1/devices/${d.id}/upgrades`);
    const best = u.available ? u.report.recommendations.find(x => x.id === u.report.best) : null;
    box.innerHTML = u.available ? `<div class="card"><div class="toggle-row"><h2 style="margin:0">Upgrade advice</h2><a class="btn sm" href="#/upgrades/${esc(d.id)}">Open</a></div><p style="margin:8px 0 0">${best ? `<b>Best next step:</b> ${esc(best.title)}` : esc(u.report.replacement.text)}</p>${u.report.essentialCount ? `<p class="mute" style="margin:4px 0 0">${u.report.essentialCount} essential item${u.report.essentialCount === 1 ? '' : 's'}</p>` : ''}</div>` : '';
  } catch { box.innerHTML = ''; }
});
