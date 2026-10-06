import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness } from './helpers.js';
import { hashPassword } from '../src/security.js';
import { buildInstallScript } from '../src/installer.js';

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54342); });
after(async () => { await h.stop(); });

type Hdr = Record<string, string>;
const PK = { 'x-platform-key': 'platform-key' };
const post = (url: string, payload: unknown, headers: Hdr = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const get = (url: string, headers: Hdr = {}) => h.app.inject({ method: 'GET', url, headers });
const putBin = (url: string, body: Buffer, headers: Hdr = {}) => h.app.inject({ method: 'PUT', url, payload: body, headers: { 'content-type': 'application/octet-stream', ...headers } });

async function mkOrg(name: string, email: string) {
  const r = await post('/api/v1/platform/organizations', { name, ownerEmail: email, ownerPassword: 'correct horse battery', autopilot: false }, PK);
  const l = await post('/api/v1/auth/login', { email, password: 'correct horse battery' });
  return { auth: { authorization: `Bearer ${l.json().token}` } as Hdr, orgId: r.json().organizationId as string };
}
const fakeMsi = () => Buffer.concat([Buffer.from('D0CF11E0A1B11AE1', 'hex'), randomBytes(8192)]);
const TOKEN = 'vet_' + 'A'.repeat(43);

test('the install script embeds only validated values and cannot be talked into running something else', () => {
  const ok = { serverUrl: 'https://control.example.com', token: TOKEN, sha256: 'a'.repeat(64), orgName: 'Acme', expiresAt: new Date('2026-12-01T00:00:00Z') };
  const s = buildInstallScript(ok);
  assert.ok(s.includes("$server = 'https://control.example.com'") && s.includes(`$token  = '${TOKEN}'`) && s.includes("$sha256 = '" + 'a'.repeat(64) + "'"));
  assert.ok(s.includes('\r\n') && !/[^\r]\n/.test(s), 'Windows line endings');
  assert.match(s, /ENROLL_TOKEN=\$token/); assert.match(s, /exit 6/, 'checksum mismatch stops the install');
  assert.match(s, /2026-12-01/);
  for (const bad of ["https://x.com'; calc; '", 'https://user:pw@x.com', 'https://x.com/path', 'ftp://x.com', 'https://x.com?a=b'])
    assert.throws(() => buildInstallScript({ ...ok, serverUrl: bad }), /invalid server URL/, bad);
  assert.throws(() => buildInstallScript({ ...ok, token: "vet_x'; calc; '" }), /invalid token/);
  assert.throws(() => buildInstallScript({ ...ok, sha256: 'zz' }), /invalid checksum/);
  const evil = buildInstallScript({ ...ok, orgName: "Evil #> $(calc) `whoami` \"x\"" });
  assert.ok(!evil.includes('$(calc)') && !evil.includes('`whoami`') && evil.indexOf('#>') === evil.lastIndexOf('#>'), 'organization name cannot close the comment or inject');
});

test('publishing, downloading, and generating the one-file installer: platform-gated, checksummed, admin-only, single-org, audited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'viro-inst-')); void dir;
  const a = await mkOrg('Install Org', 'o@install.test'), b = await mkOrg('Install Other', 'o@install-other.test');
  const site = (await post('/api/v1/sites', { name: 'Head office' }, a.auth)).json();
  const otherSite = (await post('/api/v1/sites', { name: 'Other site' }, b.auth)).json();
  await h.db.query(`INSERT INTO users(org_id,email,password_hash,role) VALUES ($1,'t@install.test',$2,'technician')`, [a.orgId, await hashPassword('another long password')]);
  const tech = { authorization: `Bearer ${(await post('/api/v1/auth/login', { email: 't@install.test', password: 'another long password' })).json().token}` };

  // nothing published yet
  assert.equal((await get('/install/ViroAgent.msi')).statusCode, 404);
  assert.equal((await get('/api/v1/installer', a.auth)).json().available, false);
  assert.equal((await post('/api/v1/installer/script', { serverUrl: 'https://control.example.com' }, a.auth)).statusCode, 409);

  // publish: platform key required; only real .msi files
  const msi = fakeMsi();
  assert.equal((await putBin('/api/v1/platform/installer', msi)).statusCode, 401);
  assert.equal((await putBin('/api/v1/platform/installer', Buffer.from('MZ' + 'x'.repeat(8000)), PK)).statusCode, 400, 'an exe or random file is refused');
  const pub = await putBin('/api/v1/platform/installer', msi, PK);
  assert.equal(pub.statusCode, 201);
  const sha = createHash('sha256').update(msi).digest('hex'); assert.equal(pub.json().sha256, sha);

  // public download returns exactly those bytes and their checksum
  const dl = await get('/install/ViroAgent.msi');
  assert.equal(dl.statusCode, 200); assert.equal(dl.headers['x-sha256'], sha); assert.ok(Buffer.from(dl.rawPayload).equals(msi));

  // the download page reads the same facts with no key at all, so a visitor can verify what they got
  const pubMeta = (await get('/api/v1/public/installer')).json();
  assert.equal(pubMeta.available, true); assert.equal(pubMeta.sha256, sha); assert.equal(pubMeta.size, msi.length); assert.ok(pubMeta.updatedAt);

  // only administrators generate the script; validation; org isolation
  assert.equal((await post('/api/v1/installer/script', { serverUrl: 'https://control.example.com' }, tech)).statusCode, 403);
  assert.equal((await get('/api/v1/installer', tech)).statusCode, 403);
  assert.equal((await post('/api/v1/installer/script', { serverUrl: 'https://control.example.com/x' }, a.auth)).statusCode, 400);
  assert.equal((await post('/api/v1/installer/script', { serverUrl: 'https://control.example.com', siteId: otherSite.id }, a.auth)).statusCode, 404, 'another org site');
  const r = await post('/api/v1/installer/script', { serverUrl: 'https://control.example.com/', siteId: site.id, maxUses: 50, ttlHours: 24 }, a.auth);
  assert.equal(r.statusCode, 200); const out = r.json();
  assert.equal(out.fileName, 'Install-Viro.ps1'); assert.ok(out.script.includes(sha) && out.script.includes("$server = 'https://control.example.com'"));
  assert.match(out.script, /Install Org/); assert.equal(out.maxUses, 50);

  // the token inside the script really enrolls a PC into that org and site
  const token = /\$token\s+= '([^']+)'/.exec(out.script)![1];
  const e = await post('/agent/v1/enroll', { enrollmentToken: token, machineGuid: 'install-dev-0001', hostname: 'NEW-PC', agentVersion: '0.1.0' });
  assert.equal(e.statusCode, 201, e.body);
  const dev = (await get('/api/v1/devices', a.auth)).json().devices.find((d: any) => d.hostname === 'NEW-PC');
  assert.ok(dev && dev.site_id === site.id);
  assert.equal((await get('/api/v1/devices', b.auth)).json().devices.length, 0);
  assert.ok((await get('/api/v1/audit', a.auth)).json().entries.some((x: any) => x.action === 'installer.script'));

  // republishing replaces the file and the checksum that new scripts embed
  const msi2 = fakeMsi(); await putBin('/api/v1/platform/installer', msi2, PK);
  const out2 = (await post('/api/v1/installer/script', { serverUrl: 'https://control.example.com' }, a.auth)).json();
  assert.ok(out2.script.includes(createHash('sha256').update(msi2).digest('hex')) && !out2.script.includes(sha));
  rmSync(dir, { recursive: true, force: true });
});

