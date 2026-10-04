# Viro WorkCare: product plan v2 (written 2026-10-03)

Goal: be the PC-care product people pay for because it is **honest, verified and reversible**, where CCleaner and the Microsoft PC Manager style cleaners are broad, cosmetic and unverified.

## What was built in this pass (all local, nothing deployed or released)

| Area | What exists now | Where |
|---|---|---|
| Program sizes | Every installed program with its size (registered size, else measured from its folder), largest first, search, hidden filter. Windows app page **Installed programs**; console computer page lists size and hidden programs. | `agent/.../Care/AppUninstall.cs`, `ui/index.html`, `server/public/app.js` |
| Uninstall | Runs the program's own uninstaller (Windows Installer, Store, or the registered quiet uninstall command), then **scans again** to prove it is gone. Local app and remote from the console (`repair.run` recipe `app.uninstall`, administrator only, approval required). | `AppUninstallRecipe` |
| Hidden / failing programs | Hidden entries (system-component, child-of-another-program) are shown under a filter. **Forced removal** when the uninstaller is missing or fails: registration is exported to a `.reg` file, the program folder is *moved aside, not deleted*, the registration is removed, and the whole thing can be undone. | same |
| Safety rails | Refuses Viro itself, Microsoft runtimes (Visual C++, .NET, WebView2, Edge, Windows components), and any folder that is a drive root, Windows, WindowsApps or the Program Files root itself. | `AppGuard` |
| Machine history | One timeline and fact sheet per computer: Windows upgrades (exact, from Windows' own `Source OS` records), current install date, memory / drive / other part changes Viro has seen, drive power-on hours, power cycles, unsafe power-offs, write wear, battery cycles and wear, firmware date, confirmed service events. Every line is labelled *measured*, *observed* or *recorded*, and a "what this cannot tell you" list is always shown. | `server/src/machine-history.ts`, `/api/v1/devices/:id/history` |
| Viro certificate | Seller asks for a certificate for a named buyer. Viro takes a **fresh** reading (a reading older than the request is refused), signs the statement with Viro's own key (ECDSA P-256), and emails it **only to the buyer**. The seller is shown a masked address and never receives the code. A public page (`/verify/<code>`) and API verify the signature, status (valid / expired / withdrawn / does not verify) and let the buyer enter the serial number of the machine in front of them to prove the paper belongs to that machine. The full serial is never published (last four digits plus a salted hash). Valid 30 days; can be withdrawn. | `server/src/certificate.ts`, `mailer.ts`, migration `030` |

Tests: agent `AppUninstallTests` (7), server `certificate.test.ts` (4) cover the happy path, forced removal and undo, protected programs, tampering (an edited statement stops verifying), the "old reading is not enough" rule, and that the seller can never read the code back.

## Owner decisions and set-up needed before the certificate can go live

1. **Email delivery.** Production needs `SMTP_URL` (e.g. `smtps://user:password@mail.viro3.online`) and `MAIL_FROM` set on the server. Without them the certificate request returns a plain "email is not set up" error; nothing is faked. Create a dedicated sender such as `certificates@viro3.online` with SPF, DKIM and DMARC so buyers' mail providers trust it. This is what makes "only from Viro's email" true.
2. **Signing key.** Production needs `CERT_SIGNING_KEY` (PKCS8 PEM, separate from `JOB_SIGNING_KEY`). Keep a sealed offline backup: losing it means old certificates can no longer verify. `GET /api/v1/public/certificate-key` publishes the public half.
3. **Wording and liability.** The certificate states what was measured and says it is not a warranty. Have counsel review the notice text, the 30-day validity, and what data is shown to a buyer (make/model, last four serial digits, history facts). Decide whether serial last-four is acceptable in each target market.
4. **Who may request one.** Today: an administrator of the organisation that manages the computer. A standalone consumer PC (not connected to any workspace) cannot request one, because there is no server record to sign from. A "personal workspace" sign-up is the natural way to open this up; it needs a decision on accounts and pricing.
5. **Verify domain.** `https://control.viro3.online/verify/...` works today. A short public domain (for example `viro3.online/verify`) needs nginx and DNS (needs sudo on the server).

## Why people would pay: gaps found in the research, ranked

Research notes: Revo Uninstaller's forced uninstall and leftover scan (our forced removal matches the idea but adds undo); HP's proposed used-PC "health report" shows buyers want this; registry cleaners are widely criticised (Microsoft does not support them, no measurable benefit, CCleaner is accused of being too aggressive). Our edge is *proof, undo, honesty, fleet management, and hardware lifetime*, not "clean more".

### Build next (highest value first)
1. **Fix, then prove it** everywhere. The pipeline already does diagnose → change → verify → roll back. Surface it as one visible loop: after any recommendation is applied, Viro re-measures and shows a before/after (free space, start-up time, memory, health score) in *What Viro did* and the Overview, and re-opens the problem if it came back. Today this is shown per repair; make it the headline.
2. **Leftover scan after uninstall** (files, registry keys, scheduled tasks), shown for approval and quarantined with undo, the way Revo does it but reversible.
3. **Secure wipe with an erasure certificate** for resale (NIST 800-88 style, with verification). Pairs naturally with the buyer certificate: sellers wipe, then certify.
4. **Drive and battery health with plain advice**: SMART/NVMe wear, reallocated sectors, battery capacity and cycles, with "back up now" and "replace soon" states. The data is already collected for the certificate.
5. **Windows readiness**: Windows 11 compatibility, support-end dates, activation status, BIOS/firmware and driver freshness, pending reboot. (Support-end and Windows 11 data already exist in anatomy for the console; bring it into the Windows app.)
6. **Backup health**: is there a recent backup of Documents/Desktop (OneDrive, File History, or Windows Backup)? One of the few features people feel in their wallet.
7. **Scheduled, verified maintenance** with a weekly summary email: "Viro fixed 3 things, measured gains, nothing needed your attention."
8. **Duplicate and large-file finder** (read-only first, move to Recycle Bin only), because free-space is the number one reason people open cleaners.
9. **Privacy cleaner done safely**: browser caches and trackers, with a visible preview and undo; never touches passwords or saved sessions.
10. **Windows app: machine history page** (the data is in the console today; the Windows app only shows local views). Needs a decision on whether a standalone PC should send its reading to Viro.

### Deliberately not building
- A registry cleaner. No measurable benefit, real risk, and a bad reputation. We will say so on the site.
- Anything that disables antivirus or evades security software.
- Fake "your PC is at risk" scare scores. Scores stay evidence-based.

## Honesty rules the certificate follows (do not weaken)
- A clean reinstall erases Windows' own records, so the reinstall count is **a minimum**, and the certificate says so.
- Part-change history only starts when Viro first saw the computer.
- Drive counters belong to the drive, not the computer.
- Nothing is inferred silently: each line is *measured*, *observed* or *recorded*.
- Unknowns are listed, never filled in.

## Release checklist for the Windows app (not done yet)
Version bump, `scripts/Build-Installer.ps1`, publish release, click through the real window on a PC with a few old programs (including one with a broken uninstaller) to try forced removal and undo for real. The uninstall paths were tested with fakes; **a live uninstall of a real program has not been run yet.**
