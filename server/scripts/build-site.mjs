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
const NAV = [['/site/features.html', 'Features'], ['/site/#pricing', 'Pricing'], ['/site/security.html', 'Security & privacy'], ['/site/about.html', 'About'], ['/site/contact.html', 'Contact']];
const PRICE = { care: 250, careHelp: 450, orgFrom: 35, certificate: 60 };
const DL = '/install/ViroAgent.msi', SIGNUP = 'https://control.viro3.online/?signup=1';
const esc = s => s.replace(/&(?!amp;|#)/g, '&amp;');
const IMG = Object.fromEntries(readdirSync(join(OUT, 'img')).filter(f => f.endsWith('.webp')).map(f => [f.replace('.webp', ''), execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(OUT, 'img', f)]).toString().trim().split(',').map(Number)]));
const shot = (name, alt, { eager = false, fade = false } = {}) => `<img class="pic${fade ? ' fade' : ''}" src="/site/img/${name}.webp" width="${IMG[name][0]}" height="${IMG[name][1]}" alt="${alt}"${eager ? ' fetchpriority="high"' : ' loading="lazy" decoding="async"'}>`;

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
  <div class="nav-cta"><a class="link" href="https://control.viro3.online/" data-signin>Sign in</a><a class="btn small" href="${DL}">Download free</a></div>
</div></header>
<main id="main">
`;
const foot = () => `</main>
<footer><div class="wrap">
  <div class="foot">
    <div><a class="brand" href="/site/"><span class="mark"><img src="/logo.png" alt="" width="26" height="26"></span><span>Viro <b>WorkCare</b></span></a><p>Care for your Windows PC, or for every computer in an organization: fixes that are checked, changes you can undo, and a way to move to a new PC without starting over.</p></div>
    <div><h4>Product</h4><ul><li><a href="/site/features.html">Features</a></li><li><a href="/site/#pricing">Pricing</a></li><li><a href="${DL}">Download for Windows</a></li><li><a href="${SIGNUP}">Create an account</a></li><li><a href="/site/security.html">Security &amp; privacy</a></li><li><a href="https://control.viro3.online/" data-signin>Sign in</a></li></ul></div>
    <div><h4>Company</h4><ul><li><a href="/site/about.html">About us</a></li><li><a href="/site/contact.html">Contact</a></li><li><a href="/site/privacy.html">Privacy</a></li><li><a href="/site/terms.html">Terms</a></li><li><a href="${DEMO}">Request a demo</a></li></ul></div>
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
  <div class="actions"><a class="btn light" href="${DL}">Download free for Windows</a><a class="btn ghost" style="color:#fff;border-color:rgba(255,255,255,.45)" href="${DEMO}">Request a demo for an organization</a></div>
</div></div></section>
<script src="/hero-video.js"></script>
`;
const row = ({ title, text, points, img, alt, flip, fade }) => `<div class="row${flip ? ' flip' : ''}">
  <div class="text"><h2>${title}</h2><p>${text}</p><ul class="points">${points.map(p => `<li>${p}</li>`).join('')}</ul></div>
  <div class="media">${shot(img, alt, { fade })}</div>
</div>`;

const ICO = {
  clean: '<path d="M4 20h10M7 20l3-9 4 2-3 7"/><path d="M13 5l2-2 2 2-2 2zM17 9l3-1M10 8L8 5"/>', rocket: '<path d="M5 15c-1 2-1 4-1 4s2 0 4-1M9 14l-3-3c1-4 5-8 12-8 0 7-4 11-8 12z"/><circle cx="14.5" cy="9.5" r="1.5"/>',
  chip: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"/>', update: '<path d="M12 4v11M7.5 11L12 15.5 16.5 11M5 20h14"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/>', shield: '<path d="M12 3l7 3v5.5c0 4.4-3 7.8-7 9.5-4-1.700-7-5.100-7-9.500V6z"/><path d="M8.500 12l2.500 2.500 4.500-5"/>',
  clock: '<circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 2"/>', disk: '<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M3 14l3-8h12l3 8M7 17h.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.500 9.500a2.500 2.500 0 015 .5c0 1.500-2.500 2-2.500 3.500M12 17h.01"/>', win: '<path d="M3 5.500l7-1v7H3zM11 4.400l10-1.400v8.500H11zM3 12.500h7v7l-7-1zM11 12.500h10V21l-10-1.400z"/>',
};
const ico = n => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[n]}</svg>`;
const pages = {};

