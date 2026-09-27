using System.Collections;
using Breach.AR;
using Breach.Combat;
using Breach.Core.Combat;
using Breach.Core.Diagnostics;
using Breach.Core.Hunter;
using Breach.Core.Match;
using Breach.Core.World;
using Breach.Hunter;
using Breach.Presentation;
using Breach.UI;
using Breach.Util;
using UnityEngine;
using UnityEngine.XR.ARFoundation;

namespace Breach.Game
{
    /// <summary>
    /// Owns the single playable loop:
    /// menu → safety → room scan → countdown → Hunter encounter → kill → next
    /// encounter … → player down → after-action → again.
    /// Every system terminates here in gameplay.
    /// </summary>
    public sealed class GameDirector : MonoBehaviour
    {
        const float MinFloorArea = 1.0f;

        ArRig _rig;
        SimulatedRoom _simRoom;
        RoomModel _room;
        MarkerOrigin _marker;
        ImpactEffects _fx;
        Hud _hud;
        Screens _screens;
        DiagnosticsPanel _diag;
        FireInput _input;
        RifleController _rifle;
        HunterActor _hunter;
        readonly SpawnPlanner _planner = new SpawnPlanner(seed: System.Environment.TickCount);
        MatchState _match;
        Health _player;
        PlayBoundary _boundary;
        readonly FrameStats _frames = new FrameStats(600);
        MatchMode _mode;
        bool _paused;
        bool _safetyConfirmed;
        float _scanStarted;
        float _boundaryWarnCooldown;
        double _lastHunterSpawn;
        BoundaryStatus _lastBoundary;

        public static GameDirector Create()
        {
            var go = new GameObject("BREACH");
            DontDestroyOnLoad(go);
            return go.AddComponent<GameDirector>();
        }

        IEnumerator Start()
        {
            Application.targetFrameRate = 60;
            QualitySettings.vSyncCount = 0;
            Screen.sleepTimeout = SleepTimeout.NeverSleep;
            Physics.queriesHitBackfaces = true; // AR planes are single-sided meshes; walls must block both ways
            Physics.IgnoreLayerCollision(Layers.ViewModel, Layers.HunterRagdoll, true);

            BreachAudio.Create(transform).MasterVolume = Settings.Volume;
            Haptics.Enabled = Settings.Haptics;
            UiFactory.EnsureEventSystem(transform);

            bool simulated = true;
#if UNITY_ANDROID && !UNITY_EDITOR
            simulated = false;
#endif
            if (!simulated)
            {
                yield return ARSession.CheckAvailability();
                if (ARSession.state == ARSessionState.Unsupported)
                {
                    Debug.LogWarning("[BREACH] ARCore unsupported on this device — falling back to simulated room.");
                    simulated = true;
                }
            }

            _rig = ArRig.Create(transform, simulated);
            if (simulated) _simRoom = SimulatedRoom.Create(transform);
            _room = new GameObject("Room Model").AddComponent<RoomModel>();
            _room.transform.SetParent(transform, false);
            _room.Init(_rig, _simRoom);
            _marker = new GameObject("Marker Origin").AddComponent<MarkerOrigin>();
            _marker.transform.SetParent(transform, false);
            _marker.Init(_rig);

            _fx = ImpactEffects.Create(transform);
            _hud = Hud.Create(transform);
            _screens = Screens.Create(transform);
            _diag = DiagnosticsPanel.Create(transform);
            _diag.BuildReport = BuildReport;

            _input = gameObject.AddComponent<FireInput>();
            _input.Exclusions = new[] { _hud.ReloadHitArea, _hud.PauseHitArea };
            _rifle = RifleController.Create(transform, _rig.Camera, _fx, _input);
            _rifle.SetViewModelVisible(false);
            _rifle.ShotResolved += OnShotResolved;

            _hunter = HunterActor.Create(transform, _room, _rig.Camera, _fx);
            _hunter.StruckPlayer += OnPlayerStruck;
            _hunter.Died += OnHunterDied;
            _hunter.TookHit += (zone, killed) => _hud.ShowHit(zone, killed);

            _hud.ReloadButton.onClick.AddListener(() => _rifle.RequestReload());
            _hud.PauseButton.onClick.AddListener(Pause);
            _hud.PauseHitArea.gameObject.AddComponent<LongPress>().OnLongPress = () => _diag.SetVisible(true);

            WireScreens();
            _screens.SetFooter($"{BuildInfo.Text}   ·   {(simulated ? "SIMULATED ROOM (no ARCore)" : "ARCORE")}");
            _screens.Show("Menu");
        }

