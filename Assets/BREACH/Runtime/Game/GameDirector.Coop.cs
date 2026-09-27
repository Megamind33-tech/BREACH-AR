using System.Collections.Generic;
using System.Text;
using Breach.Core.Combat;
using Breach.Core.Diagnostics;
using Breach.Core.Hunter;
using Breach.Core.Match;
using Breach.Core.Net;
using Breach.Core.World;
using Breach.Hunter;
using Breach.Net;
using Breach.Presentation;
using Breach.Util;
using UnityEngine;
using SVector3 = System.Numerics.Vector3;
using SQuaternion = System.Numerics.Quaternion;

namespace Breach.Game
{
    /// <summary>
    /// Stage 3/4 — shared world and co-op. Host is authoritative for the
    /// Hunter (brain, damage, death), score and match phase. Every position
    /// crosses the network in shared (marker) space and is converted with
    /// this device's SharedOrigin on arrival.
    /// </summary>
    public sealed partial class GameDirector
    {
        const float PoseRate = 20f, HunterRate = 20f, MatchRate = 4f, RosterRate = 2f;
        const double PoseFreshSeconds = 1.5;

        CoopSession _session;
        NetRole _lastRole;
        ushort _spawnId;
        bool _localDown;
        bool _coopReady;
        readonly ClaimValidator _claims = new ClaimValidator();
        float _nextPose, _nextHunter, _nextMatch, _nextRoster, _nextDownCheck;
        ushort _poseSeq, _hunterSeq;
        MatchPhase _lastSentPhase = MatchPhase.Idle;
        readonly Dictionary<ulong, AllyMarker> _allies = new Dictionary<ulong, AllyMarker>();
        readonly List<HuntTarget> _targets = new List<HuntTarget>(4);
        readonly List<ulong> _stale = new List<ulong>();

        bool IsNetworked => _session != null && _session.IsNetworked;
        bool IsHost => _session != null && _session.Role == NetRole.Host;
        bool IsClient => _session != null && _session.Role == NetRole.Client;
        ulong LocalId => _session != null ? _session.LocalId : 0;
        string LocalCallsign => CoopSession.CallsignFor(LocalId);

        // ------------------------------------------------------------------ shared-space conversion

        SharedOrigin Origin => _marker.Origin;
        SVector3 ToShared(Vector3 session) => Origin.SessionToShared(session.ToS());
        Vector3 ToSession(SVector3 shared) => Origin.SharedToSession(shared).ToU();
        SQuaternion ToShared(Quaternion session) => Origin.SessionToShared(session.ToS());
        Quaternion ToSession(SQuaternion shared) => Origin.SharedToSession(shared).ToU();
        SVector3 DirToShared(Vector3 d) => System.Numerics.Vector3.Transform(d.ToS(), System.Numerics.Quaternion.Inverse(Origin.OriginInSession.Rotation));
        Vector3 DirToSession(SVector3 d) => System.Numerics.Vector3.Transform(d, Origin.OriginInSession.Rotation).ToU();
        float YawToShared(float sessionYaw) => ToU(ToShared(Quaternion.Euler(0, sessionYaw, 0))).eulerAngles.y;
        float YawToSession(float sharedYaw) => ToSession(Quaternion.Euler(0, sharedYaw, 0).ToS()).eulerAngles.y;
        static Quaternion ToU(SQuaternion q) => q.ToU();

        // ------------------------------------------------------------------ wiring

        void WireCoop()
        {
            _session.JoinedHost += () =>
            {
                _lastRole = NetRole.Client;
                _screens.Show("Lobby");
            };
            _session.Ended += OnSessionEnded;
            _session.EventReceived += OnNetEvent;
            _session.HunterReceived += OnHunterSnapshot;
            _session.MatchReceived += OnMatchSnapshot;
            _session.PoseReceived += (id, pose) =>
            {
                if (_session.Peers.TryGetValue(id, out var peer))
                    peer.Buffer.Add(Time.timeAsDouble, pose.Eye, 0f);
                if (IsHost && (pose.Flags & PlayerFlags.Alive) == 0 && _match != null && _match.Phase == MatchPhase.Live) CheckAllDown();
            };
            _session.PeerLeft += id =>
            {
                if (_allies.TryGetValue(id, out var m))
                {
                    Destroy(m.gameObject);
                    _allies.Remove(id);
                }
                if (IsHost) CheckAllDown();
            };
            _hunter.HitClaimed += OnPuppetHitClaimed;
        }

