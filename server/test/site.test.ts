import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness } from './helpers.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54355); });
after(async () => { await h.stop(); });

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const siteDir = join(pub, 'site');
const PAGES = ['index.html', 'features.html', 'security.html', 'about.html', 'contact.html'];
const read = (f: string) => readFileSync(join(siteDir, f), 'utf8');
const urlToFile = (u: string) => join(pub, u.replace(/^\//, '').split(/[?#]/)[0] || 'index.html');

test('every marketing page is a complete, accessible page with one heading, a description, and the company details in its footer', () => {
  for (const f of PAGES) {
    const html = read(f);
    assert.match(html, /^<!doctype html>\s*<html lang="en">/i, f); assert.match(html, /<title>[^<]{10,}<\/title>/, f);
    assert.match(html, /<meta name="description" content="[^"]{40,}">/, `${f} has a description`);
    assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, `${f} has exactly one h1`);
    assert.match(html, /<a class="skip" href="#main">/, `${f} has a skip link`); assert.match(html, /<main id="main">/, f);
    for (const must of ['info@viro3.online', 'tel:+260976092585', '+260 976 092 585', '18 Mukuni Road', 'Kansenshi, Ndola', 'Copperbelt Province, Zambia', 'Orange Mobility Solutions', '320241014086']) assert.ok(html.includes(must), `${f} footer must show ${must}`);
    for (const img of html.match(/<img [^>]*>/g) ?? []) { assert.match(img, /\balt="[^"]*"/, `${f}: image without alt text: ${img.slice(0, 80)}`); assert.match(img, /\bwidth="\d+"/); assert.match(img, /\bheight="\d+"/); }
  }
});

test('every link and file a page uses exists, and sign-in leads to the console', () => {
  for (const f of PAGES) {
    const html = read(f);
    for (const m of html.matchAll(/(?:href|src)="([^"#]*)(#[^"]*)?"/g)) {
      const u = m[1]!; if (!u || /^(https?:|mailto:|tel:)/.test(u) || u === '/install/ViroAgent.msi') continue;       // the installer is served by the server, not a file in public/
      assert.ok(u.startsWith('/'), `${f}: use root-relative paths (${u})`);
      assert.ok(u === '/' || existsSync(urlToFile(u)), `${f}: ${u} does not exist`);
    }
    for (const m of html.matchAll(/<a [^>]*href="(#[^"]+)"/g)) assert.ok(html.includes(`id="${m[1]!.slice(1)}"`), `${f}: in-page link ${m[1]} has no target`);
    assert.match(html, /data-signin/, `${f} has a sign-in link`);
  }
});

test('the pages say nothing the product cannot back up: no invented customers, certifications, guarantees or hype', () => {
  const words = /\b(SOC ?2|ISO ?27001|GDPR|HIPAA|FERPA|guarantee[ds]?|100%|trusted by|our customers|testimonial|award|world-class|cutting-edge|revolutionary|AI-powered|artificial intelligence|lorem|TODO|coming soon|unlimited)\b/i;
  for (const f of PAGES) { const text = read(f).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ''); const hit = text.match(words); assert.equal(hit, null, `${f} contains "${hit?.[0]}"`); }
});

test('private details from the registry printout, and the mining feature, never appear on the public site', () => {
  const everything = PAGES.map(read).join('\n') + readFileSync(join(siteDir, 'site.css'), 'utf8');
  for (const p of ['gmail', '260961582985', '539925', 'LAMECK', 'MWENYA', 'CHANSA', 'passenger', 'xmrig', 'Monero', 'mining', 'hashvault']) assert.ok(!everything.toLowerCase().includes(p.toLowerCase()), `must not contain ${p}`);
});

test('the screenshots are real captures of reasonable size and every page reads as a finished product', () => {
  const imgs = readdirSync(join(siteDir, 'img')).filter(f => f.endsWith('.webp'));
  assert.ok(imgs.length >= 5, 'screenshots present');
  for (const f of imgs) { const size = statSync(join(siteDir, 'img', f)).size; assert.ok(size > 20_000 && size < 250_000, `${f} is ${size} bytes`); }
  // checked against the visible text only: a form's own `placeholder="…"` attribute is real UI, not draft filler.
  for (const p of PAGES) assert.ok(!/lorem|placeholder|prototype/i.test(read(p).replace(/<[^>]+>/g, ' ')), `${p} must not read like a draft`);
});

test('the site is public (no sign-in), and the console and operator console link to it', async () => {
  for (const f of PAGES) { const r = await h.app.inject({ method: 'GET', url: f === 'index.html' ? '/site/' : '/site/' + f }); assert.equal(r.statusCode, 200, f); assert.match(String(r.headers['content-type']), /text\/html/); }
  for (const u of ['/site/site.css', '/site/site.js', '/site/img/shot-overview.webp', '/fonts/inter-latin-wght-normal.woff2', '/media/hero.mp4']) assert.equal((await h.app.inject({ method: 'GET', url: u })).statusCode, 200, u);
  assert.match(readFileSync(join(pub, 'app.js'), 'utf8'), /href="\/site\/"/, 'the sign-in screen links to the site');
  assert.match(readFileSync(join(pub, 'platform.html'), 'utf8'), /href="\/site\/about\.html"/);
  assert.match(readFileSync(join(pub, 'about.html'), 'utf8'), /url=\/site\/about\.html/, 'the old About address redirects to the new page');
});

test('media and fonts are cached so the same clip is not downloaded twice on one page; pages themselves always revalidate', async () => {
  for (const u of ['/media/hero.mp4', '/site/img/shot-overview.webp', '/fonts/inter-latin-wght-normal.woff2', '/logo.png'])
    assert.match(String((await h.app.inject({ method: 'GET', url: u })).headers['cache-control']), /max-age=3600/, u);
  for (const u of ['/site/index.html', '/site/site.css', '/site/site.js', '/app.js'])
    assert.equal((await h.app.inject({ method: 'GET', url: u })).headers['cache-control'], 'no-cache', u);
});