// ------------------------------------------------------------------ home
pages['index.html'] = head('Viro WorkCare: your PC, looked after and proved', 'Viro finds what is wrong with your Windows PC, fixes it, checks the fix worked and lets you undo it. Move to a new PC without starting over. For one PC or a whole organization.', '/site/') + `
<section class="hero3"><div class="wrap hero3-in">
  <div class="hero3-text">
    <p class="eyebrow">Windows PC care, made in Zambia</p>
    <h1>Your PC, looked after. And proved.</h1>
    <p class="lead">Free cleaners clear junk and hope. Viro finds what is actually wrong, fixes it, checks that the fix worked, and lets you undo it. When you buy a new PC, everything comes with you.</p>
    <div class="actions"><a class="btn big" href="${DL}">Download free for Windows</a><a class="btn big ghost" href="${SIGNUP}">Create a free account</a></div>
    <p class="note">Free to start. For a school, shop or office: <a href="${DEMO}">request a demonstration</a>.</p>
  </div>
  <div class="collage">
    ${shot('app-overview', 'The Viro WorkCare window: this PC at a glance, with its health score, memory, drive and the seven things that need attention.', { eager: true })}
    <div class="float">${shot('app-fix', 'The result of Fix my PC: space freed, memory in use down, start-up programs turned off, each with an Undo.', { eager: true })}</div>
  </div>
</div></section>

<section class="strip"><div class="wrap"><ul class="proof">
  <li><b>Checked</b><span>Every fix is measured before and after, so you see what changed.</span></li>
  <li><b>Undoable</b><span>Every change can be put back exactly as it was.</span></li>
  <li><b>Honest</b><span>It says what it measured and what it could not. No scare scores.</span></li>
  <li><b>Made in Zambia</b><span>By ${CO.name}, with local payment and local support.</span></li>
</ul></div></section>

<section class="dark" id="proof"><div class="wrap">
  <div class="sec-head center"><p class="eyebrow">The difference</p><h2>Fix it, then prove it.</h2><p>One click clears temporary files, gives back idle memory and turns off start-up programs that only slow you down. Viro measures your PC before and after, so you see what actually changed, and every step has an Undo.</p></div>
  <div class="stage3">${shot('app-fix', 'Fix my PC: 11.8 GB freed, memory in use down from 71% to 52%, six start-up programs turned off, each fix checked, with an Undo.')}</div>
</div></section>

<section id="compare"><div class="wrap">
  <div class="sec-head"><h2>Free cleaners clear junk. Viro does the rest.</h2><p>Tools like Microsoft PC Manager are a good start, and the cleaning part of Viro is free too. What they do not do is where Viro earns its place.</p></div>
  <div class="compare-wrap"><table class="compare">
    <thead><tr><th></th><th>Free cleaners<small>like Microsoft PC Manager</small></th><th>Viro Free</th><th class="hl">Viro Care</th></tr></thead>
    <tbody>
      <tr><th scope="row">Clear temporary files and caches</th><td class="y">Yes</td><td class="y">Yes</td><td class="y hl">Yes</td></tr>
      <tr><th scope="row">Manage start-up programs and memory</th><td class="y">Yes</td><td class="y">Yes</td><td class="y hl">Yes</td></tr>
      <tr><th scope="row">Installed programs with their sizes</th><td class="y">Yes</td><td class="y">Yes</td><td class="y hl">Yes</td></tr>
      <tr><th scope="row">Every fix re-checked, with before and after and undo</th><td class="n">No</td><td class="n">No</td><td class="y hl">Yes</td></tr>
      <tr><th scope="row">Finds why a PC is slow or crashing</th><td class="n">No</td><td class="n">No</td><td class="y hl">Yes</td></tr>
      <tr><th scope="row">Early warning for failing drives and batteries</th><td class="n">No</td><td class="n">No</td><td class="y hl">Yes</td></tr>
      <tr><th scope="row">Repair, upgrade or replace advice, with a price for your PC's age</th><td class="n">No</td><td class="n">No</td><td class="y hl">Yes</td></tr>
      <tr><th scope="row">Remove stubborn programs, with undo</th><td class="n">No</td><td class="n">No</td><td class="y hl">Yes</td></tr>
      <tr><th scope="row">Back up and move to a new PC, encrypted</th><td class="n">No</td><td class="n">No</td><td class="y hl">Yes</td></tr>
      <tr><th scope="row">A real technician to ask</th><td class="n">No</td><td class="n">No</td><td class="y hl">With help plan</td></tr>
    </tbody></table></div>
</div></section>

<section class="tint"><div class="wrap">
  ${row({ title: 'Know what is wearing out, and what it will cost', text: 'Viro reads your drives, battery, memory and cooling, and says in plain words what to do. It weighs repair against replacement for a PC of your age, with an estimated price.', points: ['Warnings for failing drives and tired batteries before they fail', 'Repair, upgrade or replace, with the reasons and a price', 'How the PC has been used: Windows upgrades, drive hours, unsafe shut-downs'], img: 'app-report', alt: 'The PC report: one part to replace soon, three to watch, an estimated age of 6.7 years and a verdict of repair it, with USD 125 of work to expect.' })}
  ${row({ flip: true, title: 'Get a new PC without starting over', text: 'Back up your files, wallpaper and settings, bookmarks, Wi-Fi networks and your list of programs. On the new PC, sign in, enter your passphrase and put it all back.', points: ['Encrypted on your PC before it leaves it: Viro cannot read it', 'Programs are reinstalled for you; the ones Windows cannot find are listed', 'Nothing on the new PC is overwritten'], img: 'app-move', alt: 'Viro Move: choose your folders, settings and programs, then protect the backup with a passphrase only you know.' })}
  ${row({ title: 'Buying or selling a used PC? Show the proof', text: 'Viro inspects the PC afresh and emails a signed certificate straight to the buyer. The seller cannot edit it. It says how old the PC is, what is worn, what repairs to expect and what it is worth.', points: ['Sent only to the buyer, so it cannot be faked', 'The buyer checks the serial number on the certificate page', 'Honest about what it could not see'], img: 'cert-inspection', alt: 'A Viro Certificate of Inspection for a Dell Latitude 5400: assessment, about 6.5 years old, USD 220 of work to expect, with a verification seal.', fade: true })}
</div></section>

<section id="more"><div class="wrap">
  <div class="sec-head"><h2>And everything else a PC needs.</h2><p>The basics are free and always will be. The rest is in Viro Care.</p></div>
  <div class="grid3">
    <div class="cell">${ico('clean')}<h3>Free up space</h3><p>Clear temporary files and caches that Windows leaves behind.</p></div>
    <div class="cell">${ico('rocket')}<h3>Start-up programs</h3><p>Turn off what only slows you down. Everything still opens when you start it.</p></div>
    <div class="cell">${ico('chip')}<h3>Memory</h3><p>Ask Windows to take back idle memory. Nothing is closed.</p></div>
    <div class="cell">${ico('trash')}<h3>Uninstall properly</h3><p>Sizes for every program, and stubborn or hidden ones removed with undo.</p></div>
    <div class="cell">${ico('disk')}<h3>Backup check</h3><p>Are your files really protected? Viro looks at OneDrive, Windows Backup and Viro Move.</p></div>
    <div class="cell">${ico('clock')}<h3>Weekly care</h3><p>The safe fixes run by themselves, and a report arrives by email.</p></div>
    <div class="cell">${ico('update')}<h3>Updates</h3><p>Windows and program updates in one place, installed when you choose.</p></div>
    <div class="cell">${ico('win')}<h3>Windows 11 ready?</h3><p>Whether your PC can move up, and what that means for its security updates.</p></div>
    <div class="cell">${ico('help')}<h3>Ask a technician</h3><p>A real person reads your question and replies. Part of the help plan.</p></div>
  </div>
</div></section>

<section class="tint"><div class="wrap">
  <div class="sec-head center"><h2>How it works</h2></div>
  <div class="steps">
    <div class="step"><div class="n">1</div><h3>Download and open it</h3><p>One small installer. The free tools work straight away, with no account.</p></div>
    <div class="step"><div class="n">2</div><h3>See what is wrong</h3><p>Viro scans your PC and explains each finding in plain words, with the fix next to it.</p></div>
    <div class="step"><div class="n">3</div><h3>Fix it, and see the proof</h3><p>Choose Viro Care when you want the checked fixes, the warnings and the move to a new PC.</p></div>
  </div>
</div></section>

<section id="pricing"><div class="wrap">
  <div class="sec-head"><h2>Start free. Pay when it earns it.</h2><p>No card needed. Pay by mobile money, bank transfer or cash, and your plan starts when we confirm the payment.</p></div>
  <div class="plans">
    <div class="plan"><h3>Free</h3><p class="amt"><b>K&nbsp;0</b><span>free for ever</span></p><ul><li>Full scan of what is wrong</li><li>Free up space, start-up programs, memory</li><li>Installed programs with sizes</li><li>Windows and program updates</li></ul><a class="btn ghost" href="${DL}">Download free</a></div>
    <div class="plan feat-plan" data-plan-code="care-year"><span class="badge">Most people</span><h3>Viro Care</h3><p class="amt"><b data-amt>K&nbsp;${PRICE.care}</b><span>a year, for one PC</span></p><ul><li>Everything in Free</li><li>Fixes that are checked, with undo</li><li>Why it is slow or crashing</li><li>Failing drive and battery warnings</li><li>Repair or replace advice with a price</li><li>Remove stubborn programs</li><li>Backup check and weekly care</li><li>Viro Move to a new PC</li></ul><a class="btn" href="${SIGNUP}">Create a free account</a></div>
    <div class="plan" data-plan-code="care-help-year"><h3>Care with help</h3><p class="amt"><b data-amt>K&nbsp;${PRICE.careHelp}</b><span>a year, for one PC</span></p><ul><li>Everything in Viro Care</li><li>Ask a technician, by email, any time</li><li>Replies from a real person</li></ul><a class="btn ghost" href="${SIGNUP}">Create a free account</a></div>
    <div class="plan"><h3>Organizations</h3><p class="amt"><b>from K&nbsp;${PRICE.orgFrom}</b><span>a computer, a month</span></p><ul><li>Every computer in one console</li><li>Autopilot, alerts and remote support</li><li>Updates and drivers in stages</li><li>Audit log and two-step sign-in</li></ul><a class="btn ghost" href="${DEMO}">Request a demo</a></div>
  </div>
  <p class="foot-note">Buyer certificates for sellers and shops: K&nbsp;${PRICE.certificate} each. Prices are in Zambian kwacha. <a href="/site/terms.html#plans">Plan terms</a>.</p>
</div></section>

<section class="tint" id="business"><div class="wrap split">
  <div><h2 style="font-size:clamp(28px,3.6vw,42px);letter-spacing:-.03em">Looking after more than one PC?</h2><p style="color:var(--mute);margin-top:16px;font-size:19px;line-height:1.55">Schools, shops and offices get one console for every computer: health at a glance, Autopilot for routine work, early hardware warnings and remote help from your desk.</p><p style="margin-top:22px"><a class="textlink" href="/site/features.html">See everything the console does</a></p></div>
  <div class="media">${shot('shot-overview', 'The Viro console in the light theme: eight computers online, health 98 out of 100, one alert to review.')}</div>
</div></section>

<section><div class="wrap split">
  <div><h2 style="font-size:clamp(30px,4vw,46px);letter-spacing:-.03em">Built so you can trust what it does.</h2><p style="color:var(--mute);margin-top:16px;font-size:19px;line-height:1.55">Software that changes your PC has to earn that trust. This is how Viro is built to.</p><a class="textlink" href="/site/security.html" style="margin-top:20px">Security and privacy</a></div>
  <ul class="facts">
    <li><b>Changes you can undo</b><span>Viro keeps what it needs to put things back, and records every change.</span></li>
    <li><b>Backups only you can read</b><span>Encrypted on your PC with a passphrase only you know. We cannot read them or recover the passphrase.</span></li>
    <li><b>Signed updates and actions</b><span>Updates to Viro are digitally signed and verified before they install, and rolled back if the new version does not start.</span></li>
    <li><b>Certificates that cannot be forged</b><span>Signed by Viro and sent only to the buyer. An edited copy fails the check.</span></li>
    <li><b>No selling your data</b><span>We do not sell it, read your files or run adverts. <a href="/site/privacy.html">Read the privacy notice</a>.</span></li>
  </ul>
</div></section>

<section class="tint" id="faq"><div class="wrap narrow">
  <div class="sec-head"><h2>Questions</h2></div>
  <div class="faq">
    <details><summary>Which computers does it work on?</summary><p>Windows 10 and Windows 11 PCs. Viro is built for Windows only today: it does not run on Mac, Linux or phones. It also tells you when a PC cannot run Windows 11 and what that means for its security updates.</p></details>
    <details><summary>Is it safe to let Viro change my PC?</summary><p>Viro checks the result of every change and keeps what it needs to undo it. It refuses to touch Windows itself, Microsoft runtimes and Viro. A program removed by force is moved aside, not deleted, so it can be brought back.</p></details>
    <details><summary>What does the free plan include?</summary><p>A full scan that tells you what is wrong, clearing temporary files, start-up programs, memory, the installed programs list with sizes, and Windows and program updates. It does not expire.</p></details>
    <details><summary>How do I pay?</summary><p>By mobile money, bank transfer or cash. You place an order, pay quoting your reference, and tell us you have paid. Your plan starts as soon as we confirm the money has arrived.</p></details>
    <details><summary>What if I lose my backup passphrase?</summary><p>Viro cannot recover it, because we never have it. That is what keeps your files private. Write it down somewhere safe when you create a backup.</p></details>
    <details><summary>Who is behind Viro?</summary><p>${CO.name}, a company registered in Zambia and based in Ndola. You can write or call us any time.</p></details>
  </div>
</div></section>
` + band('Try it on your own PC.', 'Download it free, or create an account. If you look after many computers, we will arrange a demonstration.') + foot();

