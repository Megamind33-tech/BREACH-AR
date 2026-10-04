'use strict';
/* The "care" story on a computer's page: what is wrong, why, what Viro can do, what it did, whether it worked. Plus the service passport. */

const STATUS_TEXT = {
  DETECTED: 'Detected', DIAGNOSING: 'Investigating', ROOT_CAUSE_SUSPECTED: 'Cause suspected', ROOT_CAUSE_CONFIRMED: 'Cause confirmed', REPAIR_READY: 'Viro can fix this',
  REPAIRING: 'Repairing now', VERIFYING: 'Checking the result', OBSERVING: 'Watching for a return', RESOLVED: 'Resolved', IMPROVED: 'Improved, not gone', UNRESOLVED: 'Not fixed',
  HARDWARE_ACTION_REQUIRED: 'Needs a hardware repair', USER_ACTION_REQUIRED: 'Needs the user', ADMIN_APPROVAL_REQUIRED: 'Needs an administrator',
};
const STATUS_PILL = { RESOLVED: 'healthy', OBSERVING: 'running', VERIFYING: 'running', REPAIRING: 'running', REPAIR_READY: 'attention', IMPROVED: 'attention', UNRESOLVED: 'critical', HARDWARE_ACTION_REQUIRED: 'critical', ADMIN_APPROVAL_REQUIRED: 'attention', USER_ACTION_REQUIRED: 'attention' };
const CONF_TEXT = { HIGH: 'High confidence', MEDIUM: 'Medium confidence', LOW: 'Low confidence', UNKNOWN: 'Confidence unknown' };
const METRIC_LABEL = { healthOverall: 'Health score', systemFreeBytes: 'Free storage', ramPercent: 'Memory in use', cpuAvgPercent: 'Background CPU', startupCount: 'Startup programs', failedServices: 'Failed services', pendingUpdates: 'Pending updates', crashes7d: 'Crashes (7 days)', driverErrors: 'Driver errors', bootSeconds: 'Boot time', runningServices: 'Running services', processCount: 'Processes', diskSyncWriteMs: 'Disk write latency' };

const fmtMetric = (k, v) => v == null ? '—' : k === 'systemFreeBytes' ? mb(v) : /Percent$/.test(k) ? v + '%' : k === 'bootSeconds' ? v + ' s' : k === 'diskSyncWriteMs' ? v + ' ms' : String(v);
const when = t => t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
const day = t => t ? new Date(t).toLocaleDateString([], { dateStyle: 'medium' }) : '';

function evidenceLine(e) {
  const v = e.value ?? {};
  if (e.type === 'EVENT_LOG' && Array.isArray(v.crashes)) {
    const mods = [...new Set(v.crashes.map(c => c.module).filter(Boolean))], codes = [...new Set(v.crashes.map(c => c.exceptionCode).filter(Boolean))];
    return `${v.total} crash${v.total === 1 ? '' : 'es'} or hangs of ${v.app} recorded by Windows${mods.length ? ' · faulting module ' + mods.slice(0, 3).join(', ') : ''}${codes.length ? ' · error ' + codes.slice(0, 3).join(', ') : ''}`;
  }
  if (e.type === 'TELEMETRY' && v.cause) return e.note ?? 'Cause analysis';
  if (e.type === 'COMMAND_OUTPUT' && v.deferred) return 'Repair postponed (the application was open). Nothing was changed; Viro will try again.';
  if (e.type === 'VERIFICATION') return v.result ?? (v.symptomGone ? 'The problem is gone in the latest health report.' : 'Checked after the repair.');
  if (e.type === 'RECURRENCE') return v.message ?? 'The problem came back.';
  if (e.type === 'COMMAND_OUTPUT') return e.note ?? 'The repair step ran.';
  const bits = [];
  if (v.freeBytes != null) bits.push(`${mb(v.freeBytes)} free of ${mb(v.totalBytes)}`);
  if (v.ramPercent != null) bits.push(`memory ${v.ramPercent}% in use`);
  if (v.cpuAvgPercent != null) bits.push(`CPU ${v.cpuAvgPercent}% busy`);
  if (v.count != null) bits.push(`${v.count} programs at startup`);
  if (v.services) bits.push('stopped: ' + v.services.map(s => s.name).join(', '));
  if (v.pending != null) bits.push(`${v.pending} updates pending`);
  if (v.errors) bits.push(`${v.errors.length} device error${v.errors.length === 1 ? '' : 's'}`);
  if (v.finding) bits.push(v.finding);
  return bits.join(' · ') || e.source;
}

