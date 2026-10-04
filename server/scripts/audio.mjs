// Composes the soundtrack for the 40-second demo video in code (no samples, no licensed music): a warm pad, a soft pulse and plucks that build with the story, small sounds that land on
// the on-screen moments, a riser into the call to action, and a closing chord. Then it mixes it into the video.
// Usage: node scripts/audio.mjs     reads ../docs/video/viro-demo-40s.mp4 (silent) and writes viro-demo-40s-sound.mp4 and viro-demo-music.mp3
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url)), DIR = join(here, '..', '..', 'docs', 'video');
const DEMO = process.argv.includes('--demo');                                   // the usage demo: calm bed, small sounds on each click, no marketing build-up
const EV = DEMO ? JSON.parse(readFileSync(join(DIR, 'viro-usage-events.json'), 'utf8')) : null;
const SR = 44100, SECS = DEMO ? Math.ceil(EV.seconds) : 40, END = SECS - 5, N = SR * SECS, BPM = 100, BEAT = 60 / BPM;
const L = new Float32Array(N), R = new Float32Array(N);
let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
const TAU = Math.PI * 2;

/** Adds a sample generator into the stereo bed: fn(t, i) gives one sample for the time since the start of the sound. */
function put(t0, dur, amp, pan, fn) {
  const i0 = Math.max(0, Math.floor(t0 * SR)), i1 = Math.min(N, Math.floor((t0 + dur) * SR));
  const gl = amp * Math.cos((pan + 1) * Math.PI / 4), gr = amp * Math.sin((pan + 1) * Math.PI / 4);
  for (let i = i0; i < i1; i++) { const t = (i - Math.floor(t0 * SR)) / SR, s = fn(t, i); L[i] += s * gl; R[i] += s * gr; }
}
const env = (t, dur, a, r) => Math.min(1, t / a) * Math.min(1, Math.max(0, (dur - t) / r));
const tri = p => 2 * Math.abs(2 * (p - Math.floor(p + .5))) - 1;

// ---- harmony: Am, F, C, G, four beats each; the end resolves to a bright C ----
const CH = [[220, 261.63, 329.63], [174.61, 220, 261.63], [261.63, 329.63, 392], [196, 246.94, 293.66]];
const BAR = BEAT * 4;
const chordAt = t => t >= END ? [261.63, 329.63, 392, 523.25] : CH[Math.floor(t / BAR) % 4];

// pad: two slightly detuned triangle voices per note, slow swell, longer than the chord so they overlap
for (let c = 0; c * BAR < END; c++) for (const [k, f] of CH[c % 4].entries()) {
  const t0 = c * BAR - .1, dur = BAR + .9, fade = Math.min(1, 0.35 + Math.max(0, (c * BAR - 3)) / 6);
  for (const d of [0.997, 1.003]) put(t0, dur, 0.05 * fade, (k - 1) * .5, (t) => (tri(f * d * t) * .7 + Math.sin(TAU * f * 2 * d * t) * .15) * env(t, dur, .7, .9) * (0.85 + 0.15 * Math.sin(TAU * .25 * t)));
}
for (const [k, f] of [261.63, 329.63, 392, 523.25, 659.25].entries()) put(END - .05, SECS - END + .05, 0.06, (k - 2) * .35, (t) => (tri(f * t) * .7 + Math.sin(TAU * f * t) * .3) * env(t, SECS - END + .05, .4, 1.6));

// bass, kick, hat, plucks: they come in as the story builds
for (let b = 0; b * BEAT < END; b++) {
  const t = b * BEAT; if (t < (DEMO ? 2.5 : 4)) continue; const ch = chordAt(t);
  put(t, BEAT * .95, 0.17, 0, (s) => Math.sin(TAU * ch[0] * .5 * s) * Math.exp(-s * 3.2) * Math.min(1, s / .01));                                  // bass
  if (DEMO || (t >= 33 && t < 35)) continue;                                                                                                                  // the riser takes over
  put(t, .3, 0.32, 0, (s) => Math.sin(TAU * (45 + 80 * Math.exp(-s * 28)) * s) * Math.exp(-s * 11));                                                // kick
}
for (let b = 0; b * BEAT / 2 < END; b++) {
  const t = b * BEAT / 2; if (t < (DEMO ? 2.5 : 4)) continue; const ch = chordAt(t), n = b % 4;
  put(t, .3, DEMO ? 0.03 : 0.055, (b % 2 ? .4 : -.4), (s) => (Math.sin(TAU * ch[n % 3] * 2 * s) + .3 * Math.sin(TAU * ch[n % 3] * 4 * s)) * Math.exp(-s * 9) * Math.min(1, s / .004));   // pluck
  if (!DEMO && t >= 10 && b % 2 === 1 && !(t >= 33 && t < 35)) { let p = 0; put(t, .06, 0.05, .3, (s) => { const x = rnd(); const y = x - p; p = x; return y * Math.exp(-s * 70); }); }   // hat
}

