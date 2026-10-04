'use strict';
/* Autopilot: the "everything is handled" page. One plain-language summary, what was done automatically, and the short list that needs a person. */

NAV.splice(NAV.findIndex(n => n[0] === 'overview') + 1, 0, ['autopilot', 'Autopilot']);

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const AUTO_LABEL = { 'updates.install': 'Installed updates', 'repair.run': 'Repaired', 'cleanup.run': 'Cleaned temporary files', 'hardware.diagnose': 'Checked hardware', 'security.update-signatures': 'Updated virus definitions', 'security.scan': 'Scanned for threats', 'system.reboot': 'Restarted', 'driver.install': 'Updated a driver' };

const LEVELS = {
  OBSERVE: ['Observe only', 'Autopilot checks every computer and tells you what it finds, but changes nothing.'],
  SAFE: ['Safe', 'Autopilot fixes only low-risk problems by itself: temporary files, stopped services, virus definitions.'],
  BALANCED: ['Balanced (recommended)', 'Safe fixes plus controlled repairs such as Office Quick Repair and Windows file checks, each verified afterwards. Heavy repairs wait for the maintenance window.'],
  AGGRESSIVE: ['Aggressive', 'Balanced plus reversible Windows Update repair, retried more often. It never does anything that cannot be undone.'],
};
const STANCE_LABEL = { working: 'Working on it', 'will-fix': 'Will fix next', 'waiting-window': 'Waiting for the maintenance window', observing: 'Watching for a return' };

/** What Autopilot is doing right now, in priority order. */
function nowCard(act) {
  const row = i => `<div class="issue"><span class="pts"><span class="pill unknown">${esc(i.priority)}</span></span><a href="#/computers/${esc(i.deviceId)}">${esc(i.hostname)}</a>: ${esc(i.title)}<small>${esc(i.note)}</small></div>`;
  const groups = [['working', act.working], ['will-fix', act.willFix], ['waiting-window', act.waiting]].filter(([, l]) => l.length);
  if (!groups.length && !act.observing.length) return '';
  return `<div class="card"><h2>What Autopilot is doing now</h2>${groups.map(([k, l]) => `<h3>${esc(STANCE_LABEL[k])} (${l.length})</h3>${l.slice(0, 6).map(row).join('')}`).join('')}${act.observing.length ? `<p class="mute" style="margin:10px 0 0">${act.observing.length} repaired problem${act.observing.length === 1 ? ' is' : 's are'} being watched to make sure ${act.observing.length === 1 ? 'it does' : 'they do'} not come back.</p>` : ''}</div>`;
}