// ------------------------------------------------------------------ features
const feat = items => `<div class="feat">${items.map(([b, s]) => `<div><b>${b}</b><span>${s}</span></div>`).join('')}</div>`;
const block = (id, h, p, items, img) => `<div class="section-block" id="${id}"><h2>${h}</h2><p>${p}</p>${feat(items)}${img ? `<div class="media" style="margin-top:34px">${shot(...img)}</div>` : ''}</div>`;
pages['features.html'] = head('Features | Viro WorkCare', 'Everything Viro WorkCare does: health and alerts, Autopilot, security, updates, hardware and lifecycle advice, remote support and administration.', '/site/features.html') + `
<div class="wrap"><div class="page-head"><h1>Everything Viro WorkCare does</h1><p class="lead">A complete list, grouped by the job you are trying to get done.</p></div></div>
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


pages['privacy.html'] = head('Privacy notice | Viro WorkCare', 'What Viro WorkCare collects, why, how long we keep it, and how to have it removed.', '/site/privacy.html') + `
<div class="wrap"><div class="page-head"><h1>Privacy notice</h1><p class="lead">Plain words about what we collect and why. Orange Mobility Solutions is responsible for your data.</p></div></div>
<div class="wrap" style="padding-bottom:112px"><div class="prose">
  <h2>What we collect</h2>
  <p><strong>Your account:</strong> your name, email address and a protected form of your password. We use your email to confirm your account and to send what you ask for, such as a buyer certificate or a payment confirmation.</p>
  <p><strong>About your computers:</strong> the computer's make and model, parts, Windows version, health readings (drive, battery, memory, start-up), the list of installed programs and their sizes, and what Viro fixed. We read this so we can tell you what is wrong and prove a fix worked.</p>
  <p><strong>Payments:</strong> the order reference, amount, and the transaction number or receipt you give us. We do not receive your mobile money PIN, card number or bank password.</p>
  <p><strong>Backups (Viro Move), if you use them:</strong> the files and settings you choose. They are encrypted on your computer before they leave it, with a key that only you hold, so we cannot read them. If you lose the key we cannot recover them.</p>
  <h2>What we do not do</h2>
  <p>We do not sell your data. We do not read your files, browsing history or messages. We do not run adverts. Serial numbers are never published: a buyer certificate shows only the last four characters.</p>
  <h2>Who sees it</h2>
  <p>You, and the staff of Orange Mobility Solutions who support you. If you are part of an organization, its administrators see that organization's computers. Our email provider sends the messages you ask for.</p>
  <h2>How long we keep it</h2>
  <p>While your account is open. When you close it, or ask us to, we delete your account, computers, backups and certificates, except records we must keep for accounting or the law.</p>
  <h2>Your choices</h2>
  <p>You can ask to see, correct, export or delete your data at any time. Write to <a href="mailto:${CO.email}">${CO.email}</a> and we will answer within a reasonable time.</p>
  <p class="mute">Last updated 4 October 2026.</p>
