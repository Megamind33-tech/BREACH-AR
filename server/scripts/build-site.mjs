// Builds the marketing site (public/site/*.html) from one place, so the header, footer and company details are identical on every page.
// Usage: node scripts/build-site.mjs        (run again after changing any text below, then commit the generated pages)
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'site'); mkdirSync(OUT, { recursive: true });
const CO = {
  name: 'Orange Mobility Solutions', product: 'Viro WorkCare', reg: '320241014086', since: '14 June 2024', authority: 'Patents and Companies Registration Agency (PACRA), Zambia',
  addr: ['18 Mukuni Road', 'Kansenshi, Ndola', 'Copperbelt Province, Zambia'], email: 'info@viro3.online', phone: '+260976092585', phoneShown: '+260 976 092 585', role: 'Chief Operating Officer',
};
const DEMO = `mailto:${CO.email}?subject=${encodeURIComponent('Viro WorkCare demonstration')}&body=${encodeURIComponent('Hello,\n\nI would like to see Viro WorkCare.\n\nNumber of computers we look after:\nNumber of sites:\nOrganization:\n')}`;
const NAV = [['/site/features.html', 'Features'], ['/site/security.html', 'Security & privacy'], ['/site/about.html', 'About'], ['/site/contact.html', 'Contact']];
const esc = s => s.replace(/&(?!amp;|#)/g, '&amp;');
const IMG = Object.fromEntries(readdirSync(join(OUT, 'img')).filter(f => f.endsWith('.webp')).map(f => [f.replace('.webp', ''), execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(OUT, 'img', f)]).toString().trim().split(',').map(Number)]));
const shot = (name, alt, { eager = false } = {}) => `<img src="/site/img/${name}.webp" width="${IMG[name][0]}" height="${IMG[name][1]}" alt="${alt}"${eager ? ' fetchpriority="high"' : ' loading="lazy" decoding="async"'}>`;

const head = (title, description, page) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:type" content="website">
<meta name="theme-color" content="#fbfcfb">
<link rel="icon" type="image/png" href="/logo.png">
<link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/site/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav" id="top"><div class="wrap nav-in">
  <a class="brand" href="/site/" aria-label="Viro WorkCare home"><span class="mark"><img src="/logo.png" alt="" width="26" height="26"></span><span>Viro <b>WorkCare</b></span></a>
  <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="menu">Menu</button>
  <nav class="menu" id="menu" aria-label="Main">${NAV.map(([h, t]) => `<a href="${h}"${h === page ? ' aria-current="page"' : ''}>${esc(t)}</a>`).join('')}<a class="only-small" href="https://control.viro3.online/" data-signin>Sign in</a></nav>
  <div class="nav-cta"><a class="link" href="https://control.viro3.online/" data-signin>Sign in</a><a class="btn small" href="${DEMO}">Request a demo</a></div>
</div></header>
<main id="main">
`;
const foot = () => `</main>
<footer><div class="wrap">
  <div class="foot">
    <div><a class="brand" href="/site/"><span class="mark"><img src="/logo.png" alt="" width="26" height="26"></span><span>Viro <b>WorkCare</b></span></a><p>Care for the Windows computers in your organization: health, security, updates and repairs.</p></div>
    <div><h4>Product</h4><ul><li><a href="/site/features.html">Features</a></li><li><a href="/site/security.html">Security &amp; privacy</a></li><li><a href="https://control.viro3.online/" data-signin>Sign in</a></li></ul></div>
    <div><h4>Company</h4><ul><li><a href="/site/about.html">About us</a></li><li><a href="/site/contact.html">Contact</a></li><li><a href="${DEMO}">Request a demo</a></li></ul></div>
    <div><h4>${CO.name}</h4><ul><li><a href="mailto:${CO.email}">${CO.email}</a></li><li><a href="tel:${CO.phone}">${CO.phoneShown}</a></li><li>${CO.addr.join('<br>')}</li></ul></div>
  </div>
  <div class="legal"><span>&copy; <span data-year>2026</span> ${CO.name}. All rights reserved.</span><span>Registered in Zambia &middot; PACRA no. ${CO.reg}</span></div>
