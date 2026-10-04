'use strict';
/* Viro WorkCare admin console. Vanilla JS, hash-routed views; each view renders into <main>. */

// ---------------------------------------------------------------- utilities
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '—').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const appSize = b => b == null ? '—' : b >= 2 ** 30 ? (b / 2 ** 30).toFixed(1) + ' GB' : Math.round(b / 2 ** 20) + ' MB';
const gb = b => b == null ? '—' : (b / 2 ** 30).toFixed(1) + ' GB';
const mb = b => b == null ? '—' : b >= 2 ** 30 ? (b / 2 ** 30).toFixed(1) + ' GB' : Math.round(b / 2 ** 20) + ' MB';
const tb = b => b == null ? '—' : b >= 1e12 ? (b / 1e12).toFixed(1) + ' TB' : (b / 1e9).toFixed(0) + ' GB';
const ago = iso => { if (!iso) return 'never'; const s = (Date.now() - new Date(iso)) / 1000; return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
const uptime = s => s == null ? '—' : Math.floor(s / 86400) + 'd ' + Math.floor(s % 86400 / 3600) + 'h';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const STAT = { healthy: 'Healthy', attention: 'Needs attention', critical: 'Critical' };
const pill = (st, label) => st ? `<span class="pill ${esc(st)}">${esc(label ?? STAT[st] ?? st)}</span>` : '<span class="pill unassessed">not assessed</span>';
const bar = (n, st) => `<div class="bar ${st}"><i style="width:${n}%"></i></div>`;
const catSt = n => n >= 80 ? 'healthy' : n >= 60 ? 'attention' : 'critical';
const CATS = { security: 'Security', performance: 'Performance', storage: 'Storage', updates: 'Updates', drivers: 'Drivers', reliability: 'Reliability', hardware: 'Hardware' };
const SAFE_CLEAN = ['windows-temp', 'user-temp', 'crash-dumps', 'update-leftovers', 'browser-cache', 'thumbnail-cache', 'old-logs'];
const emptyState = (ic, title, text = '') => `<div class="card empty">${icon(ic)}<b>${esc(title)}</b>${text ? `<p>${text}</p>` : ''}</div>`;
const kv = (l, v) => `<div><span>${esc(l)}</span>${esc(v)}</div>`;
const JOB_LABEL = { 'health.check': 'Health check', 'inventory.refresh': 'Inventory refresh', 'hardware.diagnose': 'Hardware diagnosis', 'repair.run': 'Repair', 'repair.fix-safe': 'Fix my PC', 'repair.rollback': 'Undo a repair', 'cleanup.preview': 'Cleanup scan', 'cleanup.run': 'Cleanup', 'service.restart': 'Restart a service',
  'anatomy.collect': 'Read hardware details', 'app.repair': 'Repair an app', 'app.update': 'Update an app', 'apps.end-hung': 'Close frozen apps', 'battery.diagnose': 'Battery check', 'benchmark.run': 'Speed test', 'benchmark.upgrade': 'Upgrade speed test',
  'driver.install': 'Install a driver', 'driver.rollback': 'Roll back a driver', 'memory.analyze': 'Memory check', 'message.send': 'Message to the user', 'persistence.hunt': 'Start-up threat hunt', 'security.investigate': 'Security investigation', 'security.remediate': 'Security clean-up', 'security.scan': 'Virus scan', 'security.status': 'Security check', 'security.update-signatures': 'Update virus definitions',
  'software.check-updates': 'Check app updates', 'software.install': 'Install software', 'software.uninstall': 'Uninstall software', 'software.update': 'Update software', 'startup.disable': 'Turn off a start-up item', 'startup.enable': 'Turn on a start-up item', 'startup.inspect': 'Start-up check', 'startup.quarantine': 'Quarantine a start-up item', 'startup.restore': 'Restore a start-up item',
  'system.reboot': 'Restart', 'system.reboot-cancel': 'Cancel a restart or shut-down', 'system.shutdown': 'Shut down', 'ui.notify': 'Notice to the user', 'updates.install': 'Install Windows updates', 'updates.scan': 'Check for Windows updates', 'wol.send': 'Wake a PC' };
const jobLabel = j => (JOB_LABEL[j.type] ?? j.type) + (j.params?.recipe ? ' · ' + j.params.recipe : j.params?.name ? ' · ' + j.params.name : '');

let token = sessionStorage.getItem('viro_token');
let ME = null;

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) } });
  if (r.status === 401 && token) { logout(); throw new Error('session expired'); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.message ?? (body.error ? body.error + (body.details ? ': ' + body.details.map(d => d.message).join('; ') : '') : r.statusText)), { code: body.error });
  return body;
}
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b ?? {}) });
const patch = (p, b) => api(p, { method: 'PATCH', body: JSON.stringify(b ?? {}) });
const del = p => api(p, { method: 'DELETE' });
const runJob = (type, params, target) => post('/api/v1/jobs', { type, params, target });

let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 4500); }
const fail = e => toast('Error: ' + e.message);

