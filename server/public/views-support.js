'use strict';
/* Remote support: request a session from a computer's page, then work in it here (terminal, files, desktop). */

NAV.splice(NAV.findIndex(n => n[0] === 'audit'), 0, ['support', 'Remote support']);

// The device page offers terminal, files and remote desktop in its "Remote control" bar (views-remote.js); there is no second panel for them.

const KIND_LABEL = { terminal: 'terminal', files: 'file', desktop: 'remote desktop' };
const STATUS_LABEL = { active: 'In progress', requested: 'Waiting for the PC', ended: 'Finished' };
const FOLDER_SVG = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z"/></svg>', FILE_SVG = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/></svg>';

// ---------------------------------------------------------------- history
VIEWS.support = async main => {
  if (!can('admin')) { main.innerHTML = '<div class="card empty">Remote support history is visible to administrators.</div>'; return; }
  const id = null;
  const r = await api('/api/v1/support/sessions');
  main.innerHTML = `<h1>Remote support</h1><p class="lead">Audit record of every remote session: operator, target, reason, outcome.</p>
    ${r.sessions.length ? `<div class="table-wrap"><table><thead><tr><th>Computer</th><th>Type</th><th>Administrator</th><th>Reason</th><th>Status</th><th>Started</th><th>Actions taken</th></tr></thead><tbody>${r.sessions.map(s => `<tr class="row" data-id="${esc(s.id)}"><td><span class="nowrap">${esc(s.hostname)}</span></td><td>${esc(KIND_LABEL[s.kind] ?? s.kind)}</td><td>${esc(s.admin)}</td><td>${esc(s.reason)}</td><td><span class="pill ${s.status === 'active' ? 'running' : s.status === 'requested' ? 'queued' : 'cancelled'}">${esc(STATUS_LABEL[s.status] ?? s.status)}</span>${s.ended_reason ? `<small>${esc(s.ended_reason)}</small>` : ''}</td><td class="nowrap">${s.started_at ? new Date(s.started_at).toLocaleString() : ago(s.requested_at)}</td><td>${s.actions}</td></tr>`).join('')}</tbody></table>` : '<div class="card empty">No support sessions yet. Open a computer from the <a href="#/computers">Computers page</a> to start one.</div>'}
    <div id="detail"></div>`;
  $$('tr.row').forEach(tr => tr.onclick = async () => {
    const s = await api('/api/v1/support/sessions/' + tr.dataset.id);
    $('#detail').innerHTML = `<div class="card"><h2>${esc(s.kind)} session on ${esc(s.hostname)} by ${esc(s.admin)}</h2><div class="kv">${kv('Reason', s.reason)}${kv('Status', s.status + (s.ended_reason ? ' (' + s.ended_reason + ')' : ''))}${kv('Started', s.started_at ? new Date(s.started_at).toLocaleString() : '—')}${kv('Ended', s.ended_at ? new Date(s.ended_at).toLocaleString() : '—')}</div>
      <h3>Recorded activity</h3>${s.events.map(e => `<div class="issue"><span class="pts">${new Date(e.at).toLocaleTimeString()}</span><b>${esc(e.kind)}</b> ${esc(e.detail)}</div>`).join('')}</div>`;
    $('#detail').scrollIntoView();
  });
  poll(15000);
};

