// Generates public/hero-art.svg: flowing emerald ribbons with a glossy orb, the same visual language as the Viro mark
// (folded glossy ribbons + an orb) as resolution-independent vector art for the Overview banner.
// The logo.png it replaces is only 210x210 pixels and looked soft when stretched.
// Usage: node scripts/make-hero-art.cjs
const fs = require('fs');
const path = require('path');

const W = 760, H = 380, STEPS = 140;
const fmt = n => n.toFixed(2);
// A ribbon is the band between two smooth curves; the band's thickness swells and pinches along its length, which reads as a twisting sheet.
function ribbon({ y0, amp, k, phase, thick, tPhase, x0 = -20, x1 = W + 20, slope = 0, id, bright = 1, edge = true }) {
  const top = [], bot = [];
  for (let i = 0; i <= STEPS; i++) {
    const u = i / STEPS, x = x0 + (x1 - x0) * u;
    const y = y0 + slope * (u - 0.5) + amp * Math.sin(k * u * Math.PI * 2 + phase) + amp * 0.35 * Math.sin(2.1 * k * u * Math.PI * 2 + phase * 1.7);
    const t = thick * (0.18 + 0.82 * Math.pow(Math.abs(Math.sin(u * Math.PI * 1.15 + tPhase)), 1.2));
    top.push([x, y - t / 2]); bot.push([x, y + t / 2]);
  }
  const d = 'M' + top.map(p => fmt(p[0]) + ' ' + fmt(p[1])).join(' L') + ' L' + bot.reverse().map(p => fmt(p[0]) + ' ' + fmt(p[1])).join(' L') + ' Z';
  const line = 'M' + top.slice().map(p => fmt(p[0]) + ' ' + fmt(p[1])).join(' L');
  return `<g opacity="${bright}"><path d="${d}" fill="url(#${id})"/>${edge ? `<path d="${line}" fill="none" stroke="url(#edge)" stroke-width="1.3" stroke-linecap="round"/>` : ''}</g>`;
}

const ribbons = [
  ribbon({ y0: 250, amp: 46, k: 0.9, phase: 0.2, thick: 70, tPhase: 0.4, slope: -40, id: 'r1', bright: 0.55, edge: false }),
  ribbon({ y0: 215, amp: 54, k: 1.0, phase: 1.4, thick: 96, tPhase: 1.1, slope: -30, id: 'r2', bright: 0.8 }),
  ribbon({ y0: 190, amp: 40, k: 1.15, phase: 2.6, thick: 64, tPhase: 2.0, slope: -10, id: 'r3', bright: 0.95 }),
  ribbon({ y0: 150, amp: 34, k: 0.85, phase: 3.9, thick: 54, tPhase: 0.2, slope: 20, id: 'r4', bright: 0.7 }),
  ribbon({ y0: 285, amp: 30, k: 1.3, phase: 5.0, thick: 40, tPhase: 2.6, slope: -20, id: 'r5', bright: 0.5, edge: false }),
].join('\n  ');

// Fine contour lines echo the ribbons and add depth.
const contours = Array.from({ length: 9 }, (_, n) => {
  const pts = [];
  for (let i = 0; i <= STEPS; i++) { const u = i / STEPS, x = -20 + (W + 40) * u; pts.push([x, 120 + n * 18 + 40 * Math.sin(u * 6.2 + n * 0.35) + 14 * Math.sin(u * 12.5 + n)]); }
  return `<path d="M${pts.map(p => fmt(p[0]) + ' ' + fmt(p[1])).join(' L')}" fill="none" stroke="#7dffbd" stroke-opacity="${(0.06 + n * 0.012).toFixed(3)}" stroke-width="1"/>`;
}).join('\n  ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMaxYMid slice" role="img" aria-label="Viro">
<defs>
  <linearGradient id="r1" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0a5c37" stop-opacity="0"/><stop offset=".5" stop-color="#0d8a4f" stop-opacity=".7"/><stop offset="1" stop-color="#1fd382" stop-opacity=".9"/></linearGradient>
  <linearGradient id="r2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0b6a40" stop-opacity="0"/><stop offset=".45" stop-color="#17b567" stop-opacity=".75"/><stop offset="1" stop-color="#5dffa8" stop-opacity=".95"/></linearGradient>
  <linearGradient id="r3" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0b6a40" stop-opacity="0"/><stop offset=".4" stop-color="#27dc86" stop-opacity=".85"/><stop offset=".85" stop-color="#b3ffd6" stop-opacity=".98"/><stop offset="1" stop-color="#e6fff1" stop-opacity="1"/></linearGradient>
  <linearGradient id="r4" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#06301f" stop-opacity="0"/><stop offset=".5" stop-color="#0a7a45" stop-opacity=".8"/><stop offset="1" stop-color="#27dc86" stop-opacity=".9"/></linearGradient>
  <linearGradient id="r5" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#041f14" stop-opacity="0"/><stop offset=".6" stop-color="#075a33" stop-opacity=".8"/><stop offset="1" stop-color="#0f9f58" stop-opacity=".9"/></linearGradient>
  <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#d9ffe9" stop-opacity="0"/><stop offset=".5" stop-color="#d9ffe9" stop-opacity=".5"/><stop offset="1" stop-color="#ffffff" stop-opacity=".9"/></linearGradient>
  <radialGradient id="orb" cx=".34" cy=".3" r=".85"><stop offset="0" stop-color="#e9fff3"/><stop offset=".18" stop-color="#5df5a6"/><stop offset=".55" stop-color="#0f9d56"/><stop offset="1" stop-color="#03281a"/></radialGradient>
  <radialGradient id="halo" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#2fe08a" stop-opacity=".6"/><stop offset=".5" stop-color="#2fe08a" stop-opacity=".16"/><stop offset="1" stop-color="#2fe08a" stop-opacity="0"/></radialGradient>
  <filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>
</defs>
<ellipse cx="560" cy="210" rx="260" ry="150" fill="url(#halo)" opacity=".55"/>
<g filter="url(#blur)" opacity=".5"><path d="M0 250 C140 150 260 330 420 220 S640 130 780 210 L780 300 C640 230 520 340 380 300 S120 330 0 320 Z" fill="#12a35e"/></g>
  ${contours}
  ${ribbons}
<g>
  <circle cx="560" cy="150" r="92" fill="url(#halo)"/>
  <circle cx="560" cy="150" r="46" fill="url(#orb)"/>
  <circle cx="560" cy="150" r="46" fill="none" stroke="#c9ffe0" stroke-opacity=".35" stroke-width="1"/>
  <circle cx="560" cy="150" r="68" fill="none" stroke="#7dffbd" stroke-opacity=".22" stroke-width="1"/>
  <ellipse cx="545" cy="132" rx="17" ry="10" fill="#fff" opacity=".5" transform="rotate(-28 545 132)"/>
</g>
</svg>
`;
fs.writeFileSync(path.join(__dirname, '..', 'public', 'hero-art.svg'), svg);
console.log('wrote public/hero-art.svg', svg.length, 'bytes');