</div></footer>
<script src="/site/site.js"></script>
</body>
</html>
`;
const band = (h, p) => `<section class="tight"><div class="wrap"><div class="band">
  <video class="hero-video" muted loop playsinline autoplay preload="metadata" poster="/media/hero-poster.jpg" aria-hidden="true" tabindex="-1" disablepictureinpicture disableremoteplayback><source src="/media/hero.mp4" type="video/mp4"></video>
  <h2>${h}</h2><p>${p}</p>
  <div class="actions"><a class="btn light" href="${DEMO}">Request a demo</a><a class="btn ghost" style="color:#fff;border-color:rgba(255,255,255,.45)" href="tel:${CO.phone}">Call ${CO.phoneShown}</a></div>
</div></div></section>
<script src="/hero-video.js"></script>
`;
const row = ({ title, text, points, img, alt, flip }) => `<div class="row${flip ? ' flip' : ''}">
  <div class="text"><h2>${title}</h2><p>${text}</p><ul class="points">${points.map(p => `<li>${p}</li>`).join('')}</ul></div>
  <div class="panel"><div class="shot">${shot(img, alt)}</div></div>
</div>`;

const pages = {};

// ------------------------------------------------------------------ home
pages['index.html'] = head('Viro WorkCare: quiet, reliable care for every computer you manage', 'Viro WorkCare watches the health of your Windows computers, fixes common problems on its own, and tells you what to repair, upgrade or replace, with the reasons.', '/site/') + `
<section class="hero"><div class="wrap">
  <h1>Every computer you manage, quietly looked after.</h1>
  <p class="lead">Viro WorkCare watches the health of your Windows computers, fixes common problems on its own, and tells you what to repair, upgrade or replace, with the reasons.</p>
  <div class="actions"><a class="btn" href="${DEMO}">Request a demo</a><a class="btn ghost" href="#how">See how it works</a></div>
  <p class="note">For Windows computers. One installer per organization, nothing to configure on each machine.</p>
  <div class="stage"><div class="frame">${shot('shot-overview', 'The Viro WorkCare overview page in the light theme: eight computers online, health 98 out of 100, one alert to review, and Autopilot switched on.', { eager: true })}</div></div>
  <p class="caption">Sample data from a fictional school, Riverside Academy.</p>
</div></section>

<section id="what"><div class="wrap">
  <div class="sec-head"><h2>What it does</h2><p>Four things, each shown here on a real screen.</p></div>
  ${row({ title: 'See every computer at a glance', text: 'One page shows which computers are online, how healthy they are, and what needs a person. Group them by site and department.', points: ['A health score for every computer, with the reasons behind it', 'Alerts stay open while a fault exists and close themselves when it is fixed', 'Acknowledge an alert once and it stops asking for you'], img: 'shot-computers', alt: 'The Computers page listing eight computers with their health, site and department.' })}
  ${row({ flip: true, title: 'Know what is wrong, and why', text: 'Open any computer to see its status, its parts and the most serious fault first, with the evidence behind it.', points: ['Findings in plain words: “System drive almost full”, not an error code', 'Cleanup that never touches personal files', 'Repairs run in your maintenance window and are checked afterwards'], img: 'shot-computer', alt: 'A computer’s page showing its status, remote control actions, and a health score of 87 with “System drive almost full” as the top fault.' })}
  ${row({ title: 'Know what to repair, upgrade or replace', text: 'Viro reads every part, its age and its wear, then shows what each computer can accept. Every recommendation comes with the reasons.', points: ['Early drive-failure warnings that Windows itself does not show', 'What fits: free memory slots, maximum memory, drive type', 'Repair or replace, set against the price of a new computer'], img: 'shot-upgrades', alt: 'An upgrade plan for one computer: the best upgrade is replacing a failing hard drive with a solid-state drive, with compatibility, expected improvement and confidence.' })}
  ${row({ flip: true, title: 'Help people without leaving your desk', text: 'Watch or control a screen, open a terminal or browse files, and restart with a visible countdown. The person at the computer is told when a session starts.', points: ['Wake a computer over the network, where its hardware allows', 'Every session is recorded: who, which computer, and why'], img: 'shot-remote', alt: 'The Remote control panel with Watch screen, Control screen, Terminal, Files, Restart, Shut down and Cancel.' })}
