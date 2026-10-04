'use strict';
/* Remote control where people look for it: a bar at the top of every computer's page (watch the screen, control it, terminal, files, restart, shut down, wake up),
   live feedback while a power action happens, and a screen that can sit beside a terminal or file session so you can see what your work does. */

const DELAYS = [['30', '30 seconds'], ['60', '1 minute'], ['300', '5 minutes'], ['600', '10 minutes']];

async function startSupportSession(d, kind, viewOnly) {
  const labels = { terminal: 'a terminal', files: 'file browsing', desktop: viewOnly ? 'screen watching' : 'remote desktop' };
  const r = await dialog(`Start ${labels[kind]} on ${d.hostname}`, `<p>The person using this PC sees a notice that you started a session, and everything is recorded.</p><label>Reason (recorded)</label><input name="reason" required minlength="5" maxlength="300" value="Remote assistance">`, 'Start');
  if (!r) return;
  try { const s = await post('/api/v1/support/sessions', { deviceId: d.id, kind, reason: r.reason }); try { sessionStorage.setItem('vo:' + s.id, viewOnly ? '1' : ''); } catch { } location.hash = '#/session/' + s.id; } catch (e) { fail(e); }
}

// Follows a power action on the computer's own status until it has visibly happened, so you can see that it worked.
let POWER_WATCH = null, POWER_STATUS = null;      // the status line is kept here because the page redraws itself while you watch
function followPower(d, what, delaySeconds) {
  POWER_WATCH?.stop(); const box = () => document.getElementById('rc-status');
  const t0 = Date.now(); let wentOffline = false, timer;
  const say = (t, cls = '') => { POWER_STATUS = { t, cls, dev: d.id }; const b = box(); if (b) { b.hidden = false; b.className = 'note ' + cls; b.textContent = t; } };
  const tick = async () => {
    if (!box()) { stop(); return; }
    try {
      const cur = await api('/api/v1/devices/' + d.id); const secs = Math.round((Date.now() - t0) / 1000);
      if (what === 'wake') {
        if (cur.status === 'online') { say(`${d.hostname} is online again. The wake-up worked.`, 'ok'); return stop(); }
        say(`Wake-up signal sent. Waiting for ${d.hostname} to start (${secs}s)…`);
      } else {
        if (cur.status === 'offline') wentOffline = true;
        const left = Math.max(0, delaySeconds - secs);
        if (what === 'restart' && wentOffline && cur.status === 'online') { say(`${d.hostname} restarted and is online again.`, 'ok'); return stop(); }
        if (wentOffline) { say(what === 'shutdown' ? `${d.hostname} has switched off (${new Date().toLocaleTimeString()}). Use Wake up to switch it on again.` : `${d.hostname} is restarting…`, what === 'shutdown' ? 'ok' : ''); if (what === 'shutdown') return stop(); }
        else say(left > 0 ? `${what === 'shutdown' ? 'Switching off' : 'Restarting'} in about ${left} s. The person at the PC can see the countdown and save their work.` : `Waiting for ${d.hostname} to go offline…`);
      }
      if (Date.now() - t0 > (delaySeconds + 420) * 1000) { say(`${d.hostname} has not changed state yet. Check the Jobs page for what happened.`, 'warn'); stop(); }
    } catch { /* keep trying */ }
  };
  const stop = () => { clearInterval(timer); if (POWER_WATCH?.stop === stop) POWER_WATCH = null; };
  POWER_WATCH = { stop }; timer = setInterval(tick, 5000); tick();
}

