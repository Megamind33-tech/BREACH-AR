using System;
using System.Collections.Generic;
using System.Numerics;
using Breach.Core.Combat;
using Breach.Core.World;

namespace Breach.Core.Hunter
{
    public enum HunterState
    {
        Dormant,
        Emerging,
        Stalking,
        Repositioning,
        Rushing,
        Attacking,
        Retreating,
        Staggered,
        Dead,
    }

    /// <summary>
    /// Decision-making and locomotion for THE HUNTER. The brain owns the
    /// authoritative floor position so it can later run on a network host
    /// while clients only render it.
    /// </summary>
    public sealed class HunterBrain
    {
        readonly Random _rng;
        HunterConfig _config;

        double _stateEnteredAt;
        double _lastTick;
        float _exposure;
        float _recentDamage;
        double _recentDamageStart;
        bool _strikeDone;
        Vector3 _target;
        bool _lastHitWasHead;

        public HunterBrain(HunterConfig config, int seed = 99)
        {
            _config = config ?? throw new ArgumentNullException(nameof(config));
            _rng = new Random(seed);
            Health = new Health(config.MaxHealth);
        }

        public HunterConfig Config => _config;
        public Health Health { get; private set; }
        public HunterState State { get; private set; } = HunterState.Dormant;
        public Vector3 Position { get; private set; }
        public Vector3 Facing { get; private set; } = Vector3.UnitZ;
        public Vector3 MoveTarget => _target;
        public float CurrentSpeed { get; private set; }
        public bool IsAlive => State != HunterState.Dormant && State != HunterState.Dead;
        public bool VisibleToPlayer { get; private set; }
        public bool KilledByHeadshot { get; private set; }
        /// <summary>0..1 progress through the attack wind-up (for animation).</summary>
        public float AttackWindup { get; private set; }

        public event Action<HunterState, HunterState> StateChanged;
        public event Action AttackWindupStarted;
        /// <summary>Raised when the strike resolves. Arg: damage to apply to the player (0 = missed).</summary>
        public event Action<float> AttackStruck;
        public event Action<DamageInfo, DamageResult> Hit;
        public event Action Died;

        public void Spawn(TacticalPoint at, double now, HunterConfig config = null)
        {
            if (config != null) _config = config;
            Health = new Health(_config.MaxHealth);
            Position = at.Position;
            _target = at.Position;
            _exposure = 0;
            _recentDamage = 0;
            KilledByHeadshot = false;
            AttackWindup = 0;
            _lastTick = now;
            SetState(HunterState.Emerging, now);
        }

        public void Despawn(double now) => SetState(HunterState.Dormant, now);

        double TimeInState(double now) => now - _stateEnteredAt;

        void SetState(HunterState next, double now)
        {
            if (next == State && next != HunterState.Staggered) return;
            var prev = State;
            State = next;
            _stateEnteredAt = now;
            _strikeDone = false;
            if (next != HunterState.Attacking) AttackWindup = 0;
            StateChanged?.Invoke(prev, next);
        }

        public DamageResult ApplyHit(in DamageInfo info, double now)
        {
            if (!IsAlive || (State == HunterState.Emerging && TimeInState(now) < 0.2))
                return new DamageResult(0, false, true);

            var scaled = new DamageInfo(info.Amount * DamageInfo.ZoneMultiplier(info.Zone), info.Zone, info.SourceId, info.Direction);
            var result = Health.Apply(scaled, now);
            if (result.Ignored) return result;

            _lastHitWasHead = info.Zone == HitZone.Head;
            Hit?.Invoke(scaled, result);

            if (result.Killed)
            {
                KilledByHeadshot = _lastHitWasHead;
                SetState(HunterState.Dead, now);
                Died?.Invoke();
                return result;
            }

            if (now - _recentDamageStart > _config.StaggerWindowSeconds)
            {
                _recentDamageStart = now;
                _recentDamage = 0;
            }
            _recentDamage += result.Applied;

            if (_recentDamage >= _config.StaggerDamageThreshold)
            {
                _recentDamage = 0;
                SetState(HunterState.Staggered, now);
            }
            else if (State == HunterState.Stalking)
            {
                // Being shot while stalking forces an immediate decision.
                _exposure = _config.ExposureTolerance;
            }
            return result;
        }

