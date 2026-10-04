import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startHarness } from './helpers.js';
import { hashPassword } from '../src/security.js';

let h: Awaited<ReturnType<typeof startHarness>>;
let base = '';
before(async () => { h = await startHarness(54334); await h.app.listen({ port: 0, host: '127.0.0.1' }); base = `127.0.0.1:${(h.app.server.address() as any).port}`; });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });
const patch = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PATCH', url, payload: payload as any, headers });
async function mkOrg(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false }, { 'x-platform-key': 'platform-key' });
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
async function mkUser(orgId: string, email: string, role: string) {
  await h.db.query('INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,$2,$3,$4)', [orgId, email, await hashPassword('another long password'), role]);
  return { authorization: `Bearer ${(await post('/api/v1/auth/login', { email, password: 'another long password' })).json().token}` } as Hdr;
}
async function enroll(auth: Hdr, guid: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname: guid, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
type Dev = Awaited<ReturnType<typeof enroll>>;

interface Peer { ws: WebSocket; msgs: any[]; bin: Buffer[]; closed: Promise<{ code: number; reason: string }>; send: (m: object) => void; waitFor: (t: string, ms?: number) => Promise<any> }
function connect(url: string, headers: Hdr = {}): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const msgs: any[] = []; const bin: Buffer[] = []; const waiters: { t: string; res: (m: any) => void }[] = [];
    const closed = new Promise<{ code: number; reason: string }>(res => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
    ws.on('message', (d, isBinary) => {
      if (isBinary) { bin.push(d as Buffer); return; }
      const m = JSON.parse(d.toString()); msgs.push(m);
      for (const w of waiters.filter(x => x.t === m.t)) { w.res(m); waiters.splice(waiters.indexOf(w), 1); }
    });
    const peer: Peer = { ws, msgs, bin, closed, send: m => ws.send(JSON.stringify(m)),
      waitFor: (t, ms = 3000) => new Promise((res, rej) => { const found = msgs.find(m => m.t === t); if (found) return res(found); waiters.push({ t, res }); setTimeout(() => rej(new Error(`timed out waiting for "${t}"; got ${JSON.stringify(msgs.map(m => m.t))}`)), ms); }) };
    ws.on('open', () => resolve(peer)); ws.on('error', reject); ws.on('unexpected-response', (_r, res) => reject(new Error('upgrade refused: ' + res.statusCode)));
  });
}
const adminWs = async (a: { auth: Hdr }, sessionId: string) => { const t = (await post(`/api/v1/support/sessions/${sessionId}/ticket`, {}, a.auth)).json().ticket; return connect(`ws://${base}/api/v1/support/sessions/${sessionId}/ws?ticket=${t}`); };
const agentWs = (d: Dev, sessionId: string) => connect(`ws://${base}/agent/v1/sessions/${sessionId}/ws`, d.dev);
const request = (a: { auth: Hdr }, d: Dev, kind = 'terminal', reason = 'Ticket 4411: printer not working') => post('/api/v1/support/sessions', { deviceId: d.deviceId, kind, reason }, a.auth);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const events = async (a: { auth: Hdr }, id: string) => (await get(`/api/v1/support/sessions/${id}`, a.auth)).json();

test('requests need an administrator, a real reason, an existing device, and the org must allow remote support', async () => {
  const a = await mkOrg('Sup Org', 'o@sup.test'); const tech = await mkUser(a.orgId, 't@sup.test', 'technician'); const d = await enroll(a.auth, 'sup-dev-000001');
  assert.equal((await post('/api/v1/support/sessions', { deviceId: d.deviceId, kind: 'terminal', reason: 'fix it' }, tech)).statusCode, 403);
  assert.equal((await post('/api/v1/support/sessions', { deviceId: d.deviceId, kind: 'terminal', reason: 'no' }, a.auth)).statusCode, 400, 'reason required');
  assert.equal((await post('/api/v1/support/sessions', { deviceId: d.deviceId, kind: 'rootkit', reason: 'valid reason' }, a.auth)).statusCode, 400);
  assert.equal((await post('/api/v1/support/sessions', { deviceId: '00000000-0000-4000-8000-000000000000', kind: 'terminal', reason: 'valid reason' }, a.auth)).statusCode, 404);
  const other = await mkOrg('Sup Other', 'o@sup-other.test');
  assert.equal((await post('/api/v1/support/sessions', { deviceId: d.deviceId, kind: 'terminal', reason: 'valid reason' }, other.auth)).statusCode, 404, 'another org cannot reach the device');
  assert.equal((await patch('/api/v1/settings', { remoteSupportEnabled: false }, { authorization: (await mkUser(a.orgId, 'adm@sup.test', 'admin')).authorization })).statusCode, 403, 'only owners change org settings');
  assert.equal((await patch('/api/v1/settings', { remoteSupportEnabled: false }, a.auth)).statusCode, 200);
  assert.equal((await request(a, d)).statusCode, 403, 'disabled by the organization');
  await patch('/api/v1/settings', { remoteSupportEnabled: true }, a.auth);
  const ok = await request(a, d); assert.equal(ok.statusCode, 201);
  assert.equal((await request(a, d)).statusCode, 409, 'one open session per device');
  assert.ok((await get('/api/v1/audit', a.auth)).json().entries.some((e: any) => e.action === 'support.request' && e.next.reason.includes('Ticket 4411')));
});