function incidentCard(i) {
  const active = i.status !== 'RESOLVED';
  const bm = i.benchmark?.measured ? i.benchmark.improved : [];
  const crashRow = i.code.startsWith('stability.app:') && i.beforeMetrics?.crashesInWindow != null && i.afterMetrics?.crashesSinceRepair != null ? [{ label: 'Crashes and hangs', before: i.beforeMetrics.crashesInWindow + ' (7 days)', after: i.afterMetrics.crashesSinceRepair + ' since the repair' }] : [];
  const compare = i.repairedAt && i.beforeMetrics && i.afterMetrics && !i.code.startsWith('stability.app:') ? Object.keys(METRIC_LABEL).filter(k => i.beforeMetrics[k] != null && i.afterMetrics[k] != null && i.beforeMetrics[k] !== i.afterMetrics[k]) : [];
  return `<div class="card incident" data-inc="${esc(i.id)}"><div class="toggle-row"><h2 style="margin:0">${esc(i.title)}</h2><span class="pill ${STATUS_PILL[i.status] ?? 'unknown'}">${esc(STATUS_TEXT[i.status] ?? i.status)}</span></div>
    <p style="margin:8px 0 4px"><b>Why:</b> ${esc(i.rootCause)}</p>
    <p class="mute" style="margin:0">${esc(CONF_TEXT[i.confidence] ?? i.confidence)} · first seen ${ago(i.firstDetected)}${i.recurrenceCount ? ` · came back ${i.recurrenceCount} time${i.recurrenceCount === 1 ? '' : 's'}` : ''}</p>
    ${i.evidence?.length ? `<details><summary>Evidence Viro measured (${i.evidence.length})</summary>${i.evidence.map(e => `<div class="issue"><span class="pts">${ago(e.observed_at)}</span>${esc(evidenceLine(e))}<small>${esc(e.source)}</small></div>`).join('')}</details>` : ''}
    ${i.status === 'OBSERVING' ? `<p class="note" style="margin-top:10px">Repaired and checked. Viro is watching until ${esc(when(i.observationUntil))} to make sure it does not come back.</p>` : ''}
    ${i.status === 'VERIFYING' ? '<p class="note" style="margin-top:10px">The repair ran. Viro has not yet confirmed that the problem is gone, so this is not counted as fixed.</p>' : ''}
    ${i.status === 'UNRESOLVED' ? '<p class="note" style="margin-top:10px">The repair did not fix it. It is not marked as fixed.</p>' : ''}
    ${!i.canFix && i.hardwareAction ? `<p class="note" style="margin-top:10px"><b>Software cannot fix this.</b> ${esc(i.recommendation ?? '')}</p>` : ''}
    ${active && !i.hardwareAction && i.recommendation && !i.canFix ? `<p class="mute" style="margin:8px 0 0">${esc(i.recommendation)}</p>` : ''}
    ${compare.length || crashRow.length ? `<h3>Before and after</h3><table><thead><tr><th></th><th>Before</th><th>After</th></tr></thead><tbody>${crashRow.map(r => `<tr><td>${esc(r.label)}</td><td>${esc(r.before)}</td><td>${esc(r.after)}</td></tr>`).join('')}${compare.map(k => `<tr><td>${esc(METRIC_LABEL[k])}</td><td>${esc(fmtMetric(k, i.beforeMetrics[k]))}</td><td>${esc(fmtMetric(k, i.afterMetrics[k]))}</td></tr>`).join('')}</tbody></table>` : ''}
    ${bm.length ? `<h3>Measured improvement</h3>${bm.map(r => `<div class="issue"><span class="pts">${esc(fmtMetric(r.metric, r.before))} → ${esc(fmtMetric(r.metric, r.after))}</span>${esc(r.label)}: ${Math.abs(r.changePercent)}% ${r.changePercent < 0 ? 'lower' : 'higher'}</div>`).join('')}` : ''}
    ${i.status === 'RESOLVED' ? `<p class="mute" style="margin:10px 0 0">${i.resolution === 'viro-repair' ? `Verified resolved ${ago(i.resolvedAt)}: the symptom stayed gone for the whole observation period.` : `Cleared ${ago(i.resolvedAt)} without a Viro repair.`}</p>` : ''}
    ${i.canFix && can('technician') ? `<div class="actions"><button data-incfix="${esc(i.id)}" data-safety="${i.safetyLevel}">${esc(i.action ?? 'Fix now')}</button></div>` : ''}</div>`;
}

