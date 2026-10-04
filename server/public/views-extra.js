'use strict';
/* Views for security (Viro Shield), Windows updates, drivers, software, and the Command Center. Loaded after app.js. */

const SHIELD = { protected: ['healthy', 'PROTECTED'], attention: ['attention', 'ATTENTION'], 'at-risk': ['critical', 'AT RISK'], unknown: ['unassessed', 'UNKNOWN'] };
const shieldPill = s => `<span class="pill ${SHIELD[s][0]}">${SHIELD[s][1]}</span>`;
const okMark = v => v === true ? '<span style="color:var(--ok)">✓</span>' : v === false ? '<span style="color:var(--bad)">✗</span>' : '<span class="mute">–</span>';

// ---------------------------------------------------------------- Command Center
window.commandCenter = async function (selectedIds = []) {
  const sites = await api('/api/v1/sites');
  const deps = sites.sites.flatMap(s => s.departments.map(d => ({ ...d, site: s.name })));
  const ACTIONS = [
    ['health.check', 'Health check', {}, 'technician'], ['hardware.diagnose', 'Hardware diagnosis', {}, 'technician'], ['cleanup.preview', 'Cleanup scan', {}, 'technician'],
    ['cleanup.run', 'Clean safe cache and temporary files', { categories: SAFE_CLEAN }, 'admin', 'Deletes temporary files, caches and crash dumps. Personal files are never touched.'],
    ['repair.fix-safe', 'Remediate (safe repairs)', {}, 'admin', 'Diagnoses first; only real problems get safe fixes.'],
    ['repair.run:windows.sfc', 'Repair Windows (System File Checker)', { recipe: 'windows.sfc' }, 'admin'], ['repair.run:windows.dism', 'Repair Windows component store (DISM)', { recipe: 'windows.dism' }, 'admin'],
    ['repair.run:services.restart-failed', 'Restart failed services', { recipe: 'services.restart-failed' }, 'admin'],
    ['security.scan', 'Scan security (Defender quick scan)', { scanType: 'quick' }, 'technician'], ['security.update-signatures', 'Update Defender definitions', {}, 'technician'],
    ['updates.scan', 'Check Windows updates and drivers', {}, 'technician'], ['updates.install', 'Install security updates', { scope: 'security' }, 'admin', 'Installs pending security and critical Windows updates. A restart may be needed.'],
    ['software.check-updates', 'Check application updates', {}, 'technician'],
    ['system.reboot', 'Restart (with visible 10-minute countdown)', { delaySeconds: 600 }, 'admin', 'Users see a countdown and can save their work.'],
    ['system.shutdown', 'Shut down (with visible 1-minute countdown)', { delaySeconds: 60 }, 'admin', 'Users see a countdown and can save their work. The PC stays off until someone switches it on.'],
    ['system.reboot-cancel', 'Cancel a pending restart or shut-down', {}, 'admin'],
    ['wake', 'Wake up switched-off computers (Wake-on-LAN)', {}, 'admin', 'Another Viro computer on the same network sends the wake-up signal. This works for computers on a network cable that allow it; Wi-Fi computers usually cannot be woken.'],
    ['repair.run:power.wol-enable', 'Allow this computer to be woken from here (turn on Wake-on-LAN)', { recipe: 'power.wol-enable' }, 'admin', 'Turns on "Wake on Magic Packet" in Windows. The computer\'s BIOS or UEFI setting must also allow it.'],
    ['message.send', 'Send a message to the user', null, 'technician'],
  ].filter(a => can(a[3]));
  const r = await dialog('Command Center', `
    <label>Target</label><select name="target"><option value="selected" ${selectedIds.length ? 'selected' : 'disabled'}>Selected computers (${selectedIds.length})</option>
      <option value="all">Whole organization</option>${sites.sites.map(s => `<option value="site:${esc(s.id)}">Site: ${esc(s.name)}</option>`).join('')}${deps.map(d => `<option value="dep:${esc(d.id)}">Department: ${esc(d.site)} / ${esc(d.name)}</option>`).join('')}</select>
    <label>Action</label><select name="action">${ACTIONS.map(a => `<option value="${esc(a[0])}">${esc(a[1])}</option>`).join('')}</select>
    <label>Message text (for "Send a message")</label><input name="text" maxlength="300" placeholder="Please save your work; we restart PCs at 18:00.">
    <p class="mute">Every action becomes a signed, audited job for each computer.</p>`, 'Run');
  if (!r) return;
  const a = ACTIONS.find(x => x[0] === r.action); const [type] = r.action.split(':');
  let params = a[2];
  if (type === 'message.send') { if (!r.text) return toast('Enter a message'); params = { text: r.text }; }
  if (a[4] && !(await confirmBox(a[1], a[4] + ' Continue?'))) return;
  if (type === 'wake') {
    // Waking is not a job on the sleeping computer: a computer awake on the same network is asked to send the signal, one computer at a time.
    try {
      let ids = r.target === 'selected' ? selectedIds : null;
      if (!ids) { const all = (await api('/api/v1/devices')).devices.filter(d => d.status !== 'online'); ids = all.filter(d => r.target === 'all' || (r.target.startsWith('site:') && d.site_id === r.target.slice(5)) || (r.target.startsWith('dep:') && d.department_id === r.target.slice(4))).map(d => d.id); }
      if (!ids.length) return toast('No switched-off computers in that selection.');
      let sent = 0; const why = [];
      for (const id of ids) { try { await post(`/api/v1/devices/${id}/wake`, {}); sent++; } catch (e) { why.push(e.message); } }
      toast(sent ? `Wake-up sent for ${sent} computer(s). They appear online within a minute or two if they can be woken.` + (why.length ? ` ${why.length} could not be woken: ${why[0]}` : '') : `Nothing could be woken: ${why[0] || 'no reason given'}`);
    } catch (e) { fail(e); }
    return;
  }
  const target = r.target === 'selected' ? { deviceIds: selectedIds } : r.target === 'all' ? { all: true } : r.target.startsWith('site:') ? { siteId: r.target.slice(5) } : { departmentId: r.target.slice(4) };
  try { const x = await runJob(type, params, target); toast(`"${a[1]}" queued on ${x.count} computer(s)`); location.hash = '#/jobs'; } catch (e) { fail(e); }
};

