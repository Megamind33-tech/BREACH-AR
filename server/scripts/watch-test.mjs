// Watches a computer's screen the way the console's "Watch screen" button does, and runs a terminal session beside it ("Show screen"), then saves one frame.
// Usage: node scripts/watch-test.mjs <base-url> <email> <password> <out.jpg>
import WebSocket from 'ws';
import fs from 'node:fs';
const [base, email, password, out] = process.argv.slice(2);
const api = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${JSON.stringify(j)}`); return j; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { token } = await api('POST', '/api/v1/auth/login', { email, password });
const dev = (await api('GET', '/api/v1/devices', null, token)).devices.find(d => d.status === 'online' && /R81KPG5/.test(d.hostname)) ?? (await api('GET', '/api/v1/devices', null, token)).devices.find(d => d.status === 'online');
for (const s of (await api('GET', '/api/v1/support/sessions', null, token)).sessions.filter(x => x.status !== 'ended')) await api('POST', `/api/v1/support/sessions/${s.id}/end`, null, token).catch(() => { });
console.log('watching', dev.hostname);

async function open(kind, reason) {
  const { id } = await api('POST', '/api/v1/support/sessions', { deviceId: dev.id, kind, reason }, token);
  const { ticket } = await api('POST', `/api/v1/support/sessions/${id}/ticket`, null, token);
  const ws = new WebSocket(base.replace('http', 'ws') + `/api/v1/support/sessions/${id}/ws?ticket=${ticket}`);
  const o = { id, ws, msgs: [], frames: [] };
  ws.on('message', (d, bin) => { if (bin) o.frames.push(Buffer.from(d)); else { try { o.msgs.push(JSON.parse(d.toString())); } catch { } } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return o;
}
const ready = async o => { for (let i = 0; i < 90 && !o.msgs.some(m => m.t === 'ready'); i++) await sleep(1000); if (!o.msgs.some(m => m.t === 'ready')) throw new Error('not ready'); };
const send = (o, m) => o.ws.send(JSON.stringify(m));

const term = await open('terminal', 'Terminal with the screen shown beside it (test)');
const screen = await open('desktop', 'Watching the screen (view only, test)');
await Promise.all([ready(term), ready(screen)]);
console.log('terminal and screen are both connected at the same time');
send(screen, { t: 'ds.start', fps: 5, quality: 60 });
send(term, { t: 'term.start' }); await sleep(2000);
send(term, { t: 'term.in', d: 'echo "typed from the console at $(Get-Date -Format HH:mm:ss)"\r\n' });
await sleep(6000);
const out1 = term.msgs.filter(m => m.t === 'term.out').map(m => m.d).join('');
console.log('terminal answered:', /typed from the console/.test(out1));
console.log('frames received:', screen.frames.length, 'sizes:', screen.frames.slice(0, 3).map(f => f.length).join(','), 'bytes');
if (screen.frames.length) { fs.writeFileSync(out, screen.frames.at(-1)); console.log('saved the latest frame to', out); }
send(screen, { t: 'ds.stop' }); send(screen, { t: 'end' }); send(term, { t: 'end' }); await sleep(800);
for (const o of [screen, term]) { o.ws.close(); await api('POST', `/api/v1/support/sessions/${o.id}/end`, null, token).catch(() => { }); }
