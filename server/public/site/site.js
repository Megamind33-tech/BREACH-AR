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
  // The installer's real size, checksum and release date, so the page never says more than the server can prove. The hero
  // line is the two facts anyone can use (requirements, how current it is); the checksum itself lives in the FAQ, for the
  // few visitors who came looking for it rather than having it in front of everyone before they even know what Viro does.
  // If the installer is not published yet, or the request fails, both are simply left hidden rather than shown with blanks.
  (function () {
    const facts = document.querySelector('[data-dl-facts]'); const verify = document.querySelector('[data-dl-verify]');
    if ((!facts && !verify) || !window.fetch) return;
    const base = /^control\./.test(location.hostname) ? '' : 'https://control.viro3.online';
    fetch(base + '/api/v1/public/installer').then(r => r.ok ? r.json() : null).then(d => {
      if (!d || !d.available) return;
      const mb = (d.size / (1024 * 1024)).toFixed(0) + ' MB';
      const date = new Date(d.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      if (facts) { facts.querySelector('[data-dl-size]').textContent = mb; facts.querySelector('[data-dl-date]').textContent = date; facts.hidden = false; }
      if (verify) { verify.querySelector('[data-dl-size2]').textContent = mb; verify.querySelector('[data-dl-date2]').textContent = date; verify.querySelector('[data-dl-sha]').textContent = d.sha256; verify.hidden = false; }
    }).catch(() => { /* the rest of the page works without this */ });
  })();
  // The "Request a demo" form. Posted straight to the console (same API as the counters above), with a honeypot field
  // a real visitor never sees or fills in. A lead is never lost silently: on failure the form says so and leaves the
  // mailto link visible underneath, so there is always a second way to reach us.
  (function () {
    const form = document.querySelector('[data-lead-form]'); if (!form || !window.fetch) return;
    const base = /^control\./.test(location.hostname) ? '' : 'https://control.viro3.online';
    const status = form.querySelector('[data-lead-status]');
    let v = {}; try { const s = JSON.parse(localStorage.getItem('viro_src') || 'null'); v = (s && s.v) || {}; } catch (e) { /* none */ }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]'), was = btn.textContent;
      const data = Object.fromEntries(new FormData(form));
      if (!data.name || !data.organization || !data.email) { status.textContent = 'Please fill in your name, organization and email.'; status.hidden = false; return; }
      btn.disabled = true; btn.textContent = 'Sending…'; status.hidden = true;
      fetch(base + '/api/v1/public/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({}, data, { source: v.source || v.ref || 'direct' })) })
        .then(function (r) {
          if (!r.ok) throw new Error('failed');
          form.hidden = true;
          const ok = document.createElement('p'); ok.className = 'lead-ok'; ok.setAttribute('role', 'status');
          ok.textContent = "Thank you — we've received your request and will be in touch shortly.";
          form.insertAdjacentElement('afterend', ok);
        })
        .catch(function () {
          btn.disabled = false; btn.textContent = was;
          status.textContent = 'That did not go through. Please try again, or email us directly below.'; status.hidden = false;
        });
    });
  })();
})();
