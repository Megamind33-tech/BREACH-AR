'use strict';
/* The marketing site's only script: the phone menu button and the year in the footer. Everything else works without JavaScript. */
(function () {
  const nav = document.querySelector('.nav'), btn = document.querySelector('.nav-toggle');
  if (nav && btn) {
    btn.addEventListener('click', () => { const open = nav.classList.toggle('open'); btn.setAttribute('aria-expanded', String(open)); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && nav.classList.contains('open')) { nav.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); btn.focus(); } });
    nav.querySelectorAll('.menu a').forEach(a => a.addEventListener('click', () => { nav.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }));
  }
  // Where did this visitor come from? A campaign link (?utm_source=facebook&utm_campaign=slow-pc) or the website they arrived from is remembered for 30 days on this device,
  // and added to the links that go to the console, so the order can say which ad or post paid. Nothing personal is kept, and nothing is sent to anyone else.
  (function () {
    const KEY = 'viro_src', DAYS = 30 * 864e5; let src = null;
    try { src = JSON.parse(localStorage.getItem(KEY) || 'null'); if (src && Date.now() - src.t > DAYS) src = null; } catch (e) { src = null; }
    const q = new URLSearchParams(location.search), now = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].forEach(k => { const v = (q.get(k) || '').replace(/[^\w .:@/+-]/g, '').slice(0, 80); if (v) now[k.slice(4)] = v; });
    if (!Object.keys(now).length) { try { const h = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : ''; if (h && h !== location.hostname && !/(^|\.)viro3\.online$/.test(h) && !(src && Object.keys(src.v).length)) now.ref = h.slice(0, 80); } catch (e) { /* no referrer */ } }
    if (Object.keys(now).length) { src = { t: Date.now(), v: now }; try { localStorage.setItem(KEY, JSON.stringify(src)); } catch (e) { /* storage blocked: the links below still carry this page's own values */ } }
    const v = src && src.v ? src.v : {}; if (!Object.keys(v).length) return;
    document.querySelectorAll('a[href^="https://control.viro3.online"]').forEach(a => {
      const u = new URL(a.href); Object.keys(v).forEach(k => { if (k === 'ref') u.searchParams.set('ref', v[k]); else u.searchParams.set('utm_' + k, v[k]); }); a.href = u.toString();
    });
    document.querySelectorAll('a.wa').forEach(a => { const u = new URL(a.href); const t = u.searchParams.get('text') || ''; u.searchParams.set('text', t + ' (' + (v.source || v.ref || 'website') + (v.campaign ? ', ' + v.campaign : '') + ')'); a.href = u.toString(); });
  })();
  // Anonymous counters: one visit a day per device, and a click on the download button. No cookie, nothing personal; a browser that asks not to be tracked is left alone.
  (function () {
    if (navigator.doNotTrack === '1' || !window.fetch) return;
    const base = /^control\./.test(location.hostname) ? '' : 'https://control.viro3.online';
    let v = {}; try { const s = JSON.parse(localStorage.getItem('viro_src') || 'null'); v = (s && s.v) || {}; } catch (e) { /* none */ }
    const source = v.source || v.ref || 'direct';
    const send = event => { try { fetch(base + '/api/v1/public/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: event, source: source }), keepalive: true }).catch(function () { }); } catch (e) { /* counting never breaks the page */ } };
    try { const day = new Date().toISOString().slice(0, 10); if (localStorage.getItem('viro_seen') !== day) { localStorage.setItem('viro_seen', day); send('visit'); } } catch (e) { send('visit'); }
    document.querySelectorAll('a[href$="ViroAgent.msi"]').forEach(a => a.addEventListener('click', () => send('download_click')));
  })();
  // "Sign in" goes to the console. On the console's own address (or a local copy) that is this same site's root; on the company domain it is the console address in the link.
  if (/^(control\.|localhost$|127\.)/.test(location.hostname)) document.querySelectorAll('[data-signin]').forEach(a => a.setAttribute('href', '/'));
  // Prices on this page are the starting prices. When the owner has set plans on sale, the live price replaces the printed one, so the page never shows a price nobody chose.
  const cards = document.querySelectorAll('[data-plan-code]');
  if (cards.length && window.fetch) fetch('https://control.viro3.online/api/v1/public/plans').then(r => r.ok ? r.json() : null).then(d => {
    if (!d) return;
    cards.forEach(card => {
      const p = (d.plans || []).find(x => x.code === card.dataset.planCode); const amt = card.querySelector('[data-amt]'); if (!p || !amt) return;
      amt.textContent = (p.currency === 'ZMW' ? 'K\u00a0' : p.currency + '\u00a0') + Number(p.price).toLocaleString('en-US');
    });
  }).catch(() => { /* the printed prices stay */ });
  document.querySelectorAll('[data-year]').forEach(el => { el.textContent = String(new Date().getFullYear()); });
})();
