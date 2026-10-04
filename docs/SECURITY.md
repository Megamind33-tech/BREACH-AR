# Security model

## Trust roots and identities

| Thing | How it is protected |
|---|---|
| **Administrators** | scrypt-hashed passwords, 12-hour tokens, four roles (viewer, technician, admin, owner), login rate limiting, per-org isolation enforced in every query |
| **Devices** | one random secret per device, stored only as a SHA-256 hash on the server and DPAPI-encrypted (machine scope) on the PC; data folder restricted to SYSTEM/Administrators; re-enrolling rotates the secret; revoking cuts it off immediately |
| **Enrollment** | hashed, expiring, use-limited tokens |
| **Jobs** | ECDSA P-256 signed by Control; the agent verifies signature, device, organization, expiry, type allow-list and replay before running anything |
| **Updates** | signed manifest + package hash + executable hash + smoke test + confirm-or-rollback |
| **Compute policy** | signed by Control, bound to the PC's worker id, versioned (no rollback to an older policy), expires after 48 h without a refresh |
| **Transport** | HTTPS enforced by the agent (loopback excepted for development) |

## What administrators cannot do

* There is **no "run arbitrary command" job**. The agent runs only compiled-in handlers with validated parameters; PowerShell is used only with fixed command text.
* Remote terminal and file transfer are separate, **admin-only, reason-required, visible-to-the-user and fully recorded** sessions. A files session cannot open a terminal and vice versa (enforced by the server). The agent refuses to read its own credential folder or registry hives.
* Personal folders (Documents, Desktop, Downloads, Pictures, Videos) **cannot be selected** for cleanup at all: they are not a category anywhere in the code.
* Commercial (sponsorship) status **never changes anything on a PC**.
* Wallet private keys are never accepted or stored anywhere; only a public payout address can be configured (private keys and seed phrases do not match the accepted format).

## Audit

Logins, organization/site/department/policy/software/compute changes, enrollments, every job (create, start, finish, cancel, timeout), every remote-support session (request, start, commands typed, files touched, end), report exports, releases and uninstalls are recorded with actor, target, previous and new state.

## Tamper detection

The agent reports the SHA-256 of its own executable, whether it is code-signed and trusted, whether the service is still registered as installed, and whether its data folder is exposed. Control compares the hash with the signed release and raises alerts (`tamper.binary_modified`, `tamper.certificate_invalid`, `tamper.service_misconfigured`, `tamper.config_exposed`, `agent.outdated`). A clean uninstall tells Control; a device that simply vanishes shows as offline. Viro does not hide from or evade antivirus products.

## Known limits (be honest with your customers)

* **No device client certificates / mutual TLS yet.** Devices authenticate with a per-device secret over TLS. Adding mTLS at the reverse proxy is a planned hardening step.
* **One signing key.** No rotation procedure, per-organization keys or HSM/KMS integration yet.
* **A compromised endpoint with administrator rights can stop the agent** (that is what "tamper detection" reports); it cannot make Control accept forged jobs or updates.
* The remote desktop cannot show or control the UAC secure desktop or the lock screen (a Windows security boundary).
* Remote terminal runs as the agent identity (SYSTEM when installed): treat the admin role accordingly, and enable MFA at your identity layer when one is added in front of the console.
