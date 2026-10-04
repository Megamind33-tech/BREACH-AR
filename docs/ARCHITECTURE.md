# Architecture

```
                         Viro Control (Node 24 / Fastify / PostgreSQL)
        admin console (HTML/JS)   agent API      support relay (WebSocket)   scheduler, sweepers, rollout engine
                    │                  │                    │
                    └──────── HTTPS (TLS, Caddy) ───────────┘
                                       │
   ┌───────────────────────────────────┴────────────────────────────────────┐
   │ Windows PC                                                              │
   │  viro-agent.exe  (service "ViroAgent", LocalSystem)                     │
   │    heartbeat · inventory · health · hardware · signed jobs · self-update│
   │    support sessions (terminal, files) · integrity report                │
   │        │ pipe (ACL: SYSTEM + user)                                      │
   │        ├── desktop helper (in the user's session): screen + input       │
   │  viro-compute.exe (service "ViroCompute", LocalSystem)  — SEPARATE      │
   │    policy engine · Job Object caps · user-activity probe · telemetry    │
   └─────────────────────────────────────────────────────────────────────────┘
```

## Components and boundaries

* **`server/`** (TypeScript). Stateless except PostgreSQL and the release folder. Every tenant table carries `org_id`; the organization comes only from the verified token (admins) or the authenticated device (agents), never from request input.
* **`agent/src/Viro.Agent`** (.NET 10). The WorkCare agent: telemetry, jobs, repair, security, patching, remote support, update, integrity.
* **`agent/src/Viro.Compute`** (.NET 10). The Compute Worker, deliberately a **separate executable and service**. It shares only the device identity and a "busy" coordination lease with the agent. It never contains, downloads or launches anything from the WorkCare agent, and vice versa.
* **`agent/installer`, `scripts/`**. WiX MSI, build/sign/release scripts, end-to-end test script.

## Key design decisions

1. **Jobs, not remote shells.** Every administrative action is a signed, typed, audited job executed by a compiled-in handler. Interactive access exists only as explicit remote-support sessions.
2. **Server-side interpretation.** Agents report facts; Control scores and diagnoses them, so rules and thresholds change without redeploying agents. Unreadable data is `null` and shown as "not measured", never guessed.
3. **Every repair is a pipeline:** diagnose first; record state; smallest change; verify; roll back on failed verification; report each step.
4. **Priority order is code, not policy:** user → security → health → maintenance → paid compute → internal compute → fallback. The compute worker yields through signals (user activity, a busy lease held by the agent, maintenance processes, battery, temperature, memory) and OS-enforced limits.
5. **Safe by construction.** Personal data is not a cleanup category; the file-transfer policy blocks the agent's own credential store; commercial status cannot reach a device.
6. **Testability.** System-touching code sits behind small interfaces (process runner, service manager, Windows Update agent, registry slots, notifier, message channel) so logic is verified with fakes and sandboxes, and the risky pieces (screen capture, NVMe SMART, PowerShell, Job Objects) are additionally verified against the real machine.

## Data flow highlights

* **Enrollment:** token → device row + secret → agent pins Control's public key.
* **Heartbeat (30 s):** metrics; response carries signed jobs, cancel requests, an update offer, waiting support sessions and a polling hint.
* **Health (30 min):** raw snapshot → scored on read (Control) → alerts, policy reactions.
* **Update:** heartbeat offer → verify → stage → swap script → confirm or roll back → outcome reported → auto-halt if failing.
* **Compute:** worker fetches its signed policy (verified against the pinned key), decides every 2 s, reports state and compute time every 30 s.