function passportHtml(p, svc) {
  const id = p.identity, age = p.age, c = p.counts;
  const pending = svc.events.filter(e => e.status === 'PENDING_CONFIRMATION');
  return `<div class="card"><h2>Service passport</h2>
    <dl>
      <dt>Computer</dt><dd>${esc(p.device.hostname)}${id ? ` · ${esc(id.manufacturer ?? '')} ${esc(id.model ?? '')}` : ''}</dd>
      <dt>Serial number</dt><dd>${esc(id?.serialNumber ?? null)}</dd>
      <dt>First seen by Viro</dt><dd>${esc(day(p.device.firstSeenByViro))}</dd>
      <dt>Hardware age</dt><dd>${age.hardwareAgeEstimate == null ? 'Not enough evidence to estimate' + (age.systemDriveInServiceYears != null ? ` (the system drive has been powered on for about ${age.systemDriveInServiceYears} years)` : '') : `About ${age.hardwareAgeEstimate} years <span class="pill ${age.hardwareAgeConfidence === 'HIGH' ? 'healthy' : age.hardwareAgeConfidence === 'MEDIUM' ? 'attention' : 'unknown'}">${esc(CONF_TEXT[age.hardwareAgeConfidence])}</span>`}</dd>
      <dt>Health now</dt><dd>${p.currentHealth ?? '—'} / 100${p.baseline?.healthOverall != null ? ` <span class="mute">(${p.baseline.healthOverall} when Viro first saw it)</span>` : ''}</dd>
      <dt>Memory</dt><dd>${esc((id?.memoryModules ?? []).map(m => `${gb(m.capacityBytes)} ${m.manufacturer ?? ''} ${m.speedMhz ? m.speedMhz + ' MHz' : ''}`.trim()).join(' + ') || (id?.ramBytes ? gb(id.ramBytes) : null))}</dd>
      <dt>Storage</dt><dd>${esc((id?.disks ?? []).map(d => `${d.model ?? ''} ${d.sizeBytes ? gb(d.sizeBytes) : ''}`.trim()).join(', ') || null)}</dd>
      <dt>Viro repairs (verified)</dt><dd>${c.autopilotRepairs}</dd><dt>Manual IT interventions</dt><dd>${c.manualInterventions}</dd><dt>Physical services</dt><dd>${c.physicalServices}</dd><dt>Parts replaced</dt><dd>${c.componentsReplaced}</dd>
    </dl>
    <details><summary>How the age estimate was made</summary>${age.hardwareAgeEvidence.length ? age.hardwareAgeEvidence.map(e => `<div class="issue">${esc(e.source)}<small>${esc(e.detail)}</small></div>`).join('') : ''}<p class="mute">${esc(age.note)}</p></details>
    ${p.currentRecommendation ? `<p style="margin:10px 0 0"><b>Current recommendation:</b> ${esc(p.currentRecommendation.title)}${p.currentRecommendation.recommendation ? ' — ' + esc(p.currentRecommendation.recommendation) : ''}</p>` : ''}
    <div class="actions">${can('admin') ? '<button class="ghost sm" id="setpurchase">Enter purchase date and cost</button>' : ''}${can('technician') ? '<button class="ghost sm" id="addservice">Add service record</button>' : ''}</div></div>
    ${pending.length ? `<div class="card"><h2>Hardware changes to confirm</h2><p class="mute">Viro noticed these changes in the computer's parts. Confirm to add them to the service history, or dismiss them.</p>
      ${pending.map(e => `<div class="issue">${can('admin') ? `<span class="pts"><button class="sm" data-svcdecide="confirm" data-svc="${esc(e.id)}">Confirm</button> <button class="ghost sm" data-svcdecide="dismiss" data-svc="${esc(e.id)}">Dismiss</button></span>` : ''}<b>${esc(e.service_type)}</b> <span class="mute">${ago(e.occurred_at)}</span><small>${esc(e.notes ?? e.reason ?? '')}</small></div>`).join('')}</div>` : ''}
    <div class="card"><h2>Service history</h2>${svc.events.filter(e => e.status === 'CONFIRMED').length
      ? svc.events.filter(e => e.status === 'CONFIRMED').map(e => `<div class="issue"><span class="pts">${esc(day(e.occurred_at))}</span><b>${esc(e.service_type)}</b>${e.reason ? ` · ${esc(e.reason)}` : ''}<small>${esc([e.source === 'AUTOMATIC' ? 'Done by Viro' : e.technician ? 'By ' + e.technician : e.source.toLowerCase(), e.cost != null ? 'cost ' + e.cost : '', e.downtime_minutes != null ? e.downtime_minutes + ' min downtime' : '', e.old_part_serial ? 'old part ' + e.old_part_serial : '', e.new_part_serial ? 'new part ' + e.new_part_serial : ''].filter(Boolean).join(' · '))}</small></div>`).join('')
      : '<p class="mute" style="margin:0">No service recorded yet. Viro only records what it did or what someone tells it; it does not guess at earlier repairs.</p>'}</div>`;
}