        void WireScreens()
        {
            _screens.OnPlay = () => BeginFlow(MatchMode.Hunt);
            _screens.OnTraining = () => BeginFlow(MatchMode.Training);
            _screens.OnSafetyConfirmed = () =>
            {
                _safetyConfirmed = true;
                BeginScan();
            };
            _screens.OnBeginMatch = BeginMatch;
            _screens.OnResume = Resume;
            _screens.OnEndMatch = () =>
            {
                Resume();
                EndMatch("MATCH ENDED");
            };
            _screens.OnAgain = () => BeginFlow(_mode);
            _screens.OnMenu = ToMenu;
            _screens.OnDiagnostics = () => _diag.SetVisible(true);
            _screens.OnRecalibrate = () => _marker.Recalibrate();
        }

        // ------------------------------------------------------------------ flow

        void BeginFlow(MatchMode mode)
        {
            _mode = mode;
            if (!_safetyConfirmed) _screens.Show("Safety");
            else BeginScan();
        }

        void BeginScan()
        {
            Time.timeScale = 1f;
            _hunter.Despawn();
            _match = new MatchState(new MatchConfig { Mode = _mode });
            _match.EncounterStarted += OnEncounterStarted;
            _match.PhaseChanged += OnPhaseChanged;
            _match.BeginScanning(Time.timeAsDouble);

            _player = new Health(_match.Config.PlayerMaxHealth)
            {
                RegenDelaySeconds = _match.Config.PlayerRegenDelay,
                RegenPerSecond = _match.Config.PlayerRegenPerSecond,
                InvulnerabilitySeconds = _match.Config.PlayerHitInvulnerability,
                Invulnerable = _mode == MatchMode.Training,
            };

            var spec = WeaponSpec.DefaultRifle();
            spec.InfiniteReserve = _mode == MatchMode.Training;
            _rifle.Configure(spec);
            _rifle.InputEnabled = false;
            _rifle.SetViewModelVisible(false);

            _room.Frozen = false;
            _room.Boundary = null;
            _room.ScanVisible = true;
            _scanStarted = Time.time;
            _input.LeftHanded = Settings.LeftHanded;
            _hud.SetCombatVisible(false);
            _screens.Show("Scan");
        }

        void BeginMatch()
        {
            var eye = _rig.Camera.transform.position;
            float floorY = _room.FloorY ?? eye.y - 1.4f;
            _boundary = new PlayBoundary(new System.Numerics.Vector3(eye.x, floorY, eye.z), Settings.ArenaRadius);
            _room.Boundary = _boundary;
            _room.Rebuild();
            _room.Frozen = true;
            _room.ScanVisible = false;
            if (_marker.Origin.State != OriginState.Locked)
                _marker.Origin.LockAt(new RigidPose(new System.Numerics.Vector3(eye.x, floorY, eye.z), _rig.Camera.transform.rotation.ToS()));

            _screens.Show("Countdown");
            _hud.SetCombatVisible(true);
            _rifle.SetViewModelVisible(true);
            _match.ArenaReady(Time.timeAsDouble);
        }

        void OnPhaseChanged(MatchPhase from, MatchPhase to)
        {
            switch (to)
            {
                case MatchPhase.Countdown:
                    StartCoroutine(CountdownTicks());
                    break;
                case MatchPhase.Live:
                    _screens.HideAll();
                    _rifle.InputEnabled = true;
                    break;
                case MatchPhase.Intermission:
                    break;
                case MatchPhase.PlayerDown:
                    _rifle.InputEnabled = false;
                    StartCoroutine(AfterDeath());
                    break;
            }
        }

        IEnumerator CountdownTicks()
        {
            int last = -1;
            while (_match != null && _match.Phase == MatchPhase.Countdown)
            {
                int n = Mathf.CeilToInt(_match.CountdownRemaining(Time.timeAsDouble));
                if (n != last && n > 0) BreachAudio.Instance?.Play2D(Sfx.CountdownTick, 0.8f, 0f);
                last = n;
                yield return null;
            }
            BreachAudio.Instance?.Play2D(Sfx.MatchStart, 1f, 0f);
        }

        void OnEncounterStarted(int encounter)
        {
            var cam = _rig.Camera.transform;
            float floorY = _room.FloorY ?? cam.position.y - 1.4f;
            var point = _planner.Choose(_room.Points, cam.position.ToS(), cam.forward.ToS(), floorY, _boundary,
                p => _room.HasLineOfSight(cam.position, p.ToU()));
            _hunter.Spawn(point, HunterConfig.ForEncounter(encounter), Time.timeAsDouble);
            _lastHunterSpawn = Time.timeAsDouble;
            StartCoroutine(ContactCue());
        }

