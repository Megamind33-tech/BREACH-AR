# What the audit checks, what is free, what is Plus, and what keeps people coming back

The rules every part of this follows:

1. **Never lie.** A finding is shown only if something measured it. A check that could not run is listed as "not measured", with the reason. A check that was not run because of the plan is listed by name and described, and the screen says plainly that nothing is known about it. No invented scores, no predicted failures, no teaser "you have problems" without a result.
2. **Never hide a safety problem behind a price.** Anything the essential checks find (failing drive, no screen lock, no encryption on a phone, Defender off, dead battery) is shown free. Plus adds *more checks* and *more history*, not the right to know about a danger the free scan already found.
3. **Evidence labels stay honest.** MEASURED (read from the device), TESTED (a person confirmed a hardware test), INFERRED (derived: Windows support dates, rooted-phone signs, storage forecast).

## Essentials (free)
- **Phone:** battery condition and heat, storage, memory pressure, thermal state, screen lock, storage encryption, security-patch age.
- **Computer (QuickCheck):** drive health and wear (SMART/NVMe), drive space, battery wear, memory, processor heat and throttling, Defender and firewall, Windows summary.
- **Rescue** (symptom to evidence), a daily check, 7 days of history.

## Deep audit (WorkCare Plus), all implemented and tested
**Phone (9):** accessibility services, notification access, device administrators, user-installed certificates, proxy, USB debugging and developer mode, system integrity (root/test-build signs), outside-store apps with sensitive access, and a count of apps holding camera / microphone / location / messages / contacts / call history. Code: `phone/PhoneDeep.kt`; tests: `DeepAuditTests.kt`.
**Computer (about 20 rules in 8 groups):** drive encryption, Secure Boot, TPM, update age and pending restart, Windows support status, Defender definition age and last scan, UAC / SMBv1 / Remote Desktop / automatic sign-in / Guest account, 30-day blue screens / unexpected shutdowns / disk errors / program crashes, Wi-Fi security, start-up programs. Code: `apps/quickcheck/src/DeepInspection.cs`; rules: `server/src/twin/rules.ts` (tier `deep`), checked identically by the TypeScript, C# and Kotlin evaluators against `packages/health-rules/vectors.json`.
- Not readable without administrator rights (reported as not measured, never guessed): BitLocker status on most PCs and the TPM. Run QuickCheck as administrator to read them.
- Wi-Fi security is read only on English Windows.

## After a free scan
The result screen lists the deep checks that did not run, by name and with what they look at, under "Deep audit - WorkCare Plus", with a statement that nothing is known about them. There is no "N problems found, pay to see" anywhere.

## Habit (all real, none manufactured)
- **Today card:** what changed since the last reading (new and resolved findings, free storage change), a streak of days with a reading, and the daily check switch.
- **Daily check:** reads the phone around 08:30 and stores the reading. It notifies **only** when something new needs you; otherwise it is silent. Notification permission is requested when the person turns it on; without it the check still runs.
- **Trends:** free storage, battery temperature, security-patch age and findings per day, as charts of real daily readings. 7 days free, 90 with Plus.
- **Storage forecast (Plus):** a straight-line estimate, labelled INFERRED, shown only with at least seven days spanning a week and a steady decline.

## What is NOT built (be clear before launch)
- **Payment.** There is no store checkout. Plus is on for signed-in WorkCare organization accounts, and a debug build has a testing switch. To sell Plus to individuals: a Google Play product, the Play Billing library, and server-side receipt verification so entitlement cannot be forged by editing the app (today it is checked on the phone, and QuickCheck trusts the phone's request for a deep scan).
- Deep audit of a computer through the full WorkCare Desktop agent (only QuickCheck runs it).
- Background deep audit on the phone (the daily check includes deep findings for Plus accounts but this was not exercised on a device).
- Weekly digest, fix-list tracking.