// ---------------------------------------------------------------- Security (Viro Shield)
VIEWS.security = async main => {
  const s = await api('/api/v1/security/overview');
  const secTotal = s.devices.length, secPct = secTotal ? Math.round(s.protected / secTotal * 100) : 0, secCls = !secTotal ? '' : secPct < 50 ? 'critical' : secPct < 100 ? 'attention' : '';
  main.innerHTML = `<h1>Security</h1><p class="lead">Defender and Windows Security status per computer. Viro orchestrates; it is not an antivirus.</p>
    <div class="card"><h2>Protection status</h2><div class="split">
      <div class="gauge ${secCls}" style="--p:${secPct}"><div><strong>${s.protected}</strong><small>of ${secTotal}</small></div></div>
      <div><p style="margin:0 0 8px"><b>${!secTotal ? 'No computers have reported yet.' : s.protected === secTotal ? 'Every computer is protected.' : s.protected + ' of ' + plural(secTotal, 'computer') + ' protected'}</b></p>
        <div class="chips"><span class="pill healthy">${s.protected} protected</span><span class="pill attention">${s.attention} need attention</span><span class="pill critical">${s.atRisk} at risk</span><span class="pill ${s.activeThreats ? 'critical' : 'unknown'}">${s.activeThreats} active threats</span></div></div></div></div>
    <div class="card"><h2>Protection engines</h2><div class="chips">${Object.entries(s.engines).map(([k, v]) => `<span class="tag">${esc(k)}: ${v}</span>`).join('') || '<span class="mute">No data yet.</span>'}</div>
      ${can('technician') && s.devices.length ? `<div class="actions"><button id="scan-risk">Scan the PCs that need attention</button><button class="ghost" id="upd-sig">Update virus definitions everywhere</button></div>` : ''}</div>
    ${s.devices.length ? `<div class="table-wrap"><table><thead><tr><th>Computer</th><th>Shield</th><th>Why</th><th class="hide-sm">Engine</th><th class="hide-sm">Last scan</th></tr></thead><tbody>${s.devices.map(d => `<tr class="row" data-id="${esc(d.id)}"><td><span class="nowrap">${esc(d.hostname)}</span></td><td>${shieldPill(d.state)}</td><td>${d.reasons.map(esc).join('; ') || '<span class="mute">—</span>'}</td><td class="hide-sm">${esc(d.engine)}</td><td class="hide-sm">${ago(d.lastScanAt)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="card empty">No computers have reported yet.</div>'}`;
  $$('tr.row').forEach(tr => tr.onclick = () => location.hash = '#/computers/' + tr.dataset.id);
  $('#scan-risk')?.addEventListener('click', () => { const ids = s.devices.filter(d => d.state !== 'protected').map(d => d.id); if (!ids.length) return toast('Everything is protected'); runJob('security.scan', { scanType: 'quick' }, { deviceIds: ids }).then(r => toast(`Scan queued on ${r.count} computer(s). Third-party antivirus computers will report that they cannot be scanned by Defender.`)).catch(fail); });
  $('#upd-sig')?.addEventListener('click', () => runJob('security.update-signatures', {}, { all: true }).then(r => toast(`Queued on ${r.count} computer(s)`)).catch(fail));
  poll(30000);
};

EXTRA_DEVICE_PANELS.push(d => {
  const sh = d.health?.shield; if (!sh) return '';
  return `<div class="card"><h2>Viro Shield ${shieldPill(sh.state)} <span class="mute">${esc(sh.engine ?? 'no antivirus detected')}</span></h2>
    ${sh.reasons.length ? sh.reasons.map(r => `<div class="issue">${esc(r)}</div>`).join('') : '<p class="mute">Nothing needs attention.</p>'}
    <div class="kv" style="margin-top:12px">${kv('Threats', sh.threats)}${kv('Firewall', sh.firewall)}${kv('Definitions', sh.signatureAgeDays == null ? '—' : sh.signatureAgeDays + ' days old')}${kv('Last scan', sh.lastScanAt ? ago(sh.lastScanAt) : '—')}</div>
    <div class="kv" style="margin-top:10px">${sh.posture.map(p => `<div>${okMark(p.ok)} ${esc(p.label)}</div>`).join('')}</div>
    ${can('technician') ? `<div class="actions"><button class="ghost sm" data-shield="security.scan">Quick scan</button><button class="ghost sm" data-shield="security.update-signatures">Update definitions</button></div>` : ''}
    <span class="mute">Scans and definition updates manage Microsoft Defender only. ✓ ok · ✗ needs action · – could not be read on this PC.</span></div>`;
});
EXTRA_DEVICE_HOOKS.push((main, d, ctx) => {
  $$('[data-shield]').forEach(b => b.onclick = ctx.act(() => runJob(b.dataset.shield, b.dataset.shield === 'security.scan' ? { scanType: 'quick' } : {}, ctx.target)));
});

// ---------------------------------------------------------------- Windows updates
VIEWS.updates = async main => {
  const u = await api('/api/v1/updates/overview');
  const updPct = u.devicesTotal ? Math.round(u.devicesScanned / u.devicesTotal * 100) : 0, updCls = updPct < 50 ? 'attention' : '';
  main.innerHTML = `<h1>Updates</h1><p class="lead">Scan results from ${u.devicesScanned} of ${u.devicesTotal} computers. Drivers are tracked separately.</p>
    <div class="card"><h2>Update status</h2><div class="split"><div class="gauge ${updCls}" style="--p:${updPct}"><div><strong>${u.devicesScanned}</strong><small>of ${u.devicesTotal} scanned</small></div></div>
      <div class="numtiles" style="width:100%"><div class="numtile">${icon('security')}<b style="color:${u.pendingSecurity ? 'var(--bad)' : 'inherit'}">${u.pendingSecurity}</b><span>security updates waiting</span></div><div class="numtile">${icon('updates')}<b>${u.pendingTotal}</b><span>updates waiting (all)</span></div><div class="numtile">${icon('computers')}<b>${u.restartPending.length}</b><span>PCs waiting for a restart</span></div></div></div></div>
    <div class="actions">${can('technician') ? '<button class="ghost" id="scanall">Scan all computers</button>' : ''}${can('admin') ? '<button id="instsec">Install security updates on all PCs</button>' : ''}</div>
    ${u.restartPending.length ? `<div class="card"><h2>Restart required</h2>${u.restartPending.map(r => `<div class="issue"><span class="pts">${can('admin') ? `<button class="sm" data-reboot="${esc(r.device_id)}">Restart (10 min countdown)</button>` : ''}</span><a href="#/computers/${esc(r.device_id)}">${esc(r.hostname)}</a> <span class="mute">since ${ago(r.first_seen_at)}</span></div>`).join('')}</div>` : ''}
    ${u.topUpdates.length ? `<div class="card"><h2>Most widely missing updates</h2>${u.topUpdates.map(t => `<div class="issue"><span class="pts">${plural(t.devices, 'PC')}</span>${esc(t.title)} ${t.security ? '<span class="pill critical">security</span>' : ''}<small>${esc(t.kb)}</small></div>`).join('')}</div>` : ''}
    ${u.devices.length ? `<div class="table-wrap"><table><thead><tr><th>Computer</th><th>Security</th><th>Pending</th><th>Restart</th><th>Scanned</th></tr></thead><tbody>${u.devices.map(d => `<tr class="row" data-id="${esc(d.deviceId)}"><td><span class="nowrap">${esc(d.hostname)}</span></td><td>${d.security ? `<span class="pill critical">${d.security}</span>` : '0'}</td><td>${d.pending}</td><td>${d.rebootRequired ? 'needed' : ''}</td><td>${ago(d.scannedAt)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="card empty">No update scans yet. Scan all computers to see what is pending.</div>'}`;
  $$('tr.row').forEach(tr => tr.onclick = () => location.hash = '#/computers/' + tr.dataset.id);
  $('#scanall')?.addEventListener('click', () => runJob('updates.scan', {}, { all: true }).then(r => toast(`Scan queued on ${r.count} computer(s); refresh in a few minutes`)).catch(fail));
  $('#instsec')?.addEventListener('click', async () => { if (await confirmBox('Install security updates', 'Install pending security and critical Windows updates on ALL computers? A restart may be required afterwards (per your policy).', 'Install')) runJob('updates.install', { scope: 'security' }, { all: true }).then(r => toast(`Queued on ${r.count} computer(s)`)).catch(fail); });
  $$('[data-reboot]').forEach(b => b.onclick = async () => { if (await confirmBox('Restart computer', 'The user sees a 10-minute countdown and can save their work.', 'Restart')) runJob('system.reboot', { delaySeconds: 600 }, { deviceIds: [b.dataset.reboot] }).then(() => toast('Restart scheduled')).catch(fail); });
  poll(30000);
};

// ---------------------------------------------------------------- Drivers (staged rollout)
VIEWS.drivers = async main => {
  const d = await api('/api/v1/drivers/overview');
  const stageBadge = r => `<span class="pill ${r.status === 'halted' ? 'critical' : r.status === 'completed' ? 'healthy' : 'attention'}">${r.status === 'active' ? r.stage.toUpperCase() : r.status.toUpperCase()}</span>`;
  main.innerHTML = `<h1>Drivers</h1><p class="lead">Staged rollouts: test, pilot, fleet. Roll back at any stage.</p>
    <div class="card"><div class="numtiles"><div class="numtile">${icon('drivers')}<b>${d.outdated}</b><span>drivers out of date</span></div><div class="numtile">${icon('alerts')}<b>${d.missing}</b><span>missing drivers</span></div><div class="numtile">${icon('jobs')}<b style="color:${d.failed ? 'var(--bad)' : 'inherit'}">${d.failed}</b><span>devices failing</span></div></div></div>
    ${can('technician') ? '<div class="actions"><button class="ghost" id="scanall">Scan all computers for driver updates</button></div>' : ''}
    ${d.rollouts.length ? `<h3>Rollout pipeline</h3><div class="list">${d.rollouts.map(r => {
      const stages = ['test', 'pilot', 'fleet'], at = r.status === 'completed' ? 3 : stages.indexOf(r.stage) + 1;
      const act = can('admin') && r.status === 'active' ? (r.stage === 'test' ? `<button class="sm" data-adv="${esc(r.id)}" data-to="pilot">Promote to pilot</button>` : r.stage === 'pilot' ? `<button class="sm" data-adv="${esc(r.id)}" data-to="fleet">Promote to fleet</button>` : '') + `<button class="ghost sm" data-halt="${esc(r.id)}">Halt</button>` : '';
      const back = (can('admin') && r.status !== 'active') || r.status === 'completed' ? `<button class="ghost sm danger" data-rollback="${esc(r.id)}">Roll back</button>` : '';
      return `<div class="item ${esc(r.status)}"><div class="main"><b>${esc(r.title)}</b>
        <div class="track" role="img" aria-label="Stage: ${esc(r.status === 'completed' ? 'complete' : r.stage)}">${stages.map((st, i) => `<span class="${i < at ? 'on' : ''} ${r.status === 'halted' && i === at - 1 ? 'stop' : ''}"><i></i>${st}</span>`).join('')}</div>
        <small class="mono">${r.verified}/${r.devices} verified</small>${r.halt_reason ? `<small class="alert-line">${esc(r.halt_reason)}</small>` : ''}</div>
        <div class="side">${stageBadge(r)}${act}${back}</div></div>`;
    }).join('')}</div>` : ''}
    ${d.updates.length ? d.updates.map(u => `<div class="card"><h2>${esc(u.manufacturer ?? '')} ${esc(u.model ?? u.title)}</h2><div class="kv">${kv('Class', u.class)}${kv('Recommended version', u.version)}${kv('Affected PCs', u.devices.length)}</div>
      <p class="mute">${u.devices.slice(0, 8).map(x => esc(x.hostname)).join(', ')}${u.devices.length > 8 ? '…' : ''}</p>
      ${can('admin') ? `<div class="actions"><button class="sm" data-test="${esc(u.id)}">Test on one PC</button></div>` : ''}</div>`).join('') : '<div class="card empty">No pending driver updates reported. Scan computers to check Windows Update for drivers.</div>'}
    ${d.problems.length ? `<div class="card"><h2>Devices with driver problems</h2>${d.problems.map(p => `<div class="issue"><span class="pts">code ${p.code}</span>${esc(p.name)}<small>${p.devices.map(esc).join(', ')}</small></div>`).join('')}</div>` : ''}`;
  $('#scanall')?.addEventListener('click', () => runJob('updates.scan', {}, { all: true }).then(r => toast(`Scan queued on ${r.count} computer(s)`)).catch(fail));
  const byId = Object.fromEntries(d.updates.map(u => [u.id, u]));
  $$('[data-test]').forEach(b => b.onclick = async () => {
    const u = byId[b.dataset.test];
    const r = await dialog('Test on one device', `<p>Pick a low-risk computer. The driver is installed there first and its health is re-checked before anything wider can start.</p><label>Computer</label><select name="dev">${u.devices.map(x => `<option value="${esc(x.deviceId)}">${esc(x.hostname)}</option>`).join('')}</select>`, 'Start test');
    if (r) post('/api/v1/driver-rollouts', { updateId: u.id, deviceId: r.dev }).then(() => { toast('Test install queued'); reroute(); }).catch(fail);
  });
  $$('[data-adv]').forEach(b => b.onclick = async () => { if (await confirmBox(b.dataset.to === 'pilot' ? 'Pilot deploy' : 'Deploy to everyone', 'The previous stage passed its health verification. Continue?', 'Continue')) post(`/api/v1/driver-rollouts/${b.dataset.adv}/advance`, { stage: b.dataset.to }).then(r => { toast(`Started on ${r.devices} computer(s)`); reroute(); }).catch(fail); });
  $$('[data-halt]').forEach(b => b.onclick = () => post(`/api/v1/driver-rollouts/${b.dataset.halt}/halt`).then(reroute).catch(fail));
  $$('[data-rollback]').forEach(b => b.onclick = async () => { if (await confirmBox('Roll back driver', 'Remove the newly installed driver package from every computer that received it. Windows falls back to the previous driver.', 'Roll back', true)) post(`/api/v1/driver-rollouts/${b.dataset.rollback}/rollback`).then(r => { toast(`Rollback queued on ${r.rollbackQueued} computer(s)`); reroute(); }).catch(fail); });
  poll(20000);
};

// ---------------------------------------------------------------- Software
VIEWS.software = async main => {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '').get('q') ?? '';
  const [inv, cat, rules, viol] = await Promise.all([api('/api/v1/software/inventory' + (q ? '?q=' + encodeURIComponent(q) : '')), api('/api/v1/software/catalog'), api('/api/v1/software/rules'), api('/api/v1/software/violations')]);
  main.innerHTML = `<h1>Software</h1><p class="lead">${inv.devices} computers reporting. Only approved packages can be deployed.</p>
    ${viol.violations.length ? `<div class="card"><h2>Policy violations</h2>${viol.violations.map(v => `<div class="issue"><span class="pts">${ago(v.first_seen_at)}</span><a href="#/computers/${esc(v.device_id)}">${esc(v.hostname)}</a>: ${esc(v.message)}</div>`).join('')}</div>` : ''}
    <div class="card"><h2>Approved catalog</h2>${cat.catalog.length ? cat.catalog.map(c => `<div class="issue"><span class="pts">${can('admin') ? `<button class="sm" data-dep="${esc(c.winget_id)}" data-act="software.install">Install…</button> <button class="ghost sm" data-dep="${esc(c.winget_id)}" data-act="software.update">Update…</button> ${c.allow_uninstall ? `<button class="ghost sm danger" data-dep="${esc(c.winget_id)}" data-act="software.uninstall">Uninstall…</button> ` : ''}<a href="#" data-unapprove="${esc(c.id)}">remove</a>` : ''}</span><b>${esc(c.name)}</b> <code>${esc(c.winget_id)}</code>${c.allow_uninstall ? ' <span class="tag">removal allowed</span>' : ''}</div>`).join('') : '<p class="mute">Nothing approved yet.</p>'}
      ${can('admin') ? '<div class="actions"><button class="ghost" id="addcat">Approve an application (winget id)</button></div>' : ''}</div>
    <div class="card"><h2>Rules</h2>${rules.rules.map(r => `<div class="issue"><span class="pts">${can('admin') ? `<a href="#" data-delrule="${esc(r.id)}">delete</a>` : ''}</span>${r.kind === 'prohibited' ? 'Prohibited' : 'Minimum version'}: <b>${esc(r.pattern)}</b>${r.min_version ? ' ≥ ' + esc(r.min_version) : ''}${r.note ? ` <span class="mute">${esc(r.note)}</span>` : ''}</div>`).join('') || '<p class="mute">No rules. Add prohibited software or minimum versions to get alerts.</p>'}
      ${can('admin') ? '<div class="actions"><button class="ghost" id="addrule">Add rule</button></div>' : ''}</div>
    <h3>Installed applications</h3><div class="bar-tools"><input id="sq" placeholder="Search applications" value="${esc(q === '' ? '' : q)}"></div>
    ${inv.applications.length ? `<div class="table-wrap"><table><thead><tr><th>Application</th><th>Computers</th><th>Versions</th></tr></thead><tbody>${inv.applications.slice(0, 150).map(a => `<tr><td>${esc(a.name)}<small>${esc(a.publisher)}</small></td><td>${a.devices}</td><td>${a.versions.slice(0, 4).map(v => `<span class="tag">${esc(v.version)} ×${v.devices}</span>`).join('')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="card empty">No inventory yet.</div>'}`;
  $('#sq').onkeydown = e => { if (e.key === 'Enter') location.hash = '#/software' + (e.target.value ? '?q=' + encodeURIComponent(e.target.value) : ''); };
  $('#addcat')?.addEventListener('click', async () => { const r = await dialog('Approve an application', '<label>Name</label><input name="name" required><label>winget package id</label><input name="wingetId" placeholder="Mozilla.Firefox" required><label><input type="checkbox" name="allowUninstall" value="1" style="width:auto"> Allow remote removal</label>', 'Approve'); if (r) post('/api/v1/software/catalog', { name: r.name, wingetId: r.wingetId, allowUninstall: !!r.allowUninstall }).then(reroute).catch(fail); });
  $$('[data-unapprove]').forEach(a => a.onclick = e => { e.preventDefault(); del('/api/v1/software/catalog/' + a.dataset.unapprove).then(reroute).catch(fail); });
  $('#addrule')?.addEventListener('click', async () => { const r = await dialog('Add software rule', '<label>Type</label><select name="kind"><option value="prohibited">Prohibited software</option><option value="min_version">Minimum version</option></select><label>Application name contains</label><input name="pattern" required><label>Minimum version (for minimum-version rules)</label><input name="minVersion" placeholder="120.0"><label>Note</label><input name="note">', 'Add'); if (r) post('/api/v1/software/rules', { kind: r.kind, pattern: r.pattern, minVersion: r.minVersion || undefined, note: r.note || undefined }).then(reroute).catch(fail); });
  $$('[data-delrule]').forEach(a => a.onclick = e => { e.preventDefault(); del('/api/v1/software/rules/' + a.dataset.delrule).then(reroute).catch(fail); });
  $$('[data-dep]').forEach(b => b.onclick = async () => {
    const sites = await api('/api/v1/sites');
    const r = await dialog(`${b.dataset.act.split('.')[1]} ${b.dataset.dep}`, `<label>Where</label><select name="t"><option value="all">Whole organization</option>${sites.sites.map(s => `<option value="s:${esc(s.id)}">Site: ${esc(s.name)}</option>`).join('')}</select>`, 'Queue', b.dataset.act === 'software.uninstall');
    if (r) runJob(b.dataset.act, { wingetId: b.dataset.dep }, r.t === 'all' ? { all: true } : { siteId: r.t.slice(2) }).then(x => toast(`Queued on ${x.count} computer(s)`)).catch(fail);
  });
};

// Add scheduling options for the new safe jobs to the policy editor.
SCHEDULABLE.push(['security.scan', { scanType: 'quick' }, 'Security quick scan'], ['security.update-signatures', {}, 'Update Defender definitions'], ['updates.scan', {}, 'Windows update scan'],
  ['updates.install', { scope: 'security' }, 'Install security updates'], ['software.check-updates', {}, 'Check application updates'], ['repair.run', { recipe: 'windows.sfc' }, 'System File Checker']);