        /// <summary>AGAIN: in co-op the host pulls everyone back into a new scan.</summary>
        void Again()
        {
            if (IsHost) _session.BroadcastEvent(new GameEvent { Kind = GameEventKind.LobbyStart });
            BeginFlow(IsNetworked ? MatchMode.Hunt : _mode);
        }

        void HostLobby()
        {
            if (!_session.Host())
            {
                _screens.SetJoinStatus(_session.Status.ToUpperInvariant());
                _screens.Show("Coop");
                return;
            }
            _lastRole = NetRole.Host;
            _hunter.TargetProvider = BuildTargets;
            _screens.Show("Lobby");
        }

        void JoinLobby(string code)
        {
            if (!_session.Join(code))
                _screens.SetJoinStatus(_session.Status.ToUpperInvariant());
            else
                _screens.SetJoinStatus("CONNECTING…");
        }

        void HostStartLobby()
        {
            if (!IsHost) return;
            _session.BroadcastEvent(new GameEvent { Kind = GameEventKind.LobbyStart });
            BeginFlow(MatchMode.Hunt);
        }

        void LeaveCoop()
        {
            _session.Leave();
            _hunter.TargetProvider = null;
            ToMenu();
        }

        void OnSessionEnded(string why)
        {
            var was = _lastRole;
            _hunter.TargetProvider = null;
            ToMenu();
            _screens.SetJoinStatus(why.ToUpperInvariant());
            _screens.Show(was == NetRole.Client ? "Join" : "Coop");
        }

        // ------------------------------------------------------------------ flow hooks (called from GameDirector.cs)

        void EnterCombatPresentation()
        {
            if (IsClient && !_coopReady) PrepareArena();
            if (_match != null && _match.Phase == MatchPhase.Countdown) _screens.Show("Countdown");
            _hud.SetCombatVisible(true);
            _rifle.SetViewModelVisible(true);
        }

        /// <summary>Client pressed BEGIN: arena set up locally, then wait for the host's countdown.</summary>
        void ClientReady()
        {
            PrepareArena();
            _coopReady = true;
        }

        void PrepareArena()
        {
            var eye = _rig.Camera.transform.position;
            float floorY = _room.FloorY ?? eye.y - 1.4f;
            _boundary = new PlayBoundary(new System.Numerics.Vector3(eye.x, floorY, eye.z), Settings.ArenaRadius);
            _room.Boundary = _boundary;
            _room.Rebuild();
            _room.Frozen = true;
            _room.ScanVisible = false;
        }

        void CoopScanGate(ref bool ready, ref string title, ref string detail)
        {
            if (Origin.State != OriginState.Locked)
            {
                ready = false;
                title = Origin.State == OriginState.Calibrating ? "HOLD STEADY ON THE MARKER" : "SCAN THE BREACH MARKER";
                detail = "Both phones must see the printed marker so you share one battlefield. Point the camera at it until the origin locks.";
                return;
            }
            if (IsClient)
            {
                if (_coopReady)
                {
                    ready = false;
                    title = "READY";
                    detail = "Waiting for the host to begin.";
                }
                return;
            }
            if (IsHost && ready)
            {
                var waiting = new List<string>();
                foreach (var p in _session.Peers.Values)
                    if ((p.Pose.Flags & PlayerFlags.Ready) == 0 || !Fresh(p)) waiting.Add(p.Callsign);
                if (waiting.Count > 0)
                {
                    ready = false;
                    title = "WAITING FOR TEAM";
                    detail = "Waiting for " + string.Join(", ", waiting) + " to lock the marker and press BEGIN.";
                }
                else if (_session.Peers.Count > 0)
                {
                    detail = "Team ready. Begin when you are.";
                }
            }
        }

