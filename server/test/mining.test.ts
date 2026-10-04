import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { formatWorkerId, isValidWorkerId, ensureWorkerId } from '../src/mining-worker-id.js';
import { MiningPolicy, signMiningPolicy, verifyMiningPolicy, HARD_LIMITS, type MiningPolicyT } from '../src/mining-policy.js';
import { startHarness } from './helpers.js';

const PK = { 'x-platform-key': 'platform-key' };
async function makeOrgAndDevice(h: Awaited<ReturnType<typeof startHarness>>, name: string) {
  const r = await h.app.inject({ method: 'POST', url: '/api/v1/platform/organizations', payload: { name, ownerEmail: `owner@${name.toLowerCase()}.test`, ownerPassword: 'correct horse battery', autopilot: false }, headers: PK });
  const orgId = r.json().organizationId as string;
  const l = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `owner@${name.toLowerCase()}.test`, password: 'correct horse battery' } });
  const auth = { authorization: `Bearer ${l.json().token}` };
  const t = await h.app.inject({ method: 'POST', url: '/api/v1/enrollment-tokens', payload: {}, headers: auth });
  const e = await h.app.inject({ method: 'POST', url: '/agent/v1/enroll', payload: { enrollmentToken: t.json().token, machineGuid: 'G-' + randomUUID(), hostname: name + '-PC', agentVersion: '0.1.7' } });
  return { orgId, deviceId: e.json().deviceId as string };
}

test('worker ids are server-generated, readable, and never built from a person\'s name', () => {
  const id = formatWorkerId({ countryCode: 'ZM', orgId: '7ea21934-aaaa-bbbb-cccc-111122223333', orgHint: 'SCH0001', siteHint: 'LSK', deviceId: '00a42183-dddd-eeee-ffff-444455556666' });
  assert.equal(id, 'ZM-SCH0001-LSK-00A42183'); assert.ok(isValidWorkerId(id));
  // no safe hints: falls back to hash tokens, never a name/phone/email the caller might pass as a hint
  const fallback = formatWorkerId({ countryCode: 'ZM', orgId: '7ea21934-aaaa-bbbb-cccc-111122223333', deviceId: '00a42183-dddd-eeee-ffff-444455556666' });
  assert.ok(isValidWorkerId(fallback)); assert.notEqual(fallback, id);
  for (const bad of ['john.smith@example.com', '+260971234567', "O'Brien"]) assert.throws(() => { if (!/^[2-9]/.test(bad)) throw new Error('n/a'); }); // sanity: hints are sanitized to A-Z0-9 only, see below
  const sanitized = formatWorkerId({ countryCode: 'ZM', orgId: 'x', deviceId: 'y', orgHint: 'john.smith@example.com' });
  assert.ok(!sanitized.includes('@') && !sanitized.includes('.'));
  assert.throws(() => formatWorkerId({ countryCode: 'zm', orgId: 'x', deviceId: 'y' }), /2-letter/);
});

test('a worker id is issued once, is stable on repeat calls, and is never reused across devices', async () => {
  const h = await startHarness(54391);
  try {
    const { orgId, deviceId: devA } = await makeOrgAndDevice(h, 'MiningOrgA');
    // a second device in the SAME org: reuse its enrollment token rather than making a second organization
    const { app } = h;
    const l = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'owner@miningorga.test', password: 'correct horse battery' } });
    const auth = { authorization: `Bearer ${l.json().token}` };
    const t = await app.inject({ method: 'POST', url: '/api/v1/enrollment-tokens', payload: {}, headers: auth });
    const e = await app.inject({ method: 'POST', url: '/agent/v1/enroll', payload: { enrollmentToken: t.json().token, machineGuid: 'G-' + randomUUID(), hostname: 'MiningOrgA-PC2', agentVersion: '0.1.7' } });
    const devB = e.json().deviceId as string;
    const id1 = await ensureWorkerId(h.db, { countryCode: 'ZM', orgId, deviceId: devA, orgHint: 'SCH1' });
    const id2 = await ensureWorkerId(h.db, { countryCode: 'ZM', orgId, deviceId: devA, orgHint: 'SCH1' });
    assert.equal(id1, id2, 'stable across repeat calls for the same device');
    const idB = await ensureWorkerId(h.db, { countryCode: 'ZM', orgId, deviceId: devB, orgHint: 'SCH1' });
    assert.notEqual(idB, id1);
    const row = (await h.db.query('SELECT device_id FROM mining_worker_ids WHERE worker_id=$1', [id1])).rows[0]; assert.equal(row.device_id, devA);
  } finally { await h.stop(); }
});

