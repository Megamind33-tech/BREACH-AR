# Deploying Viro WorkCare

## 1. Viro Control (server)

Requirements: a Linux VPS with Docker, a DNS name pointing at it, ports 80/443 open.

```bash
cd deploy
cp .env.example .env
# fill in: DOMAIN, POSTGRES_PASSWORD, JWT_SECRET, PLATFORM_KEY, JOB_SIGNING_KEY
openssl rand -base64 48                       # use for JWT_SECRET and PLATFORM_KEY (two different values)
openssl ecparam -name prime256v1 -genkey | openssl pkcs8 -topk8 -nocrypt   # JOB_SIGNING_KEY (paste with newlines as \n)
docker compose up -d
```

* **`JOB_SIGNING_KEY` is the root of trust.** Agents pin its public key at enrollment and will only run jobs, apply updates and honour compute policies signed by it. Keep it in a secret store, back it up, and do not rotate it casually (rotation currently requires re-enrolling devices; see *Known limits*).
* **`PLATFORM_KEY`** authorizes platform-operator calls (creating organizations, uploading releases, setting plans). Treat it like a root password.
* The database schema is applied automatically at start-up. Back up the `pgdata` and `releases` volumes.
* Health endpoint: `GET /healthz`.

The compose file has **not been run end-to-end yet** (no Docker on the development machine). The server itself runs against real PostgreSQL in all tests and locally via `npm run dev:db` + `npm run dev`.

### Create the first organization

```bash
curl -X POST https://control.example.com/api/v1/platform/organizations \
  -H "x-platform-key: $PLATFORM_KEY" -H 'content-type: application/json' \
  -d '{"name":"Acme Ltd","ownerEmail":"it@acme.example","ownerPassword":"a long passphrase","plan":"standard"}'
```

Sign in at `https://control.example.com/`. `plan` may be `compute_sponsored` for organizations that opted into compute sponsorship.

## 2. Installing on Windows PCs

**Easiest (recommended): the one-file installer.** Publish the MSI to your server once (`scriptsPublish-Installer.ps1 -Server https://control.example.com -PlatformKey <key>`). Then an administrator opens the console, clicks **Add computers**, optionally picks a site, and downloads `Install-Viro.ps1`. Running that file as administrator on a PC (or deploying it with Intune, Group Policy or an RMM) downloads the MSI from your server, refuses it if its SHA-256 differs from the one embedded in the file, installs it silently and enrolls the PC. The file holds an enrollment token that expires after 14 days and is use-limited; treat it as private.

Manual alternative:

1. In the console: **Sites & groups → Create enrollment token** (optionally bound to a site). Tokens are single-organization, expire, and are use-limited.
2. Build or download the installer (`scripts\Build-Installer.ps1 -Sign`), then on each PC (elevated):

```powershell
msiexec /i ViroAgent-0.1.0.msi /qn SERVER_URL=https://control.example.com ENROLL_TOKEN=vet_xxxxxxxx
# only for organizations on the compute-sponsored plan:  ... INSTALL_COMPUTE=1
```

This deploys unchanged through GPO, Intune, SCCM or any RMM. The installer places the agent in `Program Files\Viro\Agent`, enrolls the PC, locks the data folder (`ProgramData\Viro\Agent`) to SYSTEM and Administrators, registers the `ViroAgent` service (automatic, delayed start, runs as LocalSystem, restarts itself after a crash) and starts it.

Without MSI: `viro-agent.exe install --server https://... --token vet_...` does the same from an elevated prompt.

**Transport security:** the agent refuses non-HTTPS servers (loopback is allowed for development). Use a real certificate (Caddy provisions one automatically).

### Useful commands on a PC

```text
viro-agent.exe status            service state, enrollment, version, log folder
viro-agent.exe inventory|health|hardware|security|cleanup-preview    print exactly what the agent would report
viro-agent.exe uninstall         removes the service, files and (unless --keep-data) its data; tells Control
viro-compute.exe status          compute worker state
```

Logs: `C:\ProgramData\Viro\Agent\logs\agent-YYYYMMDD.log` (14 days kept).

## 3. Day-to-day

* **Overview** answers "is my organization healthy?". **Computers** lists every PC with filters and bulk actions; **Command Center** runs any supported action against a device, a selection, a site, a department or everything.
* Every action is a signed **job** with a status (queued, running, completed, failed, cancelled) and an **audit** entry.
* **Policies** automate maintenance (schedules, maintenance windows, automatic repairs). **Alerts** open and close themselves.
* **Remote support** sessions need a stated reason, are shown to the person at the PC, and are recorded.

## 4. Scaling and operations notes

* Control is stateless apart from PostgreSQL and the release folder; run several instances behind a load balancer.
* **Remote-support sessions are held in the memory of the instance that accepted the sockets.** With more than one instance, route `/api/v1/support/*/ws` and `/agent/v1/sessions/*` with sticky sessions (or add the Redis relay reserved in the compose file).
* The job scheduler, offline sweep and rollout engine run on every instance every 30-60 s; they are idempotent, and duplicate work is absorbed by open-job checks.
* Set `REQUIRE_TRUSTED_SIGNATURE=1` in production so an unsigned or untrusted agent binary raises a critical alert.