        void OnHostHunterSpawned()
        {
            if (!IsHost) return;
            _claims.ResetHistory();
            _session.BroadcastEvent(new GameEvent
            {
                Kind = GameEventKind.HunterSpawned,
                SpawnId = _spawnId,
                Point = ToShared(_hunter.WorldPosition),
            });
            SendHunterSnapshot();
        }

        void OnHostHunterKilled(bool headshot, ulong shooter)
        {
            if (IsHost)
            {
                _session.BroadcastEvent(new GameEvent
                {
                    Kind = GameEventKind.HunterKilled,
                    SpawnId = _spawnId,
                    Client = shooter,
                    Flag = headshot,
                });
            }
            if (IsNetworked && shooter != LocalId)
                _hud.Flash($"{CoopSession.CallsignFor(shooter)} DROPPED IT", 2f);
            ReviveLocal();
        }

        /// <summary>Authority: the Hunter's strike resolved against a player.</summary>
        void OnHunterStrike(float damage, Vector3 hunterPos, ulong target)
        {
            if (!IsNetworked || target == LocalId)
            {
                OnPlayerStruck(damage, hunterPos);
                return;
            }
            _session.SendEventTo(target, new GameEvent
            {
                Kind = GameEventKind.HunterStrike,
                SpawnId = _spawnId,
                Client = target,
                Amount = damage,
                Point = ToShared(hunterPos),
            });
        }

        void LocalPlayerDown()
        {
            _localDown = true;
            _rifle.InputEnabled = false;
            _hud.Flash("YOU'RE DOWN — HOLD ON, YOUR TEAM IS STILL FIGHTING", 4f);
            if (IsClient) _session.SendEventToHost(new GameEvent { Kind = GameEventKind.PlayerDown, Client = LocalId });
            else CheckAllDown();
        }

        /// <summary>Downed players get back up when the team drops the Hunter.</summary>
        void ReviveLocal()
        {
            if (!_localDown || _player == null) return;
            _player.Restore();
            _localDown = false;
            _hud.Flash("BACK ON YOUR FEET", 1.8f);
            if (_match != null && (_match.Phase == MatchPhase.Live || _match.Phase == MatchPhase.Intermission)) _rifle.InputEnabled = true;
        }

        void CheckAllDown()
        {
            if (!IsHost || _match == null || _match.Phase != MatchPhase.Live) return;
            if (!_localDown) return;
            foreach (var p in _session.Peers.Values)
                if (Fresh(p) && (p.Pose.Flags & PlayerFlags.Alive) != 0) return;
            _match.PlayerKilled(Time.timeAsDouble);
        }

        bool Fresh(CoopSession.Peer p) => p.LastPoseTime >= 0 && Time.timeAsDouble - p.LastPoseTime < PoseFreshSeconds;

        // ------------------------------------------------------------------ network input

        void OnPuppetHitClaimed(HitZone zone, Vector3 point, Vector3 dir, float damage)
        {
            if (!IsClient) return;
            _session.SendEventToHost(new GameEvent
            {
                Kind = GameEventKind.ShotClaim,
                SpawnId = _hunter.SpawnId,
                Client = LocalId,
                Zone = (byte)zone,
                Amount = damage,
                Point = ToShared(point),
                Direction = DirToShared(dir),
            });
        }

