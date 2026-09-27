using System;
using System.Collections.Generic;
using Breach.AR;
using Breach.Combat;
using Breach.Core.Combat;
using Breach.Core.Hunter;
using Breach.Core.Net;
using Breach.Core.World;
using Breach.Presentation;
using Breach.Util;
using UnityEngine;
using SVector3 = System.Numerics.Vector3;

namespace Breach.Hunter
{
    /// <summary>A player the Hunter can hunt (session space). The local player is Local = true.</summary>
    public struct HuntTarget
    {
        public ulong Client;
        public Vector3 Eye;
        public Vector3 Forward;
        public bool Alive;
        public bool Local;
    }

    /// <summary>
    /// THE HUNTER in the scene. Two modes:
    /// AUTHORITY (solo / co-op host) — runs the engine-independent HunterBrain,
    /// answers its questions about the real room (IHunterSenses) for every
    /// player, resolves damage. PUPPET (co-op client) — renders the host's
    /// Hunter from network snapshots; hits become claims sent to the host.
    /// Both drive the same procedural body, animation, audio and ragdoll.
    /// </summary>
    public sealed class HunterActor : MonoBehaviour, IHunterSenses
    {
        public HunterBrain Brain { get; private set; }
        public HunterBody Body { get; private set; }
        HunterAnimator _anim;
        RoomModel _room;
        Camera _cam;
        ImpactEffects _fx;
        AudioSource _voice, _feet;
        GameObject _shadow;
        Material _shadowMat;
        float _nextGrowl;
        bool _ragdolled;
        float _deathTime;
        readonly List<Rigidbody> _ragdollBodies = new List<Rigidbody>();

        // --- multi-player targeting (authority) ---
        /// <summary>Supplies every huntable player. Null = solo: the local camera is the only target.</summary>
        public Func<IReadOnlyList<HuntTarget>> TargetProvider;
        HuntTarget _target;
        float _nextRetarget;
        public ulong TargetClient => _target.Client;

        // --- puppet (client) ---
        public bool Puppet { get; private set; }
        public ushort SpawnId { get; private set; }
        readonly SnapshotBuffer _snapshots = new SnapshotBuffer { InterpolationDelay = 0.12f, TeleportDistance = 3f };
        HunterAnimInput _puppetInput;
        bool _puppetAlive;
        Vector3 _lastHitDir = Vector3.forward, _lastHitPoint;
        Transform _lastHitBone;
        bool _lastHitHead;

        /// <summary>(damage, hunter world position, target client). Raised on the authority only.</summary>
        public event Action<float, Vector3, ulong> StruckPlayer;
        public event Action<HitZone, bool> TookHit;   // zone, killed (killed only known on authority)
        /// <summary>(killed by headshot, shooter client). Authority only; puppets die via <see cref="PuppetKilled"/>.</summary>
        public event Action<bool, ulong> Died;
        public event Action<HunterState> StateChanged;
        /// <summary>Puppet only: a local round hit the Hunter — (zone, world point, world dir, damage). Send it to the host.</summary>
        public event Action<HitZone, Vector3, Vector3, float> HitClaimed;

        public bool IsAlive => Puppet ? _puppetAlive && gameObject.activeSelf : Brain != null && Brain.IsAlive;
        public bool VisibleToAnyPlayer => Puppet ? LocalCanSee(transform.position) : Brain != null && Brain.VisibleToPlayer;
        public HunterState CurrentState => Puppet ? _puppetInput.State : Brain != null ? Brain.State : HunterState.Dormant;
        public Vector3 WorldPosition => transform.position;
        public Vector3 HeadPosition => Body != null ? Body.Head.position : transform.position + Vector3.up * 1.4f;

        public static HunterActor Create(Transform parent, RoomModel room, Camera cam, ImpactEffects fx)
        {
            var go = new GameObject("THE HUNTER");
            go.transform.SetParent(parent, false);
            var a = go.AddComponent<HunterActor>();
            a._room = room;
            a._cam = cam;
            a._fx = fx;
            a._voice = BreachAudio.MakeSpatialSource(go, 0.8f, 16f);
            a._feet = BreachAudio.MakeSpatialSource(go, 0.5f, 9f);
            a.BuildShadow();
            go.SetActive(false);
            return a;
        }

        void BuildShadow()
        {
            _shadowMat = BreachMaterials.UnlitTransparent(new Color(0, 0, 0, 0.55f), ProceduralTextures.BlobShadow);
            _shadow = MeshFactory.Part("Contact Shadow", transform, MeshFactory.Quad(1f), _shadowMat, new Vector3(0, 0.004f, 0), Quaternion.identity, Layers.IgnoreRaycast);
            var r = _shadow.GetComponent<MeshRenderer>();
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = false;
        }

