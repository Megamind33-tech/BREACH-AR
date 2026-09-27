using System;
using System.Collections.Generic;
using Breach.AR;
using Breach.Combat;
using Breach.Core.Combat;
using Breach.Core.Hunter;
using Breach.Core.World;
using Breach.Presentation;
using Breach.Util;
using UnityEngine;
using SVector3 = System.Numerics.Vector3;

namespace Breach.Hunter
{
    /// <summary>
    /// THE HUNTER in the scene: runs the engine-independent HunterBrain,
    /// answers its questions about the real room (IHunterSenses), drives the
    /// procedural body and animation, positional audio, and ragdoll death.
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

        /// <summary>Damage the Hunter dealt to the player, and the Hunter's world position.</summary>
        public event Action<float, Vector3> StruckPlayer;
        public event Action<HitZone, bool> TookHit;   // zone, killed
        public event Action<bool> Died;              // killed by headshot
        public event Action<HunterState> StateChanged;

        public bool IsAlive => Brain != null && Brain.IsAlive;
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

        public void Spawn(TacticalPoint at, HunterConfig config, double now)
        {
            DespawnBody();
            gameObject.SetActive(true);
            Body = HunterBody.Build(transform, this);
            _anim = new HunterAnimator(Body);
            _anim.Footstep = () => BreachAudio.Instance?.PlayAt(_feet, Sfx.HunterStep, 0.55f, 0.12f);
            _ragdolled = false;
            _shadow.SetActive(true);
            BreachMaterials.SetColor(_shadowMat, new Color(0, 0, 0, 0.55f));

            Brain = new HunterBrain(config, seed: Environment.TickCount);
            Brain.StateChanged += OnBrainState;
            Brain.AttackWindupStarted += () => BreachAudio.Instance?.PlayAt(_voice, Sfx.HunterGrowl, 1f, 0.1f);
            Brain.AttackStruck += dmg =>
            {
                BreachAudio.Instance?.PlayAt(_voice, Sfx.HunterStrike, 1f);
                if (dmg > 0f) StruckPlayer?.Invoke(dmg, transform.position);
            };
            Brain.Spawn(at, now, config);
            transform.position = at.Position.ToU();
            var toPlayer = _cam.transform.position - transform.position;
            toPlayer.y = 0;
            if (toPlayer.sqrMagnitude > 1e-4f) transform.rotation = Quaternion.LookRotation(toPlayer);
            _nextGrowl = Time.time + UnityEngine.Random.Range(1.5f, 3f);
        }

        void OnBrainState(HunterState from, HunterState to)
        {
            if (to == HunterState.Rushing) BreachAudio.Instance?.PlayAt(_voice, Sfx.HunterShriek, 1f, 0.08f);
            StateChanged?.Invoke(to);
        }

        public void Despawn()
        {
            DespawnBody();
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
            if (Brain == null) return;
            double now = Time.timeAsDouble;
            float dt = Mathf.Min(Time.deltaTime, 0.05f);

            if (_ragdolled)
            {
                UpdateDeath();
                return;
            }

            Brain.Tick(now, dt, this);
            transform.position = Brain.Position.ToU();
            var facing = Brain.Facing.ToU();
            if (facing.sqrMagnitude > 1e-4f)
            {
                var target = Quaternion.LookRotation(new Vector3(facing.x, 0, facing.z));
                transform.rotation = Quaternion.RotateTowards(transform.rotation, target, 540f * dt);
            }
            _anim.Tick(Brain, dt, _cam.transform.position);

            // Shadow tightens as the body crouches.
            float pelvisH = Body.Pelvis.localPosition.y;
            float s = Mathf.Lerp(0.75f, 1.05f, Mathf.InverseLerp(0.6f, 0.95f, pelvisH));
            _shadow.transform.localScale = new Vector3(s * 0.85f, 1f, s);

            // Unseen, it makes itself heard — the player must hunt by sound.
            if (Brain.State == HunterState.Stalking && !Brain.VisibleToPlayer && Time.time > _nextGrowl)
            {
                BreachAudio.Instance?.PlayAt(_voice, Sfx.HunterGrowl, 0.75f, 0.12f);
                _nextGrowl = Time.time + UnityEngine.Random.Range(3.5f, 6.5f);
            }
        }

        /// <summary>A round from the player's rifle struck one of our hitboxes.</summary>
        public DamageResult ReceiveHit(HunterHitbox hitbox, Vector3 point, Vector3 shotDir, float damage)
        {
            if (!IsAlive) return new DamageResult(0, false, true);
            var info = new DamageInfo(damage, hitbox.Zone, 0, shotDir.ToS());
            var result = Brain.ApplyHit(info, Time.timeAsDouble);
            if (result.Ignored) return result;

            bool head = hitbox.Zone == HitZone.Head;
            _fx?.HunterHit(point, shotDir, head);
            BreachAudio.Instance?.PlayAt(_voice, Sfx.ImpactFlesh, 0.9f, 0.1f);
            TookHit?.Invoke(hitbox.Zone, result.Killed);

            if (result.Killed)
            {
                BreachAudio.Instance?.PlayAt(_voice, Sfx.HunterDeath, 1f, 0.05f);
                EnterRagdoll(hitbox.transform, point, shotDir, head);
                Died?.Invoke(Brain.KilledByHeadshot);
            }
            else
            {
                _anim.Flinch(shotDir, head);
            }
            return result;
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
            var carry = Brain.Facing.ToU() * Mathf.Min(Brain.CurrentSpeed, 3f);
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

        // ------------------------------------------------------------------ IHunterSenses

        public SVector3 PlayerEye => _cam.transform.position.ToS();
        public SVector3 PlayerForward => _cam.transform.forward.ToS();
        public float FloorY => _room.FloorY ?? (_cam.transform.position.y - 1.4f);
        public IReadOnlyList<TacticalPoint> TacticalPoints => _room.Points;

        public bool PlayerCanSee(SVector3 hunterFloorPosition)
        {
            var p = hunterFloorPosition.ToU();
            var chest = p + Vector3.up * 0.9f;
            var vp = _cam.WorldToViewportPoint(chest);
            bool inFrustum = vp.z > 0.05f && vp.x > -0.05f && vp.x < 1.05f && vp.y > -0.1f && vp.y < 1.1f;
            if (!inFrustum) return false;
            return _room.HasLineOfSight(_cam.transform.position, p);
        }

        public bool IsPathClear(SVector3 from, SVector3 to) => _room.IsWalkable(from.ToU(), to.ToU());
    }
}
