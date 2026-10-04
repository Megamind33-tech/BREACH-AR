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
  // The price of Viro Care comes from the live plan list, so the page never shows a price nobody chose. With no plan on sale it keeps its default words.
  const price = document.querySelector('[data-price]');
  if (price && window.fetch) fetch('https://control.viro3.online/api/v1/public/plans').then(r => r.ok ? r.json() : null).then(d => {
    const p = d && (d.plans || []).find(x => x.audience === 'person'); if (!p) return;
    const per = p.per === 'pc' ? ' per computer' : ''; const when = p.period === 'year' ? ' a year' : p.period === 'month' ? ' a month' : '';
    price.textContent = p.currency + ' ' + Number(p.price).toLocaleString('en-US') + when + per;
  }).catch(() => { /* the default words stay */ });
  document.querySelectorAll('[data-year]').forEach(el => { el.textContent = String(new Date().getFullYear()); });
})();
