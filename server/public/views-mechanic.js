'use strict';
/* Outcomes and care: what Viro achieved this month (real records only), heat / memory / start-up / battery results, and what it did on each computer. */

NAV.splice(NAV.findIndex(n => n[0] === 'threats') + 1 || NAV.findIndex(n => n[0] === 'reports'), 0, ['care', 'Care']);

const fmtSec = s => s == null ? '—' : s >= 120 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`;
const fmtMin = m => m == null ? '—' : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;

function outcomeTiles(o) {
  const rows = [
    [o.verifiedRepairs, 'verified repairs'], [o.recurringCrashProblemsStopped, 'recurring crash problems stopped'], [o.malwareIncidentsRemoved, 'malware incidents removed'], [o.ransomwareContained, 'ransomware incidents contained'],
    [o.storageRecoveredGb, 'GB of storage recovered'], [o.driverIssuesResolved, 'driver issues resolved'], [o.failingDrivesDetected, 'failing drives detected early'], [o.batteryProblemsIdentified, 'battery problems identified'],
    [o.thermalEvents, 'heat events handled'], [o.memoryReclaimedGb, 'GB of memory given back by idle programs'], [o.hardwareUpgradesRecommended, 'computers where a hardware upgrade is advised'], [o.windowsUpdatesInstalled, 'Windows updates installed'],
  ].filter(([v]) => v > 0);
  return rows.length ? `<div class="facts">${rows.map(([v, l]) => `<div><b>${esc(String(v))}</b><span>${esc(l)}</span></div>`).join('')}</div>` : '<p class="mute">Nothing recorded yet. Figures appear only after Viro has done the work and checked it.</p>';
}

VIEWS.care = async main => {
  const [o, c] = await Promise.all([api('/api/v1/outcomes/month'), api('/api/v1/care/overview')]);
  main.innerHTML = `<div class="page-head"><h1>Care</h1></div><p class="lead">Heat, memory, start-up and battery: what was measured, what was done. Last 30 days.</p>
    <div class="card"><h2>Outcomes · last 30 days</h2>${outcomeTiles(o)}</div>
    <div class="card"><h2>Heat</h2><div class="facts"><div><b>${c.heat.events30d}</b><span>heat events</span></div><div><b>${c.heat.critical}</b><span>critical</span></div><div><b>${c.heat.devices}</b><span>computers affected</span></div><div><b>${c.heat.coolingSuspected}</b><span>with a suspected cooling problem</span></div></div>
      <details><summary>How it works</summary><p class="mute">When a PC gets too hot Viro stops background compute and optional work first, warns the person, and only suspects a cooling fault when the PC stays hot while mostly idle.</p></details></div>
    <div class="card"><h2>Memory</h2><div class="facts"><div><b>${(c.memory.reclaimedMb / 1024).toFixed(1)} GB</b><span>given back by idle programs</span></div><div><b>${c.memory.trims30d}</b><span>clean-ups</span></div><div><b>${c.memory.devices}</b><span>computers</span></div></div>
      <details><summary>How it works</summary><p class="mute">Viro lets Windows take back memory from idle programs. It never closes a program that may hold unsaved work, and it cannot keep memory low while someone is actively using the PC.</p></details></div>
    <div class="card"><h2>Start-up time</h2>${c.startup.devicesMeasured ? `<div class="facts"><div><b>${c.startup.avgSecondsSaved} s</b><span>average saved per computer</span></div><div><b>${c.startup.improved}</b><span>computers faster</span></div><div><b>${c.startup.devicesMeasured}</b><span>measured after a restart</span></div></div>` : '<p class="mute">No start-up improvement has been measured yet. The result is measured at the first restart after the change.</p>'}</div>
    <div class="card"><h2>Battery</h2><div class="facts"><div><b>${c.battery.devicesReporting}</b><span>laptops reporting</span></div><div><b>${c.battery.degraded}</b><span>with a worn battery (under 70%)</span></div></div></div>`;
};

// Computer page: care results and "What Viro did" under the existing page.
const computersBase = VIEWS.computers;
VIEWS.computers = async (main, id) => {
  await computersBase(main, id);
  if (!id) return;
  try {
    const [care, tl] = await Promise.all([api(`/api/v1/devices/${id}/care`), api(`/api/v1/devices/${id}/what-viro-did`)]);
    const el = document.createElement('div');
    const b = care.battery, bc = care.bootComparison;
    el.innerHTML = `<div class="card"><h2>Care</h2>
      ${care.thermal.length ? `<h3>Heat</h3>${care.thermal.slice(0, 5).map(t => `<div class="issue"><span class="pts">${esc(new Date(t.at).toLocaleString())}</span><span>${esc(t.level)} at ${Math.round(t.temperature_c ?? 0)}°C · compute ${esc(t.compute_state ?? '?')}${t.cooling_suspected ? ' · <b>cooling problem suspected</b>' : ''}${t.recovered_at ? ' · recovered' : ''}</span></div>`).join('')}` : '<p class="mute">No heat events recorded.</p>'}
      ${bc ? `<h3>Start-up time</h3><p>${bc.afterSeconds == null ? esc(bc.note ?? 'Measured at the next restart.') : `${fmtSec(bc.beforeSeconds)} before, ${fmtSec(bc.afterSeconds)} after (${bc.improvementPercent}% ${bc.improvementPercent >= 0 ? 'faster' : 'slower'}, measured over ${bc.restartsMeasured} restart${bc.restartsMeasured === 1 ? '' : 's'}).`}</p>` : (care.boots.length ? `<h3>Start-up time</h3><p>Last start-up: ${fmtSec(care.boots[0].seconds)}.</p>` : '')}
      ${b.hasData ? `<h3>Battery</h3><p>${b.health != null ? `Health ${b.health}% (${b.fullChargeWh} of ${b.designWh} Wh). ` : ''}${b.runtime ? `Measured runtime about ${fmtMin(b.runtime.typicalMinutes)} from a full charge, from ${b.runtime.periods} discharge period${b.runtime.periods === 1 ? '' : 's'}.` : 'Not enough discharge data yet to measure runtime.'}</p>
        ${b.causes.length ? `<ol>${b.causes.map(x => `<li><b>${esc(x.cause)}</b> · ${esc(x.impact)} impact, ${esc(x.confidence)} confidence<br><span class="mute">${esc(x.evidence)}${x.action ? ' → ' + esc(x.action) : ''}</span></li>`).join('')}</ol>` : ''}
        ${can('technician') ? '<div class="actions"><button class="sm" data-batdiag>Diagnose battery drain</button></div>' : ''}` : ''}</div>
      <div class="card"><h2>What Viro did</h2>${tl.items.length ? tl.items.slice(0, 25).map(i => `<div class="issue"><span class="pts">${esc(new Date(i.at).toLocaleDateString())}</span><span><b>${esc(i.title)}</b>${i.detail ? `<br><span class="mute">${esc(i.detail)}</span>` : ''}</span></div>`).join('') : '<p class="mute">Nothing yet.</p>'}</div>`;
    main.appendChild(el);
    renderStartupManager(main, id);
    renderStorageTools(main, id);
    $('[data-batdiag]', el)?.addEventListener('click', () => post(`/api/v1/devices/${id}/battery/diagnose`).then(() => toast('Battery diagnosis started. Results appear here when the PC reports back.')).catch(fail));
  } catch { /* the page still works without it */ }
};

// Start-up manager: every program that starts with Windows, what Viro thinks of it, how long Windows measured it adding to start-up, and one-click, reversible control.
const STARTUP_CLASS = { SAFE_TO_DISABLE: ['healthy', 'Safe to stop'], KEEP: ['unknown', 'Kept (security, hardware, sync)'], ASK: ['attention', 'Your decision'] };
async function renderStartupManager(main, id) {
  let d; try { d = await api('/api/v1/devices/' + id); } catch { return; }
  const items = d.startupManager ?? []; if (!items.length) return;
  const card = document.createElement('div'); card.className = 'card';
  const on = items.filter(i => i.enabled).length, measured = items.some(i => i.delaySeconds != null);
  card.innerHTML = `<h2>Start-up programs</h2><div class="mute">${on} of ${items.length} start with Windows. Nothing is uninstalled; every change can be reversed here.${measured ? ' The delay is what Windows itself measured at the last start-up.' : ''}</div>
    <table><thead><tr><th></th><th>Program</th><th>Viro's advice</th><th>Delay</th><th>Now</th></tr></thead><tbody>${items.map((i, n) => `<tr title="${esc(i.command ?? '')}">
      <td><input type="checkbox" data-su="${n}" aria-label="Select ${esc(i.name)}"></td><td>${esc(i.name)}</td>
      <td><span class="pill ${STARTUP_CLASS[i.cls]?.[0] ?? 'unknown'}" title="${esc(i.reason ?? '')}">${esc(STARTUP_CLASS[i.cls]?.[1] ?? i.cls)}</span></td>
      <td>${i.delaySeconds == null ? '—' : '+' + Math.round(i.delaySeconds) + ' s'}</td><td>${i.enabled ? 'Starts with Windows' : 'Off'}</td></tr>`).join('')}</tbody></table>
    ${can('admin') ? `<div class="actions"><button class="sm ghost" data-su-safe>Select the safe ones</button><button class="sm" data-su-off>Stop selected from starting</button><button class="sm ghost" data-su-on>Let selected start again</button></div>` : ''}`;
  main.appendChild(card);
  const picked = () => $$('[data-su]', card).filter(c => c.checked).map(c => items[+c.dataset.su]);
  $('[data-su-safe]', card)?.addEventListener('click', () => $$('[data-su]', card).forEach(c => { const i = items[+c.dataset.su]; c.checked = i.enabled && i.cls === 'SAFE_TO_DISABLE'; }));
  const go = (recipe, verb, want) => async () => {
    const sel = picked().filter(i => i.enabled === want).map(i => ({ location: i.location, name: i.name }));
    if (!sel.length) return fail(new Error(want ? 'select at least one program that starts with Windows' : 'select at least one program that is turned off'));
    if (!(await confirmBox(verb, `${verb} for ${sel.length} program${sel.length === 1 ? '' : 's'}? Nothing is deleted. You can reverse this here.`, verb))) return;
    try { await post('/api/v1/jobs', { type: 'repair.run', params: { recipe, approved: true, options: { entries: sel } }, target: { deviceIds: [id] } }); toast('Queued. The list updates at the next report from the PC.'); } catch (x) { fail(x); }
  };
  $('[data-su-off]', card)?.addEventListener('click', go('startup.disable', 'Stop from starting', true));
  $('[data-su-on]', card)?.addEventListener('click', go('startup.enable', 'Let start again', false));
}

// Storage: the one-click safe clean only removes files older than two days. Say so, and offer the stronger, approved option.
function renderStorageTools(main, id) {
  if (!can('admin')) return;
  const card = document.createElement('div'); card.className = 'card';
  card.innerHTML = `<h2>Storage</h2><p class="mute">"Clean safe files" removes temporary files and caches that are more than two days old. Programs and tests create a lot of temporary files that are newer than that. This removes those too: every temporary file that is not in use and has not changed in the last hour. Personal files are never touched.</p>
    <div class="actions"><button class="sm" data-free-more>Free more space</button></div>`;
  main.appendChild(card);
  $('[data-free-more]', card).addEventListener('click', async () => {
    if (!(await confirmBox('Free more space', 'Delete temporary files from the last two days that are not in use and have not changed in the last hour? Nothing in Documents, Desktop, Downloads, Pictures, Videos or OneDrive is touched.', 'Free space', true))) return;
    try { await post('/api/v1/jobs', { type: 'cleanup.run', params: { categories: ['recent-temp'], approveReview: true }, target: { deviceIds: [id] } }); toast('Cleaning started. The result appears in Recent jobs.'); } catch (x) { fail(x); }
  });
}