        IEnumerator ContactCue()
        {
            // Once it has emerged, point the player toward it if it is out of view.
            yield return new WaitForSeconds(1.2f);
            if (_hunter.IsAlive && !_hunter.Brain.VisibleToPlayer)
            {
                var cam = _rig.Camera.transform;
                float yaw = ViewGeometry.SignedYaw(cam.position.ToS(), cam.forward.ToS(), _hunter.WorldPosition.ToS());
                _hud.ShowThreat(yaw, "CONTACT");
            }
        }

        void OnHunterDied(bool headshot)
        {
            if (_match == null) return;
            var cfg = _hunter.Brain.Config;
            int before = _match.Score;
            _match.HunterKilled(cfg.KillScore, headshot, cfg.HeadshotKillBonus, Time.timeAsDouble);
            _hud.Flash(headshot ? $"HUNTER DOWN · HEADSHOT  +{_match.Score - before}" : $"HUNTER DOWN  +{_match.Score - before}", 2.2f);
            StartCoroutine(ClearBodyLater());
        }

        IEnumerator ClearBodyLater()
        {
            double spawnAtDeath = _lastHunterSpawn;
            float wait = _match != null ? _match.Config.IntermissionSeconds - 0.2f : 3f;
            yield return new WaitForSeconds(wait);
            // Only clear if a new encounter has not already respawned it.
            if (_lastHunterSpawn == spawnAtDeath && !_hunter.IsAlive) _hunter.Despawn();
        }

        void OnPlayerStruck(float damage, Vector3 hunterPos)
        {
            if (_match == null || _match.Phase != MatchPhase.Live) return;
            var cam = _rig.Camera.transform;
            var dir = (cam.position - hunterPos).normalized;
            var r = _player.Apply(new DamageInfo(damage, HitZone.Body, 1, dir.ToS()), Time.timeAsDouble);
            float yaw = ViewGeometry.SignedYaw(cam.position.ToS(), cam.forward.ToS(), hunterPos.ToS());
            _hud.ShowDamage(yaw);
            if (r.Ignored && !_player.Invulnerable) return;
            _match.RecordDamageTaken(r.Applied);
            BreachAudio.Instance?.Play2D(Sfx.PlayerHurt, 1f, 0.05f);
            Haptics.Hurt();
            if (r.Killed) _match.PlayerKilled(Time.timeAsDouble);
        }

        void OnShotResolved(bool hit, HitZone zone, bool killed) =>
            _match?.RecordShot(hit, hit && zone == HitZone.Head);

        IEnumerator AfterDeath()
        {
            _hud.Flash("", 0f);
            yield return new WaitForSeconds(1.4f);
            EndMatch("YOU WERE TAKEN");
        }

        void EndMatch(string title)
        {
            if (_match == null) return;
            _rifle.InputEnabled = false;
            _rifle.SetViewModelVisible(false);
            _hud.SetCombatVisible(false);
            _hunter.Despawn();
            int t = (int)_match.LiveSeconds;
            _screens.SetResult(title,
                $"{_match.Kills} HUNTERS DOWN   ·   SCORE {_match.Score:N0}\n" +
                $"ACCURACY {_match.Accuracy * 100f:0}%   ·   HEADSHOTS {_match.Headshots}   ·   TIME {t / 60:00}:{t % 60:00}");
            _match.End(Time.timeAsDouble);
            _screens.Show("Result");
        }

        void ToMenu()
        {
            Time.timeScale = 1f;
            _paused = false;
            _match = null;
            _hunter.Despawn();
            _rifle.InputEnabled = false;
            _rifle.SetViewModelVisible(false);
            _hud.SetCombatVisible(false);
            _room.ScanVisible = false;
            _screens.Show("Menu");
        }

        void Pause()
        {
            if (_match == null || _paused) return;
            _paused = true;
            Time.timeScale = 0f;
            _rifle.InputEnabled = false;
            _screens.Show("Pause");
        }

        void Resume()
        {
            if (!_paused) return;
            _paused = false;
            Time.timeScale = 1f;
            _screens.HideAll();
            _rifle.InputEnabled = _match != null && (_match.Phase == MatchPhase.Live || _match.Phase == MatchPhase.Intermission);
        }

        // ------------------------------------------------------------------ per-frame

