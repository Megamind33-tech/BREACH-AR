# Organization console: voice and naming (DECIDED: Option A, plain words, 2026-10-03)

**Status:** Option A was chosen and applied locally (page names, group names, page titles, "endpoint" to "computer" across the console, hero copy, search aliases for the old names). Not yet deployed to production: the owner reviews it first.


**Question:** keep the operational ("security console") voice, or return to plain words for school IT staff?

You originally asked for simple, readable, user-friendly screens. A later pass renamed pages to operations jargon and "computers" to "endpoints". The operator (platform) console is already in plain words (Overview, Organizations, Devices, Releases, Support, Activity); only the organization console uses the jargon.

## Option A: plain words (recommended)
The original names still exist in the code (`NAV` in `server/public/app.js`), so the page-name change is one table edit. The "endpoint" wording is the larger job: about 165 occurrences across `app.js` and the `views-*.js` files.

| Now | Proposed | Why |
|---|---|---|
| Command (group and page) | Home / Overview | "Command" says nothing to a school administrator |
| Endpoints (group) / Endpoints (page) | Computers | the word the whole product and installer already use |
| Fleet intel | Shared problems | says what it shows: faults that hit many computers |
| Defense (group) / Defense (page) | Security | |
| Hardening | Protection | the original page name |
| Incidents | Threats | the original page name |
| Upkeep | Care | the original page name |
| Hardware (group and page) | Hardware (keep) | already plain |
| Operations (group) | Maintenance | |
| Task log | Jobs | the original page name |
| Patches | Updates | |
| Remote ops | Remote support | |
| Audit trail | Audit log | |
| Enroll endpoints (button) | Add computers | |
| "Attention required" | Needs attention | |
| "Awaiting first telemetry." (hero) | Waiting for first reports. | "telemetry" is jargon |
| "LAST SWEEP 25S AGO" (status strip) | Last check 25 s ago | |

Also fix the contradictory hero on a new organization: it reads "Awaiting first telemetry" next to "4 reporting". Proposed: headline "Waiting for first health reports." with the detail "4 computers connected."

Keep the monospace status strip, the dark emerald look and the section rhythm: they are visual style, not wording.

## Option B: keep the operational voice
No change. Cost: staff who are not security specialists meet words like Hardening, Incidents and Defense without explanation. If chosen, add a one-line purpose under every page title so the names are never the only explanation.

## Option C: both
Plain names by default, with the operational names offered as an alternate "voice" setting per user. More work; only worth it if you expect security-minded customers.

## What I would do next if you pick A
1. Change the labels table and group names in `app.js` (and the "Find a page" search keywords so old and new names both match).
2. Replace "endpoint" with "computer" across the views, reading each sentence so singular/plural and phrasing stay correct.
3. Rewrite the hero strings above.
4. Update `ui.test.ts` where it asserts labels, run it, then verify visually in both themes at desktop and phone width.
5. Deploy only after you have seen it.
