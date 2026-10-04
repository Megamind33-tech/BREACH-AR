'use strict';
/* Fleet intelligence: problems that affect many computers and what they have in common, staged repair, and how each site, department and model is doing. */

NAV.splice(NAV.findIndex(n => n[0] === 'reports'), 0, ['fleet', 'Fleet']);

const FLEET_STATUS = { DETECTED: ['attention', 'New'], REMEDIATING: ['running', 'Being repaired'], REMEDIATED: ['healthy', 'Repaired'], FLAGGED: ['critical', 'Repair halted'] };
const ROLL_STATUS = { verified: ['healthy', 'Verified'], installed: ['running', 'Checking'], queued: ['attention', 'Waiting'], failed: ['critical', 'Did not work'], rolled_back: ['unknown', 'Rolled back'] };
const FCONF = { HIGH: 'High confidence', MEDIUM: 'Medium confidence', LOW: 'Low confidence' };
const FLEET_KPI = [['verifiedFixRate', 'Verified fix rate', v => v + '%'], ['recurrenceRate', 'Came back after a fix', v => v + '%'], ['automaticResolutionRate', 'Fixed by Autopilot', v => v + '%'], ['meanTimeToHealthHours', 'Average time to healthy', v => v + ' h']];

VIEWS.fleet = async main => {
  const by = new URLSearchParams(location.hash.split('?')[1] ?? '').get('by') || 'site';
  const [p, ro, bd, oc] = await Promise.all([api('/api/v1/fleet/patterns'), api('/api/v1/fix-rollouts'), api('/api/v1/fleet/breakdown?by=' + by), api('/api/v1/outcomes?days=30').catch(() => null)]);
  const active = ro.rollouts.filter(r => r.status === 'active');
  main.innerHTML = `<h1>Shared problems</h1><p class="lead">Faults hitting many computers at once, and what those computers share. Remediation goes to one computer, then a small group, then everyone, with a check at each step.</p>
    ${oc?.kpis && Object.values(oc.kpis).some(v => v != null) ? `<div class="card"><h2>Results <span class="mute">· last 30 days</span></h2><div class="facts">${FLEET_KPI.filter(([k]) => oc.kpis[k] != null).map(([k, l, f]) => `<div class="fact"><b>${esc(f(oc.kpis[k]))}</b><span>${esc(l)}</span></div>`).join('')}</div></div>` : ''}
    <h3>Shared problems</h3>
    ${p.patterns.length ? p.patterns.map(x => `<div class="card"><div class="toggle-row"><h2 style="margin:0">${esc(x.title)}</h2><span class="pill ${FLEET_STATUS[x.status]?.[0] ?? 'unknown'}">${esc(FLEET_STATUS[x.status]?.[1] ?? x.status)}</span></div>
        <p style="margin:8px 0 4px">${esc(x.explanation)}</p><p class="mute" style="margin:0">${esc(FCONF[x.confidence])} · ${x.affected} of ${x.fleetSize} computers</p>
        ${x.factors.length ? `<details><summary>What they have in common</summary>${x.factors.map(f => `<div class="issue"><span class="pts">${Math.round(f.affectedShare * 100)}% of affected${f.fleetShare ? ` vs ${Math.round(f.fleetShare * 100)}% of the fleet` : ''}</span>${esc(({ model: 'Model', osBuild: 'Windows build', site: 'Site', department: 'Department', agentVersion: 'Agent version', appVersion: 'Application version', module: 'Faulting module', cause: 'Cause', driverDevice: 'Device' })[f.factor] ?? f.factor)}: <b>${esc(f.value)}</b></div>`).join('')}</details>` : ''}
        ${x.recommendation && !x.fix ? `<p class="mute" style="margin:8px 0 0">${esc(x.recommendation)}</p>` : ''}
        <div class="actions">${x.fix && can('admin') && ['DETECTED', 'FLAGGED'].includes(x.status) ? `<button data-remediate="${esc(x.id)}">Test the fix on one computer</button>` : ''}${can('admin') && x.status !== 'REMEDIATING' ? `<button class="ghost sm" data-dismiss="${esc(x.id)}">Dismiss</button>` : ''}</div></div>`).join('')
      : emptyState('security', 'No shared problems', 'Viro looks for the same problem on several computers and tells you what they have in common. Nothing like that is happening now.')}
    ${ro.rollouts.length ? `<h3>Repairs in stages</h3>${ro.rollouts.slice(0, 6).map(r => `<div class="card" data-roll="${esc(r.id)}"><div class="toggle-row"><h2 style="margin:0">${esc(r.title)}</h2><span class="pill ${r.status === 'active' ? 'running' : r.status === 'completed' ? 'healthy' : 'critical'}">${esc(r.status === 'active' ? 'In progress: ' + r.stage : r.status === 'completed' ? 'Complete' : 'Halted')}</span></div>
        <p class="mute" style="margin:6px 0 0">${r.verified} of ${r.devices} computers repaired and verified${r.halt_reason ? ` · ${esc(r.halt_reason)}` : ''}</p><div class="rolldetail"></div>
        ${r.status === 'active' && can('admin') ? `<div class="actions">${r.stage === 'test' ? `<button class="sm" data-advance="${esc(r.id)}" data-stage="pilot">Repair a pilot group</button>` : r.stage === 'pilot' ? `<button class="sm" data-advance="${esc(r.id)}" data-stage="fleet">Repair everyone else</button>` : ''}<button class="ghost sm" data-halt="${esc(r.id)}">Stop</button></div>` : ''}</div>`).join('')}` : ''}
    <h3>By ${by === 'site' ? 'site' : by === 'department' ? 'department' : by === 'model' ? 'computer model' : 'Windows version'}</h3>
    <div class="bar-tools">${[['site', 'Site'], ['department', 'Department'], ['model', 'Model'], ['os', 'Windows']].map(([k, l]) => `<a class="btn sm ${k === by ? '' : 'ghost'}" ${k === by ? 'aria-current="page"' : ''} href="#/fleet?by=${k}">${l}</a>`).join('')}</div>
    ${bd.groups.length ? `<table><thead><tr><th>${esc(by === 'os' ? 'Windows' : by[0].toUpperCase() + by.slice(1))}</th><th>Computers</th><th>Average health</th><th>With problems</th><th>Need hardware</th></tr></thead><tbody>${bd.groups.map(g => `<tr><td>${esc(g.group)}</td><td>${g.devices}</td><td>${g.averageHealth ?? '—'}</td><td>${g.withProblems ? `<span class="pill attention">${g.withProblems}</span>` : 0}</td><td>${g.hardwareAction ? `<span class="pill critical">${g.hardwareAction}</span>` : 0}</td></tr>`).join('')}</tbody></table>` : emptyState('computers', 'No computers yet', 'Add computers and Viro will group them here.')}`;

  for (const card of $$('[data-roll]')) api('/api/v1/fix-rollouts/' + card.dataset.roll).then(v => {
    $('.rolldetail', card).innerHTML = v.devices.map(d => `<div class="issue"><span class="pts"><span class="pill ${ROLL_STATUS[d.status]?.[0] ?? 'unknown'}">${esc(ROLL_STATUS[d.status]?.[1] ?? d.status)}</span></span>${esc(d.hostname)} <span class="mute">${esc(d.stage)}</span>${d.detail && d.status === 'failed' ? `<small>${esc(d.detail)}</small>` : ''}</div>`).join('');
  }).catch(() => {});
  $$('[data-remediate]').forEach(b => b.onclick = async () => {
    if (!(await confirmBox('Test the fix', 'Viro will repair one affected computer, check that the problem is really gone there, and only then offer to repair a small group and then the rest. Nothing else is touched until you say so.', 'Start with one computer'))) return;
    try { await post(`/api/v1/fleet/patterns/${b.dataset.remediate}/remediate`); toast('Repair started on one computer. Viro will check the result before going further.'); reroute(); } catch (x) { fail(x); }
  });
  $$('[data-dismiss]').forEach(b => b.onclick = () => post(`/api/v1/fleet/patterns/${b.dataset.dismiss}/dismiss`).then(reroute).catch(fail));
  $$('[data-advance]').forEach(b => b.onclick = async () => { try { const r = await post(`/api/v1/fix-rollouts/${b.dataset.advance}/advance`, { stage: b.dataset.stage }); toast(`Repair started on ${r.devices} more computer${r.devices === 1 ? '' : 's'}.`); reroute(); } catch (x) { fail(x); } });
  $$('[data-halt]').forEach(b => b.onclick = async () => { if (await confirmBox('Stop the repair', 'Repairs that have not started are cancelled. Computers already repaired stay as they are.', 'Stop', true)) post(`/api/v1/fix-rollouts/${b.dataset.halt}/halt`).then(reroute).catch(fail); });
  poll(30000);
};
