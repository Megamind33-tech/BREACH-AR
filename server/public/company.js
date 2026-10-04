'use strict';
/* Who is behind Viro WorkCare, what it does, and how to reach us. One source for the console's About page and the public /about.html,
   so both always say the same thing. Everything here is fixed text written by the company: nothing from a user or a computer is ever put into it. */
(function () {
  const COMPANY = {
    product: 'Viro WorkCare',
    name: 'Orange Mobility Solutions',
    registration: { authority: 'Patents and Companies Registration Agency (PACRA), Zambia', number: '320241014086', since: '14 June 2024' },
    address: ['18 Mukuni Road', 'Kansenshi, Ndola', 'Copperbelt Province, Zambia'],
    email: 'info@viro3.online',
    phone: '+260976092585', phoneShown: '+260 976 092 585',
    contactRole: 'Chief Operating Officer',
  };
  window.VIRO_COMPANY = COMPANY;

  const li = items => '<ul class="aboutlist">' + items.map(t => `<li>${t}</li>`).join('') + '</ul>';
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;

  /** The About content as markup (the same for the console page and the public page). */
  window.aboutHtml = function aboutHtml() {
    const c = COMPANY, year = new Date().getFullYear();
    return `<div class="hero-card">${window.heroVideoHtml ? window.heroVideoHtml() : ''}<span class="eyebrow">ABOUT</span><h1>${c.product}</h1>
        <p class="lead">Looks after the computers in your organization: health, security, updates and repairs, handled quietly and verified.</p>
        <div class="chips"><span class="chip"><i></i>Made by ${c.name}</span></div></div>
      <div class="grid about-grid">
        <div class="card"><h2>What it does</h2>${li([
          'Checks every computer’s health and raises alerts',
          'Keeps Windows, security and drivers up to date',
          'Fixes common problems on its own, then checks the fix worked',
          'Reads each computer’s parts and age, and advises on upgrades and replacement',
          'Gives your support staff remote help',
          'Records every action in an audit log',
        ])}</div>
        <div class="card"><h2>How it treats your computers</h2>${li([
          'The person at the computer is told when a remote session starts, and the session is recorded.',
          'Cleanup never touches personal files.',
          'Every change is logged: who, what and when.',
        ])}</div>
        <div class="card"><h2>The company</h2>
          <p>${c.product} is owned and operated by <b>${c.name}</b>. We build and run software that keeps an organization’s computers healthy, secure and supported.</p>
          <dl class="aboutdl">${row('Registered name', c.name)}${row('Registration no.', `<span class="nowrap">${c.registration.number}</span>`)}${row('Registered', c.registration.since)}${row('Registered with', c.registration.authority)}${row('Registered office', c.address.join('<br>'))}</dl></div>
        <div class="card contact" id="contact"><h2>Contact us</h2>
          <p class="mute">Questions, support or a demonstration: write or call and ask for the ${c.contactRole}.</p>
          <dl class="aboutdl">${row('Email', `<a href="mailto:${c.email}">${c.email}</a>`)}${row('Phone', `<a href="tel:${c.phone}">${c.phoneShown}</a>`)}${row('Attention', c.contactRole)}${row('Address', c.address.join('<br>'))}</dl>
          <div class="actions"><a class="btn" href="mailto:${c.email}">Email us</a><a class="btn ghost" href="tel:${c.phone}">Call us</a></div></div>
      </div>
      <p class="mute aboutfoot">© ${year} ${c.name}. All rights reserved.</p>`;
  };

  // The public page has no console around it: it renders itself.
  const root = document.getElementById('about-root');
  if (root) root.innerHTML = window.aboutHtml();
})();