test('the device is told about the session on its next heartbeat, and polls quickly until it joins', async () => {
  const a = await mkOrg('Poll Org', 'o@poll.test'); const d = await enroll(a.auth, 'poll-dev-000001');
  const beat = async () => (await post('/agent/v1/heartbeat', { hostname: 'x', agentVersion: '1', metrics: {} }, d.dev)).json();
  assert.deepEqual((await beat()).sessions, []); assert.equal((await beat()).pollSeconds, 30);
  const id = (await request(a, d, 'files')).json().id;
  const hb = await beat(); assert.equal(hb.sessions[0].id, id); assert.equal(hb.sessions[0].kind, 'files'); assert.equal(hb.sessions[0].admin, 'o@poll.test'); assert.equal(hb.pollSeconds, 3);
  const agent = await agentWs(d, id); await agent.waitFor('hello');
  assert.deepEqual((await beat()).sessions, [], 'already joined');
  await post(`/api/v1/support/sessions/${id}/end`, {}, a.auth); await agent.closed;
});

test('a terminal session: ticketed admin and authenticated device are joined, commands are relayed and recorded, ending closes both', async () => {
  const a = await mkOrg('Term Org', 'o@term.test'); const d = await enroll(a.auth, 'term-dev-000001');
  const id = (await request(a, d)).json().id;
  const admin = await adminWs(a, id); const agent = await agentWs(d, id); await agent.waitFor('hello');
  admin.send({ t: 'term.start' }); admin.send({ t: 'term.in', d: 'ipconfig /flushdns\n' });
  const start = await agent.waitFor('term.start'); assert.ok(start);
  assert.equal((await agent.waitFor('term.in')).d, 'ipconfig /flushdns\n');
  agent.send({ t: 'term.out', d: 'Windows IP Configuration\r\n' }); assert.equal((await admin.waitFor('term.out')).d, 'Windows IP Configuration\r\n');
  agent.send({ t: 'term.exit', code: 0 });
  assert.equal((await events(a, id)).status, 'active');
  await post(`/api/v1/support/sessions/${id}/end`, {}, a.auth);
  const [ca, cb] = await Promise.all([admin.closed, agent.closed]); assert.ok(ca.code && cb.code);
  const s = await events(a, id);
  assert.equal(s.status, 'ended'); assert.equal(s.ended_reason, 'ended by an administrator'); assert.ok(s.started_at && s.ended_at);
  const kinds = s.events.map((e: any) => e.kind);
  for (const k of ['request', 'connect', 'active', 'command', 'end']) assert.ok(kinds.includes(k), k);
  assert.equal(s.events.find((e: any) => e.kind === 'command').detail, 'ipconfig /flushdns\n', 'commands typed by the administrator are recorded');
  const audit = (await get('/api/v1/audit', a.auth)).json().entries.map((e: any) => e.action);
  for (const act of ['support.request', 'support.start', 'support.end']) assert.ok(audit.includes(act), act);
  const list = (await get('/api/v1/support/sessions', a.auth)).json().sessions[0]; assert.equal(list.admin, 'o@term.test'); assert.equal(list.hostname, 'term-dev-000001'); assert.ok(list.actions >= 1);
});

test('session kinds are enforced: a files session cannot run commands, a terminal cannot read files; binary and unknown messages are dropped', async () => {
  const a = await mkOrg('Kind Org', 'o@kind.test'); const d = await enroll(a.auth, 'kind-dev-000001'); const d2 = await enroll(a.auth, 'kind-dev-000002');
  const files = (await request(a, d, 'files')).json().id;
  const admin = await adminWs(a, files); const agent = await agentWs(d, files); await agent.waitFor('hello');
  admin.send({ t: 'term.start' }); admin.send({ t: 'term.in', d: 'del /f /q C:\\*\n' }); admin.send({ t: 'ds.mouse' }); admin.send({ t: 'made.up' }); admin.ws.send(Buffer.from('binary'));
  admin.send({ t: 'fs.ls', path: 'C:\\Users' });
  assert.equal((await agent.waitFor('fs.ls')).path, 'C:\\Users');
  assert.deepEqual(agent.msgs.map(m => m.t).filter(t => t !== 'hello'), ['fs.ls'], 'nothing but the allowed message reached the device');
  await post(`/api/v1/support/sessions/${files}/end`, {}, a.auth); await agent.closed;   // ending flushes the event log
  const blocked = (await events(a, files)).events.filter((e: any) => e.kind === 'blocked'); assert.ok(blocked.length >= 4, `blocked events: ${blocked.length}`);
  assert.match(blocked[0].detail, /not allowed in a files session/);

  const term = (await request(a, d2, 'terminal')).json().id;
  const admin2 = await adminWs(a, term); const agent2 = await agentWs(d2, term); await agent2.waitFor('hello');
  admin2.send({ t: 'fs.get', path: 'C:\\secrets.txt' }); admin2.send({ t: 'term.in', d: 'whoami\n' });
  await agent2.waitFor('term.in'); assert.ok(!agent2.msgs.some(m => m.t === 'fs.get'));
  await post(`/api/v1/support/sessions/${term}/end`, {}, a.auth); await agent2.closed;
});