const COND_TEXT = { HEALTHY: 'Healthy', WATCH: 'Watch', DEGRADED: 'Degrading', REPLACEMENT_ADVISED: 'Replacement advised', CRITICAL: 'Critical', NOT_MEASURED: 'Not measured' };
const COND_PILL = { HEALTHY: 'healthy', WATCH: 'attention', DEGRADED: 'attention', REPLACEMENT_ADVISED: 'critical', CRITICAL: 'critical', NOT_MEASURED: 'unknown' };
const ACTION_TEXT = { KEEP: 'Keep in service', MAINTAIN: 'Maintain', UPGRADE: 'Upgrade a part', REPAIR: 'Repair a part', MONITOR: 'Monitor', REPLACE: 'Replace' };
const ACTION_PILL = { KEEP: 'healthy', MAINTAIN: 'attention', UPGRADE: 'attention', REPAIR: 'attention', MONITOR: 'attention', REPLACE: 'critical' };
const money = v => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });

function lifecycleHtml(lc) {
  return `<div class="card"><div class="toggle-row"><h2 style="margin:0">Keep or replace?</h2><span class="pill ${ACTION_PILL[lc.action]}">${esc(ACTION_TEXT[lc.action])}</span></div>
    <p style="margin:8px 0 4px"><b>${esc(lc.condition[0] + lc.condition.slice(1).toLowerCase())}</b> · <span class="mute">${esc(CONF_TEXT[lc.confidence])}</span></p>
    <ul>${lc.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
    <div class="kv"><div><span>Interventions in 12 months</span>${lc.cost.interventions12m}</div><div><span>Service cost in 12 months</span>${money(lc.cost.serviceCost12m)}</div><div><span>Recorded downtime</span>${lc.cost.downtimeHours12m} h</div><div><span>Purchase cost</span>${money(lc.cost.purchaseCost)}</div></div>
    <p class="mute" style="margin:10px 0 0">${esc(lc.note)}</p></div>`;
}

function conditionHtml(co) {
  const t = co.freeSpaceTrend;
  return `<div class="card"><h2>Hardware condition</h2>
    ${co.disks.length ? co.disks.map(d => `<div class="issue"><span class="pts"><span class="pill ${COND_PILL[d.condition]}">${esc(COND_TEXT[d.condition])}</span></span><b>${esc(d.model)}</b>${d.mediaType ? ` <span class="mute">${esc(d.mediaType)}</span>` : ''}<small>${esc(d.evidence.join(' '))}</small><small><b>${esc(d.action)}</b></small></div>`).join('') : `<p class="mute" style="margin:0">${esc(co.note ?? 'No drive health was read yet.')} Run a hardware diagnosis to read it.</p>`}
    ${co.battery ? `<div class="issue"><span class="pts"><span class="pill ${COND_PILL[co.battery.condition]}">${esc(COND_TEXT[co.battery.condition])}</span></span><b>Battery</b><small>${esc(co.battery.evidence.join(' '))}</small><small>${esc(co.battery.runtime.note)} <b>${esc(co.battery.action)}</b></small></div>` : ''}
    <div class="issue"><b>Free space on the system drive</b><small>${t.measured ? esc(t.note) + (t.projectedBelowThresholdAt ? ` At this rate it falls below ${(t.thresholdBytes / 2 ** 30).toFixed(0)} GB around ${esc(day(t.projectedBelowThresholdAt))} (${esc(CONF_TEXT[t.confidence])}).` : '') : esc(t.note)}</small></div></div>`;
}

