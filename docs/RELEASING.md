# Building, signing and releasing

## Build

```powershell
.\scripts\Build-Installer.ps1 -Sign          # dev certificate; see below for production
```

Produces `dist\viro-agent.exe`, `dist\viro-compute.exe`, `dist\ViroAgent-<version>.msi` and `dist\SHA256SUMS.txt`. The version comes from `agent\src\Viro.Agent\Viro.Agent.csproj`.

### Code signing

`scripts\New-DevCodeSigningCert.ps1` creates a **self-signed** certificate for exercising the pipeline. Windows and SmartScreen do not trust it. **Production builds must be signed with a certificate from a trusted CA** (an EV or Azure Trusted Signing certificate is recommended):

```powershell
.\scripts\Build-Installer.ps1 -Sign -CertThumbprint <thumbprint> -Timestamp http://timestamp.digicert.com
```

Signing protects customers from tampered installers and lets endpoint-security products recognize the software. Viro never asks security products to ignore its binaries.

## Staged agent updates

Agents update themselves; nothing is pushed to a whole fleet at once.

```powershell
.\scripts\Publish-Release.ps1 -Server https://control.example.com -PlatformKey $env:VIRO_PLATFORM_KEY -Version 0.2.0
```

The release starts as a **draft** (offered to nobody). Advance it, watching `GET /api/v1/platform/releases` (updated / failed counts) between steps:

| Step | Reaches |
|---|---|
| `status: active` (stage `internal`) | devices whose ring is **internal** |
| stage `pilot` | internal + **pilot** rings |
| stage `10`, `50`, `100` | pilot rings plus that percentage of stable devices (a stable, growing subset) |

Set a device's ring with `PATCH /api/v1/devices/:id {"updateRing":"pilot"}`. Stages only move forward; to stop, set `status: halted`. **Control halts a release by itself** when at least three devices (and 20% of those that tried) fail to update or have to roll back.

### What the agent verifies before it changes anything

1. the manifest is signed by the pinned Control key;
2. the package's SHA-256 and size match the signed manifest;
3. the extracted `viro-agent.exe` hash matches the signed manifest;
4. the new executable runs and reports the expected version;
5. after the swap, the new service must **confirm itself within two minutes**, otherwise the previous executable is restored automatically and the failure is reported.

Failed versions are blocked on that device so it never retries them.

## Testing the real product on a PC (needs administrator rights)

`scripts\Test-ElevatedE2E.ps1` installs the MSI, checks the services, runs a battery of jobs as SYSTEM, kills the agent to prove crash recovery, runs the compute worker, performs a real signed self-update to 0.1.1, performs a deliberately broken update to 0.1.2 to prove automatic rollback, then uninstalls. It always uninstalls at the end. Run it from an **elevated** PowerShell with Control running locally:

```powershell
.\scripts\Test-ElevatedE2E.ps1        # writes %TEMP%\viro-elevated.log
```

The two test packages (`dist\e2e\agent-0.1.1.zip`, `agent-0.1.2.zip`) are built as described at the top of the script.
