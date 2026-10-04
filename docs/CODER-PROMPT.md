# Viro WorkCare: full coder prompt (audit follow-up)

You are continuing a mature codebase in `C:\breach ar` (Fastify + Postgres Control server in `server/`, vanilla-JS web consoles in `server/public/`, Windows agent + compute worker in `agent/`, WiX MSI, scripts in `scripts/`, plus the Android/QuickCheck "mobile twin" in `packages/` and `apps/`). Production runs at https://control.viro3.online on Contabo (`ssh viro3`; deploy by tar-over-ssh then `bash deploy/contabo/install.sh`; never print `.env`). Read `docs/ROADMAP.md` (especially "UI/UX overhaul and organization administration"), `docs/ARCHITECTURE.md` and the memory notes before starting. Several sessions work in this tree in parallel: check `git status`, file times and ROADMAP before assuming something is missing, and never overwrite another session's uncommitted work.

## Ground rules (non-negotiable)
1. Real, verified behaviour only. No fake data, no placeholders presented as working features. If something cannot be verified, say so.
2. **Mining/compute sponsorship is parked, not deleted.** The code (agent compute worker, server compute routes, mining schema, consent record, session reporting, "pool unreachable" state) stays in place, consent-gated and dormant. Do not build on it, extend it, or re-enable it for any organization without the owner's explicit direction. Only bug-fix or keep it compiling. Never add antivirus evasion, hiding, persistence tricks, or anything that runs without an org's explicit policy — this applies to every feature.
3. Tests: add or update tests for every change. Run test files individually (the full server suite takes over 30 minutes; run it in the background with a long timeout, never concurrently with agent tests). Agent: `dotnet test` in `agent/`. Server: `npx tsx --test test/<file>.test.ts`, plus `npx tsc --noEmit`. `platform-ui.test.ts` requires `platform.html` to have exactly one plain `<script>`.
4. Work is staged, not committed, unless told otherwise. **A production deploy ships the whole working tree**, including other sessions' uncommitted work and their migrations. Before any deploy: list `git status`, list migrations that would run, and tell the owner. Release publishing happens only when asked.
5. Shell gotchas on this machine: use the Edit/Write tools for code; avoid sed/regex for multi-line edits; forward slashes in paths; PowerShell is case-insensitive.
6. Do not write secrets (platform key, passwords, tokens) into files or chat.
7. A hidden in-app browser pane throttles rendering and reports a 0x0 viewport: set a viewport with `resize_window` and verify visually, do not trust programmatic crawls of a hidden pane.

## Current state (verified 2026-10-03)
- Agent 0.1.11 live (release active at stage 100). Updater kills locked Viro processes, retries failed versions with backoff, updates the compute worker in the same package, and its swap task starts on battery. Anatomy is queued automatically on heartbeat. `DESKTOP-R81KPG5` is on 0.1.10+; `DESKTOP-TLEKML4` (0.1.3) and `ZAMCOPS-GM` (0.1.7) were offline and still need verifying.
- Production database has migrations through `029_twin.sql` (026 mining reporting, 027 account/MFA, 028 platform MFA, 029 twin) applied 2026-10-03 13:58 UTC.
- **Mining parked (2026-10-03):** `Viro Test Organization` is on the `standard` plan. Reasons: negligible yield on this fleet, and security products block pool traffic by category regardless of consent (only a per-organization, per-product manual exception clears it). The org console now hides the Compute page for any org not on `compute_sponsored` (`PLAN_ONLY` in `app.js`). See memory `viro-mining-parked.md`.
- **Org console (done):** grouped sidebar with search and icons, status strip, brand layer, light/dark, self-hosted Inter, `tokens.css` as the single token source, Team, Settings (country, UTC offset, alert contacts, MFA requirement), TOTP MFA with recovery codes, signed consent record, two inner-page passes.
- **Platform console (done):** rebuilt `platform.html` with grouped navigation: Overview, Organizations (detail), Devices, Commercial (plan, consent, measured compute hours, change plan; no amounts), Releases (stage advance, halt/resume, per-version devices and update events), Compute, Support log, Platform admins (MFA status/reset), My sign-in, Installer, Activity (filters, CSV), System health.
- Mobile twin (Android app, QuickCheck, WCP1 pairing, `server/src/twin*.ts`) exists and is additive; do not break it.
- No monetization is implemented: no billing, no subscription tiers, no plan enforcement beyond the `standard`/`compute_sponsored` flag, no payments integration.