// ---------------------------------------------------------------- live session viewer
let ACTIVE_SESSION = null;
VIEWS.session = async (main, id) => {
  if (ACTIVE_SESSION?.id === id && ACTIVE_SESSION.ws.readyState <= 1) return;         // already open: do not rebuild while polling
  const s = await api('/api/v1/support/sessions/' + id);
  if (s.status === 'ended') { location.hash = '#/support'; return; }
  const { ticket } = await post(`/api/v1/support/sessions/${id}/ticket`);
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + `://${location.host}/api/v1/support/sessions/${id}/ws?ticket=${ticket}`);
  ws.binaryType = 'blob';
  ACTIVE_SESSION = { id, ws };
  main.innerHTML = `<a class="back" href="#/support">&larr; Remote support</a><h1 data-eyebrow="REMOTE SUPPORT / SESSION">${esc(s.kind === 'terminal' ? 'Terminal' : s.kind === 'files' ? 'Files' : 'Remote desktop')}: ${esc(s.hostname)}</h1>
    <div class="session-bar"><span class="grow" id="sstate" role="status">Waiting for the computer to join (it checks in every few seconds)…</span><button class="danger" id="send">End session</button></div><div id="body"></div>`;
  const state = t => $('#sstate').textContent = t;
  const body = $('#body'); const send = m => ws.readyState === 1 && ws.send(JSON.stringify(m));
  $('#send').onclick = async () => { send({ t: 'end' }); await post(`/api/v1/support/sessions/${id}/end`).catch(() => {}); };
  const handlers = { 'ready': () => { state('Connected. The person at the PC has been notified.'); start(); } };
  let start = () => {};
  ws.onmessage = async ev => {
    if (ev.data instanceof Blob) return handlers.frame?.(ev.data);
    const m = JSON.parse(ev.data); handlers[m.t]?.(m);
    if (m.t === 'error' || m.t === 'fs.err') toast(m.message);
  };
  ws.onclose = () => { state('Session ended.'); ACTIVE_SESSION = null; $('#send')?.setAttribute('disabled', ''); };

  if (s.kind === 'terminal') {
    body.innerHTML = `<pre id="term" class="term" tabindex="0" aria-label="Terminal output"></pre>
      <div class="cmdline"><input id="cmd" aria-label="Command" placeholder="Type a PowerShell command and press Enter (Up/Down for history)" disabled></div>`;
    const term = $('#term'), cmd = $('#cmd'); const hist = []; let hi = 0;
    const out = t => { term.textContent += t; term.scrollTop = term.scrollHeight; };
    handlers['term.out'] = m => out(m.d); handlers['term.exit'] = m => out(`\n[shell exited with code ${m.code}]\n`);
    start = () => { send({ t: 'term.start' }); cmd.disabled = false; cmd.focus(); out('(PowerShell, running as the agent identity; every command is recorded)\n'); };
    cmd.onkeydown = e => {
      // PowerShell echoes the command itself, so nothing is printed locally
      if (e.key === 'Enter') { const v = cmd.value; hist.push(v); hi = hist.length; send({ t: 'term.in', d: v + '\n' }); cmd.value = ''; }
      else if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); cmd.value = hist[hi] ?? ''; e.preventDefault(); }
      else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); cmd.value = hist[hi] ?? ''; e.preventDefault(); }
    };
  } else if (s.kind === 'files') {
    body.innerHTML = `<div class="bar-tools"><input id="path" aria-label="Folder path" style="flex:1;min-width:200px" value="C:\\Users"><button id="go">Go</button><label class="btn ghost">Upload here…<input type="file" id="up" hidden></label></div><p class="mute" style="margin:0">Click a folder to open it, or a file to download it.</p><div id="list" class="table-wrap" style="margin-top:10px"></div>`;
    let cur = 'C:\\Users'; const chunks = {};
    const ls = p => { cur = p; $('#path').value = p; send({ t: 'fs.ls', path: p }); };
    handlers['fs.ls.r'] = m => {
      cur = m.path; $('#path').value = m.path;
      const parent = m.path.replace(/\\[^\\]+\\?$/, '') || m.path;
      $('#list').innerHTML = `<table><thead><tr><th>Name</th><th>Size</th><th class="hide-sm">Modified</th></tr></thead><tbody>${m.path.length > 3 ? `<tr class="row filerow" data-dir="${esc(parent.length < 3 ? parent + '\\' : parent)}"><td>${FOLDER_SVG} .. (up one folder)</td><td></td><td class="hide-sm"></td></tr>` : ''}${m.entries.sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name)).map(e => `<tr class="row filerow" data-${e.isDir ? 'dir' : 'file'}="${esc(m.path.replace(/\\$/, '') + '\\' + e.name)}"><td>${e.isDir ? FOLDER_SVG : FILE_SVG}${esc(e.name)}</td><td>${e.isDir ? '' : mb(e.size)}</td><td class="hide-sm">${ago(e.modified)}</td></tr>`).join('')}</tbody></table>`;
      $$('[data-dir]').forEach(r => r.onclick = () => ls(r.dataset.dir)); $$('[data-file]').forEach(r => r.onclick = () => { toast('Downloading…'); chunks.name = r.dataset.file.split('\\').pop(); chunks.parts = []; send({ t: 'fs.get', path: r.dataset.file }); });
    };
    handlers['fs.chunk'] = m => { chunks.parts.push(Uint8Array.from(atob(m.d), c => c.charCodeAt(0))); if (m.last) { Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(chunks.parts)), download: chunks.name }).click(); toast('Downloaded ' + chunks.name); } };
    handlers['fs.put.ok'] = m => { toast(`Uploaded ${m.bytes} bytes`); ls(cur); };
    start = () => ls('C:\\Users');
    $('#go').onclick = () => ls($('#path').value); $('#path').onkeydown = e => { if (e.key === 'Enter') ls($('#path').value); };
    $('#up').onchange = async e => {
      const f = e.target.files[0]; if (!f) return; if (f.size > 100 * 2 ** 20) return toast('Files over 100 MB cannot be transferred');
      const target = cur.replace(/\\$/, '') + '\\' + f.name; const overwrite = confirm(`Upload to ${target}? OK replaces an existing file with the same name.`);
      send({ t: 'fs.put', path: target, size: f.size, overwrite }); const buf = new Uint8Array(await f.arrayBuffer());
      for (let o = 0; o < buf.length || o === 0; o += 192 * 1024) { const part = buf.subarray(o, o + 192 * 1024); let bin = ''; part.forEach(b => bin += String.fromCharCode(b)); send({ t: 'fs.chunk', d: btoa(bin), last: o + 192 * 1024 >= buf.length }); if (!buf.length) break; }
    };
  } else {
    // Remote desktop viewer: live numbers, quality presets, fullscreen, typing text, and a switch between watching and controlling.
    const PRESETS = { fast: { label: 'Fast (lower quality)', fps: 12, quality: 40, maxWidth: 960 }, balanced: { label: 'Balanced', fps: 8, quality: 55, maxWidth: 1280 }, sharp: { label: 'Sharp (slower)', fps: 5, quality: 80, maxWidth: 1600 } };
    let controlling = (() => { try { return sessionStorage.getItem('vo:' + id) !== '1'; } catch { return true; } })();
    body.innerHTML = `<div class="dsbar"><label>Quality <select id="ds-q">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}" ${k === 'balanced' ? 'selected' : ''}>${p.label}</option>`).join('')}</select></label>
      <button class="ghost sm" id="ds-mode"></button><button class="ghost sm" id="ds-fit">Actual size</button><button class="ghost sm" id="ds-type">Type text…</button><button class="ghost sm" id="ds-full">Full screen</button>
      <span class="grow"></span><span class="dsstat" id="ds-stat" role="status">Waiting for the first picture…</span></div>
      <p class="mute" id="ds-hint" style="margin:6px 0"></p><div class="dswrap" id="ds-wrap"><canvas id="scr" class="screen" tabindex="0" aria-label="Remote screen"></canvas></div>`;
    const cv = $('#scr'), g = cv.getContext('2d'), wrap = $('#ds-wrap');
    let frames = 0, bytes = 0, t0 = Date.now(), rtt = null, lastFrameAt = 0;
    const hint = () => { $('#ds-mode').textContent = controlling ? 'Switch to watching' : 'Take control'; $('#ds-hint').textContent = controlling ? 'You are controlling this computer: click, type and scroll on the picture. The UAC prompt and lock screen cannot be shown or controlled.' : 'Watching only. Your mouse and keyboard are not sent to the PC.'; cv.style.cursor = controlling ? 'crosshair' : 'default'; };
    hint();
    handlers.frame = async blob => {
      const bmp = await createImageBitmap(blob); if (cv.width !== bmp.width) { cv.width = bmp.width; cv.height = bmp.height; }
      g.drawImage(bmp, 0, 0); bmp.close(); frames++; bytes += blob.size; lastFrameAt = Date.now();
      const dt = (Date.now() - t0) / 1000;
      if (dt >= 1.5) { $('#ds-stat').textContent = `${(frames / dt).toFixed(1)} pictures/s · ${Math.round(bytes / 1024 / dt)} KB/s · ${rtt == null ? 'measuring delay…' : 'delay ' + rtt + ' ms'} · ${cv.width}×${cv.height}`; frames = 0; bytes = 0; t0 = Date.now(); }
    };
    handlers['ds.pong'] = m => { rtt = Math.round(performance.now() - m.ts); };
    handlers.error = m => { $('#ds-stat').textContent = m.message; };
    const ping = setInterval(() => { if (ws.readyState === 1) send({ t: 'ds.ping', ts: performance.now() }); else clearInterval(ping); }, 2000);
    const tune = () => { const p = PRESETS[$('#ds-q').value]; send({ t: 'ds.tune', fps: p.fps, quality: p.quality, maxWidth: p.maxWidth }); };
    start = () => { const p = PRESETS.balanced; send({ t: 'ds.start', fps: p.fps, quality: p.quality }); setTimeout(tune, 600); };
    $('#ds-q').onchange = tune;
    $('#ds-mode').onclick = () => { controlling = !controlling; try { sessionStorage.setItem('vo:' + id, controlling ? '' : '1'); } catch { } hint(); };
    let actual = false; $('#ds-fit').onclick = () => { actual = !actual; cv.classList.toggle('actual', actual); $('#ds-fit').textContent = actual ? 'Fit to window' : 'Actual size'; };
    $('#ds-full').onclick = () => { (document.fullscreenElement ? document.exitFullscreen() : wrap.requestFullscreen?.()); };
    $('#ds-type').onclick = async () => { const r = await dialog('Type text on the computer', '<p>Sends this text as typing to the window that is active on the PC. Good for passwords you copied and long text.</p><textarea name="text" rows="4" style="width:100%" maxlength="2000"></textarea>', 'Type it'); if (r?.text) send({ t: 'ds.text', text: r.text }); };
    const pos = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
    const BTN = ['left', 'middle', 'right']; let lastMove = 0;
    const live = f => e => { if (!controlling) return; f(e); };
    cv.onmousemove = live(e => { if (Date.now() - lastMove > 30) { lastMove = Date.now(); send({ t: 'ds.mouse', ...pos(e), act: 'move' }); } });
    cv.onmousedown = live(e => { cv.focus(); send({ t: 'ds.mouse', ...pos(e), btn: BTN[e.button] ?? 'left', act: 'down' }); e.preventDefault(); });
    cv.onmouseup = live(e => { send({ t: 'ds.mouse', ...pos(e), btn: BTN[e.button] ?? 'left', act: 'up' }); e.preventDefault(); });
    cv.oncontextmenu = e => e.preventDefault();
    cv.onwheel = live(e => { send({ t: 'ds.mouse', ...pos(e), act: 'move', wheel: e.deltaY > 0 ? -1 : 1 }); e.preventDefault(); });
    cv.onkeydown = live(e => { send({ t: 'ds.key', code: e.keyCode, down: true }); e.preventDefault(); });
    cv.onkeyup = live(e => { send({ t: 'ds.key', code: e.keyCode, down: false }); e.preventDefault(); });
  }
};