        public void Tick(double now, float dt, IHunterSenses senses)
        {
            _lastTick = now;
            if (State == HunterState.Dormant || State == HunterState.Dead) return;

            Vector3 playerFloor = new Vector3(senses.PlayerEye.X, senses.FloorY, senses.PlayerEye.Z);
            float distToPlayer = ViewGeometry.HorizontalDistance(Position, playerFloor);
            VisibleToPlayer = senses.PlayerCanSee(Position);
            float speed = 0f;

            switch (State)
            {
                case HunterState.Emerging:
                    if (TimeInState(now) >= _config.EmergeSeconds)
                        EnterStalk(now, senses, playerFloor);
                    break;

                case HunterState.Stalking:
                    speed = _config.StalkSpeed;
                    _exposure = VisibleToPlayer ? _exposure + dt : MathF.Max(0f, _exposure - dt * 0.5f);
                    if (distToPlayer <= _config.RushTriggerDistance)
                    {
                        SetState(HunterState.Rushing, now);
                    }
                    else if (_exposure >= _config.ExposureTolerance)
                    {
                        _exposure = 0;
                        if (_rng.NextDouble() < _config.Aggression) SetState(HunterState.Rushing, now);
                        else EnterReposition(now, senses, playerFloor);
                    }
                    else if (TimeInState(now) > _config.StalkTimeoutSeconds)
                    {
                        SetState(HunterState.Rushing, now);
                    }
                    else if (Arrived())
                    {
                        // Hold briefly at the stalk point, then pick the next, closer one.
                        if (TimeInState(now) > 1.2 + _rng.NextDouble()) EnterStalk(now, senses, playerFloor);
                        speed = 0f;
                    }
                    break;

                case HunterState.Repositioning:
                    speed = _config.RepositionSpeed;
                    if (Arrived() || TimeInState(now) > _config.RepositionTimeoutSeconds)
                        EnterStalk(now, senses, playerFloor);
                    break;

                case HunterState.Rushing:
                    speed = _config.RushSpeed;
                    _target = playerFloor;
                    if (distToPlayer <= _config.AttackRange)
                    {
                        SetState(HunterState.Attacking, now);
                        AttackWindupStarted?.Invoke();
                    }
                    else if (TimeInState(now) > _config.RushTimeoutSeconds)
                    {
                        EnterReposition(now, senses, playerFloor);
                    }
                    break;

                case HunterState.Attacking:
                {
                    _target = Position;
                    double t = TimeInState(now);
                    AttackWindup = (float)Math.Clamp(t / _config.AttackWindupSeconds, 0, 1);
                    if (!_strikeDone && t >= _config.AttackWindupSeconds)
                    {
                        _strikeDone = true;
                        bool inReach = distToPlayer <= _config.AttackRange * _config.AttackReachTolerance;
                        AttackStruck?.Invoke(inReach ? _config.AttackDamage : 0f);
                    }
                    if (t >= _config.AttackWindupSeconds + _config.AttackRecoverSeconds)
                        EnterRetreat(now, senses, playerFloor);
                    break;
                }

                case HunterState.Retreating:
                    speed = _config.RetreatSpeed;
                    if (Arrived() || TimeInState(now) > _config.RetreatTimeoutSeconds)
                        EnterStalk(now, senses, playerFloor);
                    break;

                case HunterState.Staggered:
                    if (TimeInState(now) >= _config.StaggerSeconds)
                    {
                        if (Health.Normalized < 0.35f && _rng.NextDouble() > _config.Aggression)
                            EnterRetreat(now, senses, playerFloor);
                        else if (_rng.NextDouble() < _config.Aggression + 0.2)
                            SetState(HunterState.Rushing, now);
                        else
                            EnterReposition(now, senses, playerFloor);
                    }
                    break;
            }

            if (!VisibleToPlayer && State != HunterState.Attacking && State != HunterState.Staggered)
                speed *= _config.UnobservedSpeedMultiplier;

            Move(speed, dt, senses, playerFloor);
        }

        bool Arrived() => ViewGeometry.HorizontalDistance(Position, _target) < 0.15f;

        void Move(float speed, float dt, IHunterSenses senses, Vector3 playerFloor)
        {
            CurrentSpeed = 0f;
            var to = new Vector3(_target.X - Position.X, 0, _target.Z - Position.Z);
            float dist = to.Length();
            if (speed > 0f && dist > 0.02f)
            {
                var dir = to / dist;
                float step = MathF.Min(dist, speed * dt);
                var next = Position + dir * step;
                if (!senses.IsPathClear(Position, next + dir * 0.25f))
                {
                    // Slide along the obstacle: try turning either way.
                    bool moved = false;
                    foreach (float deg in new[] { 55f, -55f, 95f, -95f })
                    {
                        var alt = Vector3.Transform(dir, Quaternion.CreateFromAxisAngle(Vector3.UnitY, deg * MathF.PI / 180f));
                        var cand = Position + alt * step;
                        if (senses.IsPathClear(Position, cand + alt * 0.25f))
                        {
                            next = cand;
                            dir = alt;
                            moved = true;
                            break;
                        }
                    }
                    if (!moved) next = Position;
                }
                Position = new Vector3(next.X, senses.FloorY, next.Z);
                CurrentSpeed = step / MathF.Max(dt, 1e-5f);
                if (State != HunterState.Retreating && State != HunterState.Repositioning)
                    Facing = dir;
                else
                    Facing = Vector3.Normalize(Vector3.Lerp(dir, FaceToward(playerFloor), 0.35f));
            }
            else
            {
                Position = new Vector3(Position.X, senses.FloorY, Position.Z);
                var f = FaceToward(playerFloor);
                if (f.LengthSquared() > 0) Facing = f;
            }
        }

