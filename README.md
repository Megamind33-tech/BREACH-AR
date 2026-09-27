# BREACH AR

Grounded, tactical augmented-reality combat for Android. **Reality is the map**: the room you are standing in is scanned into floor, walls, corners and furniture, and THE HUNTER uses that geometry to stalk, hide, flank, rush and retreat.

Current milestone: **HUNTER PROTOTYPE** (Stage 0 FORGE + Stage 1 FIRST KILL + the core of Stage 2 INVASION).

## Status — honest labels

| Area | State | Label |
|---|---|---|
| Donor audit + licence classification | 4 donors audited, all donor assets rejected, no donor code copied | VERIFIED (`docs/DONOR_AUDIT.md`) |
| Core rules (rifle, health, Hunter AI, spawn, tactical map, shared origin, match flow, diagnostics) | 43 NUnit tests pass | VERIFIED (`dotnet test`, this repo) |
| Core compiles as Unity sees it (netstandard2.1, C# 9, warnings-as-errors) | builds clean | VERIFIED |
| Unity-side code (AR rig, Hunter body/animation/ragdoll, rifle, HUD, menus, diagnostics) | written against AR Foundation 6.3.5 / Input System 1.19.0 sources; APIs checked by hand | UNKNOWN until first Unity compile in CI |
| Headless Android build pipeline | workflow + build script + validation ready | BLOCKED on a Unity license secret (`docs/BUILD.md`) |
| AR on a phone (tracking, planes, occlusion, light, scale, feel) | — | DEVICE TEST REQUIRED |
| Desktop/editor preview | simulated room for development only | SIMULATED |
| Shared world / co-op / PvP | designed (`docs/ARCHITECTURE.md`), marker + shared-origin maths done and tested | NOT BUILT (Stage 3+) |

## The loop
Menu → safety check → room scan → countdown → the Hunter enters **out of view** (behind real cover when it can) → it stalks unseen (and fast), reacts when watched, rushes, winds up, strikes, retreats; you aim, fire, reload, hit (head/body/limb), stagger it, kill it (physics ragdoll) → score → the next, bolder encounter. Die → after-action → **AGAIN** in one tap.

## What's in the box
* One rifle (BR-16, hitscan): 690 RPM, 30+120, tactical/empty reloads, recoil climb and spread shown by a rising crosshair, small muzzle flash with a brief light, synthesized shot/tail/mechanical audio, haptics.
* One enemy (THE HUNTER): procedural gaunt biomechanical humanoid, two-bone-IK gait, head tracking and unnatural twitches, wind-up + swipe, spring flinch per hit, stagger on burst damage, ragdoll death, contact shadow, 3D positional growls/footsteps.
* Real-room use: floor/wall/furniture planes → cover, corner and furniture points; line of sight through real walls; environment-depth occlusion; ARCore light estimation.
* Minimal HUD: score | timer, crosshair, ammo, health, hit marker, damage direction, contact chevron, boundary warning. No bars over enemies, no damage numbers, no glowing outlines, no giant buttons.
* Safety: safe-area confirmation, play boundary with warnings.
* Hidden diagnostics with **EXPORT TEST REPORT** (share sheet + clipboard).

## Get the APK / test it
See `docs/TESTER_GUIDE.md`. Build pipeline: `docs/BUILD.md`. Architecture: `docs/ARCHITECTURE.md`. Assets and rights: `ASSET_REGISTRY.md`.