        void BuildBody(Vector3 at)
        {
            DespawnBody();
            gameObject.SetActive(true);
            Body = HunterBody.Build(transform, this);
            _anim = new HunterAnimator(Body);
            _anim.Footstep = () => BreachAudio.Instance?.PlayAt(_feet, Sfx.HunterStep, 0.55f, 0.12f);
            _ragdolled = false;
            _shadow.SetActive(true);
            BreachMaterials.SetColor(_shadowMat, new Color(0, 0, 0, 0.55f));
            transform.position = at;
            var toPlayer = _cam.transform.position - at;
            toPlayer.y = 0;
            if (toPlayer.sqrMagnitude > 1e-4f) transform.rotation = Quaternion.LookRotation(toPlayer);
            _nextGrowl = Time.time + UnityEngine.Random.Range(1.5f, 3f);
        }

        /// <summary>Authority spawn (solo or co-op host).</summary>
        public void Spawn(TacticalPoint at, HunterConfig config, double now, ushort spawnId = 0)
        {
            Puppet = false;
            SpawnId = spawnId;
            BuildBody(at.Position.ToU());
            _nextRetarget = 0f;
            Brain = new HunterBrain(config, seed: Environment.TickCount);
            Brain.StateChanged += OnBrainState;
            Brain.AttackWindupStarted += () => BreachAudio.Instance?.PlayAt(_voice, Sfx.HunterGrowl, 1f, 0.1f);
            Brain.AttackStruck += dmg =>
            {
                BreachAudio.Instance?.PlayAt(_voice, Sfx.HunterStrike, 1f);
                if (dmg > 0f) StruckPlayer?.Invoke(dmg, transform.position, _target.Client);
            };
            Brain.Spawn(at, now, config);
        }

        /// <summary>Client spawn: the host owns this Hunter; we only render it.</summary>
        public void SpawnPuppet(ushort spawnId, Vector3 worldPosition)
        {
            Puppet = true;
            SpawnId = spawnId;
            Brain = null;
            BuildBody(worldPosition);
            _snapshots.Clear();
            _puppetAlive = true;
            _puppetInput = new HunterAnimInput { State = HunterState.Emerging };
        }

        /// <summary>Client: feed a host snapshot (already converted to this device's session space).</summary>
        public void PushSnapshot(double time, Vector3 worldPosition, float yaw, HunterState state, float speed, float windup)
        {
            if (!Puppet) return;
            _snapshots.Add(time, worldPosition.ToS(), yaw);
            var prev = _puppetInput.State;
            _puppetInput = new HunterAnimInput { State = state, Speed = speed, AttackWindup = windup };
            if (prev != state) OnBrainState(prev, state);
        }

        void OnBrainState(HunterState from, HunterState to)
        {
            if (to == HunterState.Rushing) BreachAudio.Instance?.PlayAt(_voice, Sfx.HunterShriek, 1f, 0.08f);
            if (to == HunterState.Attacking && Puppet) BreachAudio.Instance?.PlayAt(_voice, Sfx.HunterGrowl, 1f, 0.1f);
            StateChanged?.Invoke(to);
        }

        public void Despawn()
        {
            DespawnBody();
            Brain = null;
            _puppetAlive = false;
            gameObject.SetActive(false);
        }

        void DespawnBody()
        {
            if (Body != null && Body.Root != null) Destroy(Body.Root.gameObject);
            Body = null;
            _ragdollBodies.Clear();
        }