test('a connection code names its workspace, is checked without being used up, and never crosses organizations', async () => {
  const a = await mkOrg('Acme Ltd', 'a@acme.test'), b = await mkOrg('Bravo Co', 'b@bravo.test');
  const site = await post('/api/v1/sites', { name: 'Lusaka HQ' }, a.auth);
  const siteId = site.json().id as string;

  const made = await post('/api/v1/connection-codes', { serverUrl: 'https://control.example.com', siteId, maxUses: 1 }, a.auth);
  assert.equal(made.statusCode, 201);
  const m = made.json();
  assert.match(m.code, /^VIRO1-[A-Za-z0-9_-]+$/);
  assert.equal(m.organization, 'Acme Ltd'); assert.equal(m.site, 'Lusaka HQ');
  const decoded = JSON.parse(Buffer.from(m.code.slice(6), 'base64url').toString());
  assert.equal(decoded.u, 'https://control.example.com');

  // Checking tells the PC which workspace it would join, and can be done any number of times.
  for (let i = 0; i < 3; i++) {
    const c = await post('/agent/v1/enroll/check', { enrollmentToken: decoded.t });
    assert.equal(c.statusCode, 200);
    assert.deepEqual({ o: c.json().organizationName, s: c.json().siteName, id: c.json().organizationId }, { o: 'Acme Ltd', s: 'Lusaka HQ', id: a.orgId });
  }
  // Only the real join uses it up: one use, then the code is dead.
  const guid = 'GUID-' + randomBytes(6).toString('hex');
  const enrolled = await post('/agent/v1/enroll', { enrollmentToken: decoded.t, machineGuid: guid, hostname: 'PC-ONE', agentVersion: '0.1.0' });
  assert.equal(enrolled.statusCode, 201); assert.equal(enrolled.json().organizationId, a.orgId);
  assert.equal((await post('/agent/v1/enroll/check', { enrollmentToken: decoded.t })).statusCode, 401, 'used up');
  assert.equal((await post('/agent/v1/enroll', { enrollmentToken: decoded.t, machineGuid: 'GUID-2' + randomBytes(5).toString('hex'), hostname: 'PC-TWO', agentVersion: '0.1.0' })).statusCode, 401);

  // Another organization cannot mint a code into this one's site, and a made-up code is refused.
  assert.equal((await post('/api/v1/connection-codes', { serverUrl: 'https://control.example.com', siteId }, b.auth)).statusCode, 404);
  assert.equal((await post('/agent/v1/enroll/check', { enrollmentToken: 'vet_' + 'Z'.repeat(43) })).statusCode, 401);
  assert.equal((await post('/api/v1/connection-codes', { serverUrl: 'https://x.com/evil' }, a.auth)).statusCode, 400);
  assert.equal((await post('/api/v1/connection-codes', { serverUrl: 'https://control.example.com' })).statusCode, 401, 'signed-in admins only');
});
