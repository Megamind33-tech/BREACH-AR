# Viro WorkCare

Organizational endpoint management for Windows: PC health, automated repair, security, patching, software and driver management, remote support, staged agent updates, and (opt-in, organization-sponsored) idle-time compute, with the mining-engine link the one deliberately unbuilt piece.

> **Your organization's computers take care of themselves.**

| Component | Path | Stack |
|---|---|---|
| Viro Control (cloud) + admin console | [`server/`](server) | Node 24, Fastify, PostgreSQL |
| Viro Agent (Windows service) | [`agent/src/Viro.Agent`](agent/src/Viro.Agent) | .NET 10 |
| Viro Compute Worker (separate service) | [`agent/src/Viro.Compute`](agent/src/Viro.Compute) | .NET 10 |
| Installer and release tooling | [`agent/installer`](agent/installer), [`scripts/`](scripts) | WiX 5, PowerShell |

## Read first

* [docs/ROADMAP.md](docs/ROADMAP.md): exactly what is finished, what is verified where, and what is not built.
* [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): run Control, install on PCs.
* [docs/RELEASING.md](docs/RELEASING.md): build, sign, staged agent updates, the elevated end-to-end test.
* [docs/SECURITY.md](docs/SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it locally

```bash
cd server && npm install
npm run dev:db          # real PostgreSQL (embedded, UTF-8) on :5433
DATABASE_URL=postgres://viro:viro@localhost:5433/viro JWT_SECRET=<32+ chars> PLATFORM_KEY=<secret> npm run dev
# open http://localhost:8080 after creating an organization (see docs/DEPLOYMENT.md)
```

```powershell
cd agent
dotnet run --project src/Viro.Agent -- enroll --server http://localhost:8080 --token <token>
dotnet run --project src/Viro.Agent -- run          # console mode; the installed form is a Windows service
```

## Test

```bash
cd server && npm test        # 131 tests, real PostgreSQL, real WebSockets
cd agent  && dotnet test     # 243 tests, incl. real screen capture, NVMe SMART, PowerShell, OS CPU caps
```

## Build the installer

```powershell
.\scripts\Build-Installer.ps1 -Sign      # dev certificate; production needs a CA-issued one (docs/RELEASING.md)
```