        void Update()
        {
            if (Body == null) return;
            float dt = Mathf.Min(Time.deltaTime, 0.05f);
            if (_ragdolled)
            {
                UpdateDeath();
                return;
            }

            HunterAnimInput input;
            if (Puppet)
            {
                if (_snapshots.TrySample(Time.timeAsDouble, out var p, out var yaw))
                {
                    // Keep our own floor: small floor-height disagreements between devices must not make it float.
                    transform.position = new Vector3(p.X, FloorY, p.Z);
                    transform.rotation = Quaternion.RotateTowards(transform.rotation, Quaternion.Euler(0, yaw, 0), 720f * dt);
                }
                input = _puppetInput;
                if (_puppetInput.State == HunterState.Attacking && _puppetInput.AttackWindup >= 1f && _lastStrikeSound < 0f)
                {
                    BreachAudio.Instance?.PlayAt(_voice, Sfx.HunterStrike, 1f);
                    _lastStrikeSound = 1f;
                }
                if (_puppetInput.State != HunterState.Attacking) _lastStrikeSound = -1f;
            }
            else
            {
                if (Brain == null) return;
                SelectTarget();
                Brain.Tick(Time.timeAsDouble, dt, this);
                transform.position = Brain.Position.ToU();
                var facing = Brain.Facing.ToU();
                if (facing.sqrMagnitude > 1e-4f)
                    transform.rotation = Quaternion.RotateTowards(transform.rotation, Quaternion.LookRotation(new Vector3(facing.x, 0, facing.z)), 540f * dt);
                input = HunterAnimInput.From(Brain);
            }

            _anim.Tick(input, dt, Puppet ? _cam.transform.position : _target.Eye);

            float pelvisH = Body.Pelvis.localPosition.y;
            float s = Mathf.Lerp(0.75f, 1.05f, Mathf.InverseLerp(0.6f, 0.95f, pelvisH));
            _shadow.transform.localScale = new Vector3(s * 0.85f, 1f, s);

            bool unseen = Puppet ? !LocalCanSee(transform.position) : !Brain.VisibleToPlayer;
            if (input.State == HunterState.Stalking && unseen && Time.time > _nextGrowl)
            {
                BreachAudio.Instance?.PlayAt(_voice, Sfx.HunterGrowl, 0.75f, 0.12f);
                _nextGrowl = Time.time + UnityEngine.Random.Range(3.5f, 6.5f);
            }
        }

        float _lastStrikeSound = -1f;

        // ------------------------------------------------------------------ damage

        /// <summary>A round from THIS device's rifle struck one of our hitboxes.</summary>
        public DamageResult ReceiveHit(HunterHitbox hitbox, Vector3 point, Vector3 shotDir, float damage)
        {
            if (!IsAlive) return new DamageResult(0, false, true);
            bool head = hitbox.Zone == HitZone.Head;
            _lastHitDir = shotDir;
            _lastHitPoint = point;
            _lastHitBone = hitbox.transform;
            _lastHitHead = head;

            if (Puppet)
            {
                // Predict feedback locally; the host decides damage and death.
                _fx?.HunterHit(point, shotDir, head);
                BreachAudio.Instance?.PlayAt(_voice, Sfx.ImpactFlesh, 0.9f, 0.1f);
                _anim.Flinch(shotDir, head);
                TookHit?.Invoke(hitbox.Zone, false);
                HitClaimed?.Invoke(hitbox.Zone, point, shotDir, damage);
                return new DamageResult(damage * DamageInfo.ZoneMultiplier(hitbox.Zone), false, false);
            }
            return ApplyDamage(hitbox.Zone, hitbox.transform, point, shotDir, damage, 0, local: true);
        }

        /// <summary>Authority: apply a validated hit from a remote player (world-space point/dir on this device).</summary>
        public DamageResult ApplyRemoteHit(HitZone zone, Vector3 point, Vector3 shotDir, float damage, ulong shooter)
        {
            if (Puppet || !IsAlive || Body == null) return new DamageResult(0, false, true);
            var bone = NearestBone(point, zone);
            return ApplyDamage(zone, bone, point, shotDir, damage, shooter, local: false);
        }

        DamageResult ApplyDamage(HitZone zone, Transform bone, Vector3 point, Vector3 shotDir, float damage, ulong shooter, bool local)
        {
            var info = new DamageInfo(damage, zone, (int)shooter, shotDir.ToS());
            var result = Brain.ApplyHit(info, Time.timeAsDouble);
            if (result.Ignored) return result;

            bool head = zone == HitZone.Head;
            _fx?.HunterHit(point, shotDir, head);
            BreachAudio.Instance?.PlayAt(_voice, Sfx.ImpactFlesh, 0.9f, 0.1f);
            if (local) TookHit?.Invoke(zone, result.Killed);

            if (result.Killed)
            {
                BreachAudio.Instance?.PlayAt(_voice, Sfx.HunterDeath, 1f, 0.05f);
                EnterRagdoll(bone, point, shotDir, head);
                Died?.Invoke(Brain.KilledByHeadshot, shooter);
            }
            else
            {
                _anim.Flinch(shotDir, head);
            }
            return result;
        }

