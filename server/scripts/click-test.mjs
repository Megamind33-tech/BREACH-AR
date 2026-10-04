// Proves remote control works: opens a remote desktop session, clicks into a window and types, and saves the resulting picture.
// Usage: node scripts/click-test.mjs <base-url> <email> <password> <out.jpg> [x y]   (x y are fractions of the screen to click, default centre)
import WebSocket from 'ws';
import fs from 'node:fs';
const [base, email, password, out, cx = '0.5', cy = '0.5'] = process.argv.slice(2);
const api = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${JSON.stringify(j)}`); return j; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { token } = await api('POST', '/api/v1/auth/login', { email, password });
const devs = (await api('GET', '/api/v1/devices', null, token)).devices; const dev = devs.find(d => d.status === 'online' && /R81KPG5/.test(d.hostname));
for (const s of (await api('GET', '/api/v1/support/sessions', null, token)).sessions.filter(x => x.status !== 'ended')) await api('POST', `/api/v1/support/sessions/${s.id}/end`, null, token).catch(() => { });
const { id } = await api('POST', '/api/v1/support/sessions', { deviceId: dev.id, kind: 'desktop', reason: 'Testing that clicking and typing work' }, token);
const { ticket } = await api('POST', `/api/v1/support/sessions/${id}/ticket`, null, token);
const ws = new WebSocket(base.replace('http', 'ws') + `/api/v1/support/sessions/${id}/ws?ticket=${ticket}`);
const msgs = [], frames = []; let pong = null;
ws.on('message', (d, bin) => { if (bin) frames.push({ at: Date.now(), b: Buffer.from(d) }); else { try { const m = JSON.parse(d.toString()); msgs.push(m); if (m.t === 'ds.pong') pong = Date.now() - m.ts; } catch { } } });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
for (let i = 0; i < 90 && !msgs.some(m => m.t === 'ready'); i++) await sleep(1000);
const send = m => ws.send(JSON.stringify(m));
const t0 = Date.now(); send({ t: 'ds.ping', ts: t0 }); send({ t: 'ds.start', fps: 8, quality: 60 }); await sleep(3000);
// click into the window, then type
send({ t: 'ds.mouse', x: +cx, y: +cy, act: 'move' }); await sleep(200);
send({ t: 'ds.mouse', x: +cx, y: +cy, btn: 'left', act: 'down' }); await sleep(80); send({ t: 'ds.mouse', x: +cx, y: +cy, btn: 'left', act: 'up' }); await sleep(500);
const typed = 'REMOTE CLICK AND TYPE WORKS ' + new Date().toLocaleTimeString();
for (const ch of typed) { const code = ch === ' ' ? 32 : ch === ':' ? 186 : ch.toUpperCase().charCodeAt(0); const shift = ch === ':'; if (shift) send({ t: 'ds.key', code: 16, down: true }); send({ t: 'ds.key', code, down: true }); send({ t: 'ds.key', code, down: false }); if (shift) send({ t: 'ds.key', code: 16, down: false }); await sleep(25); }
await sleep(3000);
console.log('frames:', frames.length, '| delay (round trip):', pong == null ? 'n/a (older agent)' : pong + ' ms', '| typed:', typed);
if (frames.length) { fs.writeFileSync(out, frames.at(-1).b); console.log('saved', out); }
send({ t: 'ds.stop' }); send({ t: 'end' }); await sleep(600); ws.close(); await api('POST', `/api/v1/support/sessions/${id}/end`, null, token).catch(() => { });