test('joining is authenticated and scoped: tickets are single-use, short-lived and bound to the requesting admin; devices only join their own sessions', async () => {
  const a = await mkOrg('Join Org', 'o@join.test'); const other = await mkOrg('Join Other', 'o@join-other.test');
  const admin2 = await mkUser(a.orgId, 'a2@join.test', 'admin');
  const d = await enroll(a.auth, 'join-dev-000001'), stranger = await enroll(a.auth, 'join-dev-000002'), foreign = await enroll(other.auth, 'join-dev-000003');
  const id = (await request(a, d)).json().id;
  assert.equal((await post(`/api/v1/support/sessions/${id}/ticket`, {}, admin2)).statusCode, 403, 'another admin cannot hijack it');
  assert.equal((await post(`/api/v1/support/sessions/${id}/ticket`, {}, other.auth)).statusCode, 404, 'nor another org');
  const t = (await post(`/api/v1/support/sessions/${id}/ticket`, {}, a.auth)).json().ticket;
  const first = await connect(`ws://${base}/api/v1/support/sessions/${id}/ws?ticket=${t}`);
  const reuse = await connect(`ws://${base}/api/v1/support/sessions/${id}/ws?ticket=${t}`); assert.equal((await reuse.closed).code, 4401, 'single use');
  assert.equal((await (await connect(`ws://${base}/api/v1/support/sessions/${id}/ws?ticket=nonsense`)).closed).code, 4401);
  const wrongSession = (await request(a, stranger)).json().id;
  const t2 = (await post(`/api/v1/support/sessions/${wrongSession}/ticket`, {}, a.auth)).json().ticket;
  assert.equal((await (await connect(`ws://${base}/api/v1/support/sessions/${id}/ws?ticket=${t2}`)).closed).code, 4401, 'a ticket only opens its own session');
  await assert.rejects(connect(`ws://${base}/agent/v1/sessions/${id}/ws`), /401/);                                       // no credentials
  assert.equal((await (await agentWs(stranger, id)).closed).code, 4404, 'a different device of the same org cannot join');
  assert.equal((await (await agentWs(foreign, id)).closed).code, 4404, 'nor a device of another org');
  const agent = await agentWs(d, id); await agent.waitFor('hello');
  assert.equal((await (await agentWs(d, id)).closed).code, 4409, 'only one device connection');
  await post(`/api/v1/support/sessions/${id}/end`, {}, a.auth); await first.closed;
  await post(`/api/v1/support/sessions/${wrongSession}/end`, {}, a.auth);
  assert.equal((await post(`/api/v1/support/sessions/${id}/ticket`, {}, a.auth)).statusCode, 404, 'ended sessions cannot be rejoined');
});

test('either side disconnecting ends the session; idle and unclaimed sessions expire', async () => {
  const a = await mkOrg('End Org', 'o@end.test'); const d1 = await enroll(a.auth, 'end-dev-0000001'), d2 = await enroll(a.auth, 'end-dev-0000002'), d3 = await enroll(a.auth, 'end-dev-0000003');
  const s1 = (await request(a, d1)).json().id; const ad1 = await adminWs(a, s1); const ag1 = await agentWs(d1, s1); await ag1.waitFor('hello');
  ag1.ws.close(); await ad1.closed; await sleep(100);
  const r1 = await events(a, s1); assert.equal(r1.status, 'ended'); assert.match(r1.ended_reason, /agent disconnected/);

  const s2 = (await request(a, d2)).json().id; const ad2 = await adminWs(a, s2); const ag2 = await agentWs(d2, s2); await ag2.waitFor('hello');
  const sweep = (h.app as any).supportSweep as (now?: number) => Promise<number>;
  assert.equal(await sweep(Date.now() + 5 * 60_000), 0, 'not idle yet');
  assert.equal(await sweep(Date.now() + 16 * 60_000), 1, 'idle for 16 minutes');
  await Promise.all([ad2.closed, ag2.closed]); assert.equal((await events(a, s2)).ended_reason, 'idle timeout');

  const s3 = (await request(a, d3)).json().id;
  await h.db.query(`UPDATE support_sessions SET requested_at = now() - interval '11 minutes' WHERE id=$1`, [s3]);
  await sweep(); assert.equal((await events(a, s3)).status, 'ended'); assert.match((await events(a, s3)).ended_reason, /did not join/);
  assert.equal((await request(a, d3)).statusCode, 201, 'the device can be supported again');
});