VIEWS.autopilot = async main => {
  const [a, s, act] = await Promise.all([api('/api/v1/autopilot'), api('/api/v1/summary'), api('/api/v1/autopilot/activity').catch(() => null)]);
  const on = a.exists && a.enabled;
  const done = s.done, pcs = s.pcs, healthyPct = pcs.total ? Math.round(pcs.healthy / pcs.total * 100) : 0;
  const gStatus = !pcs.total ? '' : healthyPct < 50 ? 'critical' : healthyPct < 80 ? 'attention' : '';
  const anyDone = done.securityUpdatesInstalled || done.repairsFixed || done.cleanedMb || done.restarts || done.driverUpdates;
  const tile = (ic, n, label) => `<div class="numtile">${icon(ic)}<b>${n}</b><span>${label}</span></div>`;
  const sev = { critical: 'Critical', warning: 'Review soon' };
  const needs = s.needsYou, shown = needs.slice(0, 4), rest = needs.slice(4);
  const needItem = n => `<div class="item"><span class="pill ${esc(n.severity)}">${esc(sev[n.severity] ?? n.severity)}</span><div><a href="#/computers/${esc(n.deviceId)}">${esc(n.hostname)}</a><small>${esc(n.message)}</small></div></div>`;
  const heroText = !a.exists ? 'Autopilot is not configured. Turn it on and computers patch, repair and clean themselves.' : on ? 'Computers are self-maintaining. You are alerted only when a person is needed.' : 'Autopilot is off. Nothing runs automatically.';

  main.innerHTML = `<div class="card ap-hero ${on ? 'on' : ''}">
      <div class="ap-orb">${icon('autopilot')}</div>
      <div><h1>Autopilot ${on ? 'on' : 'off'}</h1><p>${esc(heroText)}</p>
        <p style="margin-top:8px;color:var(--ink)"><b>${esc(s.headline)}</b></p></div>
      <div class="ap-switch"><input type="checkbox" class="switch" id="aptoggle" aria-label="Autopilot" ${on ? 'checked' : ''} ${can('admin') ? '' : 'disabled'}><span>${can('admin') ? (on ? 'Turn off' : 'Turn on') : 'Administrators only'}</span></div></div>
    <div class="dash">
      <div class="card"><h2>Last 7 days</h2>
        ${anyDone ? '' : '<p class="mute" style="margin-top:0">No actions were needed this week.</p>'}
        <div class="numtiles">${tile('security', done.securityUpdatesInstalled, 'security updates')}${tile('jobs', done.repairsFixed, done.repairsFixed === 1 ? 'problem fixed' : 'problems fixed')}${tile('reports', (done.cleanedMb / 1024).toFixed(1) + ' GB', 'cleaned up')}${tile('updates', done.restarts, done.restarts === 1 ? 'restart' : 'restarts')}${tile('drivers', done.driverUpdates, 'driver updates')}</div></div>
      <div class="card"><h2>Overall health</h2><div class="split">
        <div class="gauge ${gStatus}" style="--p:${healthyPct}"><div><strong>${pcs.healthy}</strong><small>of ${pcs.total}</small></div></div>
        <div><p style="margin:0 0 8px"><b>${healthyPct}% of computers verified healthy</b></p>
          <div class="chips"><span class="pill healthy">${pcs.healthy} healthy</span><span class="pill attention">${pcs.attention} need attention</span>${pcs.critical ? `<span class="pill critical">${pcs.critical} urgent</span>` : ''}${pcs.notReporting ? `<span class="pill unknown">${pcs.notReporting} not reporting</span>` : ''}</div></div></div></div>
    ${act ? nowCard(act) : ''}
    <div class="card needs"><h2>${needs.length ? (needs.length === 1 ? '1 item needs an operator' : needs.length + ' items need an operator') : 'Needs an operator'}</h2>
      ${needs.length ? shown.map(needItem).join('') + (rest.length ? `<details class="more-list"><summary>Show ${rest.length} more</summary>${rest.map(needItem).join('')}</details>` : '')
        : `<div class="allgood">${icon('security')}<div><b>No open items.</b><div class="mute">Standing watch.</div></div></div>`}</div>
    <div class="card timeline"><h2>Auto-remediation log</h2>${a.recent.length ? a.recent.map(r => `<div class="item"><span class="pill ${esc(r.status)}">${esc(r.status)}</span><div>${esc(AUTO_LABEL[r.type] ?? r.type)} on ${esc(r.hostname)}${r.outcome ? `<small>${esc(r.outcome)}</small>` : ''}</div><span class="when">${ago(r.created_at)}</span></div>`).join('') : '<p class="mute" style="margin:0">Nothing yet. Autopilot works in the maintenance window and when it finds a problem it can safely fix.</p>'}</div>
    <div class="card"><h2>Settings</h2><details><summary>What Autopilot does</summary><ul class="steps" style="margin-top:10px">${a.does.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>
      ${a.exists ? `<p class="mute">Maintenance window (each PC's organization time): ${a.window.days.length === 7 ? 'every night' : a.window.days.map(d => DAY_NAMES[d]).join(', ')} ${esc(a.window.start)}–${esc(a.window.end)}.</p>` : '<p class="mute">Autopilot is not set up for this organization yet.</p>'}
      ${a.exists ? `<h3>How much Autopilot may do by itself</h3><select id="aplevel" aria-label="Autopilot level" ${can('admin') ? '' : 'disabled'}>${Object.entries(LEVELS).map(([k, v]) => `<option value="${k}" ${a.level === k ? 'selected' : ''}>${esc(v[0])}</option>`).join('')}</select><p class="mute" style="margin:6px 0 0">${esc((LEVELS[a.level] ?? LEVELS.BALANCED)[1])}</p>` : ''}
      ${can('admin') ? `<div class="actions">${a.exists ? '<button class="ghost" id="apwindow">Change maintenance window…</button>' : ''}</div>` : ''}</div>`;

  $('#aplevel')?.addEventListener('change', async e => {
    try { await api('/api/v1/autopilot', { method: 'PUT', body: JSON.stringify({ level: e.target.value }) }); toast('Autopilot level changed.'); reroute(); } catch (x) { fail(x); reroute(); }
  });

  $('#aptoggle')?.addEventListener('change', async e => {
    try { await api('/api/v1/autopilot', { method: 'PUT', body: JSON.stringify({ enabled: e.target.checked }) }); toast(e.target.checked ? 'Autopilot is on.' : 'Autopilot is off. Nothing will run automatically.'); reroute(); } catch (x) { e.target.checked = !e.target.checked; fail(x); }
  });
  $('#apwindow')?.addEventListener('click', async () => {
    const v = await dialog('Maintenance window', `<p class="mute">Updates and restarts happen only inside this window. Restarts always show a 10-minute countdown.</p>
      <label>Days</label><select name="days"><option value="0,1,2,3,4,5,6" ${a.window.days.length === 7 ? 'selected' : ''}>Every night</option><option value="1,2,3,4,5" ${a.window.days.join() === '1,2,3,4,5' ? 'selected' : ''}>Weeknights (Mon–Fri)</option><option value="0,6" ${a.window.days.join() === '0,6' ? 'selected' : ''}>Weekends only</option></select>
      <div class="row2"><div><label>From</label><input name="start" type="time" value="${esc(a.window.start)}" required></div><div><label>Until</label><input name="end" type="time" value="${esc(a.window.end)}" required></div></div>`, 'Save');
    if (!v) return;
    try { await api('/api/v1/autopilot', { method: 'PUT', body: JSON.stringify({ window: { days: v.days.split(',').map(Number), start: v.start, end: v.end } }) }); toast('Maintenance window saved.'); reroute(); } catch (x) { fail(x); }
  });
  poll(30000);
};