        void OnNetEvent(ulong sender, GameEvent e)
        {
            double now = Time.timeAsDouble;
            switch (e.Kind)
            {
                case GameEventKind.LobbyStart when IsClient:
                    if (_match == null || _screens.Current == "Lobby" || _screens.Current == "Result")
                        BeginFlow(MatchMode.Hunt);
                    break;

                case GameEventKind.ShotClaim when IsHost:
                {
                    var verdict = _claims.Validate(sender, now, _hunter.IsAlive, e.SpawnId, _spawnId, e.Point, e.Amount);
                    if (verdict != ClaimVerdict.Accepted)
                    {
                        _rejectedClaims++;
                        break;
                    }
                    var r = _hunter.ApplyRemoteHit((HitZone)e.Zone, ToSession(e.Point), DirToSession(e.Direction).normalized, e.Amount, sender);
                    if (r.Ignored) break;
                    _acceptedClaims++;
                    _session.BroadcastEvent(new GameEvent
                    {
                        Kind = GameEventKind.HunterHit,
                        SpawnId = _spawnId,
                        Client = sender,
                        Zone = e.Zone,
                        Flag = r.Killed,
                        Amount = r.Applied,
                        Point = e.Point,
                        Direction = e.Direction,
                    });
                    break;
                }

                case GameEventKind.HunterHit when IsClient:
                    // Someone else's validated hit: show it where it landed on our copy.
                    if (e.Client != LocalId) _fx.HunterHit(ToSession(e.Point), DirToSession(e.Direction).normalized, e.Zone == (byte)HitZone.Head);
                    break;

                case GameEventKind.HunterStrike when IsClient:
                    if (e.Client == LocalId) OnPlayerStruck(e.Amount, ToSession(e.Point));
                    break;

                case GameEventKind.HunterSpawned when IsClient:
                    SpawnLocalPuppet(e.SpawnId, ToSession(e.Point));
                    break;

                case GameEventKind.HunterKilled when IsClient:
                    if (e.SpawnId == _hunter.SpawnId) _hunter.PuppetKilled(Vector3.zero, e.Flag);
                    _hud.Flash(e.Client == LocalId
                        ? (e.Flag ? "HUNTER DOWN · HEADSHOT" : "HUNTER DOWN")
                        : $"{CoopSession.CallsignFor(e.Client)} DROPPED IT", 2f);
                    if (e.Client == LocalId) _hud.ShowHit(e.Flag ? HitZone.Head : HitZone.Body, true);
                    ReviveLocal();
                    StartCoroutine(ClearBodyLater());
                    break;

                case GameEventKind.PlayerDown when IsHost:
                    CheckAllDown();
                    break;
            }
        }

        int _acceptedClaims, _rejectedClaims;

        void SpawnLocalPuppet(ushort spawnId, Vector3 sessionPos)
        {
            float floor = _room.FloorY ?? sessionPos.y;
            _hunter.SpawnPuppet(spawnId, new Vector3(sessionPos.x, floor, sessionPos.z));
            _lastHunterSpawn = Time.timeAsDouble;
            StartCoroutine(ContactCue());
        }

        void OnHunterSnapshot(HunterSnapshot s)
        {
            if (!IsClient || _match == null) return;
            var state = (HunterState)s.State;
            if (state == HunterState.Dead || state == HunterState.Dormant) return;
            var pos = ToSession(s.Position);
            if (!_hunter.Puppet || _hunter.SpawnId != s.SpawnId || !_hunter.gameObject.activeSelf)
                SpawnLocalPuppet(s.SpawnId, pos); // missed the spawn event (joined late / packet order)
            _hunter.PushSnapshot(Time.timeAsDouble, pos, YawToSession(s.FacingYaw), state, s.Speed, s.AttackWindup);
        }

        void OnMatchSnapshot(MatchSnapshot m)
        {
            if (!IsClient || _match == null || !_match.Remote) return;
            var phase = (MatchPhase)m.Phase;
            // Stay in our own scan until the host actually starts the countdown.
            if (_match.Phase == MatchPhase.Scanning && (phase == MatchPhase.Scanning || phase == MatchPhase.Idle)) return;
            var before = _match.Phase;
            _match.ApplyRemote(phase, m.Score, m.Kills, m.Headshots, m.Encounter, m.LiveSeconds, Time.timeAsDouble);
            if (phase == MatchPhase.Ended && before != MatchPhase.Ended && _screens.Current != "Result")
                EndMatch("HOST ENDED THE MATCH");
        }

        // ------------------------------------------------------------------ per-frame