EXTRA_DEVICE_HOOKS.push((main, d) => {
  if (!can('admin') || !d?.id) return;
  const online = d.status === 'online';
  const restoreStatus = () => { if (POWER_STATUS && POWER_STATUS.dev === d.id) { const b = $('#rc-status', main); if (b) { b.hidden = false; b.className = 'note ' + POWER_STATUS.cls; b.textContent = POWER_STATUS.t; } } };
  const bar = `<div class="card remote-bar" data-injected="remote-bar" data-state="${online ? 'online' : 'offline'}:${d.id}"><h2>Remote control</h2><p class="mute">The person at the PC is told when a session starts, and everything is recorded.</p>
    <div class="launch">${online ? `<button class="tile hot" data-rc="watch">${icon('computers')}Watch screen<small>See what the PC shows (view only)</small></button><button class="tile" data-rc="control">${icon('computers')}Control screen<small>Use its mouse and keyboard</small></button><button class="tile" data-rc="terminal">${icon('jobs')}Terminal<small>Run commands</small></button><button class="tile" data-rc="files">${icon('audit')}Files<small>Download or upload</small></button>
      <button class="tile" data-rc="restart">${icon('jobs')}Restart<small>With a visible countdown</small></button><button class="tile" data-rc="shutdown">${icon('jobs')}Shut down<small>With a visible countdown</small></button><button class="tile" data-rc="cancel">${icon('jobs')}Cancel<small>A pending restart or shut-down</small></button>`
      : `<button class="tile hot" data-rc="wake">${icon('computers')}Wake up<small>Switch it on over the network</small></button><div class="mute" style="align-self:center;padding:0 10px">This computer is offline, so screen, terminal and files are not available.</div>`}</div>
    <div id="rc-status" class="note" hidden role="status"></div></div>`;
  // The page refreshes itself while you work. The bar stays put (so nothing on the page moves) and is only rebuilt when the computer goes online or offline.
  const bars = [...main.querySelectorAll('.remote-bar')]; const have = bars[0]; const state = (online ? 'online' : 'offline') + ':' + d.id;
  bars.slice(1).forEach(b => b.remove());                  // never more than one, wherever an earlier version put it
  if (have && have.dataset.state === state) return restoreStatus();
  have?.remove();
  const anchor = main.querySelector(':scope > .readout') ?? main.querySelector(':scope > .dossier') ?? main.querySelector(':scope > h1');
  anchor ? anchor.insertAdjacentHTML('afterend', bar) : main.insertAdjacentHTML('afterbegin', bar);
  restoreStatus();
  const on = (k, f) => $(`[data-rc="${k}"]`, main)?.addEventListener('click', f);
  on('watch', () => startSupportSession(d, 'desktop', true)); on('control', () => startSupportSession(d, 'desktop', false));
  on('terminal', () => startSupportSession(d, 'terminal', false)); on('files', () => startSupportSession(d, 'files', false));
  const power = (kind) => async () => {
    const word = kind === 'shutdown' ? 'Shut down' : 'Restart';
    const r = await dialog(`${word} ${d.hostname}`, `<p>The person at the PC sees a countdown and can save their work. Their programs are never force-closed.${kind === 'shutdown' ? ' The PC stays off until someone switches it on, or you use <b>Wake up</b> (a cable-connected PC with Wake-on-LAN allowed).' : ''}</p>
      <label>Countdown</label><select name="delay">${DELAYS.map(([v, l]) => `<option value="${v}" ${v === '60' ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label>Message shown on the PC (optional)</label><input name="message" maxlength="200" placeholder="Please save your work.">`, word, true);
    if (!r) return;
    const params = { delaySeconds: Number(r.delay) }; if (r.message?.trim()) params.message = r.message.trim();
    try { await runJob(kind === 'shutdown' ? 'system.shutdown' : 'system.reboot', params, { deviceIds: [d.id] }); toast(`${word} requested.`); followPower(d, kind, params.delaySeconds); } catch (e) { fail(e); }
  };
  on('restart', power('restart')); on('shutdown', power('shutdown'));
  on('cancel', async () => { try { await runJob('system.reboot-cancel', {}, { deviceIds: [d.id] }); POWER_WATCH?.stop(); toast('Cancel requested. The PC drops the pending restart or shut-down.'); const b = $('#rc-status'); if (b) { b.hidden = false; b.textContent = 'Cancel sent. If a restart or shut-down was pending, it is cancelled.'; } } catch (e) { fail(e); } });
  on('wake', async () => {
    let plan; try { plan = await api(`/api/v1/devices/${d.id}/wake`); } catch (e) { return fail(e); }
    const lines = [`<p>${plan.canWake ? `<b>${esc(plan.relays[0].hostname)}</b> is online on the same network and will send the wake-up signal.` : 'No computer can send the wake-up signal right now.'}</p>`,
      ...plan.reasons.map(x => `<p class="mute">• ${esc(x)}</p>`), plan.adapters.length ? `<p class="mute">Adapter: ${esc(plan.adapters[0].name)} (${plan.adapters[0].wired ? 'cable' : 'Wi-Fi'}${plan.adapters[0].windowsAllows === false ? ', wake turned off in Windows' : ''})</p>` : ''].join('');
    if (!plan.canWake) { await dialog('Wake up ' + d.hostname, lines, ''); return; }
    if (!await dialog('Wake up ' + d.hostname, lines, 'Send wake-up')) return;
    try { await post(`/api/v1/devices/${d.id}/wake`, {}); toast('Wake-up signal requested.'); followPower(d, 'wake', 0); } catch (e) { fail(e); }
  });
});

// A live screen beside a terminal or file session, so you can watch what your work does. It is its own view-only session, recorded like any other.
const SCREEN_SIDE = { ws: null, id: null };
async function closeSideScreen() { const s = { ...SCREEN_SIDE }; SCREEN_SIDE.ws = null; SCREEN_SIDE.id = null; try { s.ws?.close(); } catch { } if (s.id) await post(`/api/v1/support/sessions/${s.id}/end`).catch(() => { }); }
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/session/')) closeSideScreen(); });

const sessionBaseForScreen = VIEWS.session;
VIEWS.session = async (main, id) => {
  await sessionBaseForScreen(main, id);
  if (main.querySelector('#sidescreen') || !can('admin')) return;
  let s; try { s = await api('/api/v1/support/sessions/' + id); } catch { return; }
  if (s.status === 'ended' || s.kind === 'desktop') return;
  main.insertAdjacentHTML('beforeend', `<div class="card" id="sidescreen" data-injected="sidescreen"><div class="row-actions"><h2 style="margin:0">Screen of ${esc(s.hostname)}</h2><button class="ghost" id="ss-toggle">Show screen</button></div><p class="mute" id="ss-note">See what your commands do on the PC itself. View only; it is recorded as its own session.</p><canvas id="ss-cv" class="screen" hidden aria-label="Live screen"></canvas></div>`);
  $('#ss-toggle').onclick = async () => {
    const btn = $('#ss-toggle'), cv = $('#ss-cv'), note = $('#ss-note');
    if (SCREEN_SIDE.ws) { await closeSideScreen(); cv.hidden = true; btn.textContent = 'Show screen'; note.textContent = 'Screen hidden.'; return; }
    btn.disabled = true; note.textContent = 'Asking the PC to share its screen (it checks in every few seconds)…';
    try {
      const n = await post('/api/v1/support/sessions', { deviceId: s.device_id, kind: 'desktop', reason: `Watching the screen alongside a ${s.kind} session` });
      const { ticket } = await post(`/api/v1/support/sessions/${n.id}/ticket`);
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + `://${location.host}/api/v1/support/sessions/${n.id}/ws?ticket=${ticket}`); ws.binaryType = 'blob';
      SCREEN_SIDE.ws = ws; SCREEN_SIDE.id = n.id; const g = cv.getContext('2d');
      ws.onmessage = async ev => {
        if (ev.data instanceof Blob) { const bmp = await createImageBitmap(ev.data); if (cv.width !== bmp.width) { cv.width = bmp.width; cv.height = bmp.height; } g.drawImage(bmp, 0, 0); bmp.close(); cv.hidden = false; note.textContent = 'Live. View only.'; return; }
        const m = JSON.parse(ev.data); if (m.t === 'ready') ws.send(JSON.stringify({ t: 'ds.start', fps: 5, quality: 45 })); if (m.t === 'error') note.textContent = m.message;
      };
      ws.onclose = () => { if (SCREEN_SIDE.ws === ws) { SCREEN_SIDE.ws = null; btn.textContent = 'Show screen'; note.textContent = 'The screen session ended.'; cv.hidden = true; } };
      btn.textContent = 'Hide screen';
    } catch (e) { fail(e); note.textContent = e.message; } finally { btn.disabled = false; }
  };
};
