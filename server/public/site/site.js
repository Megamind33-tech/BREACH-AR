'use strict';
/* The marketing site's only script: the phone menu button and the year in the footer. Everything else works without JavaScript. */
(function () {
  const nav = document.querySelector('.nav'), btn = document.querySelector('.nav-toggle');
  if (nav && btn) {
    btn.addEventListener('click', () => { const open = nav.classList.toggle('open'); btn.setAttribute('aria-expanded', String(open)); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && nav.classList.contains('open')) { nav.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); btn.focus(); } });
    nav.querySelectorAll('.menu a').forEach(a => a.addEventListener('click', () => { nav.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }));
  }
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
