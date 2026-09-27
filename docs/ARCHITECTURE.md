# BREACH AR — architecture

```
Assets/BREACH/
  Core/        Breach.Core      pure C# (noEngineReferences) — all game rules, unit-tested with dotnet
    Combat/      WeaponSpec, WeaponState (fire rate, mag/reserve, tactical vs empty reload, recoil, spread), Health, DamageInfo, HitZone
    Hunter/      HunterConfig (+ per-encounter scaling), IHunterSenses, HunterBrain (state machine + authoritative locomotion)
    World/       RigidPose, SharedOrigin (marker → shared frame), TacticalMapBuilder (planes → floor + cover/corner/furniture points),
                 SpawnPlanner (out-of-view, cover-preferring), PlayBoundary, ViewGeometry
    Match/       MatchState (scan → countdown → live → intermission → … → player down), MatchConfig, modes Hunt/Training
    Diagnostics/ DiagnosticsReport, FrameStats
  Runtime/     Breach.Runtime   Unity layer — builds the whole game from code at runtime
    Game/        BreachBootstrap (RuntimeInitializeOnLoad) → GameDirector (the one loop), Settings, BuildInfo
    AR/          ArRig (session/origin/camera/occlusion/planes/images/light), LightEstimator, RoomModel (plane → tactical map, LOS),
                 MarkerOrigin (runtime image library → SharedOrigin), SimulatedRoom (DEV ONLY stand-in room for editor/desktop)
    Combat/      RifleController (aim → shot → authority → damage → reaction → score), RifleViewModel, FireInput, ImpactEffects
    Hunter/      HunterActor (IHunterSenses over the real room, audio, ragdoll death), HunterBody (procedural rig), HunterAnimator (procedural)
    Presentation/ BreachMaterials, ProceduralTextures, MeshFactory, BreachAudio, Haptics
    UI/          Hud, Screens, DiagnosticsPanel, UiFactory/Palette
  Editor/      Breach.Editor    BuildScript (headless entry points), MaterialForge, Validation
  Resources/   Fonts (OFL), Audio (generated), Markers (generated)
Tools/
  CoreTests/   dotnet projects compiling Core exactly as Unity does (netstandard2.1, C# 9) + NUnit tests
  audio/       generate_sfx.py — synthesized, project-owned sound set
  marker/      generate_marker.py — origin marker + printable PDF
```

## Why the split
* **Core has no UnityEngine reference.** Every rule that decides the game — damage, reload timing, Hunter decisions, spawn choice, shared-origin maths — runs and is tested without Unity. It also means the Hunter brain can later run on a network host unchanged (Stage 3/4 authority).
* **Runtime builds everything in code.** The only scene is empty. No prefab, inspector field or scene edit is ever required, which is what makes a Unity-less, agent-driven workflow possible.

## Connection map (everything terminates in gameplay)
* AR planes → `RoomModel` → `TacticalMapBuilder` → floor height + tactical points → `SpawnPlanner` (where it enters) and `HunterBrain` (where it stalks/hides/retreats); vertical planes + furniture tops → physics colliders → line-of-sight (`PlayerCanSee`) and path checks (`IsPathClear`).
* Environment depth (`AROcclusionManager`) → real objects visually occlude the Hunter.
* Light estimation → the directional light and ambient SH that light the Hunter and rifle.
* Touch → `FireInput` → `RifleController` → `WeaponState` → raycast → `HunterHitbox` zone → `HunterActor.ReceiveHit` → `HunterBrain.ApplyHit` → flinch/stagger/ragdoll → `MatchState.HunterKilled` → score + next encounter.
* `HunterBrain.AttackStruck` → `GameDirector` → player `Health` → HUD damage direction + haptics → `MatchState.PlayerKilled` → after-action.
* Marker → `MarkerOrigin` → `SharedOrigin` (locked; single-player falls back to the start pose). Ready for Stage 3 replication in shared coordinates.

## Stage 3/4 — shared world + co-op (first cut, uncompiled)
* **Transport:** Netcode for GameObjects 2.11.2 (version pinned by Unity's 6.3 sample manifest) + Unity Transport 2.6.0, used only as a **named-message pipe**. There are no NetworkObjects and no prefabs, because the world is built in code. `Runtime/Net/CoopSession.cs` creates the NetworkManager at runtime.
* **Joining:** LAN, port 7788. The host shows the last two octets of its Wi-Fi IP as a room code (`Core/Net/RoomCode.cs`); the joiner types it on a keypad.
* **Shared space:** every position and rotation on the wire is in marker space (`Core/Net/NetProtocol.cs`), converted with each device's `SharedOrigin`. Marker lock is mandatory in co-op. On simulated/desktop rooms the origin is identity.
* **Authority:** the host runs `HunterBrain` against all players. `HunterActor.TargetProvider` feeds it every player's eye and forward vector; the Hunter picks the nearest living player (with hysteresis) and hides from *all* of them.
* **Replication:** clients render a **puppet** Hunter from 20 Hz snapshots, interpolated 120 ms behind (`SnapshotBuffer`) and snapped to the client's own floor.
* **Hits:** a client resolves its own hit on the puppet (so aiming feels immediate) and sends a `ShotClaim`. The host validates it (`ClaimValidator`: right spawn, near where the Hunter recently was, fire-rate limit, one-round damage cap), applies it, then broadcasts the hit or kill.
* **Damage to players:** host strikes are routed to the targeted client. A downed player is revived when the team kills the Hunter; the match ends when everyone is down.
* **Messages:** `breach.pose` (20 Hz, unreliable, relayed by the host), `breach.hunter` (20 Hz, unreliable), `breach.match` (4 Hz and on phase change, reliable), `breach.roster` (2 Hz), `breach.event` (reliable).

## Next
* **Stage 5 — PvP:** avatar pose in shared space (already replicated), fire requests validated on the host, first-to-five.