function recsHtml(r) {
  const lim = r.hardwareLimit?.softwareLimitReached ? `<div class="card"><h2>Software has reached its limit</h2><p class="note" style="margin:0">${esc(r.hardwareLimit.message)}</p></div>` : '';
  if (!r.recommendations.length) return lim;
  return lim + `<div class="card"><h2>Recommended hardware</h2>${r.recommendations.map(x => `<div class="issue"><span class="pts"><span class="pill ${x.compatibility.confidence === 'HIGH' ? 'healthy' : x.compatibility.confidence === 'MEDIUM' ? 'attention' : 'unknown'}">Compatibility: ${esc(x.compatibility.confidence.toLowerCase())}</span></span><b>${esc(x.title)}</b>
      <small>${esc(x.why.join(' '))}</small><small><b>Now:</b> ${esc(x.current)}</small><small><b>Recommended:</b> ${esc(x.recommended)}${x.expectedConfiguration ? ' → ' + esc(x.expectedConfiguration) : ''}</small>
      ${x.compatibility.evidence.length ? `<small>Verified from the computer: ${esc(x.compatibility.evidence.join('; '))}.</small>` : ''}
      ${x.compatibility.unknowns.length ? `<small>Could not be verified: ${esc(x.compatibility.unknowns.join('; '))}.</small>` : ''}<small><b>${esc(x.verification)}</b></small></div>`).join('')}</div>`;
}

function benchHtml(bm) {
  if (!bm.measurements) return `<div class="card"><h2>Performance benchmark</h2><p class="mute">Not measured yet. A first measurement becomes this computer's baseline.</p>${can('technician') ? '<div class="actions"><button class="ghost sm" id="runbench">Measure now</button></div>' : ''}</div>`;
  const cmp = bm.sinceBaseline;
  return `<div class="card"><h2>Performance benchmark</h2><p class="mute" style="margin-top:0">${bm.measurements} measurement${bm.measurements === 1 ? '' : 's'}; baseline taken ${esc(when(bm.baseline?.taken_at))}. Only values the computer actually measured are shown.</p>
    ${cmp?.measured ? `<table><thead><tr><th></th><th>Baseline</th><th>Latest</th><th>Change</th></tr></thead><tbody>${cmp.rows.map(r => `<tr><td>${esc(r.label)}</td><td>${esc(fmtMetric(r.metric, r.before))}</td><td>${esc(fmtMetric(r.metric, r.after))}</td><td><span class="pill ${r.result === 'improved' ? 'healthy' : r.result === 'worse' ? 'critical' : 'unknown'}">${r.result === 'unchanged' ? 'about the same' : `${r.result} ${Math.abs(r.changePercent)}%`}</span></td></tr>`).join('')}</tbody></table>`
      : `<div class="kv">${Object.entries(bm.latest.metrics).filter(([k, v]) => METRIC_LABEL[k] && typeof v === 'number').map(([k, v]) => kv(METRIC_LABEL[k], fmtMetric(k, v))).join('')}</div>`}
    ${can('technician') ? '<div class="actions"><button class="ghost sm" id="runbench">Measure now</button></div>' : ''}</div>`;
}