</div></section>

<section class="tint" id="how"><div class="wrap">
  <div class="sec-head"><h2>How it works</h2></div>
  <div class="steps">
    <div class="step"><div class="n">1</div><h3>Install one file</h3><p>Download the installer for your organization and run it on each computer. There is nothing to configure.</p></div>
    <div class="step"><div class="n">2</div><h3>Computers appear on their own</h3><p>Each one reports its health and its parts. Organize them by site and department.</p></div>
    <div class="step"><div class="n">3</div><h3>Viro does the routine work</h3><p>Updates, cleanup and common repairs run in your maintenance window. You review what needs a person.</p></div>
  </div>
</div></section>

<section><div class="wrap split">
  <div><h2 style="font-size:clamp(30px,4vw,46px);letter-spacing:-.03em">Built so you can trust what it does.</h2><p style="color:var(--mute);margin-top:16px;font-size:19px;line-height:1.55">Software that can change your computers has to earn that trust. This is how Viro is built to.</p><a class="textlink" href="/site/security.html">Security and privacy</a></div>
  <ul class="facts">
    <li><b>Signed updates</b><span>Every update to the Viro agent is digitally signed and verified before it installs, and rolled back if the new version does not start.</span></li>
    <li><b>Signed actions</b><span>Every administrative action, such as a repair or a restart, is a signed job that the computer checks before it runs.</span></li>
    <li><b>Announced, recorded sessions</b><span>The person at the computer sees a notice when remote help starts. Sessions are recorded.</span></li>
    <li><b>An audit log of everything</b><span>Who did what, on which computer and when, with the previous and the new state.</span></li>
    <li><b>Two-step sign-in</b><span>Owners, administrators and technicians can be required to use an authenticator app.</span></li>
  </ul>
</div></section>

<section class="tight tint"><div class="wrap split">
  <div><h2 style="font-size:clamp(26px,3.2vw,36px);letter-spacing:-.03em">Made by ${CO.name}</h2></div>
  <div><p style="color:var(--mute);font-size:18px">Viro WorkCare is built and operated by ${CO.name}, a company based in Ndola, Zambia.</p><a class="textlink" href="/site/about.html">About us</a></div>
