import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness } from './helpers.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54353); });
after(async () => { await h.stop(); });

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
/** Runs company.js the way a browser would and returns the About markup it produces. */
function about(): { html: string; company: any } {
  const win: any = {}; const ctx: any = { window: win, document: { getElementById: () => null } };
  vm.runInNewContext(readFileSync(join(pub, 'company.js'), 'utf8'), ctx);
  return { html: win.aboutHtml(), company: win.VIRO_COMPANY };
}

test('the About content names the company, its registered details, and how to reach it', () => {
  const { html, company } = about();
  assert.equal(company.name, 'Orange Mobility Solutions');
  for (const must of ['Orange Mobility Solutions', '320241014086', '14 June 2024', '18 Mukuni Road', 'Kansenshi, Ndola', 'Copperbelt Province, Zambia', 'Chief Operating Officer']) assert.ok(html.includes(must), `missing ${must}`);
  assert.ok(html.includes('href="mailto:info@viro3.online"') && html.includes('>info@viro3.online<'));
  assert.ok(html.includes('href="tel:+260976092585"') && html.includes('+260 976 092 585'));
});

test('private details from the registry printout never reach the public page', () => {
  const everything = about().html + readFileSync(join(pub, 'company.js'), 'utf8') + readFileSync(join(pub, 'site', 'about.html'), 'utf8');
  for (const private_ of ['gmail', '260961582985', '539925', 'LAMECK', 'MWENYA', 'CHANSA', 'Passenger', 'passenger']) assert.ok(!everything.includes(private_), `must not contain ${private_}`);
});

test('the console has an About page, and the old public address leads to the new one', async () => {
  const old = await h.app.inject({ method: 'GET', url: '/about.html' });
  assert.equal(old.statusCode, 200); assert.match(old.body, /url=\/site\/about\.html/);
  assert.equal((await h.app.inject({ method: 'GET', url: '/site/about.html' })).statusCode, 200, 'the public About page is served without signing in');
  assert.equal((await h.app.inject({ method: 'GET', url: '/company.js' })).statusCode, 200);
  const app = readFileSync(join(pub, 'app.js'), 'utf8');
  assert.match(app, /'audit', 'about']/, 'the console navigation lists it');
  assert.match(readFileSync(join(pub, 'index.html'), 'utf8'), /company\.js[\s\S]*views-about\.js/);
});