const BASIS = { measured: 'Read from the computer', observed: 'Seen by Viro', recorded: 'Entered by a person' };
function historyHtml(h, certs) {
  if (!h?.hasData) return `<div class="card"><h2>Machine history</h2><p class="mute" style="margin:0">Viro has not read this computer in full yet. The history appears after the next full reading.${can('technician') ? ' <button class="ghost sm" id="collectnow">Read it now</button>' : ''}</p></div>`;
  const s = h.summary;
  const tile = (v, k) => `<div class="fact"><b style="font-size:22px">${esc(v)}</b><span>${esc(k)}</span></div>`;
  const cert = (certs?.certificates ?? []);
  return `<div class="card"><h2>Machine history</h2>
    <div class="facts">${tile(s.windowsUpgrades, 'Windows upgrades on record')}${tile(s.memoryChangesSeen, 'Memory changes seen')}${tile(s.driveChangesSeen, 'Drive changes seen')}${tile(s.confirmedServices, 'Confirmed services')}</div>
    <dl style="margin-top:12px">${h.facts.map(f => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)} <span class="tag" title="${esc(BASIS[f.basis] ?? '')}">${esc(f.basis)}</span></dd>`).join('')}</dl>
    <details><summary>Timeline (${h.timeline.length})</summary>${h.timeline.map(t => `<div class="issue"><span class="pts">${esc(t.date ?? '')}</span>${esc(t.title)} <span class="tag">${esc(t.basis)}</span></div>`).join('')}</details>
    <details><summary>What this cannot tell you</summary><ul class="mute">${h.limits.map(l => `<li>${esc(l)}</li>`).join('')}</ul></details></div>
  <div class="card"><h2>Viro certificate for a buyer</h2>
    <p class="mute" style="margin-top:0">Selling or handing over this computer? Viro inspects it afresh and emails a signed certificate straight to the buyer. You are told where it was sent, but never given the code, so the certificate cannot be edited or faked by the seller.</p>
    ${cert.length ? cert.map(c => `<div class="issue"><span class="pts">${esc(c.status.replace('_', ' '))}</span>Sent to ${esc(c.sentTo)}<small>${esc(day(c.requestedAt))}${c.expiresAt ? ' · valid until ' + esc(day(c.expiresAt)) : ''}${c.failure ? ' · ' + esc(c.failure) : ''}${c.revokeReason ? ' · withdrawn: ' + esc(c.revokeReason) : ''}</small>${c.status === 'issued' && can('admin') ? `<span class="pts"><button class="ghost sm" data-certrevoke="${esc(c.id)}">Withdraw</button></span>` : ''}</div>`).join('') : ''}
    ${can('admin') ? '<div class="actions"><button id="certreq">Request a certificate for a buyer</button></div>' : ''}</div>`;
}

EXTRA_DEVICE_HOOKS.push(async (main, d, ctx) => {
  const id = d.id, top = $('#care-top'), low = $('#care-low');
  if (!top || !low) return;
  let inc, pass, bm, tl, svc, lc, co, rc;
  try { [inc, pass, bm, tl, svc, lc, co, rc] = await Promise.all([api(`/api/v1/devices/${id}/incidents`), api(`/api/v1/devices/${id}/passport`), api(`/api/v1/devices/${id}/benchmarks`), api(`/api/v1/devices/${id}/timeline`), api(`/api/v1/devices/${id}/service-events`), api(`/api/v1/devices/${id}/lifecycle`), api(`/api/v1/devices/${id}/condition`), api(`/api/v1/devices/${id}/recommendations`)]); } catch { return; }
  let hist = null, certs = null; try { [hist, certs] = await Promise.all([api(`/api/v1/devices/${id}/history`), api(`/api/v1/devices/${id}/certificates`)]); } catch { /* the history is optional */ }
  const s = inc.story, active = inc.incidents.filter(i => i.status !== 'RESOLVED'), recent = inc.incidents.filter(i => i.status === 'RESOLVED').slice(0, 5);
  const big = s.biggestProblem;
  top.innerHTML = `<div class="card"><div class="dash-head"><div class="facts" style="margin:0">
      <div class="fact"><div class="gauge sm ${s.healthOverall != null && s.healthOverall < 60 ? 'critical' : s.healthOverall != null && s.healthOverall < 80 ? 'attention' : ''}" style="--p:${s.healthOverall ?? 0}"><div><strong>${s.healthOverall ?? '—'}</strong></div></div><span>Health</span></div>
      <div class="fact"><b style="font-size:18px;margin-top:10px">${esc(s.status)}</b><span>State</span></div>
      <div class="fact" style="flex:2"><b style="font-size:16px;margin-top:10px">${big ? esc(big.title) : 'No faults'}</b><span>Top fault${big ? ` · ${esc(CONF_TEXT[big.confidence])}` : ''}</span></div>
      <div class="fact"><b style="font-size:18px;margin-top:10px">${esc(s.virocanFix)}</b><span>Auto-remediable</span></div>
      <div class="fact"><b style="font-size:18px;margin-top:10px">${s.hardwareAction.length ? esc(s.hardwareAction[0].title) : 'None'}</b><span>Hardware flag</span></div></div></div>
    <div class="actions"><button class="ghost sm" id="whyslow">Diagnose slowness</button></div></div>
    ${(() => {
      const symptomIds = new Set(inc.groups.flatMap(g => g.symptoms.map(x => x.id))), byId = new Map(inc.incidents.map(i => [i.id, i]));
      return active.filter(i => !symptomIds.has(i.id)).map(i => {
        const g = inc.groups.find(x => x.root === i.id);
        return incidentCard(i) + (g ? `<div class="card" style="margin-top:-8px;border-left:3px solid var(--accent-2)"><h3 style="margin-top:0">Symptoms of "${esc(i.title)}"</h3>${g.symptoms.map(s => { const x = byId.get(s.id); return x ? `<div class="issue">${esc(x.title)}<small>${s.basis === 'evidence' ? 'Viro tied these to the same cause.' : 'Present while this problem is present; likely related.'}</small></div>` : ''; }).join('')}</div>` : '');
      }).join('');
    })()}
    ${recent.length ? `<h3>Recently resolved</h3>${recent.map(incidentCard).join('')}` : ''}`;
  low.innerHTML = `${lifecycleHtml(lc)}${conditionHtml(co)}${recsHtml(rc)}${benchHtml(bm)}${passportHtml(pass, svc)}${historyHtml(hist, certs)}
    <div class="card"><h2>What Viro has done for you</h2>${tl.timeline.length ? tl.timeline.slice(0, 25).map(t => `<div class="issue"><span class="pts">${esc(day(t.at))}</span>${esc(t.text)}</div>`).join('') : '<p class="mute" style="margin:0">Nothing yet. Every repair and its verified result will appear here.</p>'}</div>`;

  $('#collectnow')?.addEventListener('click', async () => { try { await post(`/api/v1/devices/${id}/anatomy/collect`); toast('Reading started. Refresh in a minute.'); } catch (e) { fail(e); } });
  $('#certreq')?.addEventListener('click', async () => {
    const r = await dialog('Request a certificate for a buyer', '<p>Viro will inspect this computer now and email the signed certificate directly to the buyer. It cannot be sent to you.</p><label>Email address of the buyer</label><input type="email" name="buyerEmail" required placeholder="buyer@example.com">', 'Inspect and send');
    if (!r) return;
    try { const x = await post(`/api/v1/devices/${id}/certificates`, { buyerEmail: r.buyerEmail }); toast(x.message); ctx.reroute?.(); } catch (e) { fail(e); }
  });
  $$('[data-certrevoke]').forEach(b => b.onclick = async () => { const r = await dialog('Withdraw this certificate', '<label>Reason</label><input name="reason" required minlength="3" placeholder="For example: sold a different computer">', 'Withdraw', true); if (!r) return; try { await post(`/api/v1/certificates/${b.dataset.certrevoke}/revoke`, { reason: r.reason }); toast('Withdrawn. The certificate now shows as withdrawn.'); } catch (e) { fail(e); } });
  $('#whyslow')?.addEventListener('click', async () => {
    try {
      const x = await api(`/api/v1/devices/${id}/diagnosis`);
      await dialog('Why this computer is slow', `<p class="mute" style="margin-top:0">${esc(x.summary)}</p>
        ${x.limit.softwareLimitReached ? `<p class="note">${esc(x.limit.message)}</p>` : ''}
        ${x.causes.map(c => `<div class="issue"><span class="pts"><span class="pill ${c.impact === 'high' ? 'critical' : c.impact === 'medium' ? 'attention' : 'unknown'}">${esc(c.impact)} impact</span></span><b>${c.rank}. ${esc(c.title)}</b><small>${esc(c.cause)} · ${esc(CONF_TEXT[c.confidence])}${c.action ? ` · Viro can: ${esc(c.action.label)}${c.action.automatic ? '' : ' (needs approval)'}` : c.remedy === 'hardware' ? ' · needs a hardware repair' : ''}</small></div>`).join('') || '<p>No measurable cause of slowness was found.</p>'}
        ${x.notMeasured?.length ? `<p class="mute">Not measured on this computer: ${esc(x.notMeasured.join(', '))}.</p>` : ''}`, 'Close');
    } catch (e) { fail(e); }
  });
  $$('[data-incfix]').forEach(b => b.onclick = ctx.act(async () => {
    if (+b.dataset.safety >= 3 && !(await confirmBox('Approve repair', 'This repair needs your approval. Viro will make a change and then check that it worked.', 'Approve and repair'))) throw new Error('cancelled');
    await post(`/api/v1/incidents/${b.dataset.incfix}/fix`);
    toast('Repair started. Viro will check the result before calling it fixed.');
  }));
  $('#runbench')?.addEventListener('click', ctx.act(() => runJob('benchmark.run', {}, ctx.target)));
  $$('[data-svcdecide]').forEach(b => b.onclick = ctx.act(() => patch(`/api/v1/service-events/${b.dataset.svc}`, { decision: b.dataset.svcdecide })));
  $('#setpurchase')?.addEventListener('click', async () => {
    const v = await dialog('Purchase information', `<label>Purchase date</label><input name="date" type="date" value="${esc(String(pass.purchase.date ?? '').slice(0, 10))}"><label>Purchase cost</label><input name="cost" type="number" min="0" step="0.01" value="${esc(pass.purchase.cost ?? '')}">`, 'Save');
    if (!v) return;
    try { await patch(`/api/v1/devices/${id}/purchase`, { purchaseDate: v.date || null, purchaseCost: v.cost === '' ? null : +v.cost }); toast('Saved.'); ctx.again(); } catch (e) { fail(e); }
  });
  $('#addservice')?.addEventListener('click', async () => {
    const v = await dialog('Add service record', `<label>What was done</label><select name="serviceType">${svc.types.map(t => `<option>${esc(t)}</option>`).join('')}</select>
      <label>Reason</label><input name="reason" maxlength="500"><div class="row2"><div><label>Technician</label><input name="technician" maxlength="120"></div><div><label>Cost</label><input name="cost" type="number" min="0" step="0.01"></div></div>
      <div class="row2"><div><label>Downtime (minutes)</label><input name="downtime" type="number" min="0"></div><div><label>Parts (comma separated)</label><input name="parts"></div></div>
      <div class="row2"><div><label>Old part serial</label><input name="oldSerial"></div><div><label>New part serial</label><input name="newSerial"></div></div><label>Notes</label><textarea name="notes" rows="2" maxlength="2000"></textarea>`, 'Save');
    if (!v) return;
    const body = { serviceType: v.serviceType, reason: v.reason || undefined, technician: v.technician || undefined, notes: v.notes || undefined, oldPartSerial: v.oldSerial || undefined, newPartSerial: v.newSerial || undefined, parts: v.parts ? v.parts.split(',').map(x => x.trim()).filter(Boolean) : [] };
    if (v.cost !== '') body.cost = +v.cost; if (v.downtime !== '') body.downtimeMinutes = +v.downtime;
    try { await post(`/api/v1/devices/${id}/service-events`, body); toast('Service record added.'); ctx.again(); } catch (e) { fail(e); }
  });
});

/* Fleet lifecycle: which computers to keep, upgrade, repair, watch or replace, and why. */
NAV.splice(NAV.findIndex(n => n[0] === 'reports'), 0, ['lifecycle', 'Lifecycle']);
VIEWS.lifecycle = async main => {
  const r = await api('/api/v1/lifecycle');
  const order = ['REPLACE', 'REPAIR', 'UPGRADE', 'MONITOR', 'MAINTAIN', 'KEEP'];
  const anyHw = r.items.some(i => i.recommendations.length);      // no hardware advice for anyone: do not spend a column on "Nothing needed"
  main.innerHTML = `<h1>Lifecycle</h1><p class="lead">Keep, repair or replace, with the reasons. Never decided by age alone.</p>
    <div class="facts">${order.map(k => `<div class="fact"><b>${r.counts[k] ?? 0}</b><span>${esc(ACTION_TEXT[k])}</span></div>`).join('')}</div>
    ${r.items.length ? `<table><thead><tr><th>Computer</th><th>Recommendation</th><th>Why</th>${anyHw ? '<th class="hide-sm">Hardware</th>' : ''}</tr></thead><tbody>${r.items.map((i, n) => { const same = n > 0 && r.items[n - 1].action === i.action && r.items[n - 1].reasons.join('|') === i.reasons.join('|'); return `<tr class="row" data-id="${esc(i.deviceId)}"><td class="nowrap"><b>${esc(i.hostname)}</b></td><td class="nowrap"><span class="pill ${ACTION_PILL[i.action]}">${esc(ACTION_TEXT[i.action])}</span><small>${esc(i.condition.toLowerCase())}</small></td><td>${same ? '<span class="mute">Same as above</span>' : `<ul class="whylist">${i.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`}</td>${anyHw ? `<td class="hide-sm">${i.recommendations.length ? esc(i.recommendations.join(', ')) : '<span class="mute">Nothing needed</span>'}</td>` : ''}</tr>`; }).join('')}</tbody></table>` : emptyState('computers', 'No computers yet', 'Add computers and Viro will assess each one.')}`;
  $$('tr.row').forEach(tr => tr.onclick = () => location.hash = '#/computers/' + tr.dataset.id);
  poll(60000);
};