        /// <summary>Client: the host confirmed the kill.</summary>
        public void PuppetKilled(Vector3 worldDir, bool headshot)
        {
            if (!Puppet || _ragdolled || Body == null) return;
            _puppetAlive = false;
            _puppetInput.State = HunterState.Dead;
            BreachAudio.Instance?.PlayAt(_voice, Sfx.HunterDeath, 1f, 0.05f);
            var dir = worldDir.sqrMagnitude > 1e-4f ? worldDir : _lastHitDir;
            var bone = _lastHitBone != null ? _lastHitBone : (headshot ? Body.Head : Body.Chest);
            var point = _lastHitBone != null ? _lastHitPoint : bone.position;
            EnterRagdoll(bone, point, dir, headshot);
        }

        Transform NearestBone(Vector3 point, HitZone zone)
        {
            if (zone == HitZone.Head) return Body.Head;
            Transform best = Body.Chest;
            float bd = float.MaxValue;
            foreach (var c in Body.Hitboxes)
            {
                float d = (c.bounds.center - point).sqrMagnitude;
                if (d < bd) { bd = d; best = c.transform; }
            }
            return best;
        }

        void EnterRagdoll(Transform hitBone, Vector3 point, Vector3 shotDir, bool head)
        {
            _ragdolled = true;
            _deathTime = Time.time;
            var b = Body;
            // Mass split roughly like a 70 kg frame.
            var bodies = new Dictionary<Transform, Rigidbody>();
            void Rb(Transform t, float mass)
            {
                var rb = t.gameObject.AddComponent<Rigidbody>();
                rb.mass = mass;
                rb.linearDamping = 0.05f;
                rb.angularDamping = 0.6f;
                rb.interpolation = RigidbodyInterpolation.Interpolate;
                rb.collisionDetectionMode = CollisionDetectionMode.ContinuousSpeculative;
                bodies[t] = rb;
                _ragdollBodies.Add(rb);
            }
            Rb(b.Pelvis, 14f); Rb(b.Spine, 10f); Rb(b.Chest, 12f); Rb(b.Head, 5f);
            Rb(b.UpperArmL, 2.5f); Rb(b.ForearmL, 2f); Rb(b.UpperArmR, 2.5f); Rb(b.ForearmR, 2f);
            Rb(b.ThighL, 7f); Rb(b.ShinL, 4f); Rb(b.ThighR, 7f); Rb(b.ShinR, 4f);

            void Joint(Transform child, Transform parent, float swing, float twistLow, float twistHigh)
            {
                var j = child.gameObject.AddComponent<CharacterJoint>();
                j.connectedBody = bodies[parent];
                j.axis = Vector3.right;
                j.swingAxis = Vector3.forward;
                j.lowTwistLimit = new SoftJointLimit { limit = twistLow };
                j.highTwistLimit = new SoftJointLimit { limit = twistHigh };
                j.swing1Limit = new SoftJointLimit { limit = swing };
                j.swing2Limit = new SoftJointLimit { limit = swing };
                j.enableProjection = true;
            }
            Joint(b.Spine, b.Pelvis, 20f, -20f, 25f);
            Joint(b.Chest, b.Spine, 20f, -20f, 25f);
            Joint(b.Head, b.Chest, 35f, -40f, 40f); // neck folded into head for the ragdoll
            Joint(b.UpperArmL, b.Chest, 70f, -70f, 60f);
            Joint(b.ForearmL, b.UpperArmL, 15f, -110f, 5f);
            Joint(b.UpperArmR, b.Chest, 70f, -70f, 60f);
            Joint(b.ForearmR, b.UpperArmR, 15f, -110f, 5f);
            Joint(b.ThighL, b.Pelvis, 35f, -60f, 30f);
            Joint(b.ShinL, b.ThighL, 8f, -5f, 120f);
            Joint(b.ThighR, b.Pelvis, 35f, -60f, 30f);
            Joint(b.ShinR, b.ThighR, 8f, -5f, 120f);

            // Colliders on bones that did not get a rigidbody (neck) would be
            // parented statically to the head — disable to avoid self-collision.
            foreach (var c in b.Hitboxes)
            {
                if (c.GetComponent<Rigidbody>() == null) c.enabled = false;
                c.gameObject.layer = Layers.HunterRagdoll;
            }
            Physics.IgnoreLayerCollision(Layers.HunterRagdoll, Layers.HunterRagdoll, false);

            // Momentum: carry some of the current movement, plus the killing round.
            var carry = Brain != null
                ? Brain.Facing.ToU() * Mathf.Min(Brain.CurrentSpeed, 3f)
                : transform.forward * Mathf.Min(_puppetInput.Speed, 3f);
            foreach (var rb in _ragdollBodies) rb.linearVelocity = carry * 0.8f;
            var hitRb = hitBone.GetComponentInParent<Rigidbody>();
            if (hitRb == null) hitRb = bodies[b.Chest];
            hitRb.AddForceAtPosition(shotDir.normalized * (head ? 90f : 140f), point, ForceMode.Impulse);
            if (Body.Sensor != null) Body.Sensor.enabled = false;
        }