</div></section>
` + band('See it on your own computers.', 'Write or call, and we will arrange a demonstration for your organization.') + foot();

// ------------------------------------------------------------------ features
const feat = items => `<div class="feat">${items.map(([b, s]) => `<div><b>${b}</b><span>${s}</span></div>`).join('')}</div>`;
const block = (id, h, p, items, img) => `<div class="section-block" id="${id}"><h2>${h}</h2><p>${p}</p>${feat(items)}${img ? `<div class="panel" style="margin-top:34px"><div class="shot">${shot(...img)}</div></div>` : ''}</div>`;
pages['features.html'] = head('Features | Viro WorkCare', 'Everything Viro WorkCare does: health and alerts, Autopilot, security, updates, hardware and lifecycle advice, remote support and administration.', '/site/features.html') + `
<div class="wrap"><div class="page-head"><h1>Everything Viro WorkCare does</h1><p class="lead">A complete list, grouped by the job you are trying to get done. Screens show sample data from a fictional school.</p></div></div>
<div class="wrap layout">
  <nav class="toc" aria-label="On this page"><a href="#health">Health and alerts</a><a href="#autopilot">Autopilot</a><a href="#security">Security</a><a href="#updates">Updates, drivers, software</a><a href="#hardware">Hardware and lifecycle</a><a href="#remote">Remote support</a><a href="#admin">Administration</a><a href="#pc">On each computer</a></nav>
  <div>
    ${block('health', 'Health and alerts', 'Know which computers need you, and why.', [['A health score for every computer', 'Disk space, security status, updates and hardware faults feed one score, and every deduction is listed.'], ['Alerts that close themselves', 'An alert stays open while the fault exists and closes when it is fixed. Acknowledge it so it stops asking for you.'], ['Shared problems', 'When many computers have the same fault, Viro groups them and shows what they have in common.'], ['Webhooks', 'Send each new alert, and its resolution, to a chat tool.'], ['Sites and departments', 'Organize computers the way your organization is organized, and filter by site, department or tag.'], ['Reports', 'Summaries for the last week, month or quarter, and CSV exports of computers and jobs.']], ['shot-alerts', 'The Alerts page showing one warning: the system drive on LIBRARY-03 is almost full.'])}
    ${block('autopilot', 'Autopilot', 'Routine care that runs by itself, and reports what it did.', [['Maintenance windows', 'Updates, repairs and checks run when you say, not in the middle of a lesson.'], ['Repairs that are checked', 'A repair is counted only after Viro has verified that it worked. If it did not, you are told.'], ['Safe cleanup only', 'Temporary files and caches. Personal files are never touched.'], ['A weekly summary', 'What was fixed, how much space was recovered, and what still needs a person.']])}
    ${block('security', 'Security', 'Use the protection Windows already provides, and check that it is on.', [['Windows Security status', 'See, per computer, whether protection is on, current and healthy.'], ['Protection that is switched on and monitored', 'Viro turns on what Windows and Microsoft Defender already offer, and alerts when it is turned off.'], ['Threat response', 'Microsoft Defender detects threats; Viro contains them and looks for what they changed.'], ['Tamper checks', 'You are alerted if the Viro agent’s program does not match its signed release, or if its data folder is exposed.']])}
    ${block('updates', 'Updates, drivers and software', 'Keep computers current without surprises.', [['Windows updates', 'See what is pending across every computer, and install it in your maintenance window.'], ['Drivers in stages', 'Roll a driver out to a test computer, then a pilot group, then everyone, with a halt and a rollback.'], ['Software you approve', 'Install, update and uninstall only the packages you have approved.'], ['Restart when it suits', 'Restart with a visible countdown so people can save their work.']])}
    ${block('hardware', 'Hardware and lifecycle', 'Decide what to keep, repair, upgrade or replace, with the reasons.', [['A hardware report for every computer', 'Every part, its age, its wear and what is likely to fail first. Printable.'], ['Upgrade advice', 'What each computer can accept: free memory slots, maximum memory and drive type. Checked against its motherboard and firmware.'], ['Keep, repair or replace', 'A recommendation for each computer, never decided by age alone.'], ['Your own prices', 'Load typical prices to start, then enter your own so costs match your market.']], ['shot-lifecycle', 'The Lifecycle page listing each computer with a recommendation such as Keep in service or Maintain, and the reasons.'])}
    ${block('remote', 'Remote support', 'Help people from your desk, in the open.', [['See and control the screen', 'Watch a screen, or take control of it, while the person is there.'], ['Terminal and files', 'Run commands and move files. The session is recorded.'], ['Power actions', 'Restart or shut down with a visible countdown, cancel a pending one, and wake a computer over the network where its hardware allows.'], ['Announced and recorded', 'The person at the computer is told when a session starts. Either side can end it.']])}
    ${block('admin', 'Administration', 'Control who can do what, and keep a record.', [['Roles', 'Viewer, technician, administrator and owner, each limited to what they need.'], ['Two-step sign-in', 'An authenticator app with recovery codes, and an option to require it.'], ['An audit log', 'Who did what, on which computer and when, with the previous and new state.'], ['Team management', 'Add people, change roles, disable access, and reset a lost second step.']])}
    ${block('pc', 'On each computer', 'A window for the person who uses it.', [['A Viro window on every computer', 'The person at the computer can see how it is doing and what Viro has done.'], ['Runs as a Windows service', 'The agent starts with Windows, reports in, and updates itself with signed updates.']])}
  </div>
