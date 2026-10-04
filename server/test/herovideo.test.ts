import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const src = readFileSync(join(pub, 'hero-video.js'), 'utf8');

/** Runs hero-video.js against a small pretend browser holding one banner video, and reports what the script did to it. */
function run(opts: { reduced?: boolean; saveData?: boolean } = {}) {
  const log: string[] = []; const handlers: Record<string, () => void> = {}; const sourceHandlers: Record<string, () => void> = {};
  const video: any = {
    muted: false, preload: 'metadata', attrs: new Set(['autoplay']),
    pause() { log.push('pause'); }, play() { log.push('play'); return Promise.resolve(); }, remove() { log.push('remove'); },
    removeAttribute(a: string) { this.attrs.delete(a); }, hasAttribute(a: string) { return this.attrs.has(a); },
    addEventListener(e: string, f: () => void) { handlers[e] = f; }, querySelector: () => ({ addEventListener: (e: string, f: () => void) => { sourceHandlers[e] = f; } }),
    matches: () => true,
  };
  const observed: any[] = [];
  const win: any = { matchMedia: () => ({ matches: !!opts.reduced }) };
  const ctx: any = {
    window: win, navigator: { connection: { saveData: !!opts.saveData } },
    IntersectionObserver: class { observe(v: any) { observed.push(v); } },
    MutationObserver: class { observe() { /* the page is static in this test */ } },
    document: { documentElement: {}, addEventListener() { /* visibility changes are not simulated */ }, querySelectorAll: () => [video] },
  };
  vm.runInNewContext(src, ctx);
  return { video, log, observed, handlers, sourceHandlers, html: win.heroVideoHtml() as string };
}

test('the banner video is muted, looping, inline and decorative, with a still poster', () => {
  const { html } = run();
  for (const must of ['muted', 'loop', 'playsinline', 'autoplay', 'poster="media/hero-poster.jpg"', 'aria-hidden="true"', 'src="media/hero.mp4"', 'type="video/mp4"']) assert.ok(html.includes(must), `missing ${must}`);
  assert.ok(!/\bcontrols\b/.test(html), 'it is decoration: no player controls');
});

test('normally it is made silent and handed to the visibility watcher (plays on screen, pauses off screen)', () => {
  const r = run();
  assert.equal(r.video.muted, true); assert.deepEqual(r.observed, [r.video]); assert.ok(r.video.attrs.has('autoplay'));
});

test('people who asked for less motion, or for data saving, get the still picture and nothing is downloaded or played', () => {
  for (const o of [{ reduced: true }, { saveData: true }]) {
    const r = run(o);
    assert.deepEqual(r.observed, [], 'never started'); assert.ok(r.log.includes('pause')); assert.equal(r.video.preload, 'none'); assert.ok(!r.video.attrs.has('autoplay'));
  }
});

test('if the clip cannot play, the video removes itself so the vector art underneath shows', () => {
  const a = run(); a.handlers.error!(); assert.ok(a.log.includes('remove'));
  const b = run(); b.sourceHandlers.error!(); assert.ok(b.log.includes('remove'), 'a format the browser cannot play');
});

test('the clip, its poster and the pages that use them are in place and the clip stays small', () => {
  const mp4 = statSync(join(pub, 'media', 'hero.mp4')).size, poster = statSync(join(pub, 'media', 'hero-poster.jpg')).size;
  assert.ok(mp4 > 50_000 && mp4 < 1_500_000, `hero.mp4 is ${mp4} bytes`); assert.ok(poster > 5_000 && poster < 300_000, `poster is ${poster} bytes`);
  const head = readFileSync(join(pub, 'media', 'hero.mp4')).subarray(4, 12).toString('latin1'); assert.match(head, /ftyp/, 'a real MP4 file');
  for (const [page, needle] of [['index.html', 'hero-video.js'], ['site/index.html', 'hero-video.js'], ['platform.html', 'hero-video.js']] as const) assert.ok(readFileSync(join(pub, page), 'utf8').includes(needle), `${page} loads the banner player`);
  assert.match(readFileSync(join(pub, 'app.js'), 'utf8'), /heroVideoHtml/, 'the console Overview banner uses it');
  const css = readFileSync(join(pub, 'brand.css'), 'utf8'); assert.match(css, /mix-blend-mode:\s*screen/); assert.match(css, /@media print \{ \.hero-video \{ display:none; \} \}/);
});