        Vector3 FaceToward(Vector3 p)
        {
            var d = new Vector3(p.X - Position.X, 0, p.Z - Position.Z);
            return d.LengthSquared() < 1e-6f ? Facing : Vector3.Normalize(d);
        }

        void EnterStalk(double now, IHunterSenses senses, Vector3 playerFloor)
        {
            _target = PickStalkPoint(senses, playerFloor);
            SetState(HunterState.Stalking, now);
        }

        void EnterReposition(double now, IHunterSenses senses, Vector3 playerFloor)
        {
            _target = PickCoverPoint(senses, playerFloor, preferLateral: true);
            SetState(HunterState.Repositioning, now);
        }

        void EnterRetreat(double now, IHunterSenses senses, Vector3 playerFloor)
        {
            _target = PickCoverPoint(senses, playerFloor, preferLateral: false);
            SetState(HunterState.Retreating, now);
        }

        /// <summary>A hidden point nearer the player, ideally flanking.</summary>
        Vector3 PickStalkPoint(IHunterSenses senses, Vector3 playerFloor)
        {
            float current = ViewGeometry.HorizontalDistance(Position, playerFloor);
            float best = float.NegativeInfinity;
            Vector3? pick = null;
            var points = senses.TacticalPoints;
            if (points != null)
            {
                for (int i = 0; i < points.Count; i++)
                {
                    var p = points[i];
                    float d = ViewGeometry.HorizontalDistance(p.Position, playerFloor);
                    if (d < _config.StalkRingMin || d > _config.StalkRingMax) continue;
                    if (d > current + 0.3f) continue;
                    if (ViewGeometry.HorizontalDistance(p.Position, Position) < 0.4f) continue;
                    float s = 0f;
                    if (!senses.PlayerCanSee(p.Position)) s += 3f;
                    if (p.IsCover) s += 1.5f;
                    float yaw = ViewGeometry.YawAngleFromView(senses.PlayerEye, senses.PlayerForward, p.Position);
                    s += yaw / 90f; // flanks and rear
                    s -= ViewGeometry.HorizontalDistance(p.Position, Position) * 0.2f;
                    s += (float)_rng.NextDouble() * 0.5f;
                    if (s > best) { best = s; pick = p.Position; }
                }
            }
            if (pick.HasValue) return pick.Value;

            // No geometry: close in along a flanking arc.
            var toHunter = new Vector3(Position.X - playerFloor.X, 0, Position.Z - playerFloor.Z);
            if (toHunter.LengthSquared() < 1e-4f) toHunter = Vector3.UnitZ;
            toHunter = Vector3.Normalize(toHunter);
            float side = _rng.NextDouble() < 0.5 ? -1f : 1f;
            var rotated = Vector3.Transform(toHunter, Quaternion.CreateFromAxisAngle(Vector3.UnitY, side * 0.6f));
            float ring = MathF.Max(_config.StalkRingMin, MathF.Min(current - 0.8f, _config.StalkRingMax));
            return playerFloor + rotated * ring;
        }

        /// <summary>A point that breaks line of sight, lateral (reposition) or away (retreat).</summary>
        Vector3 PickCoverPoint(IHunterSenses senses, Vector3 playerFloor, bool preferLateral)
        {
            float best = float.NegativeInfinity;
            Vector3? pick = null;
            var points = senses.TacticalPoints;
            var fromPlayer = new Vector3(Position.X - playerFloor.X, 0, Position.Z - playerFloor.Z);
            if (fromPlayer.LengthSquared() < 1e-4f) fromPlayer = Vector3.UnitZ;
            fromPlayer = Vector3.Normalize(fromPlayer);

            if (points != null)
            {
                for (int i = 0; i < points.Count; i++)
                {
                    var p = points[i];
                    float travel = ViewGeometry.HorizontalDistance(p.Position, Position);
                    if (travel < 0.5f || travel > 4.5f) continue;
                    float dPlayer = ViewGeometry.HorizontalDistance(p.Position, playerFloor);
                    if (dPlayer < 1.8f) continue;
                    float s = 0f;
                    if (!senses.PlayerCanSee(p.Position)) s += 4f;
                    if (p.IsCover) s += 2f;
                    var dir = Vector3.Normalize(new Vector3(p.Position.X - Position.X, 0, p.Position.Z - Position.Z));
                    float away = Vector3.Dot(dir, fromPlayer);
                    s += preferLateral ? (1f - MathF.Abs(away)) * 1.5f : away * 1.5f;
                    s -= travel * 0.25f;
                    s += (float)_rng.NextDouble() * 0.5f;
                    if (s > best) { best = s; pick = p.Position; }
                }
            }
            if (pick.HasValue) return pick.Value;

            var lateral = Vector3.Cross(Vector3.UnitY, fromPlayer);
            float side = _rng.NextDouble() < 0.5 ? -1f : 1f;
            var d2 = preferLateral ? Vector3.Normalize(lateral * side + fromPlayer * 0.3f) : Vector3.Normalize(fromPlayer + lateral * side * 0.4f);
            return Position + d2 * 2.2f;
        }
    }
}