</div></div>
` + foot();

pages['terms.html'] = head('Terms of use | Viro WorkCare', 'The terms for using Viro WorkCare.', '/site/terms.html') + `
<div class="wrap"><div class="page-head"><h1>Terms of use</h1><p class="lead">What you can expect from Viro WorkCare, and what we ask of you.</p></div></div>
<div class="wrap" style="padding-bottom:112px"><div class="prose">
  <h2>The service</h2>
  <p>Viro WorkCare helps you look after Windows computers: it finds problems, makes fixes you approve, checks that they worked, and lets you undo them. Some features are free and some are part of a paid plan. What is included in each plan is shown on the Plan and payments page.</p>
  <h2>Changes to your computer</h2>
  <p>Fixes change your computer. Viro checks the result and keeps what it needs to undo the change, but no software can promise that nothing will ever go wrong. Keep copies of files you cannot afford to lose. Programs removed by force are moved aside, not deleted, so they can be restored.</p>
  <h2 id="estimates">Estimates</h2>
  <p>Ages, values, remaining life and repair costs shown by Viro are estimates for planning, worked out from what the computer reported and from price lists that are named where they are used. They are not quotes or valuations. Prices in your area may differ.</p>
  <h2 id="certificates">Viro certificates of inspection</h2>
  <p><strong>What it is.</strong> A certificate records what Viro measured on a computer on the date of inspection: its parts and their condition, its estimated age, its history as far as Windows and Viro could see, and estimated repair costs and value. It is signed by Viro and shows a verification code.</p>
  <p><strong>Who gets it.</strong> A seller asks Viro to inspect a computer for a named buyer. Viro sends the certificate only to the buyer's email address. The seller is told where it was sent but is not sent the code, and cannot change what it says. A copy that did not come from Viro by email cannot be confirmed.</p>
  <p><strong>What it is not.</strong> It is not a warranty, a guarantee of future performance, a valuation or advice to buy. It cannot see damage that has no sensor, such as cracks, liquid damage or a loose hinge, and it cannot see changes made before Viro first saw the computer. A clean reinstall of Windows removes Windows' own upgrade records, so counts of reinstalls are a minimum. Drive counters belong to the drive, not the computer.</p>
  <p><strong>Validity.</strong> A certificate is valid for 30 days from the date it was issued. Viro may withdraw a certificate if it was issued in error or for the wrong computer; a withdrawn certificate shows as withdrawn on its verification page.</p>
  <p><strong>Reliance.</strong> A certificate may be relied on only for the computer it describes, and only if its signature verifies and the serial number matches the computer in front of you. Check the computer yourself before you pay.</p>
  <p><strong>Privacy.</strong> A certificate shows the make and model, the last four characters of the serial number, and the facts above. It never shows full serial numbers or personal files.</p>
  <h2 id="plans">Plans and payments</h2>
  <p>You pay by mobile money, bank transfer or cash, quoting the reference we give you. Your plan starts when we confirm the money has arrived, and runs for the period you paid for, for the number of computers you paid for. Prices are in Zambian kwacha unless a price says otherwise.</p>
  <p>If you stop paying, the paid features pause when your period ends. Everything in the free plan keeps working. Your encrypted backups stay stored, but you cannot list or restore them until you renew. If something is wrong with a payment, write to us and we will put it right.</p>
  <h2>Your account</h2>
  <p>Keep your password private and use the service lawfully. Use Viro only on computers you own or are allowed to manage. We may suspend an account that is used to harm others or to break the law.</p>
  <h2>Our responsibility</h2>
  <p>We work to keep the service reliable but cannot promise it will always be available. To the extent the law allows, our responsibility for any loss is limited to the amount you paid us in the last twelve months.</p>
  <h2>Contact</h2>
  <p>Questions about these terms: <a href="mailto:${CO.email}">${CO.email}</a>.</p>
  <p class="mute">Last updated 4 October 2026.</p>
</div></div>
` + foot();

for (const [file, html] of Object.entries(pages)) { writeFileSync(join(OUT, file), html); console.log('wrote site/' + file, html.length, 'bytes'); }