/** Modal dialog. `body` is HTML; resolves to the FormData object on OK, null on cancel. */
function dialog(title, body, okLabel = 'OK', danger = false) {
  const d = $('#dlg');
  d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${body}<div class="foot"><button type="button" class="ghost" data-cancel>Cancel</button><button class="${danger ? 'danger' : ''}" value="ok">${esc(okLabel)}</button></div></form>`;
  return new Promise(res => {
    $('[data-cancel]', d).onclick = () => { d.close(); res(null); };
    d.onclose = () => res(d.returnValue === 'ok' ? Object.fromEntries(new FormData($('form', d))) : null);
    d.showModal();
  });
}
const confirmBox = (title, text, ok = 'Confirm', danger = false) => dialog(title, `<p>${esc(text)}</p>`, ok, danger).then(r => !!r);

// ---------------------------------------------------------------- auth + shell
function logout() { sessionStorage.removeItem('viro_token'); token = null; ME = null; route(); }

function loginView(msg = '', creds = null) {
  const second = !!creds;       // the password was right and this person has two-step sign-in: ask for the code
  $('#app').innerHTML = `<div class="signin"><div class="art">${window.heroVideoHtml ? window.heroVideoHtml() : ''}<div class="brand"><span class="logo"><img src="logo.png" alt="" width="42" height="42"></span><span class="word"><b>Viro</b><small>WORKCARE</small></span></div>
    <div><h2>Your PCs, looked after.</h2><p>Health, security, updates and repairs for every computer in your organization, handled quietly and verified.</p>
    <ul><li>${icon('security')}Protection that is checked, not assumed</li><li>${icon('autopilot')}Fixes run by themselves, in your maintenance window</li><li>${icon('reports')}Every change recorded and reversible</li></ul></div><span></span></div>
    <div class="formside"><form class="login" id="f"><div class="logo">${icon('security')}</div><h1>${second ? 'Verify it is you' : 'Welcome back'}</h1><span class="mute">${second ? 'Enter the 6-digit code from your authenticator app, or a recovery code' : 'Sign in to your organization'}</span>
    ${second ? `<label for="l-code">Code</label><input id="l-code" name="code" inputmode="text" autocomplete="one-time-code" placeholder="123456" required autofocus>`
    : `<label for="l-email">Email</label><input id="l-email" name="email" type="email" placeholder="you@company.com" autocomplete="username" required autofocus>
    <label for="l-pw">Password</label><input id="l-pw" name="password" type="password" placeholder="Your password" autocomplete="current-password" required>`}
    <button>${second ? 'Verify' : 'Sign in'}</button>${second ? '<button type="button" class="ghost" id="back">Back</button>' : ''}<span class="err" role="alert">${esc(msg === '' ? '' : msg)}</span></form><p class="mute signin-about">${second ? '' : 'New here? <a href="#" id="newacct">Create a personal account</a> · '}<a href="/site/">About Viro WorkCare</a> · <a href="/site/contact.html">Contact us</a></p></div></div>`;
  if (second) $('#back').onclick = () => loginView();
  if (!second && /[?&]signup\b/.test(location.search) && !window.__signupShown) { window.__signupShown = true; setTimeout(() => $('#newacct')?.click(), 50); }
  $('#newacct')?.addEventListener('click', async e => {
    e.preventDefault();
    const v = await dialog('Create a personal account', '<p class="mute">For your own PC or a few PCs at home. You will confirm your email address before you can sign in.</p><label>Your name</label><input name="name" required minlength="2" autocomplete="name"><label>Email</label><input name="email" type="email" required autocomplete="email"><label>Password (10 or more characters)</label><input name="password" type="password" required minlength="10" autocomplete="new-password"><label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="terms" required style="margin-top:4px"><span>I agree to the <a href="/site/terms.html" target="_blank" rel="noopener">terms</a> and <a href="/site/privacy.html" target="_blank" rel="noopener">privacy notice</a>.</span></label>', 'Create account');
    if (!v) return;
    try { const r = await post('/api/v1/signup', { name: v.name, email: v.email, password: v.password, acceptTerms: true }); loginView(r.message); } catch (x) { loginView(x.message); }
  });
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target)), body = second ? { ...creds, code: f.code.trim() } : f;
    try { const r = await post('/api/v1/auth/login', body); token = r.token; sessionStorage.setItem('viro_token', token); route(); }
    catch (x) { x.message === 'mfa_required' ? loginView('', { email: body.email, password: body.password }) : loginView(x.message, second ? creds : null); }
  };
}

const NAV = [
  ['overview', 'Overview'], ['computers', 'Computers'], ['alerts', 'Alerts'], ['jobs', 'Jobs'], ['policies', 'Policies'],
  ['security', 'Security'], ['software', 'Software'], ['drivers', 'Drivers'], ['updates', 'Updates'], ['sites', 'Sites & groups'], ['reports', 'Reports'], ['audit', 'Audit log'],
];
const can = role => ({ viewer: 1, technician: 2, admin: 3, owner: 4 }[ME.role] >= { viewer: 1, technician: 2, admin: 3, owner: 4 }[role]);

// Line icons (24px grid). Every screen uses these through icon(name) so the whole console shares one visual language.
const ICON_PATHS = {
  billing: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h4"/>',
  overview: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  computers: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  alerts: '<path d="M6 16v-5a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 21h4"/>',
  jobs: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  policies: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  security: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 5-5"/>',
  software: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5L12 12l8-4.5M12 12v9"/>',
  drivers: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  updates: '<path d="M12 4v11M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  sites: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M11 7.3L6 16.7M13 7.3l5 9.4M7.5 19h9"/>',
  reports: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-3"/>',
  audit: '<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4M10 12h6M10 16h6"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  compute: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  autopilot: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  webhooks: '<path d="M4 12l16-8-6 16-3-7z"/>',
  support: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/><path d="M5.6 5.6l3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9"/>',
};
const icon = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] ?? '<circle cx="12" cy="12" r="8"/>'}</svg>`;
Object.assign(ICON_PATHS, {
  care: '<path d="M14.5 5.5a4 4 0 00-5 5L4 16l4 4 5.5-5.5a4 4 0 005-5l-2.5 2.5-2.5-.5-.5-2.5z"/>',
  protection: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  threats: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  lifecycle: '<path d="M20 12a8 8 0 11-2.3-5.7"/><path d="M20 4v4h-4"/>',
  fleet: '<rect x="3" y="4" width="8" height="6" rx="1.5"/><rect x="13" y="4" width="8" height="6" rx="1.5"/><rect x="8" y="14" width="8" height="6" rx="1.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  signout: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>',
  theme: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/>',
});
// Navigation is grouped: one heading per kind of task instead of a flat row of icons. Pages not listed here still appear, under "More".
const NAV_GROUPS = [
  ['Home', ['overview', 'autopilot', 'alerts']],
  ['Computers', ['computers', 'sites', 'fleet']],
  ['Security', ['security', 'protection', 'threats', 'care']],
  ['Hardware', ['anatomy', 'upgrades', 'lifecycle']],
  ['Compute', ['compute']],
  ['Maintenance', ['jobs', 'policies', 'updates', 'software', 'drivers', 'support']],
  ['Administration', ['reports', 'team', 'billing', 'webhooks', 'settings', 'audit', 'about']],
];
const NAV_LABEL = { overview: 'Overview', computers: 'Computers', alerts: 'Alerts', jobs: 'Jobs', policies: 'Policies', security: 'Security', software: 'Software', drivers: 'Drivers', updates: 'Updates', sites: 'Sites', reports: 'Reports', audit: 'Audit log', about: 'About',
  protection: 'Protection', threats: 'Threats', care: 'Care', anatomy: 'Hardware', upgrades: 'Upgrades', lifecycle: 'Lifecycle', fleet: 'Shared problems', autopilot: 'Autopilot', compute: 'Compute', support: 'Remote support', webhooks: 'Integrations', team: 'Team', billing: 'Plan and payments', settings: 'Settings' };
// Compute sponsorship is parked: its page is offered only to organizations that are actually on that plan, so nobody else sees a feature they cannot use.
const PLAN_ONLY = { compute: 'compute_sponsored' };
function navGroups() {
  const plan = ME?.organization?.plan;
  const have = new Map(NAV.filter(([id]) => VIEWS[id] && (!PLAN_ONLY[id] || PLAN_ONLY[id] === plan)));
  const label = id => NAV_LABEL[id] ?? have.get(id);
  const placed = new Set(NAV_GROUPS.flatMap(([, ids]) => ids));
  const groups = NAV_GROUPS.map(([g, ids]) => [g, ids.filter(i => have.has(i)).map(i => [i, label(i)])]);
  const rest = [...have.keys()].filter(id => !placed.has(id)).map(id => [id, label(id)]);
  if (rest.length) groups.push(['More', rest]);
  return groups.filter(([, items]) => items.length);
}
// Appearance: follow the system by default; the reader can pick light or dark and it is remembered.
const themeNow = () => document.documentElement.dataset.theme ?? 'auto';
const themeLabel = () => ({ auto: 'Appearance: automatic', light: 'Appearance: light', dark: 'Appearance: dark' }[themeNow()]);
function cycleTheme() { const next = { auto: 'light', light: 'dark', dark: 'auto' }[themeNow()]; next === 'auto' ? delete document.documentElement.dataset.theme : document.documentElement.dataset.theme = next; store.set('viro_theme', next); }
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

function shell(active) {
  if ($('#shell')) {
    $$('#side nav a').forEach(a => { const on = a.dataset.nav === active; a.classList.toggle('active', on); on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
    $$('#side .grp').forEach(g => { if (g.querySelector('a.active')) setGroup(g, true); });
    document.body.classList.remove('nav-open');
    return $('main');
  }
  const org = ME.organization.name;
  // First visit: only Home and the page being viewed are open; after that the reader's own choices are remembered.
  const closed = closedGroups();
  const groups = navGroups().map(([g, items]) => {
    const open = !closed.has(g) || items.some(([id]) => id === active);
    const links = items.map(([id, l]) => `<a href="#/${id}" data-nav="${id}" class="${id === active ? 'active' : ''}" ${id === active ? 'aria-current="page"' : ''}>${icon(id)}<span>${esc(l)}</span>${id === 'alerts' ? '<span class="badge" id="alertbadge" hidden></span>' : ''}</a>`).join('');
    return `<section class="grp" data-g="${esc(g)}"><button type="button" class="grp-h" aria-expanded="${open}">${esc(g)}${icon('chevron')}</button><div class="grp-b" ${open ? '' : 'hidden'}>${links}</div></section>`;
  }).join('');
  $('#app').innerHTML = `<div id="shell"><aside id="side">
    <div class="brand"><span class="logo"><img src="logo.png" alt="" width="42" height="42"></span><span class="word"><b>Viro</b><small>WORKCARE</small></span></div>
    <label class="navsearch">${icon('search')}<input type="search" id="navq" placeholder="Find a page" aria-label="Find a page" autocomplete="off"><kbd>/</kbd></label>
    <nav aria-label="Main">${groups}<p class="nomatch" hidden>No page matches.</p></nav>
    <details class="acct"><summary><span class="avatar">${esc(org.trim().slice(0, 1).toUpperCase())}</span><span class="who"><b>${esc(org)}</b><small>${esc(ME.role)}</small></span>${icon('chevron')}</summary>
      <div class="menu"><a href="#" id="theme">${icon('theme')}<span>${themeLabel()}</span></a><a href="#" id="logout">${icon('signout')}Sign out</a></div></details>
  </aside>
  <div id="content"><div id="statusbar" role="status"><span class="state" id="sb-state"><i class="led"></i><span>Linking</span></span><span class="sep"></span><span>Computers <b id="sb-eps">—</b></span><span>Online <b id="sb-on">—</b></span><span>Open alerts <b id="sb-al">—</b></span><span class="sep"></span><span>Last check <b id="sb-sync">—</b></span><span class="sb-clock" id="sb-clock"></span></div><header id="mobilebar"><button type="button" class="ghost" id="navtoggle" aria-label="Open menu">${icon('menu')}</button><img src="logo.png" alt="" width="28" height="28" style="border-radius:8px"><b>Viro WorkCare</b></header><main></main></div>
  <div id="scrim"></div></div>`;
  $('#logout').onclick = e => { e.preventDefault(); logout(); };
  $('#theme').onclick = e => { e.preventDefault(); cycleTheme(); $('#theme span').textContent = themeLabel(); };
  $('#navtoggle').onclick = () => document.body.classList.toggle('nav-open');
  $('#scrim').onclick = () => document.body.classList.remove('nav-open');
  $$('#side .grp-h').forEach(h => h.onclick = () => setGroup(h.closest('.grp'), h.getAttribute('aria-expanded') !== 'true', true));
  const q = $('#navq');
  q.oninput = () => filterNav(q.value);
  q.onkeydown = e => {
    if (e.key === 'Enter') { const a = $('#side nav a:not([hidden])'); if (a) { location.hash = a.getAttribute('href'); q.value = ''; filterNav(''); q.blur(); } }
    else if (e.key === 'Escape') { q.value = ''; filterNav(''); q.blur(); }
  };
  addEventListener('keydown', e => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !e.ctrlKey && !e.metaKey && $('#navq')) { e.preventDefault(); document.body.classList.add('nav-open'); $('#navq').focus(); }
  });
  keepPlace($('main'));
  new MutationObserver(() => wrapTables($('main'))).observe($('main'), { childList: true, subtree: true });
  return $('main');
}
function closedGroups() { const saved = store.get('viro_nav_closed'); return new Set(saved === null ? navGroups().map(([g]) => g).filter(g => g !== 'Home') : saved.split('|').filter(Boolean)); }
function setGroup(g, open, remember = false) {
  g.querySelector('.grp-h').setAttribute('aria-expanded', String(open)); g.querySelector('.grp-b').hidden = !open;
  if (!remember) return;
  const closed = closedGroups(); open ? closed.delete(g.dataset.g) : closed.add(g.dataset.g); store.set('viro_nav_closed', [...closed].join('|'));
}
// Earlier names and other words people use, so a search for them still finds the page.
const NAV_ALIASES = { about: 'company contact phone email address who we are orange mobility', overview: 'command home dashboard', computers: 'endpoints pcs devices machines', security: 'defense antivirus', protection: 'hardening', threats: 'incidents malware', care: 'upkeep heat battery', jobs: 'task log tasks', updates: 'patches windows update', support: 'remote ops remote help', audit: 'audit trail log history', fleet: 'fleet intel shared', anatomy: 'parts hardware age' };
function filterNav(text) {
  const t = text.trim().toLowerCase(); let any = false;
  const closed = closedGroups();
  $$('#side .grp').forEach(g => {
    let hit = false;
    $$('a', g).forEach(a => { const m = !t || a.textContent.toLowerCase().includes(t) || (NAV_ALIASES[a.getAttribute('href').slice(2)] ?? '').includes(t) || g.dataset.g.toLowerCase().includes(t); a.hidden = !m; hit ||= m; });
    g.hidden = !hit; any ||= hit;
    setGroup(g, t ? hit : !closed.has(g.dataset.g) || !!g.querySelector('a.active'));
  });
  $('#side .nomatch').hidden = any;
}
let lastSync = 0;
/** The strip across the top: overall state, counts, and how fresh the data is. */
async function refreshStatus() {
  try {
    const o = await api('/api/v1/overview'); lastSync = Date.now();
    const crit = o.alerts?.critical ?? 0, warn = o.alerts?.warning ?? 0, unack = (o.alertsUnacknowledged?.critical ?? 0) + (o.alertsUnacknowledged?.warning ?? 0);
    const [cls, text] = !o.computers ? ['', 'No computers'] : !o.online ? ['warn', 'Nothing online'] : crit ? ['bad', 'Needs attention'] : (unack || o.attention) ? ['warn', 'Needs a look'] : (crit + warn) ? ['', 'Watching'] : o.unassessed === o.computers ? ['', 'Waiting for reports'] : ['', 'All clear'];
    const st = $('#sb-state'); if (!st) return; st.className = 'state ' + cls; st.lastElementChild.textContent = text;
    $('#sb-eps').textContent = o.computers; $('#sb-on').textContent = o.online; $('#sb-al').textContent = crit + warn;
  } catch { /* the strip is decoration: never break a page */ }
}
if (!window.__sbTimer) window.__sbTimer = setInterval(() => {
  const c = $('#sb-clock'); if (!c) return; const n = new Date(); c.textContent = n.toLocaleTimeString([], { hour12: false }) + ' · ' + n.toLocaleDateString([], { day: '2-digit', month: 'short' }).toUpperCase();
  const s = $('#sb-sync'); if (s && lastSync) { const t = Math.round((Date.now() - lastSync) / 1000); s.textContent = t < 90 ? t + 's ago' : Math.round(t / 60) + 'm ago'; }
}, 1000);
// Reading the Alerts page counts as having seen what is on it: the badge then shows only alerts that arrived since (and that nobody has acknowledged).
const alertsSeenKey = () => 'viro_alerts_seen_' + (ME?.userId ?? '');
const alertsSeen = () => Number(store.get(alertsSeenKey()) ?? 0) || 0;
const markAlertsSeen = alerts => { const top = alerts.reduce((m, a) => Math.max(m, Number(a.id) || 0), alertsSeen()); store.set(alertsSeenKey(), String(top)); };
async function refreshBadge() {
  try {
    const a = await api('/api/v1/alerts?status=open&limit=200'); const seen = alertsSeen();
    const n = a.alerts.filter(x => !x.acknowledged_at && Number(x.id) > seen).length;
    const b = $('#alertbadge'); if (b) { b.textContent = n; b.hidden = !n; }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- keeping the reader's place
// Pages refresh themselves and fill in panels as their data arrives. The reader must never lose their place, so a refresh changes only the cards whose content
// changed (every other card stays exactly where it is), late panels are replaced in place instead of removed and rebuilt, and the refresh waits while the reader is scrolling.
const OPEN_SECTIONS = new Set(); let lastY = 0, lastInputAt = 0, restoring = false;
const sectionKey = d => location.hash.split('?')[0] + '|' + (d.querySelector('summary')?.textContent ?? '').trim();
for (const ev of ['wheel', 'touchmove', 'keydown', 'mousedown']) addEventListener(ev, () => { lastInputAt = Date.now(); }, { passive: true, capture: true });
function keepPlace(main) {
  document.addEventListener('toggle', e => { const d = e.target; if (d.tagName === 'DETAILS' && main.contains(d)) d.open ? OPEN_SECTIONS.add(sectionKey(d)) : OPEN_SECTIONS.delete(sectionKey(d)); }, true);
  addEventListener('scroll', () => { if (!restoring) lastY = window.scrollY; }, { passive: true });
  addEventListener('hashchange', () => { lastY = 0; window.scrollTo(0, 0); });               // another page starts at its top
  new MutationObserver(() => {
    main.querySelectorAll('details').forEach(d => { if (!d.open && OPEN_SECTIONS.has(sectionKey(d))) d.open = true; });
    // If the page moved by itself (its height changed under the reader) put the reader back; if the reader is the one moving, leave them alone.
    if (lastY > 0 && Date.now() - lastInputAt > 700 && Math.abs(window.scrollY - lastY) > 2) { restoring = true; window.scrollTo(0, lastY); requestAnimationFrame(() => { restoring = false; }); }
  }).observe(main, { childList: true, subtree: true });
}
/** Changes only what changed. Panels filled in later (the placeholders below, and cards marked data-injected) are left alone here and refreshed in place by whoever fills them. */
const PLACEHOLDERS = /^care-(top|low)$/;
function morph(target, html) {
  const tpl = document.createElement('template'); tpl.innerHTML = html;
  const next = [...tpl.content.children], cur = [...target.children].filter(e => !e.hasAttribute('data-injected'));
  let i = 0;
  for (; i < next.length; i++) {
    const n = next[i], c = cur[i];
    if (!c) { const first = target.querySelector(':scope > [data-injected]'); first ? target.insertBefore(n, first) : target.append(n); continue; }
    if (n.id && c.id === n.id && PLACEHOLDERS.test(n.id)) continue;       // keep what is already shown until the new data arrives
    if (c.outerHTML !== n.outerHTML) c.replaceWith(n);
  }
  for (; i < cur.length; i++) cur[i].remove();
}

// ---------------------------------------------------------------- router
const VIEWS = {};
let pollTimer, routeGen = 0;
// `keep` is true when the page is only being refreshed in place (the timer, a checkbox, a filter): the reader's place on the page must not move.
async function route(keep = false) {
  clearTimeout(pollTimer);
  if (!token) return loginView();
  try { ME ??= await api('/api/v1/me'); } catch { return loginView(); }
  let [, name = 'overview', arg] = (location.hash || '#/overview').split('?')[0].split('/');
  if (ME.mfaSetupRequired && name !== 'settings') { name = 'settings'; history.replaceState(null, '', '#/settings'); }
  const view = VIEWS[name] ?? VIEWS.overview;
  const mainEl = shell(VIEWS[name] ? name : 'overview');
  // A slow page must never overwrite the page the user has since moved to: writes from a superseded navigation are dropped.
  const gen = ++routeGen;
  const main = new Proxy(mainEl, {
    set(t, k, v) {
      if (gen !== routeGen) return true;
      if (k !== 'innerHTML') { t[k] = v; return true; }
      if (!keep) { t.innerHTML = v; t.__html = v; return true; }
      if (t.__html === v) return true;                                              // nothing changed: leave the page exactly as it is
      morph(t, v); t.__html = v; return true;
    },
    get(t, k) {
      if (k === 'appendChild') return node => {
        // A card added after the page's data arrives replaces its previous version where it stands (matched by its heading), instead of being deleted and rebuilt.
        if (gen !== routeGen) return node;
        const key = node.querySelector?.('h2')?.textContent ?? node.id ?? ''; node.setAttribute('data-injected', key);
        const old = keep && key ? [...t.children].find(e => e.getAttribute('data-injected') === key) : null;
        old ? old.replaceWith(node) : t.appendChild(node); return node;
      };
      const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
    } });
  try { await view(main, arg); decorateHeading(mainEl, VIEWS[name] ? name : 'overview'); } catch (e) { if (token && gen === routeGen) mainEl.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  refreshBadge(); refreshStatus();
}
addEventListener('hashchange', () => route(false));          // going to another page starts at its top
const reroute = () => route(true);
// The timed refresh never fights the reader: it waits while a field has focus, text is selected, a dialog is open, or a live session is running.
const userIsBusy = () => { if (Date.now() - lastInputAt < 2500) return true; const a = document.activeElement; return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) || (getSelection()?.toString().length ?? 0) > 0 || !!document.querySelector('dialog[open], .scrim') || location.hash.startsWith('#/session/'); };
const poll = ms => { clearTimeout(pollTimer); pollTimer = setTimeout(() => { if (document.visibilityState === 'visible' && !userIsBusy()) route(true); else poll(ms); }, ms); };

/** Wide tables scroll inside their own box instead of clipping or pushing the page sideways. */
function wrapTables(root) { root.querySelectorAll('table').forEach(t => { if (!t.parentElement.classList.contains('table-wrap')) { const w = document.createElement('div'); w.className = 'table-wrap'; t.replaceWith(w); w.appendChild(t); } }); }
/** A sticky index of a long page's sections. Sections arrive asynchronously, so it rebuilds (idempotently) as they appear. */
function jumpBar(proxy) {
  const main = $('main'); let t;
  const build = () => {
    // The label is the heading's own words only: badges and notes inside it ("unknown", "no antivirus") are not part of its name.
    const sectionLabel = h => (([...h.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()) || h.textContent).replace(/\s*[·(].*$/, '').trim().slice(0, 26);
    const heads = [...main.querySelectorAll(':scope > .card > h2, :scope > h3')].filter(h => h.textContent.trim() && !h.closest('.jump'));
    if (heads.length < 4) return;
    heads.forEach((h, i) => { (h.closest('.card') ?? h).id ||= 'sec-' + i; });
    const html = heads.map(h => `<a href="#" data-jump="${(h.closest('.card') ?? h).id}">${esc(sectionLabel(h))}</a>`).join('');
    let nav = main.querySelector(':scope > .jump');
    if (!nav) { nav = document.createElement('nav'); nav.className = 'jump'; nav.setAttribute('aria-label', 'Sections'); (main.querySelector('.readout') ?? main.firstElementChild).after(nav); }
    if (nav.__html !== html) { nav.innerHTML = html; nav.__html = html; nav.onclick = e => { const a = e.target.closest('[data-jump]'); if (a) { e.preventDefault(); document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }; }
  };
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(build, 350); }).observe(main, { childList: true, subtree: true });
  setTimeout(build, 600);
}
/** Every page gets its own icon beside the title, so screens are recognisable at a glance. */
function decorateHeading(mainEl, id) {
  if (gen_ok(mainEl)) { wrapTables(mainEl); const h = mainEl.querySelector('.page-head h1, :scope > h1, h1'); const grp = navGroups().find(([, items]) => items.some(([i]) => i === id)); if (h && grp && !h.dataset.eyebrow) h.dataset.eyebrow = (grp[0] === (NAV_LABEL[id] ?? id) ? grp[0] : grp[0] + ' / ' + (NAV_LABEL[id] ?? id)).toUpperCase(); if (h && !h.querySelector('.h1-ico') && ICON_PATHS[id]) h.insertAdjacentHTML('afterbegin', `<span class="h1-ico">${icon(id)}</span>`); }
}
const gen_ok = el => !!el && el.isConnected;

// ---------------------------------------------------------------- overview
/** "What Viro did": only counts from verified incident and service records; nothing estimated. */
function outcomesHtml(o) {
  const n = (v, w) => `<div class="fact"><b>${v}</b><span>${w}</span></div>`;
  const any = o.verifiedFixes || o.recurringCrashesStopped || o.driversStabilized || o.windowsRepairs || o.storageRecoveredBytes || o.failingDrivesDetected || o.now.hardwareAction || o.now.repairsInProgress;
  return `<div class="card"><h2>What Viro has done <span class="mute">· last ${o.periodDays} days</span></h2>${any ? `<div class="facts">
    ${n(o.verifiedFixes, 'problems fixed and verified')}${o.recurringCrashesStopped ? n(o.recurringCrashesStopped, 'recurring crashes stopped') : ''}${o.storageRecoveredBytes ? n(mb(o.storageRecoveredBytes), 'storage recovered') : ''}
    ${o.driversStabilized ? n(o.driversStabilized, 'drivers stabilized') : ''}${o.windowsRepairs ? n(o.windowsRepairs, 'Windows repairs') : ''}${o.failingDrivesDetected ? n(o.failingDrivesDetected, 'failing drives detected') : ''}</div>
    <p class="mute" style="margin:8px 0 0">${o.now.repairsInProgress ? `${plural(o.now.repairsInProgress, 'repair')} in progress or being checked. ` : ''}${o.now.hardwareAction ? `${plural(o.now.hardwareAction, 'computer problem')} need a hardware repair. ` : ''}${o.verifiedFixRate != null ? `${o.verifiedFixRate}% of repair attempts were verified as fixed.` : ''}${o.reopenedIncidents ? ` ${plural(o.reopenedIncidents, 'problem')} came back and were reopened.` : ''}</p>`
    : '<p class="mute" style="margin:0">Nothing to report yet. Repairs appear here only after Viro has verified that they worked.</p>'}</div>`;
}
VIEWS.overview = async main => {
  const [d, ov, sr, ap, oc] = await Promise.all([api('/api/v1/devices'), api('/api/v1/overview'), api('/api/v1/storage/recovery'), api('/api/v1/autopilot').catch(() => null), api('/api/v1/outcomes').catch(() => null)]);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const answer = !ov.computers ? 'No computers are enrolled yet.' : ov.critical ? `${plural(ov.critical, 'computer')} ${ov.critical === 1 ? 'needs' : 'need'} urgent attention.` : ov.attention ? `${plural(ov.attention, 'computer')} ${ov.attention === 1 ? 'needs' : 'need'} attention.` : ov.unassessed === ov.computers ? 'Waiting for first health reports.' : 'Your organization is healthy.';
  const assessed = ov.computers - ov.unassessed;
  const avg = ov.averageHealth ?? 0, gStatus = avg < 60 ? 'critical' : avg < 80 ? 'attention' : '';
  const onlinePct = ov.computers ? Math.round(ov.online / ov.computers * 100) : 0;
  const nAlerts = (ov.alerts.critical ?? 0) + (ov.alerts.warning ?? 0);
  const nUnack = ((ov.alertsUnacknowledged ?? {}).critical ?? 0) + ((ov.alertsUnacknowledged ?? {}).warning ?? 0);
  const apOn = !!(ap && ap.exists && ap.enabled);
  const stat = (href, n, label, tone = '', ic = 'computers') => `<a class="stat-tile ${tone}" href="${href}"><span class="ico">${icon(ic)}</span><b>${n}</b><span>${label}</span></a>`;
  const chip = (tone, text) => `<span class="chip ${tone}"><i></i>${text}</span>`;
  const headline = !ov.computers ? 'No computers added yet.' : !ov.online ? 'No computers are online.' : ov.critical ? 'Action required.' : (ov.attention || nUnack) ? 'Needs attention.' : ov.unassessed === ov.computers ? 'Waiting for first health reports.' : nAlerts ? 'Nothing new needs you.' : 'All clear.';
  const detail = !ov.computers ? 'Install the agent on a PC to begin monitoring.' : !ov.online ? `${plural(ov.computers, 'computer')} enrolled, but none has reported in the last few minutes.${ov.healthy ? ' Last known: ' + ov.healthy + ' healthy.' : ''}` : `${plural(ov.computers, 'computer')} enrolled, ${ov.online} online. ${ov.critical ? plural(ov.critical, 'critical fault') + '. ' : ''}${ov.attention ? plural(ov.attention, 'computer') + ' flagged. ' : ''}${ov.healthy ? ov.healthy + ' healthy.' : ''}`;
  main.innerHTML = `<div class="hero-card">${window.heroVideoHtml ? window.heroVideoHtml() : ''}<span class="eyebrow">${esc(greet)}, ${esc(ME.organization.name)}</span><h1>${headline}</h1><p class="lead">${esc(detail)}</p>
      <div class="chips">${ov.computers ? chip(ov.online ? '' : 'warn', plural(ov.online, 'computer') + ' online') : ''}${chip(ov.alerts.critical ? 'bad' : nUnack ? 'warn' : '', nUnack ? plural(nUnack, 'alert') + ' to review' : nAlerts ? plural(nAlerts, 'alert') + ' acknowledged' : 'No open alerts')}${chip(apOn ? '' : 'warn', apOn ? 'Autopilot on' : 'Autopilot off')}</div>
      ${can('admin') ? '<div class="hero-actions"><button id="addpc2" class="ghost">Add computers</button></div>' : ''}</div>
    ${!ov.computers ? `<div class="card"><h2>Add your first computer</h2><p class="mute">Download one installer and run it on each PC. There is nothing to configure.</p>${can('admin') ? '<div class="actions"><button id="addpc">Add computers</button></div>' : '<p class="mute">Ask an administrator to add computers.</p>'}</div>` : ''}
    <div class="stat-tiles">
      ${stat('#/computers', ov.computers, 'Computers', '', 'computers')}
      ${stat('#/computers', ov.online, 'Online now', '', 'overview')}
      ${stat('#/alerts', nAlerts, 'Open alerts', ov.alerts.critical ? 'bad' : nUnack ? 'warn' : '', 'alerts')}
      ${stat('#/security', ov.security.needAttention, 'Security flags', ov.security.needAttention ? 'warn' : '', 'security')}
    </div>
    <div class="dash">
      <div class="card"><h2>Health</h2><div class="gauges">
        <div class="gauge-wrap"><div class="gauge ${gStatus}" style="--p:${avg}"><div><strong>${ov.averageHealth ?? '—'}</strong><small>/ 100</small></div></div><span>average of ${assessed} assessed</span></div>
        <div class="gauge-wrap"><div class="gauge" style="--p:${onlinePct}"><div><strong>${ov.online}</strong><small>of ${ov.computers}</small></div></div><span>${onlinePct}% online</span></div></div></div>
      <div class="card"><h2>Autopilot</h2>
        <div class="toggle-row"><span>${apOn ? 'On' : ap?.exists ? 'Off' : 'Not set up'}<br><span class="mute">${ap?.counts?.last7Days ? `${ap.counts.last7Days} tasks handled this week.` : 'Updates, repairs and checks run by themselves.'}</span></span>
          <input type="checkbox" class="switch" id="apswitch" aria-label="Autopilot" ${apOn ? 'checked' : ''} ${can('admin') ? '' : 'disabled'}></div>
        <div class="actions"><a class="btn ghost sm" href="#/autopilot">Open Autopilot</a></div></div></div>
    ${oc ? outcomesHtml(oc) : ''}
    ${ov.topIssues.length ? `<div class="card"><h2>Most common issues</h2>${ov.topIssues.slice(0, 6).map(i => `<div class="issue"><span class="pts">${plural(i.devices, 'PC')}</span>${esc(i.example)}</div>`).join('')}</div>` : ''}
    <div class="card"><h2>Storage recovery <span class="mute">· ${sr.devicesScanned} of ${sr.devicesTotal} scanned</span></h2>
      <div class="kv">${kv('Safe to recover', mb(sr.safeBytes))}${kv('Needs review', mb(sr.reviewBytes))}</div>
      ${sr.categories.slice(0, 5).map(c => `<div class="issue"><span class="pts">${mb(c.bytes)}</span>${esc(c.title)} <span class="mute">${plural(c.devices, 'PC')}</span></div>`).join('')}
      ${can('technician') ? `<div class="actions"><button class="ghost" id="scanall">Scan all computers</button>${can('admin') ? `<button id="cleanall" ${sr.safeBytes ? '' : 'disabled'}>Clean all safe files</button>` : ''}</div>` : ''}
      <small class="mute">Personal folders (${sr.personalDataNeverTouched.join(', ')}) are never scanned or deleted.</small></div>`;
  $('#addpc')?.addEventListener('click', () => addComputers());
  $('#addpc2')?.addEventListener('click', () => addComputers());
  $('#apswitch')?.addEventListener('change', async e => {
    try { await api('/api/v1/autopilot', { method: 'PUT', body: JSON.stringify({ enabled: e.target.checked }) }); toast(e.target.checked ? 'Autopilot is on.' : 'Autopilot is off. Nothing will run automatically.'); reroute(); } catch (x) { e.target.checked = !e.target.checked; fail(x); }
  });
  $('#scanall')?.addEventListener('click', () => runJob('cleanup.preview', {}, { all: true }).then(r => toast(`Scan started on ${r.count} computer(s)`)).catch(fail));
  $('#cleanall')?.addEventListener('click', async () => { if (await confirmBox('Clean all computers', 'Delete safe temporary files and caches on ALL computers? Personal files are never touched; files in use are skipped.', 'Clean all', true)) runJob('cleanup.run', { categories: SAFE_CLEAN }, { all: true }).then(r => toast(`Cleanup queued on ${r.count} computer(s)`)).catch(fail); });
  poll(30000);
};

// ---------------------------------------------------------------- computers (list, filters, bulk actions)
const filters = { q: '', siteId: '', departmentId: '', tag: '', status: '', health: '' };
const selected = new Set();

VIEWS.computers = async (main, id) => {
  if (id) return deviceView(main, id);
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const [d, sites, tags] = await Promise.all([api('/api/v1/devices' + (qs ? '?' + qs : '')), api('/api/v1/sites'), api('/api/v1/tags')]);
  const deps = sites.sites.flatMap(s => s.departments.map(x => ({ ...x, site: s.name })));
  const opt = (v, cur, l) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
  const rows = d.devices.map(x => `<tr class="row" data-id="${esc(x.id)}"><td><input type="checkbox" data-sel="${esc(x.id)}" aria-label="Select ${esc(x.hostname)}" ${selected.has(x.id) ? 'checked' : ''}></td>
    <td class="host"><span class="dot ${x.status}" title="${esc(x.status)}"></span>${esc(x.hostname)}<small>${esc(x.logged_in_user ?? '')}</small></td>
    <td class="posture"><b class="score">${x.health_score ?? '—'}</b>${x.health_score != null ? bar(x.health_score, catSt(x.health_score)) : ''}${pill(x.health_status)}${x.hardware_verdict && x.hardware_verdict !== 'ok' ? ` ${pill(x.hardware_verdict === 'critical' ? 'critical' : 'warning', 'hardware')}` : ''}</td>
    <td class="hide-sm">${esc(x.site)} / ${esc(x.department)}${(x.tags ?? []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</td>
    <td class="hide-sm">${esc(x.os_caption)}${x.ram_bytes != null ? `<small>${gb(x.ram_bytes)} RAM</small>` : ''}</td><td>${x.open_alerts ? `<span class="pill warning">${x.open_alerts}</span>` : ''}</td><td class="nowrap">${ago(x.last_seen_at)}</td></tr>`).join('');
  main.innerHTML = `<h1>Computers</h1><p class="lead">${d.total} shown, ${d.online} reporting.</p>
    <div class="bar-tools"><input id="f-q" type="search" aria-label="Search computers" placeholder="Search hostname or operator" value="${esc(filters.q === '' ? '' : filters.q)}">
      <select id="f-site" aria-label="Site"><option value="">All sites</option>${sites.sites.map(s => opt(s.id, filters.siteId, s.name)).join('')}</select>
      <select id="f-dep" aria-label="Department"><option value="">All departments</option>${deps.map(x => opt(x.id, filters.departmentId, x.site + ' / ' + x.name)).join('')}</select>
      <select id="f-tag" aria-label="Tag"><option value="">All tags</option>${tags.tags.map(t => opt(t.tag, filters.tag, `${t.tag} (${t.devices})`)).join('')}</select>
      <select id="f-status" aria-label="Online status"><option value="">Any status</option>${opt('online', filters.status, 'Online')}${opt('offline', filters.status, 'Offline')}</select>
      <select id="f-health" aria-label="Health"><option value="">Any health</option>${opt('healthy', filters.health, 'Healthy')}${opt('attention', filters.health, 'Needs attention')}${opt('critical', filters.health, 'Critical')}</select>
      <a class="btn ghost" href="#" id="csv">Export CSV</a>${can("technician") ? `<button class="ghost" id="cmdc">Command Center…</button>` : ""}</div>
    <div class="bar-tools bulk" id="bulk"${selected.size ? '' : 'hidden'}><b>${selected.size} selected</b>
      ${can('technician') ? `<button class="ghost sm" data-bulk="health.check">Health check</button><button class="ghost sm" data-bulk="hardware.diagnose">Hardware diagnosis</button><button class="ghost sm" data-bulk="cleanup.preview">Cleanup scan</button>` : ''}
      ${can('admin') ? `<button class="sm" data-bulk="repair.fix-safe">Remediate</button><button class="ghost sm" data-bulk="cleanup.run">Clean safe files</button><button class="ghost sm" data-bulk="assign">Assign / tag…</button>` : ''}
      <button class="ghost sm" id="clearsel">Clear</button></div>
    ${d.total ? `<table><thead><tr><th style="width:26px"><input type="checkbox" id="selall" aria-label="Select all"></th><th>Computer</th><th>Health</th><th class="hide-sm">Site / dept</th><th class="hide-sm">System</th><th>Alerts</th><th>Last report</th></tr></thead><tbody>${rows}</tbody></table>`
      : emptyState('computers', 'No computers to show', `Nothing matches these filters, or no computer has been added yet. ${can('admin') ? 'To add one, create an enrollment token on the Sites page and install the agent (see docs/DEPLOYMENT.md).' : ''}`)}`;

  const refilter = () => { Object.assign(filters, { q: $('#f-q').value, siteId: $('#f-site').value, departmentId: $('#f-dep').value, tag: $('#f-tag').value, status: $('#f-status').value, health: $('#f-health').value }); reroute(); };
  $$('#f-site,#f-dep,#f-tag,#f-status,#f-health').forEach(e => e.onchange = refilter);
  $('#f-q').onkeydown = e => { if (e.key === 'Enter') refilter(); };
  $('#cmdc')?.addEventListener('click', () => commandCenter([...selected]));
  $('#csv').onclick = async e => { e.preventDefault(); const r = await fetch('/api/v1/reports/devices.csv', { headers: { authorization: 'Bearer ' + token } }); const u = URL.createObjectURL(await r.blob()); Object.assign(document.createElement('a'), { href: u, download: 'viro-computers.csv' }).click(); };
  $$('tr.row').forEach(tr => tr.onclick = e => { if (e.target.matches('input')) return; location.hash = '#/computers/' + tr.dataset.id; });
  $$('[data-sel]').forEach(c => c.onchange = () => { c.checked ? selected.add(c.dataset.sel) : selected.delete(c.dataset.sel); reroute(); });
  $('#selall')?.addEventListener('change', e => { d.devices.forEach(x => e.target.checked ? selected.add(x.id) : selected.delete(x.id)); reroute(); });
  $('#clearsel')?.addEventListener('click', () => { selected.clear(); reroute(); });
  $$('[data-bulk]').forEach(b => b.onclick = async () => {
    const ids = [...selected], t = b.dataset.bulk;
    try {
      if (t === 'assign') return assignDialog(ids, sites.sites);
      if (t === 'repair.fix-safe' && !(await confirmBox('Remediate', `Remediate ${plural(ids.length, 'computer')}? Each is diagnosed first; only confirmed faults get safe fixes. Personal files are never touched.`, 'Run'))) return;
      if (t === 'cleanup.run' && !(await confirmBox('Clean safe files', `Delete temporary files and caches on ${plural(ids.length, 'computer')}?`, 'Clean', true))) return;
      const params = t === 'cleanup.run' ? { categories: SAFE_CLEAN } : {};
      const r = await runJob(t, params, { deviceIds: ids }); toast(`Queued on ${r.count} computer(s)`);
    } catch (e) { fail(e); }
  });
};

async function assignDialog(ids, sites) {
  const deps = sites.flatMap(s => s.departments.map(x => ({ ...x, site: s.name, siteId: s.id })));
  const r = await dialog(`Assign ${plural(ids.length, 'computer')}`, `<div class="row2"><div><label>Site</label><select name="siteId"><option value="">(no change)</option><option value="none">Unassign</option>${sites.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></div>
    <div><label>Department</label><select name="departmentId"><option value="">(no change)</option>${deps.map(x => `<option value="${esc(x.id)}">${esc(x.site)} / ${esc(x.name)}</option>`).join('')}</select></div></div>
    <label>Add tags (comma separated)</label><input name="add" placeholder="finance, critical"><label>Remove tags</label><input name="remove">`, 'Apply');
  if (!r) return;
  const list = s => (s ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const body = { deviceIds: ids };
  if (r.siteId) body.siteId = r.siteId === 'none' ? null : r.siteId;
  if (r.departmentId) body.departmentId = r.departmentId;
  if (list(r.add).length) body.addTags = list(r.add); if (list(r.remove).length) body.removeTags = list(r.remove);
  try { const x = await post('/api/v1/devices/assign', body); toast(`Updated ${x.updated} computer(s)`); reroute(); } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- computer detail
const FIXES = []; let STARTUP = [];
function healthHtml(H) {
  const li = x => { let btn = ''; if (x.fix && can('admin')) { FIXES.push(x.fix); btn = ` <button class="sm" data-fix="${FIXES.length - 1}">${esc(x.fix.label)}</button>`; }
    const startup = x.code === 'perf.startup_heavy' && STARTUP.length && can('admin') ? `<details><summary>Choose startup items to disable</summary>${STARTUP.map((it, i) => `<label style="display:block"><input type="checkbox" data-startup="${i}"> ${esc(it.name)} <span class="mute">${esc(it.location)}</span></label>`).join('')}<button class="sm" data-startup-go style="margin-top:8px">Disable selected (reversible)</button></details>` : '';
    return `<div class="issue"><span class="pts">-${x.points}</span>${esc(x.reason)}${btn}<small>${esc(x.recommendation)}${x.remedy === 'hardware' ? ' (hardware limit: software cannot fix this)' : ''}</small>${startup}</div>`; };
  const dg = H.diagnosis;
  return `<div class="card"><div class="hero"><div class="gauge-wrap"><div class="gauge ${H.status === 'healthy' ? '' : esc(H.status)}" style="--p:${+H.overall}"><div><strong>${H.overall}</strong><small>/ 100</small></div></div><span>${pill(H.status)}</span></div>
    <div class="cats" style="flex:1;min-width:280px">${Object.entries(CATS).map(([k, n]) => H.measured && H.measured[k] === false ? `<div>${n}<b class="mute" title="Viro could not read this yet, so it is not scored">not measured</b></div>` : `<div>${n}<b>${H.categories[k]}</b>${bar(H.categories[k], catSt(H.categories[k]))}</div>`).join('')}</div></div>
    <span class="mute">Assessed ${ago(H.collectedAt)}. Every deducted point is explained below.</span></div>
    ${H.deductions.length ? `<div class="card"><h2>Deductions</h2>
      ${['high', 'medium', 'low'].map(k => dg[k].length ? `<div class="mute" style="margin-top:10px">${k.toUpperCase()} IMPACT</div>${dg[k].map(li).join('')}` : '').join('')}
      ${dg.hardwareNote ? `<p class="note">${esc(dg.hardwareNote)}</p>` : ''}
      <p class="mute" style="margin-bottom:0">${plural(dg.safeFixCount, 'issue')} can be fixed automatically and safely.</p></div>` : '<div class="card">No faults found.</div>'}
    ${H.appReliability.length ? `<div class="card"><h2>Unstable applications</h2>${H.appReliability.map(a => `<div class="issue"><span class="pts">${a.rating}</span>${esc(a.app)}: ${plural(a.crashes, 'crash')}, ${plural(a.hangs, 'hang')} in 7 days${a.factors.length ? `<small>Likely contributing factors: ${a.factors.map(esc).join(', ')}</small>` : ''}</div>`).join('')}</div>` : ''}
    ${H.notMeasured.length ? `<p class="mute">Not measured on this PC: ${H.notMeasured.map(esc).join(', ')}.</p>` : ''}`;
}

function hardwareHtml(hd) {
  if (!hd) return '<div class="card"><h2>Hardware diagnosis</h2><p class="mute" style="margin-bottom:0">Not run yet. Run a hardware diagnosis to read drive SMART data, memory, battery, thermals and hardware error logs directly from this PC.</p></div>';
  const r = hd.raw ?? {}, rows = [];
  for (const d of (r.storage?.disks ?? []).filter(d => d.nvme)) { const n = d.nvme; rows.push(kv('Drive', d.model), kv('Temperature', n.temperatureC == null ? '—' : n.temperatureC + ' °C'), kv('Life used', n.percentageUsed + '%'), kv('Spare capacity', n.availableSparePercent + '% (min ' + n.availableSpareThresholdPercent + '%)'), kv('Data written', tb(n.dataUnitsWrittenBytes)), kv('Power-on time', n.powerOnHours + ' h'), kv('Power cycles', n.powerCycles), kv('Unsafe shutdowns', n.unsafeShutdowns), kv('Media errors', n.mediaErrors)); }
  for (const d of (r.storage?.disks ?? []).filter(d => !d.nvme)) rows.push(kv('Drive', d.model + ' (' + d.busType + ' ' + d.mediaType + ')'), kv('Windows health', d.health ?? '—'));
  if (r.battery) { const b = r.battery, pct = b.designCapacityMWh && b.fullChargeCapacityMWh ? Math.round(100 * b.fullChargeCapacityMWh / b.designCapacityMWh) : null; rows.push(kv('Battery health', pct == null ? '—' : pct + '% of original'), kv('Battery cycles', b.cycleCount ?? '—')); }
  for (const m of r.memory?.modules ?? []) rows.push(kv('RAM ' + (m.slot ?? ''), gb(m.capacityBytes) + ' ' + (m.manufacturer ?? '') + ' ' + (m.speedMhz ?? '?') + ' MT/s'));
  const hot = [...(r.thermal?.zones ?? [])].sort((a, b) => b.tempC - a.tempC).slice(0, 3); if (hot.length) rows.push(kv('Thermal now', hot.map(z => z.name.replace('\\_TZ.', '') + ' ' + z.tempC.toFixed(0) + '°C').join(', ')));
  rows.push(kv('WHEA hardware errors (30 d)', r.whea?.events30d ?? '—'), kv('CPU throttled by firmware (7 d)', r.cpu?.thermalThrottleEvents7d ?? '—'));
  return `<div class="card"><h2>Hardware diagnosis ${pill(hd.verdict === 'ok' ? 'healthy' : hd.verdict === 'warning' ? 'attention' : 'critical')} <span class="mute">read directly from the hardware ${ago(hd.collectedAt)}</span></h2>
    ${hd.findings.length ? hd.findings.map(f => `<div class="issue"><span class="sev ${f.severity}">${f.severity.toUpperCase()}</span>${esc(f.message)}<small>${esc(f.recommendation)}</small></div>`).join('') : '<p>No hardware faults detected in what could be read.</p>'}
    <div class="kv">${rows.join('')}</div>
    <p class="mute" style="margin-bottom:0">Checked: ${hd.checked.map(esc).join('; ') || 'nothing'}.${hd.unavailable.length ? ` <b>Could not read:</b> ${hd.unavailable.map(u => esc(u.component) + ' (' + esc(u.reason) + ')').join('; ')}.` : ''}</p></div>`;
}

function jobsHtml(jobs) {
  return `<div class="card"><a class="more" href="#/jobs" title="All jobs" aria-label="All jobs">•••</a><h2>Jobs</h2>${jobs.length ? jobs.map(j => `<div class="issue"><span class="pts"><span class="pill ${j.status}">${j.status}</span></span>${esc(jobLabel(j))} <span class="mute">${ago(j.created_at)}</span>${j.summary ? `<small>${esc(j.summary)}</small>` : ''}${j.error ? `<small style="color:var(--bad)">${esc(j.error)}</small>` : ''}${['queued', 'running'].includes(j.status) && can('technician') ? ` <a href="#" data-cancel="${esc(j.id)}">cancel</a>` : ''}</div>`).join('') : '<p class="mute" style="margin-bottom:0">Nothing has been run on this computer yet. Use the buttons above to start a check.</p>'}</div>`;
}

async function deviceView(main, id) {
  const [d, jl] = await Promise.all([api('/api/v1/devices/' + id), api('/api/v1/jobs?deviceId=' + id + '&limit=8')]);
  FIXES.length = 0; STARTUP = d.startupItems ?? [];
  const hw = d.inventory?.hardware ?? {}, hb = d.recentHeartbeats[0]?.metrics ?? {};
  const swAll = d.inventory?.software ?? [];
  main.innerHTML = `<a class="back" href="#/computers">&larr; Computers</a>
    <div class="dossier"><h1 data-eyebrow="COMPUTER / ${esc(String(d.id ?? id).slice(0, 8).toUpperCase())}"><span class="led ${d.status === 'online' ? 'online' : 'offline'}"></span>${esc(d.hostname)}</h1>${(d.tags ?? []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <dl class="readout"><div><dt>Status</dt><dd>${esc(d.status)} · seen ${ago(d.last_seen_at)}</dd></div><div><dt>Operator</dt><dd>${esc(d.logged_in_user)}</dd></div><div><dt>Site</dt><dd>${esc(d.site)} / ${esc(d.department)}</dd></div><div><dt>Address</dt><dd>${esc(d.ip_address)}</dd></div><div><dt>System</dt><dd>${esc(d.os_caption)}</dd></div><div><dt>Agent</dt><dd>${esc(d.agent_version)}</dd></div><div><dt>Uptime</dt><dd>${uptime(d.uptime_seconds)}</dd></div></dl>
    <div id="care-top"></div>
    <div class="actions tools">${can('admin') ? '<button data-fixmypc>Remediate</button>' : ''}${can('technician') ? '<button class="ghost" data-job="hardware.diagnose">Hardware diagnosis</button><button class="ghost" data-job="health.check">Health check</button><button class="ghost" data-job="cleanup.preview">Cleanup scan</button><button class="ghost" data-job="inventory.refresh">Refresh inventory</button>' : ''}${can('admin') ? '<button class="ghost danger" data-revoke>Revoke computer</button>' : ''}</div>
    ${jobsHtml(jl.jobs)}
    ${(EXTRA_DEVICE_PANELS.map(f => f(d)).join(''))}
    ${hardwareHtml(d.hardwareDiagnosis)}
    ${d.health ? healthHtml(d.health) : emptyState('security', 'Health not assessed yet', 'The first health snapshot arrives within a minute of the agent starting.')}
    <div id="care-low"></div>
    <div class="card"><h2>Specifications</h2><dl>
      <dt>User</dt><dd>${esc(d.logged_in_user)}</dd><dt>Organization</dt><dd>${esc(d.organization)}</dd><dt>Site / Department</dt><dd>${esc(d.site)} / ${esc(d.department)}</dd><dt>IP</dt><dd>${esc(d.ip_address)}</dd>
      <dt>OS</dt><dd>${esc(d.os_caption)} (build ${esc(d.os_build)})</dd><dt>Uptime</dt><dd>${uptime(d.uptime_seconds)}</dd><dt>Manufacturer / Model</dt><dd>${esc(hw.manufacturer)} ${esc(hw.model)}</dd><dt>Serial</dt><dd>${esc(hw.serialNumber)}</dd>
      <dt>CPU</dt><dd>${esc(hw.cpu)} (${esc(hw.cpuCores)} cores)</dd><dt>RAM</dt><dd>${gb(hw.ramBytes)}</dd><dt>GPU</dt><dd>${esc((hw.gpus ?? []).map(g => g.name).join(', ') || null)}</dd>
      <dt>Disks</dt><dd>${esc((hw.disks ?? []).map(x => x.model + ' ' + gb(x.sizeBytes)).join(', ') || null)}</dd></dl></div>
    <div class="card"><h2>Live readings</h2><dl><dt>CPU</dt><dd>${hb.cpuPercent ?? '—'}%</dd><dt>RAM in use</dt><dd>${hb.ramPercent ?? '—'}%</dd><dt>System disk free</dt><dd>${gb(hb.systemDiskFreeBytes)} of ${gb(hb.systemDiskTotalBytes)}</dd><dt>Power</dt><dd>${hb.onBattery == null ? '—' : hb.onBattery ? 'On battery' : 'AC'}</dd></dl></div>
    <h3>Installed software · (${swAll.filter(x => !x.hidden).length}${swAll.some(x => x.hidden) ? ` and ${swAll.filter(x => x.hidden).length} hidden` : ''})</h3><div id="swbox"></div>`;

  const target = { deviceIds: [id] }, again = () => deviceView(main, id);
  let showHidden = false;
  const drawSw = () => {
    const list = swAll.filter(x => showHidden || !x.hidden).sort((p, q) => (q.sizeBytes ?? -1) - (p.sizeBytes ?? -1) || p.name.localeCompare(q.name));
    const total = list.reduce((n, x) => n + (x.sizeBytes ?? 0), 0);
    $('#swbox').innerHTML = !swAll.length ? '<p class="mute">The software list has not been reported yet.</p>' : `<p class="mute" style="margin:0 0 8px">${appSize(total)} in ${list.length} programs, largest first. <label style="margin-left:10px"><input type="checkbox" id="swhid" ${showHidden ? 'checked' : ''}> Show hidden programs</label></p>
      <table><thead><tr><th>Name</th><th>Size</th><th class="hide-sm">Version</th><th class="hide-sm">Publisher</th>${can('admin') ? '<th></th>' : ''}</tr></thead><tbody>${list.map((x, i) => `<tr><td>${esc(x.name)}${x.hidden ? ' <span class="tag">hidden</span>' : ''}</td><td>${appSize(x.sizeBytes)}</td><td class="hide-sm">${esc(x.version)}</td><td class="hide-sm">${esc(x.publisher)}</td>${can('admin') ? `<td>${x.key && x.hive ? `<button class="ghost sm" data-uninst="${i}">Uninstall</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table>`;
    $('#swhid')?.addEventListener('change', e => { showHidden = e.target.checked; drawSw(); });
    $('[data-uninst]').forEach(btn => btn.onclick = async () => {
      const x = list[+btn.dataset.uninst];
      const r = await dialog('Uninstall ' + x.name + '?', `<p>Viro will run the program's own uninstaller on this computer and then check that it is gone. ${x.sizeBytes ? 'It uses ' + appSize(x.sizeBytes) + '. ' : ''}</p><label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="forced" style="margin-top:4px"><span>If the uninstaller is missing or fails, remove it by force: its folder is moved aside (not deleted) and its entry is removed. This can be undone from the computer's Undo list.</span></label>`, 'Uninstall', true);
      if (!r) return;
      try { await runJob('repair.run', { recipe: 'app.uninstall', approved: true, options: { kind: x.kind ?? 'other', id: x.key, hive: x.hive, forced: !!r.forced } }, target); toast('Queued. The result appears in Recent jobs, and the list updates after the PC reports again.'); } catch (e) { fail(e); }
    });
  };
  drawSw();
  const act = (fn) => async e => { const b = e.currentTarget; b.disabled = true; try { await fn(b); await again(); } catch (x) { fail(x); b.disabled = false; } };
  $$('[data-job]').forEach(b => b.onclick = act(() => runJob(b.dataset.job, {}, target)));
  $$('[data-fix]').forEach(b => b.onclick = act(async () => { const f = FIXES[+b.dataset.fix]; if (f.confirm && !(await confirmBox(f.label, f.confirm))) throw new Error('cancelled'); await runJob(f.jobType, f.params, target); }));
  $$('[data-fixmypc]').forEach(b => b.onclick = act(async () => { if (!(await confirmBox('Fix my PC', 'Diagnose first, then apply only safe fixes to things that are actually broken (failed services, safe temporary files). Personal files are never touched.', 'Run'))) throw new Error('cancelled'); await runJob('repair.fix-safe', {}, target); }));
  $$('[data-startup-go]').forEach(b => b.onclick = act(async () => {
    const entries = $$('[data-startup]:checked').map(c => STARTUP[+c.dataset.startup]).map(x => ({ location: x.location, name: x.name }));
    if (!entries.length) throw new Error('select at least one item');
    if (!(await confirmBox('Disable startup items', `Disable ${entries.length} item(s)? Nothing is deleted; this can be rolled back.`))) throw new Error('cancelled');
    await runJob('repair.run', { recipe: 'startup.disable', approved: true, options: { entries } }, target);
  }));
  $$('[data-cancel]').forEach(a => a.onclick = async e => { e.preventDefault(); try { await post('/api/v1/jobs/' + a.dataset.cancel + '/cancel'); again(); } catch (x) { fail(x); } });
  $$('[data-revoke]').forEach(b => b.onclick = async () => { if (await confirmBox('Revoke this computer?', 'Its agent credential stops working immediately. History is kept.', 'Revoke', true)) { await del('/api/v1/devices/' + id).catch(fail); location.hash = '#/computers'; } });
  EXTRA_DEVICE_HOOKS.forEach(f => f(main, d, { again, act, target }));
  jumpBar(main);
  if (jl.jobs.some(j => ['queued', 'running'].includes(j.status))) poll(4000); else poll(30000);
}
const EXTRA_DEVICE_PANELS = [], EXTRA_DEVICE_HOOKS = [];

// ---------------------------------------------------------------- jobs
VIEWS.jobs = async main => {
  const st = new URLSearchParams(location.hash.split('?')[1] ?? '').get('status') ?? '';
  const r = await api('/api/v1/jobs?limit=150' + (st ? '&status=' + st : ''));
  main.innerHTML = `<h1>Jobs</h1><p class="lead">Every action is a signed task. ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(' · ')}</p>
    <div class="bar-tools">${['', 'queued', 'running', 'completed', 'failed', 'cancelled'].map(s => `<a class="btn ${s === st ? '' : 'ghost'} sm" ${s === st ? 'aria-current="page"' : ''} href="#/jobs${s ? '?status=' + s : ''}">${s || 'all'}</a>`).join('')}
      <a class="btn ghost sm" href="#" id="jcsv">Export CSV</a></div>
    ${r.jobs.length ? `<table><thead><tr><th>Task</th><th>Computer</th><th>Status</th><th>Result</th><th>Created</th></tr></thead><tbody>${r.jobs.map(j => `<tr><td>${esc(jobLabel(j))}</td><td><a href="#/computers/${esc(j.device_id)}">${esc(j.hostname)}</a></td><td><span class="pill ${j.status}">${j.status}</span></td><td>${esc(j.summary ?? j.error ?? '')}</td><td class="nowrap">${ago(j.created_at)}</td></tr>`).join('')}</tbody></table>` : emptyState('jobs', 'No jobs to show', 'Jobs appear here when you run a check, cleanup or repair, or when a policy runs one.')}`;
  $('#jcsv').onclick = async e => { e.preventDefault(); const x = await fetch('/api/v1/reports/jobs.csv', { headers: { authorization: 'Bearer ' + token } }); Object.assign(document.createElement('a'), { href: URL.createObjectURL(await x.blob()), download: 'viro-jobs.csv' }).click(); };
  poll(8000);
};

// ---------------------------------------------------------------- alerts
VIEWS.alerts = async main => {
  const r = await api('/api/v1/alerts?status=open&limit=200');
  markAlertsSeen(r.alerts); refreshBadge();
  const unack = r.alerts.filter(a => !a.acknowledged_at).length;
  main.innerHTML = `<h1>Alerts</h1><div class="mute">Alerts stay open while the fault exists and clear themselves when it is fixed. ${r.open.critical ?? 0} critical · ${plural(r.open.warning ?? 0, 'warning')}${r.alerts.length ? ' · ' + (r.alerts.length - unack) + ' acknowledged' : ''}</div>
    ${unack > 1 && can('technician') ? '<div class="actions"><button class="ghost" id="ackall">Acknowledge all (' + unack + ')</button></div>' : ''}
    ${r.alerts.length ? `<table><thead><tr><th>Severity</th><th>Computer</th><th>Fault</th><th>Since</th><th></th></tr></thead><tbody>${r.alerts.map(a => `<tr><td><span class="pill ${a.severity}">${a.severity}</span></td><td><a href="#/computers/${esc(a.device_id)}">${esc(a.hostname)}</a></td><td>${esc(a.message)}${a.acknowledged_at ? '<small>acknowledged</small>' : ''}</td><td class="nowrap">${ago(a.first_seen_at)}</td><td>${!a.acknowledged_at && can('technician') ? `<button class="ghost sm" data-ack="${a.id}">Acknowledge</button>` : ''}</td></tr>`).join('')}</tbody></table>` : emptyState('security', 'All clear', 'No open alerts. Standing watch.')}`;
  $$('[data-ack]').forEach(b => b.onclick = () => post('/api/v1/alerts/' + b.dataset.ack + '/ack').then(() => { refreshBadge(); refreshStatus(); reroute(); }).catch(fail));
  const ackAll = $('#ackall'); if (ackAll) ackAll.onclick = () => post('/api/v1/alerts/ack-all').then(x => { toast(plural(x.acknowledged, 'alert') + ' acknowledged'); refreshBadge(); refreshStatus(); reroute(); }).catch(fail);
  poll(20000);
};

// ---------------------------------------------------------------- policies
const SCHEDULABLE = [
  ['health.check', {}, 'Health check'], ['inventory.refresh', {}, 'Inventory refresh'], ['hardware.diagnose', {}, 'Hardware diagnosis'], ['cleanup.preview', {}, 'Cleanup scan'],
  ['repair.run', { recipe: 'cleanup.safe' }, 'Safe cleanup'], ['repair.run', { recipe: 'services.restart-failed' }, 'Restart failed services'], ['repair.run', { recipe: 'dns.flush' }, 'Fix DNS if broken'],
];
window.SCHEDULABLE = SCHEDULABLE;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const describeSchedule = s => { const lab = (SCHEDULABLE.find(x => x[0] === s.type && JSON.stringify(x[1]) === JSON.stringify(s.params ?? {})) ?? [, , s.type])[2]; return `${lab}: ${s.everyMinutes ? 'every ' + (s.everyMinutes % 60 ? s.everyMinutes + ' min' : s.everyMinutes / 60 + ' h') : s.weekly.days.map(d => DAYS[d]).join('/') + ' ' + s.weekly.time}${s.windowOnly ? ' (maintenance window only)' : ''}`; };

VIEWS.policies = async main => {
  const [r, sites, tpl] = await Promise.all([api('/api/v1/policies'), api('/api/v1/sites'), api('/api/v1/policy-templates')]);
  const scopeLabel = s => s.type === 'org' ? 'Whole organization' : s.type === 'tag' ? 'Tag: ' + s.tag : s.type === 'site' ? 'Site: ' + (sites.sites.find(x => x.id === s.id)?.name ?? '?') : 'Department: ' + (sites.sites.flatMap(x => x.departments).find(x => x.id === s.id)?.name ?? '?');
  main.innerHTML = `<h1>Policies</h1><p class="lead">Scheduled maintenance and auto-remediation, scoped by site, department, tag or everyone.</p>
    ${can('admin') ? `<div class="actions"><button id="newpol">New policy</button>${tpl.templates.map(t => `<button class="ghost" data-tpl="${esc(t.id)}">From template: ${esc(t.name)}</button>`).join('')}</div>` : ''}
    ${r.policies.length ? r.policies.map(p => `<div class="card"><h2>${esc(p.name)} ${p.enabled ? '<span class="pill ok">active</span>' : '<span class="pill cancelled">disabled</span>'} <span class="mute">${esc(scopeLabel(p.scope))} · ${plural(p.deviceCount, 'computer')}</span></h2>
      ${p.description ? `<p class="mute">${esc(p.description)}</p>` : ''}
      ${(p.settings.schedules ?? []).map(s => `<div class="issue">${esc(describeSchedule(s))}</div>`).join('') || '<p class="mute">No scheduled jobs.</p>'}
      ${p.settings.maintenanceWindow ? `<div class="issue">Maintenance window: ${p.settings.maintenanceWindow.days.map(d => DAYS[d]).join('/')} ${p.settings.maintenanceWindow.start}–${p.settings.maintenanceWindow.end}</div>` : ''}
      ${p.settings.autoRepair ? `<div class="issue">Automatic repair: ${[p.settings.autoRepair.failedServices && 'restart failed services', p.settings.autoRepair.safeCleanup && 'safe cleanup when disk is low'].filter(Boolean).join(', ') || 'none'}</div>` : ''}
      ${can('admin') ? `<div class="actions" style="justify-content:space-between;align-items:center"><label class="toggle-row" style="gap:10px"><input type="checkbox" class="switch" data-toggle="${esc(p.id)}" data-en="${p.enabled}" ${p.enabled ? 'checked' : ''}><span>${p.enabled ? 'Policy is on' : 'Policy is off'}</span></label><button class="ghost sm danger" data-delpol="${esc(p.id)}">Delete</button></div>` : ''}</div>`).join('') : emptyState('policies', 'No policies yet', 'A policy runs health scans, cleanup and repairs for you on a schedule. Create one to get started.')}`;
  $('#newpol')?.addEventListener('click', () => policyDialog(null, sites.sites));
  $$('[data-tpl]').forEach(b => b.onclick = () => policyDialog(tpl.templates.find(t => t.id === b.dataset.tpl), sites.sites));
  $$('[data-toggle]').forEach(b => b.onchange = () => patch('/api/v1/policies/' + b.dataset.toggle, { enabled: b.dataset.en !== 'true' }).then(reroute).catch(e => { b.checked = !b.checked; fail(e); }));
  $$('[data-delpol]').forEach(b => b.onclick = async () => { if (await confirmBox('Delete policy', 'Scheduled jobs from this policy stop. Continue?', 'Delete', true)) del('/api/v1/policies/' + b.dataset.delpol).then(reroute).catch(fail); });
};

async function policyDialog(tpl, sites) {
  const s = tpl?.settings ?? { schedules: [{ key: 'health', type: 'health.check', params: {}, everyMinutes: 30 }] };
  const deps = sites.flatMap(x => x.departments.map(y => ({ ...y, site: x.name })));
  const r = await dialog(tpl ? 'New policy from template' : 'New policy', `
    <label>Name</label><input name="name" required value="${esc(tpl?.name ?? '')}">
    <div class="row2"><div><label>Applies to</label><select name="scope"><option value="org">Whole organization</option>${sites.map(x => `<option value="site:${esc(x.id)}">Site: ${esc(x.name)}</option>`).join('')}${deps.map(x => `<option value="department:${esc(x.id)}">Department: ${esc(x.site)} / ${esc(x.name)}</option>`).join('')}<option value="tag">Computers with tag…</option></select></div>
    <div><label>Tag (when scoped by tag)</label><input name="tag" placeholder="finance"></div></div>
    <label>Schedule and settings (JSON, validated by the server)</label><textarea name="settings" rows="12" spellcheck="false">${esc(JSON.stringify(s, null, 2))}</textarea>
    <p class="mute">Available jobs: ${SCHEDULABLE.map(x => x[2]).join(', ')}. Days are 0 (Sunday) to 6. Times are the organization's local time.</p>`, 'Create policy');
  if (!r) return;
  let settings; try { settings = JSON.parse(r.settings); } catch { return toast('Settings are not valid JSON'); }
  const scope = r.scope === 'org' ? { type: 'org' } : r.scope === 'tag' ? { type: 'tag', tag: r.tag } : { type: r.scope.split(':')[0], id: r.scope.split(':')[1] };
  try { await post('/api/v1/policies', { name: r.name, description: tpl?.description, scope, settings }); toast('Policy created'); reroute(); } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- sites & groups
VIEWS.sites = async main => {
  const [r, d] = await Promise.all([api('/api/v1/sites'), api('/api/v1/devices')]);
  const count = (k, id) => d.devices.filter(x => x[k] === id).length;
  main.innerHTML = `<h1>Sites</h1><p class="lead">Group computers by site and department. Tags are set from Computers.</p>
    ${can('admin') ? '<div class="actions"><button id="addsite">Add site</button><button class="ghost" id="enroll">Create enrollment token</button></div>' : ''}
    ${r.sites.length ? r.sites.map(s => `<div class="card"><h2>${esc(s.name)} <span class="mute">${plural(count('site_id', s.id), 'computer')}</span>
        ${can('admin') ? `<span class="right"><button class="ghost sm" data-adddep="${esc(s.id)}">Add department</button> <button class="ghost sm" data-rensite="${esc(s.id)}" data-name="${esc(s.name)}">Rename</button> <button class="ghost sm danger" data-delsite="${esc(s.id)}">Delete</button></span>` : ''}</h2>
      ${s.departments.map(x => `<div class="issue"><span class="pts">${plural(count('department_id', x.id), 'computer')}${can('admin') ? ` · <a href="#" data-deldep="${esc(x.id)}">delete</a>` : ''}</span>${esc(x.name)}</div>`).join('') || '<p class="mute">No departments.</p>'}</div>`).join('') : emptyState('sites', 'No sites yet', 'Add a site (for example an office) to start organizing your computers.')}`;
  $('#addsite')?.addEventListener('click', async () => { const x = await dialog('Add site', '<label>Name</label><input name="name" required>', 'Add'); if (x) post('/api/v1/sites', x).then(reroute).catch(fail); });
  $$('[data-adddep]').forEach(b => b.onclick = async () => { const x = await dialog('Add department', '<label>Name</label><input name="name" required>', 'Add'); if (x) post('/api/v1/departments', { siteId: b.dataset.adddep, name: x.name }).then(reroute).catch(fail); });
  $$('[data-rensite]').forEach(b => b.onclick = async () => { const x = await dialog('Rename site', `<label>Name</label><input name="name" required value="${esc(b.dataset.name)}">`, 'Rename'); if (x) patch('/api/v1/sites/' + b.dataset.rensite, x).then(reroute).catch(fail); });
  $$('[data-delsite]').forEach(b => b.onclick = async () => { if (await confirmBox('Delete site', 'Its departments are removed; computers stay but become unassigned.', 'Delete', true)) del('/api/v1/sites/' + b.dataset.delsite).then(reroute).catch(fail); });
  $$('[data-deldep]').forEach(a => a.onclick = async e => { e.preventDefault(); if (await confirmBox('Delete department', 'Computers stay but lose the department.', 'Delete', true)) del('/api/v1/departments/' + a.dataset.deldep).then(reroute).catch(fail); });
  $('#enroll')?.addEventListener('click', async () => {
    const x = await dialog('Enrollment token', `<div class="row2"><div><label>Site (optional)</label><select name="siteId"><option value="">—</option>${r.sites.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></div><div><label>Valid for (hours)</label><input name="ttl" type="number" value="72" min="1"></div></div><p class="mute">Computers that enroll with this token join the chosen site.</p>`, 'Create');
    if (!x) return;
    try { const t = await post('/api/v1/enrollment-tokens', { siteId: x.siteId || undefined, ttlHours: +x.ttl }); await dialog('Copy this now, it is shown once', `<label>Token</label><input readonly value="${esc(t.token)}" onclick="this.select()"><label>Install command (elevated PowerShell)</label><textarea readonly rows="3" onclick="this.select()">msiexec /i ViroAgent.msi /qn SERVER_URL=${esc(location.origin)} ENROLL_TOKEN=${esc(t.token)}</textarea>`, 'Done'); } catch (e) { fail(e); }
  });
};

// ---------------------------------------------------------------- reports
VIEWS.reports = async main => {
  const days = +(new URLSearchParams(location.hash.split('?')[1] ?? '').get('days') ?? 30);
  const r = await api('/api/v1/reports/summary?days=' + days);
  main.innerHTML = `<h1>Reports</h1><div class="bar-tools">${[7, 30, 90].map(n => `<a class="btn sm ${n === days ? '' : 'ghost'}" href="#/reports?days=${n}">Last ${n} days</a>`).join('')}
    <a class="btn ghost sm" href="#" id="rcsv">Computers CSV</a><a class="btn ghost sm" href="#" id="jcsv2">Jobs CSV</a></div>
    <div class="grid"><div class="card stat"><b>${r.computers}</b><span>computers</span></div><div class="card stat"><div class="gauge sm ${r.averageHealth == null || r.averageHealth >= 80 ? '' : r.averageHealth < 60 ? 'critical' : 'attention'}" style="--p:${+r.averageHealth || 0}"><div><strong>${r.averageHealth ?? '—'}</strong></div></div><span>average health</span></div>
      <div class="card stat"><b>${r.problemsResolved}</b><span>problems resolved automatically</span></div><div class="card stat"><b>${mb(r.storageRecoveredBytes)}</b><span>storage recovered</span></div>
      <div class="card stat"><b>${r.alerts.opened}</b><span>alerts raised · ${r.alerts.resolved} resolved</span></div></div>
    <div class="card"><h2>Health distribution</h2><div class="kv">${Object.entries(r.distribution).map(([k, v]) => kv(k, v)).join('')}</div></div>
    <div class="card"><h2>Jobs</h2>${r.jobs.length ? r.jobs.map(j => `<div class="issue"><span class="pts">${j.n}</span>${esc(JOB_LABEL[j.type] ?? j.type)} <span class="pill ${j.status}">${j.status}</span></div>`).join('') : '<p class="mute">No jobs in this period.</p>'}</div>
    <div class="card"><h2>Hardware needing attention</h2>${r.hardwareAttention.length ? r.hardwareAttention.map(x => `<div class="issue"><a href="#/computers/${esc(x.deviceId)}">${esc(x.hostname)}</a> ${pill(x.verdict === 'critical' ? 'critical' : 'warning', x.verdict)}</div>`).join('') : '<p class="mute">None.</p>'}</div>
    <div class="card"><h2>Not seen in 7 days</h2>${r.notSeenIn7Days.length ? r.notSeenIn7Days.map(x => `<div class="issue"><a href="#/computers/${esc(x.deviceId)}">${esc(x.hostname)}</a> <span class="mute">${ago(x.lastSeenAt)}</span></div>`).join('') : '<p class="mute">None.</p>'}</div>`;
  const dl = (id, url, name) => $(id).onclick = async e => { e.preventDefault(); const x = await fetch(url, { headers: { authorization: 'Bearer ' + token } }); Object.assign(document.createElement('a'), { href: URL.createObjectURL(await x.blob()), download: name }).click(); };
  dl('#rcsv', '/api/v1/reports/devices.csv', 'viro-computers.csv'); dl('#jcsv2', '/api/v1/reports/jobs.csv', 'viro-jobs.csv');
};

// ---------------------------------------------------------------- audit
VIEWS.audit = async main => {
  if (!can('admin')) { main.innerHTML = '<div class="card empty">The audit log is visible to administrators.</div>'; return; }
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const act = q.get('action') ?? '';
  const r = await api('/api/v1/audit/search?limit=150' + (act ? '&action=' + encodeURIComponent(act) : ''));
  main.innerHTML = `<h1>Audit log</h1><div class="mute">Who did what, where and when, with previous and new state.</div>
    <div class="bar-tools"><input id="aq" type="search" aria-label="Filter audit log" placeholder="Filter by action prefix, e.g. job. or policy." value="${esc(act === '' ? '' : act)}"></div>
    ${r.entries.length ? `<table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Change</th><th>Result</th></tr></thead><tbody>${r.entries.map(e => `<tr><td class="nowrap">${new Date(e.at).toLocaleString()}</td><td>${esc(e.actor_type)}<small>${esc(String(e.actor_id ?? '').slice(0, 8))}</small></td><td>${esc(e.action)}</td><td>${esc(e.target_type)}<small>${esc(String(e.target_id ?? '').slice(0, 8))}</small></td><td><small>${esc(e.next ? JSON.stringify(e.next).slice(0, 140) : '')}</small></td><td>${esc(e.result)}</td></tr>`).join('')}</tbody></table>` : emptyState('audit', 'No matching entries', 'Nothing has been recorded for this filter yet.')}`;
  $('#aq').onkeydown = e => { if (e.key === 'Enter') location.hash = '#/audit' + (e.target.value ? '?action=' + encodeURIComponent(e.target.value) : ''); };
};

