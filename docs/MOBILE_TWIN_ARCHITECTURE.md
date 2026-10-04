# WorkCare Mobile twin and QuickCheck: architecture

Status: Phase 1 (inspection and baseline) complete; later phases are tracked at the end. This document is the contract between the existing WorkCare product and the two new siblings. Nothing in the existing product is renamed, removed or rewritten by this work.

## 1. What exists today (inspected, not assumed)

| Part | Where | Notes |
|---|---|---|
| WorkCare Desktop agent | `agent/src/Viro.Agent` (.NET 10, `net10.0-windows`, assembly `viro-agent`) | Windows service plus user-session helper and local WebView2 window. Collectors for health, hardware (`HardwareDiagnostics.cs`), anatomy (`Anatomy.cs`), security, stability. Signed jobs, self-update, support sessions. |
| Compute worker | `agent/src/Viro.Compute` (separate service `ViroCompute`) | The only place mining can run. Obeys a signed policy and the health gate. Deliberately a separate executable. |
| Control server | `server/` (Node 24, Fastify, PostgreSQL) | Org users and JWT, MFA (027), device registry, health scoring (`health.ts`), hardware rules (`hardware.ts`), anatomy engine, passport (`passport.ts`), alerts, jobs, compute policy/state/audit (`compute.ts`, `mining-reporting.ts`), platform console. 29+ test files. |
| Consoles | `server/public` (org), `server/public/platform.html` (operator) | Vanilla JS. |
| Local Windows window | `agent/src/Viro.Agent/Care/ui/index.html` | Embedded in the agent. |
| Installer | `agent/installer` (WiX), `scripts/` | MSI, signing scripts. |

Existing deterministic layers (the single source of truth for desktop conclusions):

* `server/src/health.ts`: `scoreHealth` -> `HealthResult` (categories, `Deduction` with code, impact, remedy, recommendation).
* `server/src/hardware.ts`: `analyzeHardware(raw)` -> `HwFinding[]` (component, severity, code, message, recommendation) plus `unavailable` and `checked`. Input is the agent's `hardware.diagnose` result.
* `server/src/anatomy-engine.ts`, `passport.ts`, `lifecycle.ts`: parts, age evidence, passport events, lifecycle decisions.

## 2. Baseline (recorded before any new code)

Run on this machine, 2026-10-02:

* Agent: `dotnet test` in `agent/`: 415 passed, 0 failed.
* Server: `tsc --noEmit` clean; test files run individually: ui, platform-ui, account, platform-ops, platform, compute, compute-engine, mining, mining-reporting, mining-routes, control, support, webhooks, installer: all pass (the full suite takes over 30 minutes and is not part of this baseline).
* Repository state: the old Unity "Hunter" project is staged as deleted by an earlier session; unrelated to this work and left alone.
* Toolchain present: JDK 17, Android SDK (platforms 34-36, build-tools 34-36, platform-tools), Gradle 8.5/8.7/9.3.1 caches with AGP 8.2.2, Kotlin 1.9.22, Compose BOM 2024.02.00, Material3 1.2.0, Navigation-Compose 2.7.7. One real Android phone attached over adb (TECNO CI6, Android 13, API 33).

## 3. Modules that must not be disturbed

* `agent/src/Viro.Agent/**` and `agent/src/Viro.Compute/**`: no behavioural change. QuickCheck may *link* specific read-only collector source files; it never references the agent project and never pulls in `ComputeProvisioner`, the service host, self-update, jobs or anything compute-related.
* `server/src/compute.ts`, `mining-*.ts`, `healthgate.ts`: no change except additive routes in a new file.
* Existing routes and tables: additive migrations only. Existing tests must keep passing.

## 4. New components (all additive)

```
packages/
  contracts/          versioned payload schemas (zod) + JSON fixtures; generated JSON Schema
  health-rules/       declarative rule set (rules.json) + shared test vectors + TS evaluator
  pairing-protocol/   session/handshake spec + reference implementation + test vectors
apps/
  mobile/             Android app (Kotlin, Jetpack Compose), package com.viro.workcare
  quickcheck/         WorkCareQuickCheck (.NET, portable, no install)
server/src/twin.ts    mobile-facing API (additive), mapped onto existing data
docs/MOBILE_TWIN_ARCHITECTURE.md   this file
```

The suggested monorepo layout is a target, not a mandate: the existing `agent/` and `server/` stay where they are; new code goes in `packages/` and `apps/`.

### 4.1 Shared contracts (`packages/contracts`)

Every payload carries `schemaVersion`, `deviceId`, `timestamp`, `source` where applicable. Models: `DeviceSummary`, `DeviceHealth`, `ComponentHealth`, `DiagnosticFinding`, `DiagnosticEvidence`, `ScanProgress`, `ScanResult`, `Alert`, `MachinePassportEvent`, `RepairVerification`, `ConnectionSession`, `ComputeStatus`. Unknown fields are ignored by readers; a reader refuses a major version it does not know and says so.

`DiagnosticFinding`: `id`, `severity` (`healthy | attention | critical`), `title`, `summary`, `evidenceType` (`measured | tested | inferred`), `evidence[]` (`name`, `value`, `unit?`), `recommendedAction`. Presentation layers render findings; they never invent warnings.

### 4.2 One rule layer, three evaluators (`packages/health-rules`)