        void Update()
        {
            _frames.Add(Time.unscaledDeltaTime);
            if (_match == null || _rig == null) return;
            double now = Time.timeAsDouble;
            float dt = Time.deltaTime;

            _match.Tick(now, dt);

            switch (_match.Phase)
            {
                case MatchPhase.Scanning:
                    UpdateScan();
                    break;
                case MatchPhase.Countdown:
                    _screens.SetCountdown(_match.CountdownRemaining(now));
                    break;
            }

            bool combat = _match.Phase == MatchPhase.Live || _match.Phase == MatchPhase.Intermission ||
                          _match.Phase == MatchPhase.Countdown || _match.Phase == MatchPhase.PlayerDown;
            if (!combat) return;

            _player.Tick(now, dt);
            var w = _rifle.Weapon;
            _hud.SetScore(_match.Score, _match.Kills);
            _hud.SetTimer(_match.LiveSeconds);
            _hud.SetAmmo(w.AmmoInMagazine, w.Spec.MagazineSize, w.Reserve, w.Spec.InfiniteReserve);
            _hud.SetReload(w.IsReloading, w.ReloadProgress(now), w.AmmoInMagazine == 0, w.CanReload);
            _hud.SetHealth(_player.Normalized, _player.Current);
            _hud.SetCrosshair(w.Spec.BaseSpreadDegrees + w.Spread, w.RecoilPitch, _rig.Camera.fieldOfView);
            UpdateBoundary();
        }

        void UpdateScan()
        {
            float area = _room.FloorArea;
            float progress = _simRoom != null ? 1f : Mathf.Clamp01(area / MinFloorArea);
            bool ready = progress >= 1f && Time.time - _scanStarted > 1.5f;
            string stats = $"FLOOR {area:0.0} M²   ·   WALLS {_room.WallCount}   ·   SURFACES {_room.RaisedCount}   ·   COVER POINTS {CountCover()}";
            string title = ready ? "ARENA READY" : "SCAN THE FLOOR";
            string detail = ready
                ? (_room.WallCount == 0 ? "Look at nearby walls and furniture to give the Hunter somewhere to hide — or begin now." : "Stand where you want to fight, then begin.")
                : "Sweep the phone slowly across the floor around you.";
            string origin = _marker.Supported ? "ORIGIN MARKER: " + _marker.Status.ToUpperInvariant() : "";
            _screens.SetScan(progress, ready, stats, origin, title, detail);
        }

        int CountCover()
        {
            int n = 0;
            var pts = _room.Points;
            for (int i = 0; i < pts.Count; i++) if (pts[i].IsCover) n++;
            return n;
        }

        void UpdateBoundary()
        {
            if (_boundary == null) return;
            var status = _boundary.Evaluate(_rig.Camera.transform.position.ToS());
            _boundaryWarnCooldown -= Time.unscaledDeltaTime;
            switch (status)
            {
                case BoundaryStatus.Outside:
                    _hud.SetBoundaryWarning("OUTSIDE PLAY AREA — STEP BACK");
                    if (_boundaryWarnCooldown <= 0f)
                    {
                        BreachAudio.Instance?.Play2D(Sfx.BoundaryWarn, 0.9f, 0f);
                        _boundaryWarnCooldown = 2f;
                    }
                    break;
                case BoundaryStatus.Warning:
                    _hud.SetBoundaryWarning("EDGE OF PLAY AREA");
                    if (_lastBoundary == BoundaryStatus.Inside) BreachAudio.Instance?.Play2D(Sfx.BoundaryWarn, 0.5f, 0f);
                    break;
                default:
                    _hud.SetBoundaryWarning(null);
                    break;
            }
            _lastBoundary = status;
        }

        // ------------------------------------------------------------------ diagnostics