</div>
` + band('Want to see it with your own computers?', 'Tell us how many computers you look after and we will arrange a demonstration.') + foot();

// ------------------------------------------------------------------ security
pages['security.html'] = head('Security and privacy | Viro WorkCare', 'How Viro WorkCare protects your computers, how remote sessions work, and exactly what it collects and does not collect.', '/site/security.html') + `
<div class="wrap"><div class="page-head"><h1>Security and privacy</h1><p class="lead">Software that can change your computers has to be careful. Here is how Viro is built, how remote help works, and exactly what it collects.</p></div></div>
<div class="wrap layout">
  <nav class="toc" aria-label="On this page"><a href="#built">How it is built</a><a href="#remote">Remote sessions</a><a href="#collects">What it collects</a><a href="#never">What it does not collect</a><a href="#questions">Questions</a></nav>
  <div class="prose">
    <h2 id="built">How it is built</h2>
    <ul>
      <li><b>Signed updates.</b> Every update to the Viro agent is digitally signed. The computer checks the signature and the file’s fingerprint before installing, and rolls back if the new version does not start.</li>
      <li><b>Signed actions.</b> Every administrative action, such as a repair or a restart, is a signed job. The computer refuses a job that is not signed by your Control server, or that has expired.</li>
      <li><b>Tamper checks.</b> The agent reports a fingerprint of its own program and whether its data folder is protected. Your Control server raises an alert if the program does not match the signed release.</li>
      <li><b>Separate organizations.</b> Each organization’s data is separate. One organization cannot see another’s computers, people or records.</li>
      <li><b>Roles and two-step sign-in.</b> People have only the access their role needs. An authenticator app can be required for owners, administrators and technicians.</li>
      <li><b>An audit log.</b> Every administrative action is recorded with who, what, where and when.</li>
    </ul>

    <h2 id="remote">How remote sessions work</h2>
    <ul>
      <li>A support person must give a reason, which is recorded.</li>
      <li>The person at the computer sees a notice that a session has started.</li>
      <li>Either side can end the session at any time.</li>
      <li>The session is recorded in the audit log: who connected, to which computer, when, and why.</li>
      <li>Screen watching and control happen only while a session is open.</li>
    </ul>

    <h2 id="collects">What it collects</h2>
    <p class="mute">Viro collects only what it needs to look after the computer. Each item is used for the purpose in the right-hand column.</p>
    <table class="table"><thead><tr><th>Information</th><th>What it is, and why</th></tr></thead><tbody>
      <tr><td>Health</td><td>Disk space, Windows update and security status, start-up time, crashes, heat and battery. To raise alerts and score health.</td></tr>
      <tr><td>Inventory</td><td>The computer’s hardware and the software installed, with versions. To plan updates and upgrades.</td></tr>
      <tr><td>Hardware condition</td><td>Parts and their serial numbers where Windows exposes them, age evidence, drive self-monitoring counters and memory errors. To warn before something fails.</td></tr>
      <tr><td>Activity</td><td>Processor and memory use, uptime, the signed-in user’s account name and the computer’s network address. To show whether a computer is busy, idle or offline.</td></tr>
      <tr><td>Browser extensions</td><td>The names of installed Chrome and Edge extensions. So an unsafe extension can be found and blocked.</td></tr>
      <tr><td>Support sessions</td><td>Who connected, when, why, and what was done. For accountability.</td></tr>
    </tbody></table>

    <h2 id="never">What it does not collect</h2>
    <ul>
      <li>The contents of your files.</li>
      <li>Browser history, cookies or saved passwords.</li>
      <li>Keystrokes.</li>
      <li>What is on the screen, except while a support session is open.</li>
    </ul>
    <p>Cleanup removes temporary files and browser caches only. It never touches personal files, cookies, history or passwords.</p>
    <div class="callout">Your organization decides who is an administrator, and every administrative action is recorded in your audit log.</div>

    <h2 id="questions">Questions</h2>
    <p>If you want to know more about how your data is handled, write to <a href="mailto:${CO.email}">${CO.email}</a> or call <a href="tel:${CO.phone}">${CO.phoneShown}</a>.</p>
  </div>