Desktop conclusions already live in `server/src/hardware.ts` and `health.ts` and stay there. For local-first phone to QuickCheck sessions (no cloud) the rules must also run on the PC and be understood by the phone, so the portable subset is declared once in `rules.json` (rule id, input path, thresholds, severity, evidence type, copy). A small evaluator exists in TypeScript (reference), C# (QuickCheck) and Kotlin (phone, for its own hardware). A shared set of input/expected-output vectors is executed by all three, so they cannot drift. Rule ids deliberately reuse the server's existing codes (for example `storage.nvme_life_high`) so a finding means the same thing wherever it appears. For a PC that runs WorkCare Desktop, the phone shows the server's findings, not a re-evaluation.

### 4.3 Pairing and sessions (`packages/pairing-protocol`)

* A **session** is created by the PC side (QuickCheck or Desktop) with an ephemeral X25519 key pair, a random session id, an expiry (default 10 minutes) and a one-time secret.
* The **QR / session code** carries only: protocol version, session id, the PC's ephemeral public key, expiry, a short list of transport hints, and an HMAC over those fields. No passwords, no serials, no health data.
* The phone derives a shared key (X25519 + HKDF-SHA256), proves possession by returning an HMAC over the transcript, and both sides show a short authentication string for verification. All later messages are AEAD-protected (ChaCha20-Poly1305 or AES-GCM) under keys derived per session; a transport therefore does not need to be trusted.
* Sessions expire, are single use, and can be revoked. A session grants **inspection only**. **Permanent pairing** (managing the PC later) is a separate, explicit approval on the PC and, for WorkCare Desktop, an authenticated server-side link between the phone's signed-in account and the device.
* **Transports** are adapters under the session layer: LAN (mDNS + HTTP), phone hotspot, USB tethering (same LAN adapter on the tether interface), Internet relay (server-mediated, ciphertext only), Bluetooth (discovery/bootstrap only), QR / code bootstrap. Diagnostics never depend on which one carried the bytes.

### 4.4 Mobile API (`server/src/twin.ts`)

Authenticated with the existing org user JWT (MFA applies). Read endpoints map existing data to the contracts; **no generic command execution**. Explicit capabilities only, each authenticated, authorised by role, validated and audited: `GET_DEVICE_HEALTH`, `RUN_QUICK_SCAN`, `RUN_APPROVED_TEST`, `GET_ALERTS`, `GET_MACHINE_PASSPORT`, `GET_COMPUTE_STATUS`, `PAUSE_COMPUTE`, `RESUME_COMPUTE`, `RUN_APPROVED_MAINTENANCE_ACTION` (each maps to an already-existing signed job type; disruptive ones require an explicit confirmation flag). `RESUME_COMPUTE` can only resume a device whose organization policy already enables compute and whose consent is recorded; it never activates compute on a machine that is not already enabled, and the health gate still overrides.

### 4.5 Android app (`apps/mobile`)

Kotlin, Jetpack Compose, Material3 as a base only (components restyled to the WorkCare language), Navigation-Compose, single activity. Five destinations: Home, Devices, Check, Rescue, You. It reads real Android telemetry for "This phone" (BatteryManager, StatFs, ActivityManager, thermal status, network, security state) and shows "Not available on this device" where Android does not expose a value. There is no mining code and no compute library in the APK; a build check (like the server's `check-no-miner-in-image.mjs`) scans the APK contents for miner strings.

### 4.6 QuickCheck (`apps/quickcheck`)

Portable .NET executable, no installer, no service, no startup entry, no scheduled task, no persistence, no mining or compute code. Read-only by default. Runs fully offline for local inspection. Temporary session data lives in a per-run folder that is deleted on exit. It links only read-only collector sources from the agent (hardware inventory) and shares `packages/contracts` and `packages/health-rules` semantics.

## 5. Visual language (mobile)

Palette from the directive (`#080B0A`, `#0E1311`, `#151B18`, `#38E078`, `#F3F7F4`, `#97A39C`, hairline borders at 8% white), restrained green (health, readiness, connection, one primary action per screen), three states only (healthy, attention, critical), rows and grouped surfaces rather than a card per fact, strong numerals, no decorative illustration. Light mode is a designed palette, not an inversion. Design research is recorded in `docs/MOBILE_DESIGN_RESEARCH.md` with what could and could not be consulted.

## 6. Security and privacy rules (apply to every phase)

Ephemeral tokens, expiring and revocable sessions, encrypted channel, explicit device authorisation, no secrets in QR codes or logs, no plaintext credentials on the phone (Android Keystore-backed storage), refresh-token rotation when account features need it, local-first inspection, honest freshness labels ("Last checked 4 minutes ago"), no fabricated readings in production builds (any mock provider is isolated in a debug-only source set).

## 7. Build phases and honest status

| Phase | Scope | Status |
|---|---|---|
| 1 | Baseline, inspection, this document | Done |
| 2 | Android shell: theme, navigation, onboarding, Home/Devices/Check/Rescue/You | Built; see ROADMAP (verified on a real phone: launch, screens, real phone health) |
| 3 | Real phone telemetry | Built; read on a real phone; limited to what Android exposes, the rest says Not available |
| 4 | Pairing protocol and transports | Built; LAN carrier verified phone to PC over an adb tunnel; discovery, hotspot, USB-tether, QR, relay, Bluetooth not verified or not built |
| 5 | QuickCheck | Built, published, run on this PC, paired with the real phone, cleanup verified |
| 6 | Mobile with full Desktop through the same contracts | See ROADMAP |
| 7 | Rescue workflows | See ROADMAP |
| 8 | Passport and history | See ROADMAP |
| 9 | Authorised compute view/pause/resume | See ROADMAP |

The definition of done in the directive (real-device pairing with QuickCheck and Desktop, offline behaviour, Android 10-14 matrix, poor-network testing) cannot be claimed from emulator or unit-test evidence alone; ROADMAP states for each item whether it was verified on the attached phone, only in tests, or not at all.