// ---- sounds that land on what the screen is doing ----
const blip = (t, f = 1318.5, a = 0.07) => put(t, .28, a, 0, (s) => (Math.sin(TAU * f * s) + .4 * Math.sin(TAU * f * 2 * s)) * Math.exp(-s * 14) * Math.min(1, s / .003));
const chime = (t, a = 0.09) => [523.25, 783.99, 1046.5, 1568].forEach((f, k) => put(t + k * .04, 1.6, a / (1 + k * .3), (k - 1.5) * .3, (s) => Math.sin(TAU * f * s) * Math.exp(-s * 2.6) * Math.min(1, s / .004)));
const whoosh = (t, dur = .6, a = 0.1) => { let lp = 0; put(t - dur * .4, dur, a, 0, (s) => { const e = Math.sin(Math.PI * Math.min(1, s / dur)) ** 2, k = .05 + .5 * (s / dur); lp += (rnd() - lp) * k; return lp * e * 3; }); };
const thump = (t, a = 0.5, f0 = 90) => put(t, .7, a, 0, (s) => Math.sin(TAU * (38 + f0 * Math.exp(-s * 16)) * s) * Math.exp(-s * 5));
if (!DEMO) {
for (const t of [4, 10, 17, 24, 30]) whoosh(t);
for (const t of [4.9, 5.5, 6.1, 6.7, 7.3, 7.9]) blip(t, 1174.7 + (t - 4.9) * 60);          // the six things the scan finds
put(10.9, 1.7, 0.05, 0, (s) => Math.sin(TAU * (330 + 900 * (s / 1.6) ** 2) * s) * Math.min(1, s / .1) * Math.min(1, (1.7 - s) / .2));   // 11.8 GB counts up
chime(12.6, .08); blip(12.3, 988, .05); blip(13.2, 1244, .05);
for (const t of [18, 18.6, 19.2, 19.8]) blip(t, 1046.5);                                     // the four readings
thump(20.8, .45); chime(20.9, .1);                                                           // "Repair it."
whoosh(24.6, .5, .07); thump(26.6, .55, 120); chime(26.75, .07);                             // the seal is stamped
for (const [k, t] of [31.2, 31.6, 32, 32.4].entries()) blip(t, 1046.5 * (1 + k * .12), .08); // Files, Programs, Wallpaper, Wi-Fi
chime(32.8, .09); whoosh(32.8, .6, .06);
{ let lp = 0; put(32.8, 2.2, 0.16, 0, (s) => { const k = .03 + .55 * (s / 2.2) ** 2; lp += (rnd() - lp) * k; return lp * (s / 2.2) ** 1.5 * 3; }); }   // riser into the call to action
thump(35, .7, 140); whoosh(35, .8, .12); chime(35, .12);                                      // the logo lands
chime(36.4, .1); blip(36.4, 1568, .06);                                                       // the Download button

}
if (DEMO) for (const e of EV.events) {
  if (e.type === 'click') { blip(e.t + .02, e.label === 'page' ? 880 : 1174.7, .06); }
  if (e.type === 'step') whoosh(e.t, .45, .04);
  if (e.type === 'result') { chime(e.t, .08); thump(e.t, .25, 70); }
  if (e.type === 'end') { chime(e.t - 3.4, .09); }
}

// ---- finish: gentle limiter, 1 s fade in and out ----
let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const g = 0.8 / (peak || 1);
const pcm = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  const t = i / SR, f = Math.min(1, t / .8) * Math.min(1, (SECS - t) / 1.2);
  const sat = x => Math.tanh(x * g * 1.15) * f;
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sat(L[i]))) * 32767), i * 4); pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sat(R[i]))) * 32767), i * 4 + 2);
}
const tmp = mkdtempSync(join(tmpdir(), 'viro-audio-')), wav = join(tmp, 'raw.wav');
const hdr = Buffer.alloc(44); hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
writeFileSync(wav, Buffer.concat([hdr, pcm]));

const LAND = process.argv.includes('--landscape'), BASE = DEMO ? 'viro-usage-demo' : LAND ? 'viro-demo-landscape-40s' : 'viro-demo-40s';
const music = join(DIR, DEMO ? 'viro-usage-music.mp3' : 'viro-demo-music.mp3');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-af', 'aecho=0.7:0.5:180|320:0.22|0.12,highpass=f=30,loudnorm=I=-16:TP=-1.5:LRA=11', '-b:a', '192k', music]);
const silent = join(DIR, BASE + '.mp4'), silentCopy = join(DIR, '_silent.mp4');
copyFileSync(silent, silentCopy);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', silentCopy, '-i', music, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', join(DIR, BASE + '-sound.mp4')]);
rmSync(tmp, { recursive: true, force: true });
console.log('wrote viro-demo-40s-sound.mp4 and viro-demo-music.mp3');
