# Handoff: Workstream A (mining reporting and proof), remaining wiring

You are continuing Viro WorkCare in `C:\breach ar`. Work in this checkout. Do not create a new git worktree. Read `docs/ROADMAP.md`, `docs/ARCHITECTURE.md` and the memory notes first. The ground rules from the audit follow-up prompt still apply: consent-based only, real verified behaviour, tests for every change, stage but do not commit, no deploys unless asked, and no secrets in files or chat.

## Already done (staged, tested: `npx tsx --test test/mining-reporting.test.ts` passes 5/5, `npx tsc --noEmit` is clean)
- `server/migrations/026_mining_reporting.sql` adds:
  - on `mining_sessions`: `client_session_id` (unique per device), `engine_version`, `agent_version`, `last_report_at` and `closed_by` ('worker' | 'server');
  - on `mining_telemetry`: `session_id`, `accepted_delta` and `rejected_delta`;
  - on `mining_audit_log`: `actor_type`, `actor_label` and `reasons text[]`.
- `server/src/mining-reporting.ts` (nothing calls it yet):
  - `SessionReport` (zod schema) and `recordSession(db, {id, orgId}, report)`. It is idempotent by sessionId and rejects start times in the future or more than 8 days old. Runtime is capped at wall-clock time, share counts only go up, a worker stop is final, and an optional `sample` writes one telemetry row with share deltas. It returns 409 when the device has no `mining_devices` row.
  - `closeSilentSessions(db, 15)`: the server closes sessions that have gone silent. A later worker report can still correct them.
  - `rollupMiningTelemetry(db, 3)`: builds hourly rows from completed hours (idempotent), then deletes raw samples older than 3 days.
  - `miningTick(db)`: runs both of the above.
  - `miningAudit(db, entry)`: `high_risk` is set exactly when `reasons` is non-empty.
  - `classifyPolicyChange(prev, next)`: returns the action (create, enable, disable or update) and the high-risk reasons.

## To do
1. **Server: `server/src/compute.ts`**
   - Add `POST /agent/v1/compute/session` (`requireDevice`) that parses `SessionReport` and calls `recordSession`. Return its status and error on failure.
   - In `PUT /api/v1/compute/policy`, call `miningAudit` with `classifyPolicyChange(prev, settings)`. Use actorType 'user', actorId = user id, and record previous and next.
   - In `DELETE /api/v1/compute/policy/:id`, return the settings and write a `policy.delete` entry.
   - In `PATCH /api/v1/platform/organizations/:id/plan`, read the previous plan first and write `plan.change` with actorType 'platform'. It is high-risk when the new plan is `compute_sponsored`.
   - In `GET /agent/v1/compute/policy`, write `device.enable` / `device.disable` (actorType 'system', with the agent version from `compute_state.worker_version`) when `mining_devices.enabled` actually changes.
   - Add admin read routes for viewer/admin roles: recent sessions with totals, hourly telemetry, and the mining audit log. Scope everything to `req.user.org`.
2. **Server: `platform.ts`**: when an organization is created with the `compute_sponsored` plan, write a `plan.change` audit entry.
3. **Server: `index.ts`**: run `miningTick(db)` every 10 minutes, following the existing `setInterval(...).unref()` pattern.
4. **Worker: `agent/src/Viro.Compute`**
   - Add a small, testable session tracker. It assigns a new GUID when the XMRig workload starts, takes samples of hashrate and accepted/rejected shares, and records average and peak hashrate.
   - Extend parsing of XMRig's local `/2/summary` (it already reads the hashrate) to read `connection.accepted`, `connection.rejected`, pool uptime (as "connected") and the last share time.
   - Send a report on start, every 60 s while running (with a sample), and on stop, with the stop reason: the policy engine's reason, "engine exited", or "worker shutting down".
   - Save an unsent stop report to disk and retry it.
   - Only report for the `xmrig` fallback, never for `selftest`.
5. **Console**: show sessions and the mining audit on the Compute page. Change the stale "Mining engine (not connected yet)" option label.
6. **Tests**
   - Server: route tests that send explicit JSON `null` for every optional field (zod `.nullish()`), plus cross-org isolation and audit rows written for each hook.
   - Agent: tracker and summary-parsing tests in `agent/tests`.
   - Run test files individually, and never run server and agent tests at the same time.
7. Update `docs/ROADMAP.md` honestly. Zero real sessions have run so far, because both devices are blocked by the health gate.

## Out of scope / do not
- Do not weaken the health gate. No per-device override exists today, so if one is needed, it must be explicit, per device, audited in `mining_audit_log` and high-risk.
- Do not add any hiding, renaming, persistence or antivirus-exclusion behaviour. Mining runs only for orgs on `compute_sponsored` with a signed policy.