        void UpdateCoop()
        {
            if (!IsNetworked) return;
            float t = Time.unscaledTime;

            if (_screens.Current == "Lobby") RefreshLobby();

            if (t >= _nextPose)
            {
                _nextPose = t + 1f / PoseRate;
                var cam = _rig.Camera.transform;
                var flags = PlayerFlags.None;
                bool inCombat = _match != null && _match.Phase != MatchPhase.Scanning && _match.Phase != MatchPhase.Idle;
                if (!_localDown && (inCombat || _match == null || _match.Phase == MatchPhase.Scanning)) flags |= PlayerFlags.Alive;
                if (Origin.State == OriginState.Locked) flags |= PlayerFlags.OriginLocked;
                if (_coopReady) flags |= PlayerFlags.Ready;
                _session.SendPose(new PlayerPose
                {
                    Sequence = _poseSeq++,
                    Eye = ToShared(cam.position),
                    Rotation = ToShared(cam.rotation),
                    Health = _player != null ? _player.Current : 100f,
                    Flags = flags,
                });
            }

            if (IsHost)
            {
                if (_hunter.IsAlive) _claims.RecordHunter(Time.timeAsDouble, ToShared(_hunter.WorldPosition));
                if (t >= _nextHunter)
                {
                    _nextHunter = t + 1f / HunterRate;
                    SendHunterSnapshot();
                }
                bool phaseChanged = _match != null && _match.Phase != _lastSentPhase;
                if (_match != null && (t >= _nextMatch || phaseChanged))
                {
                    _nextMatch = t + 1f / MatchRate;
                    _lastSentPhase = _match.Phase;
                    _session.BroadcastMatch(new MatchSnapshot
                    {
                        Phase = (byte)_match.Phase,
                        Mode = (byte)_match.Config.Mode,
                        Score = _match.Score,
                        Kills = _match.Kills,
                        Headshots = _match.Headshots,
                        Encounter = _match.Encounter,
                        LiveSeconds = (float)_match.LiveSeconds,
                        CountdownRemaining = _match.CountdownRemaining(Time.timeAsDouble),
                    });
                }
                if (t >= _nextRoster)
                {
                    _nextRoster = t + 1f / RosterRate;
                    _session.BroadcastRoster(BuildRoster());
                }
                if (t >= _nextDownCheck)
                {
                    _nextDownCheck = t + 0.5f;
                    CheckAllDown();
                }
            }

            UpdateAllyMarkers();
        }

        void SendHunterSnapshot()
        {
            if (!IsHost || _hunter.Brain == null || !_hunter.gameObject.activeSelf) return;
            var b = _hunter.Brain;
            _session.BroadcastHunter(new HunterSnapshot
            {
                Sequence = _hunterSeq++,
                SpawnId = _hunter.SpawnId,
                State = (byte)b.State,
                Position = ToShared(_hunter.WorldPosition),
                FacingYaw = YawToShared(_hunter.transform.eulerAngles.y),
                Speed = b.CurrentSpeed,
                AttackWindup = b.AttackWindup,
                Health01 = b.Health.Normalized,
                TargetClient = _hunter.TargetClient,
            });
        }

        RosterEntry[] BuildRoster()
        {
            var list = new List<RosterEntry>
            {
                new RosterEntry { Client = LocalId, Callsign = LocalCallsign + " (HOST)", Health = _player != null ? _player.Current : 100f,
                    Flags = (_localDown ? PlayerFlags.None : PlayerFlags.Alive) | (Origin.State == OriginState.Locked ? PlayerFlags.OriginLocked : 0) | (_coopReady ? PlayerFlags.Ready : 0) },
            };
            foreach (var p in _session.Peers.Values)
                list.Add(new RosterEntry { Client = p.Id, Callsign = p.Callsign, Health = p.Pose.Health, Flags = Fresh(p) ? p.Pose.Flags : PlayerFlags.None });
            return list.ToArray();
        }

        IReadOnlyList<HuntTarget> BuildTargets()
        {
            _targets.Clear();
            var cam = _rig.Camera.transform;
            _targets.Add(new HuntTarget { Client = LocalId, Eye = cam.position, Forward = cam.forward, Alive = !_localDown, Local = true });
            foreach (var p in _session.Peers.Values)
            {
                if (!Fresh(p)) continue;
                var rot = ToSession(p.Pose.Rotation);
                _targets.Add(new HuntTarget
                {
                    Client = p.Id,
                    Eye = ToSession(p.Pose.Eye),
                    Forward = rot * Vector3.forward,
                    Alive = (p.Pose.Flags & PlayerFlags.Alive) != 0,
                    Local = false,
                });
            }
            return _targets;
        }

