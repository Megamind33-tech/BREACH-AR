# Donor audit — BREACH FORGE PROCESS

Audited 2026-09-27 from shallow clones of each repository's default branch.
Classification rule: **code and assets are judged separately**; anything with unclear rights is REFERENCE ONLY.

## Summary

| Donor | Code license | Code verdict | Asset verdict | Last commit | Engine / AR stack |
|---|---|---|---|---|---|
| Unity-Technologies/arfoundation-samples | Unity Companion License | **APPROVED FOR CODE REUSE** (Unity-dependent projects) | Settings/URP/XR assets **APPROVED**; sample meshes/textures not used | 2026-04-10 (`main`), branch `6.3` used | Unity 6000.3.1f1, AR Foundation 6.3.5, ARCore 6.3.5, URP 17.3.0 |
| AnimaRain/ShootAR | MIT (© 2018 John "Rain" Spyropoulos) | APPROVED FOR CODE REUSE — used as **pattern reference only**, nothing copied | **REFERENCE ONLY** — enemy models are Unity Asset Store packages ("Low Poly Combat Drone", "Aaron's Assets"); Asset Store EULA does not permit redistribution in an open repo | 2020-11-15 | Unity 2019.2.14f1; **not AR Foundation** — gyroscope + `WebCamTexture` fake-AR |
| nikhilverma360/AR-Multiplayer-Online-Beyblade-Battle-Arena | MIT (© 2020 nikhilverma360) | APPROVED FOR CODE REUSE — used as **concept reference only** | **REFERENCE ONLY** — bundles Photon PUN 2 (Exit Games proprietary SDK/licence, needs AppId), Joystick Pack (Asset Store), Beyblade-style models of unclear origin | 2021-07-29 | Unity 2020.1.3f1, AR Foundation 3.1.5 (obsolete), Photon PUN 2 |
| alphayama/base-blitz | MIT (© 2023 Ashish Pratap) | APPROVED FOR CODE REUSE — used as **pattern reference only** | **REFERENCE ONLY** — 11 Asset Store packages (APC, turret, radar, buildings, explosions, rocket launcher…) and Freesound clips with mixed/unstated CC terms (`Source.md`) | 2024-11-21 | Unity 2021.3.16f1, AR Foundation 4.2.7 |

## What was extracted, and how

### arfoundation-samples → AR foundation (technology authority)
* **Extracted as-is** (config, not code): `ProjectSettings/*`, the XR Management + ARCore loader assets (`Assets/XR`), and the URP pipeline asset with `ARBackgroundRendererFeature` and `ARCommandBufferSupportRendererFeature` on its renderer. These are the fiddly editor-GUI pieces — having them from a Unity-verified project is what makes a headless build possible.
* **Ported**: the AR rig composition (ARSession + ARInputManager; XROrigin + camera offset; ARCameraManager, ARCameraBackground, AROcclusionManager, TrackedPoseDriver bound to `<HandheldARInputDevice>`/`<XRHMD>`; ARPlaneManager, ARRaycastManager, ARTrackedImageManager) re-expressed as code in `ArRig.cs`; light-estimation application (`LightEstimator.cs`, after the samples' BasicLightEstimation); runtime mutable image library usage (`MarkerOrigin.cs`).
* **Pinned versions** come from the samples' `6.3` branch `Packages/manifest.json` — not guessed.

### ShootAR → shooting loop patterns
* Fire-rate gate + ammo check before spawning a shot (`Player.Shoot`) → `WeaponState.TryFire` (hitscan, recoil, spread, magazine + reserve, tactical vs empty reload added).
* Damage cooldown / armour absorb (`Player.GetDamaged`) → `Health.InvulnerabilitySeconds`, plus delayed regeneration.
* `GameState` events (round start / won / game over) + `ScoreManager` → `MatchState` phases and score.
* Discarded: projectile bullets, capsule pickups, cartoon enemies, gyroscope fake-AR, menu art.

### Beyblade AR → shared-world concept
* Positions are serialised **relative to the arena transform** (`rb.position - battleArena.position`) so peers agree → `SharedOrigin` expresses every pose relative to a marker-defined, gravity-aligned origin (yaw only), averaged over 30 samples with jump rejection. Tested with two simulated devices (`SharedOriginTests`).
* Interpolation with teleport threshold (`MySynchronizationScript`) — noted for Stage 3 replication.
* Discarded: Photon PUN 2 (proprietary, account-bound; Stage 3 will use Unity Netcode for GameObjects 2.11.2, which the samples' 6.3 manifest pins), joystick controls, spinning-top gameplay/terminology.

### base-blitz → camera-centre hitscan & physical play
* Viewport-centre raycast shooting (`rayCast.cs`) → `RifleController` raycasts from the camera centre with recoil offsets, resolving through `HunterHitbox` zones instead of destroying whatever it hits.
* Physical movement as input → kept; BREACH has no virtual joystick at all.
* Discarded: laser `LineRenderer`, military-toy art, tank/drone enemies, health bars above enemies.

## Result
BREACH contains **no donor source files and no donor assets**. It builds without any donor repository present. Attribution for the Unity-derived configuration is in `ThirdPartyLicenses/UNITY_COMPANION_LICENSE_NOTICE.md`.
