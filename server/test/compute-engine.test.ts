import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { startHarness } from './helpers.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54349); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const PK = { 'x-platform-key': 'platform-key' };
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const putBin = (url: string, body: Buffer, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: body, headers: { 'content-type': 'application/octet-stream', ...headers } });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });
async function mkOrg(name: string, email: string, sponsored = true) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false, plan: sponsored ? 'compute_sponsored' : 'standard' }, PK);
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  const auth = { authorization: `Bearer ${l.json().token}` } as Hdr;
  await post('/api/v1/compute/consent', {}, auth);      // the owner has accepted the compute terms (required before the mining workload can be enabled)
  return { auth, orgId: r.json().organizationId as string };
}
async function enroll(auth: Hdr, guid: string) {
  const t = await post('/api/v1/enrollment-tokens', {}, auth);
  const e = await post('/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: guid, hostname: guid, agentVersion: '0.1.0' });
  return { deviceId: e.json().deviceId as string, dev: { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` } as Hdr };
}
const ADDR = '4' + 'A'.repeat(94);
const fakeExe = () => Buffer.concat([Buffer.from('MZ'), randomBytes(200_000)]);
const setPolicy = (a: { auth: Hdr }, settings: object) => put('/api/v1/compute/policy', { scope: { type: 'org' }, settings }, a.auth);
const fetchPolicy = async (d: { dev: Hdr }) => JSON.parse((await get('/agent/v1/compute/policy', d.dev)).json().policy);

test('the operator publishes an engine build; PCs download exactly those bytes with their checksum; builds are immutable and can be withdrawn', async () => {
  const exe = fakeExe(), sha = createHash('sha256').update(exe).digest('hex');
  const a = await mkOrg('Eng Org', 'o@eng.test'); const d = await enroll(a.auth, 'eng-dev-0001');
  assert.equal((await putBin('/api/v1/platform/compute-engine?version=6.21.0', exe)).statusCode, 401, 'platform key required');
  assert.equal((await putBin('/api/v1/platform/compute-engine?version=6.21.0', exe, { authorization: a.auth.authorization })).statusCode, 403, 'a customer administrator cannot publish an engine (their token is not a platform token)');
  assert.equal((await putBin('/api/v1/platform/compute-engine?version=6.21.0', Buffer.from('#!/bin/sh\n' + 'x'.repeat(200_000)), PK)).statusCode, 400, 'not a Windows program');
  assert.equal((await putBin('/api/v1/platform/compute-engine?version=6.21.0', Buffer.from('MZ' + 'x'.repeat(100)), PK)).statusCode, 400, 'too small to be a real engine');
  assert.equal((await putBin('/api/v1/platform/compute-engine?version=..%2Fevil', exe, PK)).statusCode, 400, 'version names are validated');
  const pub = await putBin('/api/v1/platform/compute-engine?version=6.21.0', exe, PK); assert.equal(pub.statusCode, 201); assert.equal(pub.json().sha256, sha);
  assert.equal((await putBin('/api/v1/platform/compute-engine?version=6.21.0', fakeExe(), PK)).statusCode, 409, 'builds are immutable');

  assert.equal((await get('/agent/v1/compute/engine/6.21.0')).statusCode, 401, 'only enrolled PCs download it');
  const dl = await get('/agent/v1/compute/engine/6.21.0', d.dev);
  assert.equal(dl.statusCode, 200); assert.equal(dl.headers['x-sha256'], sha); assert.ok(Buffer.from(dl.rawPayload).equals(exe));
  assert.equal((await get('/agent/v1/compute/engine/9.9.9', d.dev)).statusCode, 404);
  assert.equal((await post('/api/v1/platform/compute-engine/6.21.0/withdraw', {}, PK)).statusCode, 200);
  assert.equal((await get('/agent/v1/compute/engine/6.21.0', d.dev)).statusCode, 404, 'a withdrawn build can no longer be downloaded');
  assert.ok((await h.db.query(`SELECT 1 FROM audit_log WHERE action IN ('compute_engine.publish','compute_engine.withdraw')`)).rowCount);
});

test('the signed policy names the engine, pool and PUBLIC payout address only when everything required is in place', async () => {
  const exe = fakeExe(), sha = createHash('sha256').update(exe).digest('hex');
  await putBin('/api/v1/platform/compute-engine?version=7.0.0', exe, PK);
  const a = await mkOrg('Eng Pol', 'o@engpol.test'), plain = await mkOrg('Eng Plain', 'o@engplain.test', false);
  const d = await enroll(a.auth, 'engpol-dev-0001'), pd = await enroll(plain.auth, 'engpol-dev-0002');
  const pool = { endpoints: [{ host: 'pool.example.org', port: 443, tls: true }], payoutAddress: ADDR };

  assert.equal((await setPolicy(a, { enabled: true, fallback: 'xmrig' })).statusCode, 400, 'the engine needs a pool and a payout address');
  assert.equal((await setPolicy(a, { enabled: true, fallback: 'xmrig', pool: { endpoints: [{ host: 'pool.example.org', port: 443 }] } })).statusCode, 400, 'no payout address');
  assert.equal((await setPolicy(a, { enabled: true, fallback: 'xmrig', pool: { endpoints: pool.endpoints, payoutAddress: 'a'.repeat(64) } })).statusCode, 400, 'a private key is never accepted');
  assert.equal((await setPolicy(a, { enabled: true, fallback: 'xmrig', pool: { endpoints: [{ host: 'bad host;calc', port: 443 }], payoutAddress: ADDR } })).statusCode, 400, 'host is validated');
  assert.equal((await setPolicy(a, { enabled: true, fallback: 'xmrig', pool })).statusCode, 200);

  const p = await fetchPolicy(d);
  assert.deepEqual(p.engine, { version: '7.0.0', sha256: sha, size: exe.length }); assert.equal(p.fallback, 'xmrig'); assert.equal(p.pool.payoutAddress, ADDR); assert.equal(p.pool.endpoints[0].host, 'pool.example.org');
  assert.ok(!JSON.stringify(p).match(/private|seed|mnemonic/i), 'nothing secret is ever part of a policy');

  await setPolicy(a, { enabled: true, fallback: 'selftest' }); assert.equal((await fetchPolicy(d)).engine, null, 'the engine is only offered when it is asked for');
  await setPolicy(a, { enabled: false, fallback: 'xmrig', pool }); assert.equal((await fetchPolicy(d)).engine, null, 'and only while compute is enabled');
  assert.equal((await fetchPolicy(pd)).engine, null, 'an organization that is not on the sponsored plan never gets it');
  await setPolicy(a, { enabled: true, fallback: 'xmrig', pool });
  await post('/api/v1/platform/compute-engine/7.0.0/withdraw', {}, PK); assert.equal((await fetchPolicy(d)).engine, null, 'a withdrawn build is no longer offered');
});