        string BuildReport()
        {
            var r = new DiagnosticsReport();
            r.Section("BUILD")
                .Row("version", Application.version)
                .Row("build", BuildInfo.Text)
                .Row("unity", Application.unityVersion)
                .Row("device", SystemInfo.deviceModel)
                .Row("os", SystemInfo.operatingSystem)
                .Row("gpu", $"{SystemInfo.graphicsDeviceName} ({SystemInfo.graphicsDeviceType})")
                .Row("time (utc)", System.DateTime.UtcNow.ToString("u"));

            r.Section("AR")
                .Row("mode", _rig == null ? "starting" : _rig.Simulated ? "SIMULATED (not physical AR)" : "ARCORE")
                .Row("tracking", _rig?.TrackingSummary())
                .Row("planes", _room != null ? _room.PlaneCount.ToString() : "-")
                .Row("floor", _room?.FloorY.HasValue == true ? $"y={_room.FloorY.Value:0.00} m, {_room.FloorArea:0.0} m²" : "not found")
                .Row("walls / raised", _room != null ? $"{_room.WallCount} / {_room.RaisedCount}" : "-")
                .Row("tactical points", _room != null ? $"{_room.Points.Count} ({CountCover()} cover)" : "-");
            if (_rig != null && _rig.Occlusion != null)
                r.Row("depth", $"requested {_rig.Occlusion.requestedEnvironmentDepthMode}, active {_rig.Occlusion.currentEnvironmentDepthMode}");
            else
                r.Row("depth", "n/a");
            var est = _rig != null ? _rig.Sun.GetComponent<LightEstimator>() : null;
            r.Row("light estimate", est != null && est.Brightness.HasValue ? $"brightness {est.Brightness.Value:0.00}" : "none");
            r.Row("marker", _marker != null ? $"{_marker.Status} (tracking: {_marker.MarkerTracking})" : "-");
            r.Row("origin", _marker != null ? _marker.Origin.State.ToString() : "-");

            r.Section("NETWORK")
                .Row("session", "OFFLINE — shared world is Stage 3 (not built yet)")
                .Row("peers", "0")
                .Row("ping", "n/a")
                .Row("packet loss", "n/a");

            r.Section("PLAYER");
            if (_player != null) r.Row("health", $"{_player.Current:0}/{_player.Max:0}{(_player.Invulnerable ? " (training)" : "")}");
            if (_rifle != null)
            {
                var w = _rifle.Weapon;
                r.Row("weapon", $"{w.Spec.DisplayName} {w.AmmoInMagazine}/{w.Spec.MagazineSize} +{(w.Spec.InfiniteReserve ? "inf" : w.Reserve.ToString())}{(w.IsReloading ? " reloading" : "")}");
            }
            r.Row("pose sync", "n/a (single device)");
            if (_boundary != null) r.Row("boundary", _boundary.Evaluate(_rig.Camera.transform.position.ToS()).ToString());

            r.Section("MATCH");
            if (_match != null)
            {
                r.Row("mode / phase", $"{_match.Config.Mode} / {_match.Phase}")
                    .Row("score / kills", $"{_match.Score} / {_match.Kills}")
                    .Row("accuracy", $"{_match.Accuracy * 100f:0}% ({_match.ShotsHit}/{_match.ShotsFired}), headshots {_match.Headshots}")
                    .Row("damage taken", $"{_match.DamageTaken:0}");
            }
            else r.Row("phase", "menu");
            if (_hunter != null && _hunter.Brain != null)
                r.Row("hunter", $"{_hunter.Brain.State}, hp {_hunter.Brain.Health.Current:0}, seen {_hunter.Brain.VisibleToPlayer}, dist {Vector3.Distance(_hunter.WorldPosition, _rig.Camera.transform.position):0.0} m");

            r.Section("PERFORMANCE")
                .Row("fps avg", _frames.AverageFps, "0.0")
                .Row("fps 1% low", _frames.OnePercentLowFps, "0.0")
                .Row("worst frame", _frames.WorstFrameMs.ToString("0.0") + " ms")
                .Row("managed heap", (System.GC.GetTotalMemory(false) / (1024f * 1024f)).ToString("0.0") + " MB")
                .Row("gc gen0 count", System.GC.CollectionCount(0).ToString())
                .Row("device ram", SystemInfo.systemMemorySize + " MB")
                .Row("battery", SystemInfo.batteryLevel < 0 ? "unknown" : $"{SystemInfo.batteryLevel * 100f:0}% {SystemInfo.batteryStatus}")
                .Row("thermal", "UNKNOWN (not exposed)");
            return r.ToText();
        }
    }

    /// <summary>Invokes a callback when a UI element is held for 1.2 s.</summary>
    public sealed class LongPress : MonoBehaviour, UnityEngine.EventSystems.IPointerDownHandler, UnityEngine.EventSystems.IPointerUpHandler
    {
        public System.Action OnLongPress;
        float _downAt = -1f;

        public void OnPointerDown(UnityEngine.EventSystems.PointerEventData e) => _downAt = Time.unscaledTime;
        public void OnPointerUp(UnityEngine.EventSystems.PointerEventData e) => _downAt = -1f;

        void Update()
        {
            if (_downAt >= 0f && Time.unscaledTime - _downAt > 1.2f)
            {
                _downAt = -1f;
                OnLongPress?.Invoke();
            }
        }
    }
}