        void RefreshLobby()
        {
            var sb = new StringBuilder();
            if (IsHost)
            {
                sb.AppendLine($"{LocalCallsign}  ·  YOU");
                foreach (var p in _session.Peers.Values) sb.AppendLine($"{p.Callsign}  ·  CONNECTED");
                string addr = _session.LocalAddress != null ? _session.LocalAddress.ToString() : "unknown";
                _screens.SetLobby(true, _session.RoomCodeText, sb.ToString(),
                    _session.Peers.Count == 0 ? $"Waiting for a teammate. On their phone: CO-OP → JOIN → {_session.RoomCodeText}   ({addr})" : "Start when everyone is here.",
                    true);
            }
            else
            {
                foreach (var e in _session.Roster) sb.AppendLine($"{e.Callsign}{(e.Client == LocalId ? "  ·  YOU" : "")}");
                if (_session.Roster.Length == 0) sb.AppendLine($"{LocalCallsign}  ·  YOU");
                _screens.SetLobby(false, "", sb.ToString(), "Connected. Waiting for the host to start.", false);
            }
        }

        void UpdateAllyMarkers()
        {
            bool show = Origin.State == OriginState.Locked;
            _stale.Clear();
            foreach (var kv in _allies) if (!_session.Peers.ContainsKey(kv.Key)) _stale.Add(kv.Key);
            foreach (var id in _stale)
            {
                Destroy(_allies[id].gameObject);
                _allies.Remove(id);
            }
            foreach (var p in _session.Peers.Values)
            {
                if (!_allies.TryGetValue(p.Id, out var marker))
                {
                    marker = AllyMarker.Create(transform, _rig.Camera, p.Callsign);
                    _allies[p.Id] = marker;
                }
                bool fresh = Fresh(p);
                marker.gameObject.SetActive(show && p.LastPoseTime >= 0);
                if (!marker.gameObject.activeSelf) continue;
                SVector3 eyeShared = p.Pose.Eye;
                if (p.Buffer.TrySample(Time.timeAsDouble, out var sampled, out _)) eyeShared = sampled;
                marker.SetState(ToSession(eyeShared), (p.Pose.Flags & PlayerFlags.Alive) != 0, fresh);
            }
        }

        void ClearAllyMarkers()
        {
            foreach (var m in _allies.Values) if (m != null) Destroy(m.gameObject);
            _allies.Clear();
        }

        // ------------------------------------------------------------------ diagnostics

        void AppendNetworkDiagnostics(DiagnosticsReport r)
        {
            r.Section("NETWORK");
            if (!IsNetworked)
            {
                r.Row("session", "OFFLINE (solo)").Row("peers", "0").Row("ping", "n/a").Row("packet loss", "n/a");
                return;
            }
            r.Row("session", $"{_session.Role} · {_session.Status}")
                .Row("local", $"{LocalCallsign} (id {LocalId}) @ {(_session.LocalAddress != null ? _session.LocalAddress.ToString() : "no address")}")
                .Row("room code", string.IsNullOrEmpty(_session.RoomCodeText) ? "-" : _session.RoomCodeText)
                .Row("peers", _session.Peers.Count.ToString());
            foreach (var p in _session.Peers.Values)
            {
                double age = p.LastPoseTime >= 0 ? (Time.timeAsDouble - p.LastPoseTime) * 1000.0 : -1;
                float rtt = _session.RttMs(p.Id);
                r.Row("  " + p.Callsign, $"ping {(rtt >= 0 ? rtt.ToString("0") + " ms" : "?")}, last pose {(age >= 0 ? age.ToString("0") + " ms ago" : "never")}, flags {p.Pose.Flags}");
            }
            r.Row("packet loss", "UNKNOWN (not exposed by transport)");
            if (IsHost) r.Row("hit claims", $"{_acceptedClaims} accepted / {_rejectedClaims} rejected");
            r.Row("origin", $"{Origin.State}, marker {_marker.Status}");
        }

        string PoseSyncSummary()
        {
            if (_session.Peers.Count == 0) return "no peers";
            var sb = new StringBuilder();
            foreach (var p in _session.Peers.Values)
            {
                if (sb.Length > 0) sb.Append("; ");
                sb.Append(p.Callsign).Append(Fresh(p) ? " live" : " stale");
            }
            return sb.ToString();
        }
    }
}
