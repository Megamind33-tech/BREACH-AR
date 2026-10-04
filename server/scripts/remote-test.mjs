// Drives a real remote-support session end to end, as an organization administrator would from the console.
// Usage: node scripts/remote-test.mjs <base-url> <email> <password>
import WebSocket from 'ws';
const [base, email, password] = process.argv.slice(2);
const api = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${JSON.stringify(j)}`); return j; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { token } = await api('POST', '/api/v1/auth/login', { email, password });
const dev = (await api('GET', '/api/v1/devices', null, token)).devices.find(d => d.status === 'online');
if (!dev) throw new Error('no online computer');
console.log('computer:', dev.hostname);
for (const s of (await api('GET', '/api/v1/support/sessions', null, token)).sessions.filter(x => x.status !== 'ended')) await api('POST', `/api/v1/support/sessions/${s.id}/end`, null, token).catch(() => { });      // a failed earlier run may have left one open

async function session(kind, reason, run) {
  const { id } = await api('POST', '/api/v1/support/sessions', { deviceId: dev.id, kind, reason }, token);
  const { ticket } = await api('POST', `/api/v1/support/sessions/${id}/ticket`, null, token);
  // The administrator connects first and waits; the computer joins on its next heartbeat and announces itself.
  let ws, ready = false, msgs = [];
  const t2 = ticket;
  const url = base.replace('https', 'wss').replace('http', 'ws') + `/api/v1/support/sessions/${id}/ws?ticket=${t2}`;
  ws = new WebSocket(url);
  ws.on('message', (d, isBinary) => { if (isBinary) { msgs.push({ t: 'ds.frame', bytes: d.length }); return; } try { msgs.push(JSON.parse(d.toString())); } catch { } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); ws.on('close', c => { if (!ready) rej(new Error('closed ' + c)); }); });
  for (let i = 0; i < 90 && !msgs.some(m => m.t === 'ready'); i++) await sleep(1000);
  if (!msgs.some(m => m.t === 'ready')) throw new Error(kind + ': the computer did not become ready');
  ready = true; console.log(kind, 'session ready; capabilities:', JSON.stringify(msgs.find(m => m.t === 'ready').caps));
  try { await run(ws, msgs); } finally { try { ws.send(JSON.stringify({ t: 'end' })); } catch { } await sleep(500); ws.close(); await api('POST', `/api/v1/support/sessions/${id}/end`, null, token).catch(() => { }); }
  return id;
}
const send = (ws, m) => ws.send(JSON.stringify(m));

await session('terminal', 'End-to-end test of remote support', async (ws, msgs) => {
  send(ws, { t: 'term.start' }); await sleep(2500);
  send(ws, { t: 'term.in', d: 'hostname; whoami; (Get-Date).ToString("s")\r\n' }); await sleep(4000);
  const out = msgs.filter(m => m.t === 'term.out').map(m => m.d).join('');
  console.log('--- terminal output ---\n' + out.trim().split('\n').filter(l => !/^PS /.test(l.trim()) || l.trim().length > 3).slice(-6).join('\n'));
  if (!/DESKTOP-R81KPG5/i.test(out)) throw new Error('terminal did not return this computer\'s name');
});
await session('files', 'End-to-end test of remote file browsing', async (ws, msgs) => {
  send(ws, { t: 'fs.ls', path: 'C:\\Users\\Public', id: 1 }); await sleep(4000);
  const r = msgs.find(m => m.t === 'fs.ls' || m.t === 'fs.list' || m.entries);
  console.log('--- files ---\n' + JSON.stringify(r ?? msgs.slice(-2)).slice(0, 400));
});
await session('desktop', 'End-to-end test of remote desktop', async (ws, msgs) => {
  send(ws, { t: 'ds.start' }); await sleep(8000);
  const frames = msgs.filter(m => m.t === 'ds.frame');
  console.log('--- desktop ---\nframes received:', frames.length, '| other messages:', [...new Set(msgs.map(m => m.t))].join(','));
  send(ws, { t: 'ds.stop' });
});
console.log('all remote sessions finished');