</div>
` + band('Questions about your data?', 'Ask us anything about how Viro works before you decide.') + foot();

// ------------------------------------------------------------------ about
pages['about.html'] = head('About us | Viro WorkCare', 'Viro WorkCare is built and operated by Orange Mobility Solutions, a company based in Ndola, Zambia.', '/site/about.html') + `
<div class="wrap"><div class="page-head"><h1>About Viro WorkCare and ${CO.name}</h1><p class="lead">We build and run software that keeps an organization’s computers healthy, secure and supported.</p></div></div>
<div class="wrap" style="padding-bottom:96px"><div class="split">
  <div class="prose">
    <h2>What we do</h2>
    <p>${CO.product} looks after the Windows computers in an organization. It watches their health, keeps them updated, fixes common problems on its own, and tells the people responsible what to repair, upgrade or replace, with the reasons.</p>
    <p>It is made for organizations that depend on their computers but may not have a full IT department: schools, offices and similar places.</p>
    <h2>How we work</h2>
    <ul>
      <li><b>Say what we did, and why.</b> Every recommendation comes with its reasons, and every repair is checked afterwards.</li>
      <li><b>Ask before we act on someone’s computer.</b> Remote help is announced to the person at the computer and recorded.</li>
      <li><b>Hide nothing.</b> Every administrative action is in the audit log.</li>
    </ul>
    <p><a class="textlink" href="/site/security.html">Read about security and privacy</a></p>
  </div>
  <div>
    <h2 style="font-size:24px;margin-bottom:18px">The company</h2>
    <dl class="defs">
      <dt>Name</dt><dd>${CO.name}</dd>
      <dt>Product</dt><dd>${CO.product}</dd>
      <dt>Registration no.</dt><dd>${CO.reg}</dd>
      <dt>Registered</dt><dd>${CO.since}</dd>
      <dt>Registered with</dt><dd>${CO.authority}</dd>
      <dt>Registered office</dt><dd>${CO.addr.join('<br>')}</dd>
    </dl>
    <h2 style="font-size:24px;margin:44px 0 18px">Get in touch</h2>
    <dl class="defs">
      <dt>Email</dt><dd><a href="mailto:${CO.email}">${CO.email}</a></dd>
      <dt>Phone</dt><dd><a href="tel:${CO.phone}">${CO.phoneShown}</a></dd>
      <dt>Attention</dt><dd>${CO.role}</dd>
    </dl>
  </div>
</div></div>
` + band('Meet Viro WorkCare.', 'Write or call, and we will arrange a demonstration for your organization.') + foot();

// ------------------------------------------------------------------ contact
pages['contact.html'] = head('Contact | Viro WorkCare', 'Contact Orange Mobility Solutions to request a demonstration of Viro WorkCare, or to ask a question.', '/site/contact.html') + `
<div class="wrap"><div class="page-head"><h1>Contact us</h1><p class="lead">Questions, support or a demonstration: write or call, and ask for the ${CO.role}.</p></div></div>
<div class="wrap" style="padding-bottom:40px"><div class="contact-cards">
  <a href="mailto:${CO.email}"><small>Email</small><strong>${CO.email}</strong></a>
  <a href="tel:${CO.phone}"><small>Phone</small><strong>${CO.phoneShown}</strong></a>
  <div><small>Address</small><strong style="line-height:1.4">${CO.addr.join('<br>')}</strong></div>
</div></div>
<div class="wrap" style="padding-bottom:112px"><div class="prose">
  <h2>Request a demonstration</h2>
  <p>Tell us how many computers you look after, and whether they are in one place or on several sites. We will arrange a demonstration for your organization.</p>
  <p style="margin-top:22px"><a class="btn" href="${DEMO}">Request a demo</a></p>
  <h2>Already a customer?</h2>
  <p>Sign in to your organization’s console, or write to us if you cannot.</p>
  <p style="margin-top:18px"><a class="btn ghost" href="https://control.viro3.online/" data-signin>Sign in</a></p>
</div></div>
` + foot();

for (const [file, html] of Object.entries(pages)) { writeFileSync(join(OUT, file), html); console.log('wrote site/' + file, html.length, 'bytes'); }
