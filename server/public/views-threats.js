'use strict';
/* Security incidents: from detection to verified clean. Microsoft Defender detects; Viro contains, inspects, repairs with approval, verifies and observes. */

NAV.splice(NAV.findIndex(n => n[0] === 'protection') + 1 || NAV.findIndex(n => n[0] === 'reports'), 0, ['threats', 'Threats']);

const SEC_STATUS = { DETECTED: ['attention', 'Detected'], CONTAINING: ['running', 'Containing'], QUARANTINED: ['running', 'Contained'], INVESTIGATING: ['running', 'Inspecting the PC'], REPAIR_READY: ['attention', 'Needs your approval'], REPAIRING: ['running', 'Repairing'], VERIFYING: ['running', 'Verifying'],
  OBSERVING: ['healthy', 'Clean, observing'], RESOLVED: ['healthy', 'Resolved'], UNRESOLVED: ['critical', 'Not resolved'], ADMIN_ACTION_REQUIRED: ['critical', 'Needs an administrator'] };
const SEC_TYPE = { malware: 'Malware', ransomware: 'Ransomware', pua: 'Unwanted software', other: 'Threat' };
const SEC_CHECKS = [['threatGone', 'The threat is no longer listed as active'], ['scanClean', 'A fresh scan came back clean'], ['noLinkedPersistence', 'Nothing starts the threat again'], ['protectionHealthy', 'Microsoft Defender protection is healthy'], ['policyRestored', 'No policy or hosts entry blocks security or updates']];

VIEWS.threats = async main => {
  const r = await api('/api/v1/security-incidents');
  const open = r.incidents.filter(i => i.status !== 'RESOLVED'), done = r.incidents.filter(i => i.status === 'RESOLVED');
  const card = i => `<div class="card" data-inc="${esc(i.id)}"><div class="toggle-row"><h2 style="margin:0">${esc(i.threat_name)}</h2><span class="pill ${SEC_STATUS[i.status]?.[0] ?? 'unknown'}">${esc(SEC_STATUS[i.status]?.[1] ?? i.status)}</span></div>
      <p class="mute" style="margin:6px 0 0">${esc(SEC_TYPE[i.threat_type] ?? 'Threat')} · ${esc(i.hostname)} · detected ${esc(ago(i.detected_at))} by ${esc(i.source)}</p><div class="incdetail"></div></div>`;
  main.innerHTML = `<h1>Threats</h1><p class="lead">Detect, contain, remediate, re-scan. An incident closes only after a clean scan.</p>
    ${open.length ? `<h3>Open</h3>${open.map(card).join('')}` : emptyState('security', 'No active incidents', 'Standing watch. Anything Defender detects appears here.')}
    ${done.length ? `<h3>Resolved</h3>${done.slice(0, 20).map(card).join('')}` : ''}`;
  for (const c of $$('[data-inc]')) api('/api/v1/security-incidents/' + c.dataset.inc).then(v => {
    const ver = v.verification, proposals = v.proposed_actions ?? [];
    $('.incdetail', c).innerHTML = `
      ${ver ? `<h3>Verification</h3>${SEC_CHECKS.map(([k, l]) => `<div class="issue"><span class="pts"><span class="pill ${ver[k] === true ? 'healthy' : ver[k] === false ? 'critical' : 'unknown'}">${ver[k] === true ? 'Yes' : ver[k] === false ? 'No' : 'Not measured'}</span></span><span>${esc(l)}</span></div>`).join('')}${ver.unverifiableReason ? `<p class="mute">${esc(ver.unverifiableReason)}</p>` : ''}` : ''}
      ${proposals.length && v.status === 'REPAIR_READY' ? `<h3>Proposed repairs</h3>${proposals.map(p => `<div class="issue"><span><b>${esc(p.recipe)}</b> · ${esc(p.confidence)} confidence<br><span class="mute">${p.evidence.map(esc).join('<br>')}</span></span></div>`).join('')}
        ${can('admin') ? `<div class="actions"><button data-approve="${esc(v.id)}">Approve all proposed repairs</button><button class="ghost" data-verify="${esc(v.id)}">These are fine, just verify</button></div>` : ''}` : ''}
      ${v.status === 'ADMIN_ACTION_REQUIRED' && can('admin') ? `<div class="actions"><button class="ghost" data-verify="${esc(v.id)}">Try verification again</button></div>` : ''}
      <details><summary>What Viro did</summary>${v.timeline.map(t => `<div class="issue"><span class="pts">${esc(new Date(t.at).toLocaleString())}</span><span><b>${esc(t.event)}</b> · ${esc(t.detail)}</span></div>`).join('')}</details>`;
    $$('[data-approve]', c).forEach(b => b.onclick = async () => { if (await confirmBox('Approve repairs', 'Viro will run only the approved repairs listed, read each change back to confirm it worked, undo it if it did not, and then verify with a fresh scan.', 'Approve')) post(`/api/v1/security-incidents/${b.dataset.approve}/approve`, { recipes: proposals.map(p => p.recipe) }).then(() => { toast('Repairs queued'); reroute(); }).catch(fail); });
    $$('[data-verify]', c).forEach(b => b.onclick = () => post(`/api/v1/security-incidents/${b.dataset.verify}/verify`).then(() => { toast('Verification started'); reroute(); }).catch(fail));
  }).catch(() => {});
};
