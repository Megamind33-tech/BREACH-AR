'use strict';
/* Alert webhooks: send opened/resolved alerts to a chat tool or ticketing system, signed so the receiver can verify them. */

NAV.splice(NAV.findIndex(n => n[0] === 'alerts') + 1, 0, ['webhooks', 'Alert webhooks']);

VIEWS.webhooks = async main => {
  if (!can('admin')) { main.innerHTML = '<h1>Integrations</h1><div class="card empty">Administrators manage integrations.</div>'; return; }
  const r = await api('/api/v1/alert-webhooks');
  main.innerHTML = `<div class="page-head"><h1>Integrations</h1>${can('admin') ? '<button id="addhook">Add webhook…</button>' : ''}</div>
    <p class="lead">Push each alert and its resolution to a chat tool or ticketing system. Deliveries are signed. Failures retry for several hours.</p>
    ${r.webhooks.length ? r.webhooks.map(w => `<div class="card"><div class="hook">
      <div><div class="url">${esc(w.url)} ${w.enabled ? '<span class="pill healthy">Active</span>' : '<span class="pill unknown">Paused</span>'}</div>
        <div class="mute">${w.minSeverity === 'critical' ? 'Sends critical alerts only' : 'Sends critical and warning alerts'}</div>
        <div class="nums"><span><b>${w.delivered}</b> delivered</span><span><b>${w.pending}</b> waiting</span><span><b style="${w.failed ? 'color:var(--bad)' : ''}">${w.failed}</b> failed</span></div>
        ${w.lastError ? `<small class="err">Last error: ${esc(w.lastError)}</small>` : ''}</div>
      <div class="btns"><button class="ghost sm" data-test="${esc(w.id)}">Send test</button> <button class="ghost sm" data-toggle="${esc(w.id)}" data-on="${w.enabled}">${w.enabled ? 'Pause' : 'Resume'}</button> <button class="ghost sm" data-remove="${esc(w.id)}">Remove</button></div></div></div>`).join('')
      : '<div class="card empty">No integrations configured. Alerts remain visible in the console.</div>'}
    <details class="card"><summary style="cursor:pointer;color:var(--accent-2)">Signature format</summary>
      <p class="mute" style="margin-bottom:0">Requests are signed with a secret (header <code>x-viro-signature</code>, HMAC-SHA256 over <code>timestamp.body</code>) so the receiver can check they came from Viro. Only https addresses on the public internet are accepted.</p></details>`;

  if ($('#addhook')) $('#addhook').onclick = async () => {
    const v = await dialog('Add alert webhook', `<label>Address (https)</label><input name="url" placeholder="https://hooks.example.com/…" required>
      <label>Send</label><select name="minSeverity"><option value="warning">Critical and warning alerts</option><option value="critical">Critical alerts only</option></select>`, 'Add');
    if (!v) return;
    try {
      const w = await post('/api/v1/alert-webhooks', { url: v.url.trim(), minSeverity: v.minSeverity });
      await dialog('Signing secret', `<p>Copy this secret into the receiving system now. It is shown only once.</p><input readonly value="${esc(w.secret)}" onfocus="this.select()" style="font-family:monospace">`, 'Done');
      reroute();
    } catch (x) { fail(x); }
  };
  $$('[data-test]').forEach(b => b.onclick = async () => { try { await post(`/api/v1/alert-webhooks/${b.dataset.test}/test`); toast('Test delivered.'); } catch (x) { fail(x); } });
  $$('[data-toggle]').forEach(b => b.onclick = () => patch(`/api/v1/alert-webhooks/${b.dataset.toggle}`, { enabled: b.dataset.on !== 'true' }).then(reroute).catch(fail));
  $$('[data-remove]').forEach(b => b.onclick = async () => { if (await confirmBox('Remove webhook', 'Alerts will no longer be sent to this address.', 'Remove', true)) del(`/api/v1/alert-webhooks/${b.dataset.remove}`).then(reroute).catch(fail); });
  poll(30000);
};
