import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import type { JobCtx } from './jobs.js';
import { newSecret, sha256Hex } from './security.js';

/**
 * One-file installer. The MSI is published to the server once (platform operator); an administrator then downloads a small
 * PowerShell file that already contains the organization's enrollment token and the expected checksum. Running it as administrator
 * (or deploying it with Intune, a GPO or any RMM) downloads the MSI from this server, refuses it if the checksum differs, installs it
 * silently and enrolls the PC. The script contains no secret other than the enrollment token, which is limited by uses and expiry.
 */
const MSI_MAGIC = Buffer.from('D0CF11E0A1B11AE1', 'hex');       // OLE compound file header, which every .msi starts with
const SERVER_URL = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
const TOKEN = /^vet_[A-Za-z0-9_-]{20,80}$/;
const HASH = /^[0-9a-f]{64}$/;

export function buildInstallScript(o: { serverUrl: string; token: string; sha256: string; orgName: string; expiresAt: Date }): string {
  if (!SERVER_URL.test(o.serverUrl)) throw new Error('invalid server URL');
  if (!TOKEN.test(o.token)) throw new Error('invalid token');
  if (!HASH.test(o.sha256)) throw new Error('invalid checksum');
  const org = o.orgName.replace(/[^\p{L}\p{N} .,&'()-]/gu, '').slice(0, 80);
  return `<#
  Viro WorkCare installer for ${org}
  Run this file as Administrator on the PC (right-click, "Run with PowerShell" as administrator), or deploy it with
  Intune, Group Policy or your remote-management tool. It downloads Viro from ${o.serverUrl}, checks it, installs it and
  enrolls this PC. The enrollment token in this file expires ${o.expiresAt.toISOString().slice(0, 10)}; keep the file private.
#>
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$server = '${o.serverUrl}'
$token  = '${o.token}'
$sha256 = '${o.sha256}'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host 'Please run this file as Administrator.'; exit 5 }

$msi = Join-Path $env:TEMP 'ViroAgent.msi'
Write-Host 'Downloading Viro WorkCare...'
Invoke-WebRequest -UseBasicParsing -Uri "$server/install/ViroAgent.msi" -OutFile $msi
if ((Get-FileHash $msi -Algorithm SHA256).Hash.ToLower() -ne $sha256) {
  Remove-Item $msi -Force
  Write-Host 'The download did not match the expected checksum. Nothing was installed.'
  exit 6
}
Write-Host 'Installing...'
$log = Join-Path $env:TEMP 'viro-install.log'
$p = Start-Process msiexec.exe -ArgumentList '/i', "\`"$msi\`"", '/qn', "SERVER_URL=$server", "ENROLL_TOKEN=$token", '/l*v', "\`"$log\`"" -Wait -PassThru
Remove-Item $msi -Force -ErrorAction SilentlyContinue
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Write-Host "Installation failed (code $($p.ExitCode)). Details: $log"; exit $p.ExitCode }
Write-Host 'Done. This PC appears in your Viro console within a minute.'
exit 0
`.replace(/\n/g, '\r\n');
}

export function registerInstallerRoutes(app: FastifyInstance, c: JobCtx, o: { releasesDir: string; platformGuard?: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>; platformKey?: string; safeEq: (a: string, b: string) => boolean }) {
  const { db } = c;
  const dir = join(o.releasesDir, 'installer');
  const msiPath = join(dir, 'ViroAgent.msi'), metaPath = join(dir, 'meta.json');
  const meta = async (): Promise<{ sha256: string; size: number; updatedAt: string } | null> => { try { return JSON.parse(await readFile(metaPath, 'utf8')); } catch { return null; } };
  const platform = o.platformGuard ?? (async (req: FastifyRequest, reply: FastifyReply) => { if (!o.platformKey || !o.safeEq(String(req.headers['x-platform-key'] ?? ''), o.platformKey)) return reply.code(401).send({ error: 'unauthenticated' }); });

  // Publish (platform operator): raw .msi body.
  app.put('/api/v1/platform/installer', { preHandler: platform, bodyLimit: 300 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 4096 || !body.subarray(0, 8).equals(MSI_MAGIC)) return reply.code(400).send({ error: 'body must be a Windows Installer (.msi) file (Content-Type: application/octet-stream)' });
    await mkdir(dir, { recursive: true });
    const tmp = msiPath + '.part'; await writeFile(tmp, body); await rename(tmp, msiPath);
    const m = { sha256: createHash('sha256').update(body).digest('hex'), size: body.length, updatedAt: new Date().toISOString() };
    await writeFile(metaPath, JSON.stringify(m));
    await c.audit({ orgId: null, actorType: 'system', action: 'installer.publish', targetType: 'installer', next: m });
    return reply.code(201).send(m);
  });

  // Public download: the MSI holds no secret (the enrollment token travels in the script), and the script checks the checksum.
  app.get('/install/ViroAgent.msi', async (_req, reply) => {
    const m = await meta();
    if (!m) return reply.code(404).send({ error: 'the installer has not been published to this server yet' });
    return reply.header('content-type', 'application/x-msi').header('content-length', String((await stat(msiPath)).size)).header('x-sha256', m.sha256)
      .header('content-disposition', 'attachment; filename="ViroAgent.msi"').send(createReadStream(msiPath));
  });

  app.get('/api/v1/platform/installer', { preHandler: platform }, async () => { const m = await meta(); return { available: !!m, ...(m ?? {}) }; });

  app.get('/api/v1/installer', { preHandler: c.requireRole('admin') }, async () => {
    const m = await meta();
    return { available: !!m, ...(m ?? {}) };
  });

  app.post('/api/v1/installer/script', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const b = z.object({
      serverUrl: z.string().max(200), siteId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(),
      maxUses: z.number().int().min(1).max(100000).default(1000), ttlHours: z.number().int().min(1).max(24 * 90).default(24 * 14),
    }).strict().parse(req.body);
    const serverUrl = b.serverUrl.replace(/\/+$/, '');
    if (!SERVER_URL.test(serverUrl)) return reply.code(400).send({ error: 'serverUrl must look like https://control.example.com (no path or credentials)' });
    const m = await meta();
    if (!m) return reply.code(409).send({ error: 'the installer has not been published to this server yet; ask your Viro operator to publish it' });
    if (b.siteId && !(await db.query('SELECT 1 FROM sites WHERE id=$1 AND org_id=$2', [b.siteId, req.user.org])).rowCount) return reply.code(404).send({ error: 'site not found' });
    if (b.departmentId && !(await db.query('SELECT 1 FROM departments WHERE id=$1 AND org_id=$2', [b.departmentId, req.user.org])).rowCount) return reply.code(404).send({ error: 'department not found' });
    const secret = newSecret('vet');
    const r = await db.query(
      `INSERT INTO enrollment_tokens(org_id,token_hash,site_id,department_id,max_uses,expires_at,created_by) VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6), $7) RETURNING id, expires_at`,
      [req.user.org, sha256Hex(secret), b.siteId ?? null, b.departmentId ?? null, b.maxUses, b.ttlHours, req.user.sub]);
    const org = (await db.query('SELECT name FROM organizations WHERE id=$1', [req.user.org])).rows[0].name as string;
    const expiresAt = new Date(r.rows[0].expires_at);
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'installer.script', targetType: 'enrollment_token', targetId: r.rows[0].id, next: { siteId: b.siteId, departmentId: b.departmentId, maxUses: b.maxUses, ttlHours: b.ttlHours } });
    return { fileName: 'Install-Viro.ps1', script: buildInstallScript({ serverUrl, token: secret, sha256: m.sha256, orgName: org, expiresAt }), expiresAt: expiresAt.toISOString(), maxUses: b.maxUses };
  });

  // ---- connection codes: one short string a person pastes into the Viro window on their PC ----------------------------------------
  app.post('/api/v1/connection-codes', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const b = z.object({
      serverUrl: z.string().max(200), siteId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(),
      maxUses: z.number().int().min(1).max(1000).default(1), ttlHours: z.number().int().min(1).max(24 * 14).default(24),
    }).strict().parse(req.body);
    const serverUrl = b.serverUrl.replace(/\/+$/, '');
    if (!SERVER_URL.test(serverUrl)) return reply.code(400).send({ error: 'serverUrl must look like https://control.example.com (no path or credentials)' });
    const site = b.siteId ? (await db.query('SELECT name FROM sites WHERE id=$1 AND org_id=$2', [b.siteId, req.user.org])).rows[0] : null;
    if (b.siteId && !site) return reply.code(404).send({ error: 'site not found' });
    const dept = b.departmentId ? (await db.query('SELECT name FROM departments WHERE id=$1 AND org_id=$2', [b.departmentId, req.user.org])).rows[0] : null;
    if (b.departmentId && !dept) return reply.code(404).send({ error: 'department not found' });
    const secret = newSecret('vet');
    const r = await db.query(
      `INSERT INTO enrollment_tokens(org_id,token_hash,site_id,department_id,max_uses,expires_at,created_by) VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6), $7) RETURNING id, expires_at`,
      [req.user.org, sha256Hex(secret), b.siteId ?? null, b.departmentId ?? null, b.maxUses, b.ttlHours, req.user.sub]);
    const org = (await db.query('SELECT name FROM organizations WHERE id=$1', [req.user.org])).rows[0].name as string;
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'connection_code.create', targetType: 'enrollment_token', targetId: r.rows[0].id, next: { siteId: b.siteId, departmentId: b.departmentId, maxUses: b.maxUses, ttlHours: b.ttlHours } });
    const code = 'VIRO1-' + Buffer.from(JSON.stringify({ u: serverUrl, t: secret })).toString('base64url');
    return reply.code(201).send({ code, organization: org, site: site?.name ?? null, department: dept?.name ?? null, expiresAt: new Date(r.rows[0].expires_at).toISOString(), maxUses: b.maxUses });
  });

  // The PC asks "which workspace is this code for?" before it joins, so a person always sees the name first. Nothing is used up or changed.
  app.post('/agent/v1/enroll/check', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ enrollmentToken: z.string().min(10).max(200) }).parse(req.body);
    const r = await db.query(
      `SELECT o.id AS org_id, o.name AS org_name, s.name AS site_name, d.name AS dept_name
         FROM enrollment_tokens t JOIN organizations o ON o.id=t.org_id
         LEFT JOIN sites s ON s.id=t.site_id LEFT JOIN departments d ON d.id=t.department_id
        WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at > now() AND t.uses < t.max_uses`, [sha256Hex(b.enrollmentToken)]);
    if (!r.rowCount) return reply.code(401).send({ error: 'invalid or expired enrollment token' });
    const x = r.rows[0];
    return { organizationId: x.org_id, organizationName: x.org_name, siteName: x.site_name ?? null, departmentName: x.dept_name ?? null };
  });
}
