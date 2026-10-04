'use strict';
/* Protection: ransomware, attack-surface and privacy controls Windows already provides, how many computers have each one on, and one-click, verified, reversible rollout. */

NAV.splice(NAV.findIndex(n => n[0] === 'fleet') + 1 || NAV.findIndex(n => n[0] === 'reports'), 0, ['protection', 'Protection']);

const PROT_GROUPS = [['ransomware', 'Ransomware', 'Keeps personal files from being encrypted, and makes recovery possible.'], ['attacks', 'Cyber attacks', 'Closes the doors worms and remote attackers use.'], ['privacy', 'Tracking and privacy', 'Limits what Windows itself collects and shares about people.']];

VIEWS.protection = async main => {
  const ov = await api('/api/v1/protection/overview');
  const offTotal = ov.controls.reduce((n, c) => n + (c.off ? 1 : 0), 0);
  main.innerHTML = `<div class="page-head"><h1>Protection</h1></div>
    <div class="lead">Controls Viro enforces, then reads back to confirm. Every change is reversible. <details class="inline"><summary>What this is not</summary>${esc(ov.limits)}</details></div>
    <div class="stat-tiles"><div class="stat-tile"><b>${ov.score == null ? '—' : ov.score + '%'}</b><span>of measured controls on</span></div><div class="stat-tile"><b>${ov.devices}</b><span>Computers</span></div><div class="stat-tile ${offTotal ? 'warn' : ''}"><b>${offTotal}</b><span>Controls with gaps</span></div></div>
    ${PROT_GROUPS.map(([g, title, blurb]) => `<h3>${esc(title)} <span class="mute" style="text-transform:none;letter-spacing:0;font-weight:400">· ${esc(blurb)}</span></h3><div class="list">${ov.controls.filter(c => c.group === g).map(c => {
      const measured = c.on + c.off;
      const pill = c.off ? ['attention', `${c.off} off`] : c.on ? ['healthy', 'On'] : c.notApplicable ? ['unknown', 'Managed by another product'] : ['unknown', 'Not measured'];
      const detail = measured ? `${c.on} of ${measured} computers${c.notApplicable ? ` · ${c.notApplicable} managed elsewhere` : ''}` : 'No computer has reported this yet';
      return `<div class="item"><div class="main"><b>${esc(c.title)}</b><small>${esc(c.why)}</small><small>${detail}${c.optional ? ' · optional' : ''}</small>
        ${c.devicesOff.length ? `<details><summary>Where it is off</summary>${c.devicesOff.map(d => `<div>${esc(d.hostname)}</div>`).join('')}</details>` : ''}</div>
        <div class="side"><span class="pill ${pill[0]}">${esc(pill[1])}</span>${!c.reportOnly && c.off && can('admin') ? `<button class="sm" data-apply="${esc(c.id)}" data-risk="${esc(c.risk)}">Turn on (${c.off})</button>` : ''}</div></div>`;
    }).join('')}</div>`).join('')}
    ${ov.weakest.length ? `<h3>Least protected computers</h3><div class="table-wrap"><table><thead><tr><th>Computer</th><th>Controls off</th><th>Coverage</th></tr></thead><tbody>${ov.weakest.map(w => `<tr><td><span class="nowrap">${esc(w.hostname)}</span></td><td>${w.off}</td><td>${w.score}%</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  $$('[data-apply]').forEach(b => b.onclick = async () => {
    const review = b.dataset.risk === 'review';
    if (!(await confirmBox('Turn on protection', review ? 'This can change how people work (for example it can block programs or features they use). Each change is checked afterwards and can be undone from the repair history. Continue?' : 'Viro makes the change, reads it back to confirm it took effect, and undoes it if it did not. It can be undone later from the repair history.', 'Turn on', review))) return;
    try { const r = await post('/api/v1/protection/apply', review ? { control: b.dataset.apply, approved: true } : { control: b.dataset.apply }); toast(`Queued on ${r.queued} computer${r.queued === 1 ? '' : 's'}`); reroute(); } catch (x) { fail(x); }
  });
};