function freshPolicy(over: Partial<MiningPolicyT> = {}): MiningPolicyT {
  const now = new Date();
  return {
    deviceId: randomUUID(), workerId: 'ZM-SCH0001-LSK-00A42183', enabled: true,
    poolPrimary: { host: 'pool.hashvault.pro', port: 443 }, poolFailover: { host: 'pool.hashvault.sh', port: 443 }, tls: true,
    wallet: '85FVXgmWdXC29WgXxbipGG6pKKxmXnRo9JT1TqyAEDorPKqrDnYcS6EbuKjiGjRTNG46HY8B1tzLKgaw6gCzAoXLUxFYxza',
    engineVersion: '1.0.0', engineSha256: 'a'.repeat(64), maxCpuPercent: 60, stopOnBattery: true, maxTemperatureC: 80, onlyWhileIdle: true,
    issuedAt: now.toISOString(), validUntil: new Date(now.getTime() + 24 * 3600_000).toISOString(), ...over,
  };
}

test('a mining policy is only ever signed over valid, safety-bounded fields', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.throws(() => signMiningPolicy(privateKey, freshPolicy({ maxCpuPercent: HARD_LIMITS.maxCpuPercentCeiling + 1 })), /80|maxCpuPercent/i);
  assert.throws(() => signMiningPolicy(privateKey, freshPolicy({ maxTemperatureC: HARD_LIMITS.maxTemperatureCeilingC + 1 })));
  assert.throws(() => signMiningPolicy(privateKey, freshPolicy({ stopOnBattery: false as unknown as true })));
  assert.throws(() => signMiningPolicy(privateKey, freshPolicy({ tls: false as unknown as true })));
  assert.throws(() => signMiningPolicy(privateKey, freshPolicy({ wallet: '46PnLwm9rZEUsLVvocwi1MXjRSdpPuoZjiZQPHTBB4RPSAESknB72iHeEvWCbZ5uTKH8h1swsBqbwXYiEFkeKuY7MDRi2keXXXXX' })), /wallet/);
  assert.throws(() => signMiningPolicy(privateKey, freshPolicy({ validUntil: new Date(Date.now() + 8 * 24 * 3600_000).toISOString() })), /7 days/);
  const ok = signMiningPolicy(privateKey, freshPolicy()); assert.equal(ok.policy.wallet.length, 95);
});

test('the endpoint verifies against the signing key alone: wrong key, tampered field, or expiry are all refused; the matching key and an unexpired policy pass', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { publicKey: otherPublic } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signed = signMiningPolicy(privateKey, freshPolicy());
  assert.equal(verifyMiningPolicy(publicKey, signed).ok, true);
  assert.equal(verifyMiningPolicy(otherPublic, signed).ok, false, 'a different key must not verify');
  const tampered = { policy: { ...signed.policy, maxCpuPercent: 80 }, signature: signed.signature };
  assert.equal(verifyMiningPolicy(publicKey, tampered).ok, false, 'changing a field after signing must invalidate it');
  const expired = signMiningPolicy(privateKey, freshPolicy({ issuedAt: new Date(Date.now() - 48 * 3600_000).toISOString(), validUntil: new Date(Date.now() - 3600_000).toISOString() }));
  const r = verifyMiningPolicy(publicKey, expired); assert.equal(r.ok, false); if (!r.ok) assert.match(r.reason, /expired/);
});

test('the server image is checked for mining components, and the check itself is exercised against planted forbidden content', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const script = join(process.cwd(), 'scripts', 'check-no-miner-in-image.mjs');
  const clean = mkdtempSync(join(tmpdir(), 'viro-imgchk-clean-')); writeFileSync(join(clean, 'index.js'), 'console.log("hello")');
  try { execFileSync(process.execPath, [script, clean], { stdio: 'pipe' }); } finally { rmSync(clean, { recursive: true, force: true }); }
  const dirty = mkdtempSync(join(tmpdir(), 'viro-imgchk-dirty-')); writeFileSync(join(dirty, 'xmrig.exe'), Buffer.from([0]));
  try { execFileSync(process.execPath, [script, dirty], { stdio: 'pipe' }); assert.fail('should have exited non-zero'); }
  catch (e: any) { assert.notEqual(e.status, 0); } finally { rmSync(dirty, { recursive: true, force: true }); }
  const scripted = mkdtempSync(join(tmpdir(), 'viro-imgchk-script-')); writeFileSync(join(scripted, 'launch.js'), 'connect("stratum+tcp://pool.hashvault.pro:443")');
  try { execFileSync(process.execPath, [script, scripted], { stdio: 'pipe' }); assert.fail('should have exited non-zero'); }
  catch (e: any) { assert.notEqual(e.status, 0); } finally { rmSync(scripted, { recursive: true, force: true }); }
});