        void UpdateDeath()
        {
            float t = Time.time - _deathTime;
            // Shadow fades as the body is on the floor (its own mesh now reads as grounded).
            BreachMaterials.SetColor(_shadowMat, new Color(0, 0, 0, Mathf.Lerp(0.55f, 0f, t / 0.6f)));
            if (Body != null) _shadow.transform.position = new Vector3(Body.Pelvis.position.x, FloorY + 0.004f, Body.Pelvis.position.z);
            if (t > 3.5f)
            {
                foreach (var rb in _ragdollBodies)
                    if (rb != null && !rb.isKinematic) rb.isKinematic = true;
            }
        }

        // ------------------------------------------------------------------ targeting + IHunterSenses

        readonly List<HuntTarget> _soloTargets = new List<HuntTarget>(1);

        IReadOnlyList<HuntTarget> Targets()
        {
            if (TargetProvider != null) return TargetProvider();
            _soloTargets.Clear();
            _soloTargets.Add(new HuntTarget { Client = 0, Eye = _cam.transform.position, Forward = _cam.transform.forward, Alive = true, Local = true });
            return _soloTargets;
        }

        /// <summary>Nearest living player, with hysteresis so it does not flip-flop between teammates.</summary>
        void SelectTarget()
        {
            var targets = Targets();
            bool found = false;
            HuntTarget current = default;
            for (int i = 0; i < targets.Count; i++)
                if (targets[i].Client == _target.Client) { current = targets[i]; found = targets[i].Alive; }

            if (found && Time.time < _nextRetarget)
            {
                _target = current;
                return;
            }

            float best = float.MaxValue;
            HuntTarget pick = found ? current : default;
            bool any = found;
            for (int i = 0; i < targets.Count; i++)
            {
                var t = targets[i];
                if (!t.Alive) continue;
                float d = HorizontalDistance(t.Eye, transform.position) - (found && t.Client == current.Client ? 1.0f : 0f);
                if (d < best) { best = d; pick = t; any = true; }
            }
            if (!any && targets.Count > 0) pick = targets[0];
            if (pick.Client != _target.Client) _nextRetarget = Time.time + 2f;
            _target = pick;
        }

        static float HorizontalDistance(Vector3 a, Vector3 b)
        {
            float dx = a.x - b.x, dz = a.z - b.z;
            return Mathf.Sqrt(dx * dx + dz * dz);
        }

        public SVector3 PlayerEye => (_target.Eye == Vector3.zero && _cam != null ? _cam.transform.position : _target.Eye).ToS();
        public SVector3 PlayerForward => (_target.Forward == Vector3.zero && _cam != null ? _cam.transform.forward : _target.Forward).ToS();
        public float FloorY => _room.FloorY ?? (_cam.transform.position.y - 1.4f);
        public IReadOnlyList<TacticalPoint> TacticalPoints => _room.Points;

        /// <summary>Visible to ANY living player — the Hunter hides from the whole team.</summary>
        public bool PlayerCanSee(SVector3 hunterFloorPosition)
        {
            var p = hunterFloorPosition.ToU();
            var targets = Targets();
            for (int i = 0; i < targets.Count; i++)
            {
                var t = targets[i];
                if (!t.Alive) continue;
                if (t.Local ? LocalCanSee(p) : RemoteCanSee(t, p)) return true;
            }
            return false;
        }

        bool LocalCanSee(Vector3 p)
        {
            var chest = p + Vector3.up * 0.9f;
            var vp = _cam.WorldToViewportPoint(chest);
            bool inFrustum = vp.z > 0.05f && vp.x > -0.05f && vp.x < 1.05f && vp.y > -0.1f && vp.y < 1.1f;
            return inFrustum && _room.HasLineOfSight(_cam.transform.position, p);
        }

        bool RemoteCanSee(in HuntTarget t, Vector3 p)
        {
            // Remote phones: approximate their camera as a 38° half-angle horizontal cone.
            float yaw = ViewGeometry.YawAngleFromView(t.Eye.ToS(), t.Forward.ToS(), p.ToS());
            return yaw < 38f && _room.HasLineOfSight(t.Eye, p);
        }

        public bool IsPathClear(SVector3 from, SVector3 to) => _room.IsWalkable(from.ToU(), to.ToU());
    }
}