## Workstream A: Commercial model (replaces mining as the economics plan)
Build a conventional subscription + services model on what exists (orgs, device counts, plans, anatomy/upgrade intelligence, remote support, the platform "Commercial" page).
1. **Plan and billing schema.** Replace the single `plan` enum with tiers (e.g. `free`, `standard`, `pro`, `district`), each with a device limit and feature set. Add a `billing` table: org, tier, device limit, price, cycle, status (trialing/active/past_due/canceled), renewal date. No real payment processor unless asked; manual/invoice billing first. Keep `compute_sponsored` working for the dormant feature.
2. **Feature gating by tier.** Write the tier table in `docs/ROADMAP.md` (suggested: Starter = health, alerts, Autopilot, basic remote support; Standard = + anatomy, upgrades, lifecycle, sites/departments; Pro/District = + audit export, SLAs, scale, priority support). Enforce server-side (device limits; gated routes return a clear "upgrade required", never a silent failure). The sidebar already hides plan-only pages via `PLAN_ONLY`: extend that mechanism.
3. **Upgrade/lifecycle brokering.** Referral link-outs on upgrade recommendations (`anatomy-engine.ts`, `upgrade/*.ts`): partner URL configured by the platform operator per region, click-through tracking for later commission reconciliation, no invented commission figures.
4. **Managed remote-support packages.** Sellable session bundles or a monthly retainer built on the existing support infrastructure; usage visible to the org admin.
5. **Platform billing view.** Extend the Commercial page: tier, device count vs limit, renewal date, status, manual invoice/mark-paid. Zero/empty states say so plainly.
6. Out of scope unless the owner asks: selling or sharing fleet telemetry with third parties, even anonymised.

## Workstream B: Update and install robustness
1. Confirm each PC reaches the latest release by itself. Add a server-side signal: a device that was offered an update but never started it after N hours raises an `agent.update_stuck` alert with the update log tail.
2. One-time bridge for `DESKTOP-TLEKML4` (0.1.3) when online: stop services, end Viro processes, copy the verified staged exe, clear its blocked list, restart; verify the new version and anatomy. Then confirm `ZAMCOPS-GM`.
3. Agent reports the update log tail in its update result so failures are diagnosable without a remote shell.
4. New-PC path end to end: fresh MSI + connection code yields anatomy and the latest version with no manual steps; add an E2E test or checklist script.
5. Split the server test suite into fast and slow groups so a full run fits in CI time.

## Workstream C: Organization admin: what is still open
Done: Team, Settings, MFA, consent, webhooks under Integrations. Open:
1. API keys (not built).
2. MFA QR code (the key is typed in); SSO; enforcing MFA for viewers.
3. E-mail delivery: invitations are "temporary password" only and alert contacts are recorded but nothing sends. Decide a provider with the owner before building.
4. Price book and update-ring defaults on the Settings page (the Prices page exists under Hardware; rings are set by the platform).
5. Plan and billing visibility for the org admin (tier, device count vs limit, renewal date, upgrade path) once Workstream A1 exists.
6. Verify TOTP against real authenticator apps (only RFC 6238 vectors are verified today).

## Workstream D: Platform (operator) console: what is still open
Done: see "Current state". Open:
1. Release **upload** from the console (today only the release script uploads).
2. Platform admin roles (all admins are equal today); a platform-level support policy.
3. System health: error rate and backup status currently show "not measured": measure them for real or remove them.
4. Revenue/billing: build on Workstream A (tiers, limits, renewal, invoices, a revenue ledger with no invented amounts).
5. Pool reconciliation shows "not connected": leave it dormant (mining is parked).

## Workstream E: UI/UX: what is still open
Done: tokens, Inter, icons, grouped navigation, light/dark, brand layer, two inner-page passes (see ROADMAP). Open:
1. **Voice: DECIDED (2026-10-03) = plain words.** Names, titles, "computers" wording and hero copy were changed in the organization console (see `docs/UI-VOICE-PROPOSAL.md`); remaining work is only to keep new copy in plain words, with one-line page purposes, and to check any screen not yet visually reviewed.
2. **Copy diet, measured.** Count words per screen before/after for the heaviest screens (Hardening, Autopilot, Upkeep, Anatomy, Upgrades, Lifecycle, Threats, Software, Drivers, Support, computer detail); the 40% target was never measured. Each concept explained once.
3. **Template on the remaining screens:** header (title, one-line purpose, primary action), summary tiles, main table/list, detail in a drawer; consistent empty/loading/error states with a next step.
4. **Windows-side app** (`agent/src/Viro.Agent/Care/ui/index.html`) was not restyled: bring it onto the same tokens and icons; its sidebar must scroll and never clip.
5. **Not re-verified:** the live remote-session screen (`#/session/<id>`), and any width other than 375 px and desktop. Verify visually with an explicit viewport (see rule 7), dark and light.
6. Accessibility: keyboard navigation and focus order for the new sidebar/search, WCAG AA contrast in both themes.
7. Do not break behaviour: view tests, `platform-ui.test.ts` and agent UI tests must pass.

## Order of work
1. B1 to B3 (finish the update/anatomy rollout; mostly done).
2. E1 (voice decision with the owner), then E2 to E3 (copy diet and template on remaining screens).
3. A1 to A2 (plan/billing schema and gating), then D4 and C5 (display it).
4. D1 to D3 (platform console gaps), C1 to C4 (org admin gaps).
5. A3 to A5 (upgrade brokering, support packages, platform billing flow).
6. E4 to E6 (Windows-side app, remaining verification, accessibility).

## Definition of done for each item
Code, tests passing, behaviour verified (local run and, where applicable, production after an approved deploy), docs/ROADMAP updated, and a short note listing what is verified versus unverified.
