'use strict';
/* Compute sponsorship: dashboard, resource policy, and commercial compliance. */

NAV.splice(NAV.findIndex(n => n[0] === 'reports'), 0, ['compute', 'Compute']);

const STATE_LABEL = { running: 'Contributing', 'user-active': 'User active', 'idle-wait': 'Waiting for idle', 'on-battery': 'On battery', hot: 'Too hot', busy: 'Higher-priority work', 'low-memory': 'Low memory', fullscreen: 'Full-screen app', 'outside-window': 'Outside schedule', 'no-work': 'No workload', 'idle-unknown': 'Activity unknown', disabled: 'Disabled', offline: 'Offline', 'worker-silent': 'Worker not reporting', 'not-eligible': 'Not eligible', paused: 'Paused', 'pool-unreachable': 'Pool blocked' };
const COMPLIANCE_PILL = { ok: 'healthy', grace: 'attention', review: 'attention', 'standard-required': 'critical' };

VIEWS.compute = async main => {
  const [o, comp, pol, sites, ses, maud, consent] = await Promise.all([api('/api/v1/compute/overview'), api('/api/v1/compute/compliance'), api('/api/v1/compute/policy'), api('/api/v1/sites'), api('/api/v1/compute/sessions?limit=20'), api('/api/v1/compute/mining-audit?limit=30'), api('/api/v1/compute/consent').catch(() => null)]);
  const orgPol = pol.policies.find(p => p.scope_type === 'org')?.settings;
  const on = o.plan === 'compute_sponsored';
  const eligPct = o.eligible ? Math.round(o.contributing / o.eligible * 100) : 0;
  const numtile = (ic, n, label) => `<div class="numtile">${icon(ic)}<b>${n}</b><span>${label}</span></div>`;
  const slider = (name, label, min, max, val, unit, hint) => `<div class="slider-field"><div class="top"><label for="f-${name}">${label}</label><output for="f-${name}" data-unit="${unit}">${val}${unit}</output></div><input type="range" id="f-${name}" name="${name}" min="${min}" max="${max}" value="${val}"><small>${hint}</small></div>`;
  const sw = (name, title, hint, checked) => `<label class="switch-field"><span><b>${title}</b><small>${hint}</small></span><input type="checkbox" class="switch" name="${name}" ${checked ? 'checked' : ''}></label>`;
  const bad = comp.plan === 'compute_sponsored' ? comp.devices.filter(d => d.state !== 'ok') : [];
  const stat = (n, label, tone = '') => `<div class="stat-tile ${tone}"><b>${n}</b><span>${label}</span></div>`;
  main.innerHTML = `<div class="page-head"><h1>Compute</h1><span class="pill ${o.status === 'ACTIVE' ? 'healthy' : 'unassessed'}">${esc(o.status === 'ACTIVE' ? 'On' : 'Off')}</span></div>
    <p class="lead">${on ? 'Idle computers contribute spare capacity and stand down the moment a person returns.' : '<b>This organization is on the Standard plan, so compute is off.</b>'}</p>
    ${on && consent && !consent.accepted ? `<div class="card" style="border-color:var(--warn)"><b>Consent needed.</b> <span class="mute">An owner must accept the compute terms before the mining workload can be switched on.</span> <a href="#/settings">Open Settings</a></div>` : ''}
    <div class="stat-tiles">
      ${stat(`${o.contributing} / ${o.eligible}`, 'PCs contributing')}${stat(o.userActive, 'In use by a person')}${stat(o.offline, 'Offline or not reporting', o.offline ? 'warn' : '')}${stat(o.computeHoursThisMonth, 'Compute-hours this month')}
    </div>
    <p class="mute" style="margin:-4px 0 16px">${o.maxCpuPercent == null ? '' : `CPU limit ${o.maxCpuPercent}%. `}Today: ${o.computeHoursToday} compute-hours. Hash rate: ${o.hashRateHps == null ? 'not available (shown while the mining engine runs)' : Math.round(o.hashRateHps).toLocaleString() + ' H/s'}.${Object.keys(o.paused).length ? ' Paused: ' + Object.entries(o.paused).map(([k, v]) => `${esc(STATE_LABEL[k] ?? k)} ${v}`).join(', ') + '.' : ''}</p>
    <div class="card"><h2>Commercial status <span class="pill ${COMPLIANCE_PILL[comp.overall]}">${esc(comp.billingState)}</span></h2>
      ${bad.length ? bad.slice(0, 10).map(d => `<div class="issue"><span class="pts"><span class="pill ${COMPLIANCE_PILL[d.state]}">${esc(d.state)}</span></span><a href="#/computers/${esc(d.deviceId)}">${esc(d.hostname)}</a> <span class="mute">worker silent for ${d.unavailableDays} days while the PC is online</span></div>`).join('') : '<p class="mute" style="margin:0">Every eligible PC reports a running Compute Worker.</p>'}
      <small class="mute">${esc(comp.guarantee)}</small></div>
    ${can('admin') ? `<div class="card"><h2>Resource policy</h2><p class="mute">Organization default${orgPol ? '' : ' (not set: compute is off)'}. Sites and departments can override it.</p>
      <form id="cpform">
        ${sw('enabled', 'Compute is on', 'PCs contribute only when this is on.', orgPol?.enabled)}
        <div class="form-grid">
          ${slider('maxCpuPercent', 'Maximum CPU use', 5, 90, orgPol?.maxCpuPercent ?? 30, '%', 'How much of the processor may be used.')}
          ${slider('startAfterIdleMinutes', 'Start after being idle for', 1, 240, orgPol?.startAfterIdleMinutes ?? 10, ' min', 'Wait this long after the last keystroke.')}
          ${slider('maxTempC', 'Stop above CPU temperature', 40, 95, orgPol?.maxTempC ?? 70, ' °C', 'Pauses when the PC gets this warm.')}
          ${slider('maxMemoryPercent', 'Maximum memory use', 5, 50, orgPol?.maxMemoryPercent ?? 15, '%', 'Share of the PC\'s RAM.')}</div>
        <div class="form-grid">
          ${sw('allowOnBattery', 'Allow on battery', 'Off keeps laptops from draining.', orgPol?.allowOnBattery)}
          ${sw('pauseOnFullscreen', 'Pause for full-screen apps', 'Presentations, video calls and games.', orgPol?.pauseOnFullscreen !== false)}
          <div><label for="f-fallback">Workload</label><select id="f-fallback" name="fallback"><option value="none" ${(orgPol?.fallback ?? 'none') === 'none' ? 'selected' : ''}>None configured</option><option value="selftest" ${orgPol?.fallback === 'selftest' ? 'selected' : ''}>Built-in self-test (validates limits)</option><option value="xmrig" ${orgPol?.fallback === 'xmrig' ? 'selected' : ''}>Mining engine (needs a published engine, pool and payout address)</option></select></div></div>
        <details class="adv"><summary>Only allow at certain times (optional)</summary>
          <p class="mute" style="margin:8px 0 0">Leave empty to allow any time a PC is idle. Advanced format, for example: [{"days":[1,2,3,4,5],"start":"18:00","end":"07:00"}]</p>
          <textarea name="windows" rows="2" spellcheck="false" aria-label="Allowed schedule (JSON)">${esc(orgPol?.windows ? JSON.stringify(orgPol.windows) : '')}</textarea></details>
        <div class="actions"><button>Save organization policy</button></div></form>
      <details><summary>Always enforced</summary><p class="mute">Compute stops within seconds when the user returns and pauses during scans, updates and repairs. People are told once, in plain words, the first time it runs.</p></details>
      ${pol.policies.filter(p => p.scope_type !== 'org').map(p => `<div class="issue"><span class="pts"><a href="#" data-delpol="${esc(p.id)}">remove override</a></span>${esc(p.scope_type)} override: ${esc(sites.sites.flatMap(s => [s, ...s.departments]).find(x => x.id === p.scope_id)?.name ?? p.scope_id)} — ${p.settings.enabled ? 'on' : 'off'}, ${p.settings.maxCpuPercent}% CPU</div>`).join('')}
      <div class="actions"><button class="ghost" id="addoverride">Add site/department override…</button></div></div>` : ''}
    <div class="card"><h2>Mining sessions</h2>${ses.sessions.length ? `<p class="mute">${ses.totals.sessions} sessions in total, ${fmtSecs(ses.totals.runtime_seconds)} of runtime, ${ses.totals.accepted.toLocaleString()} accepted and ${ses.totals.rejected.toLocaleString()} rejected shares${ses.totals.running ? `, ${ses.totals.running} running or not yet closed` : ''}.</p><div class="table-wrap"><table><thead><tr><th>Computer</th><th>Started</th><th>Runtime</th><th class="hide-sm">Avg / peak H/s</th><th>Shares ok / rejected</th><th>Ended</th></tr></thead><tbody>${ses.sessions.map(x => `<tr><td><span class="nowrap">${esc(x.hostname)}</span><br><small class="mute">${esc(x.worker_id)}</small></td><td>${ago(x.started_at)}</td><td>${fmtSecs(x.runtime_seconds)}</td><td class="hide-sm">${x.average_hashrate == null ? '—' : Math.round(x.average_hashrate)} / ${x.peak_hashrate == null ? '—' : Math.round(x.peak_hashrate)}</td><td>${x.accepted_shares} / ${x.rejected_shares}</td><td>${x.stopped_at ? esc(x.stop_reason ?? '') + (x.closed_by === 'server' ? ' <small class="mute">(closed by the server)</small>' : '') : '<span class="pill healthy">running</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mute" style="margin-bottom:0">No mining session has been reported yet. A session appears when a PC actually starts the mining engine.</p>'}</div>
    <div class="card"><h2>Mining change log</h2>${maud.entries.length ? maud.entries.map(e => `<div class="issue"><span class="pts">${e.high_risk ? '<span class="pill critical">high risk</span>' : ''} ${ago(e.at)}</span><b>${esc(e.action)}</b> <span class="mute">by ${esc(e.actor_label ?? e.actor_type)}${e.reasons?.length ? ' — ' + esc(e.reasons.join('; ')) : ''}</span></div>`).join('') : '<p class="mute" style="margin-bottom:0">No changes recorded yet.</p>'}</div>
    <h3>Computers</h3>
    ${o.devices.length ? `<div class="table-wrap"><table><thead><tr><th>Computer</th><th>State</th><th class="hide-sm">Why</th><th>Last report</th></tr></thead><tbody>${o.devices.map(d => `<tr class="row" data-id="${esc(d.deviceId)}"><td><span class="nowrap">${esc(d.hostname)}</span></td><td><span class="pill ${d.status === 'contributing' ? 'healthy' : d.status === 'not-eligible' ? 'unassessed' : d.status === 'offline' || d.status === 'worker-silent' || d.status === 'pool-unreachable' ? 'attention' : 'queued'}">${esc(STATE_LABEL[d.status] ?? d.status)}</span></td><td class="hide-sm">${esc(d.reason ?? '')}</td><td>${ago(d.lastSeen)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="card empty">No computers enrolled yet.</div>'}`;

  $$('input[type=range]').forEach(r => r.oninput = () => { const out = r.closest('.slider-field').querySelector('output'); out.textContent = r.value + out.dataset.unit; });
  $$('tr.row').forEach(tr => tr.onclick = () => location.hash = '#/computers/' + tr.dataset.id);
  const readSettings = f => {
    const v = Object.fromEntries(new FormData(f)); const s = { enabled: v.enabled === 'on', maxCpuPercent: +v.maxCpuPercent, startAfterIdleMinutes: +v.startAfterIdleMinutes, maxTempC: +v.maxTempC, maxMemoryPercent: +v.maxMemoryPercent, allowOnBattery: v.allowOnBattery === 'on', pauseOnFullscreen: v.pauseOnFullscreen === 'on', fallback: v.fallback };
    if (v.windows?.trim()) s.windows = JSON.parse(v.windows);
    if (orgPol?.pool) s.pool = orgPol.pool;          // pool/payout settings are preserved as configured on the server side
    return s;
  };
  $('#cpform')?.addEventListener('submit', async e => { e.preventDefault(); try { await put('/api/v1/compute/policy', { scope: { type: 'org' }, settings: readSettings(e.target) }); toast('Policy saved. PCs pick it up within a minute.'); reroute(); } catch (x) { fail(x); } });
  $$('[data-delpol]').forEach(a => a.onclick = e => { e.preventDefault(); del('/api/v1/compute/policy/' + a.dataset.delpol).then(reroute).catch(fail); });
  $('#addoverride')?.addEventListener('click', async () => {
    const opts = sites.sites.flatMap(s => [`<option value="site:${esc(s.id)}">Site: ${esc(s.name)}</option>`, ...s.departments.map(d => `<option value="department:${esc(d.id)}">Department: ${esc(s.name)} / ${esc(d.name)}</option>`)]);
    const r = await dialog('Policy override', `<label>Applies to</label><select name="scope">${opts.join('')}</select><div class="row2"><div><label>Enabled</label><select name="enabled"><option value="true">Yes</option><option value="false">No (opt out)</option></select></div><div><label>Maximum CPU %</label><input name="cpu" type="number" min="5" max="90" value="20"></div></div><p class="mute">Other settings are inherited from your defaults.</p>`, 'Save override');
    if (!r) return;
    const [type, id] = r.scope.split(':');
    const base = orgPol ?? {}; try { await put('/api/v1/compute/policy', { scope: { type, id }, settings: { ...base, enabled: r.enabled === 'true', maxCpuPercent: +r.cpu } }); reroute(); } catch (x) { fail(x); }
  });
  poll(20000);
};
const fmtSecs = n => { n = Math.round(n ?? 0); return n < 90 ? n + ' s' : n < 5400 ? Math.round(n / 60) + ' min' : (n / 3600).toFixed(1) + ' h'; };
const put = (p, b) => api(p, { method: 'PUT', body: JSON.stringify(b) });
