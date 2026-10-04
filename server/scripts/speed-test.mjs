// Measures remote desktop speed the way the console's live numbers do: delay (round trip), pictures per second and data rate, for each quality preset. Sends no mouse or keyboard input.
import WebSocket from 'ws';
const [base, email, password] = process.argv.slice(2);
const api = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${JSON.stringify(j)}`); return j; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { token } = await api('POST', '/api/v1/auth/login', { email, password });
const dev = (await api('GET', '/api/v1/devices', null, token)).devices.find(d => d.status === 'online' && /R81KPG5/.test(d.hostname));
for (const s of (await api('GET', '/api/v1/support/sessions', null, token)).sessions.filter(x => x.status !== 'ended')) await api('POST', `/api/v1/support/sessions/${s.id}/end`, null, token).catch(() => { });
const { id } = await api('POST', '/api/v1/support/sessions', { deviceId: dev.id, kind: 'desktop', reason: 'Measuring remote desktop speed (no input is sent)' }, token);
const { ticket } = await api('POST', `/api/v1/support/sessions/${id}/ticket`, null, token);
const ws = new WebSocket(base.replace('http', 'ws') + `/api/v1/support/sessions/${id}/ws?ticket=${ticket}`);
let frames = 0, bytes = 0; const rtts = [], msgs = [];
ws.on('message', (d, bin) => { if (bin) { frames++; bytes += d.length; } else { try { const m = JSON.parse(d.toString()); msgs.push(m); if (m.t === 'ds.pong') rtts.push(Date.now() - m.ts); } catch { } } });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
for (let i = 0; i < 90 && !msgs.some(m => m.t === 'ready'); i++) await sleep(1000);
const send = m => ws.send(JSON.stringify(m));
send({ t: 'ds.start', fps: 8, quality: 55 });
for (const [name, p] of [['Fast', { fps: 12, quality: 40, maxWidth: 960 }], ['Balanced', { fps: 8, quality: 55, maxWidth: 1280 }], ['Sharp', { fps: 5, quality: 80, maxWidth: 1600 }]]) {
  send({ t: 'ds.tune', ...p }); await sleep(1500); frames = 0; bytes = 0; rtts.length = 0;
  const t0 = Date.now(); for (let i = 0; i < 5; i++) { send({ t: 'ds.ping', ts: Date.now() }); await sleep(1000); }
  const dt = (Date.now() - t0) / 1000;
  console.log(`${name.padEnd(9)} delay ${rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : 'n/a'} ms | ${(frames / dt).toFixed(1)} pictures/s | ${Math.round(bytes / 1024 / dt)} KB/s`);
}
send({ t: 'ds.stop' }); send({ t: 'end' }); await sleep(500); ws.close(); await api('POST', `/api/v1/support/sessions/${id}/end`, null, token).catch(() => { });
