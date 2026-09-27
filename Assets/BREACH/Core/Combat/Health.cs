using System;
using System.Numerics;

namespace Breach.Core.Combat
{
    public enum HitZone
    {
        Body = 0,
        Head = 1,
        Limb = 2,
    }

    public readonly struct DamageInfo
    {
        public readonly float Amount;
        public readonly HitZone Zone;
        public readonly int SourceId;
        /// <summary>World-space direction the damage travelled (from attacker to victim).</summary>
        public readonly Vector3 Direction;

        public DamageInfo(float amount, HitZone zone, int sourceId, Vector3 direction)
        {
            Amount = amount;
            Zone = zone;
            SourceId = sourceId;
            Direction = direction;
        }

        public static float ZoneMultiplier(HitZone zone) => zone switch
        {
            HitZone.Head => 2.2f,
            HitZone.Limb => 0.75f,
            _ => 1f,
        };
    }

    public readonly struct DamageResult
    {
        public readonly float Applied;
        public readonly bool Killed;
        public readonly bool Ignored;

        public DamageResult(float applied, bool killed, bool ignored)
        {
            Applied = applied;
            Killed = killed;
            Ignored = ignored;
        }
    }

    /// <summary>
    /// Health pool with optional delayed regeneration (player) and a short
    /// post-hit invulnerability window (so one lunge cannot register twice).
    /// </summary>
    public sealed class Health
    {
        public float Max { get; }
        public float Current { get; private set; }
        public bool IsDead => Current <= 0f;
        public float Normalized => Max <= 0 ? 0 : Current / Max;

        public float RegenDelaySeconds { get; set; }
        public float RegenPerSecond { get; set; }
        public float InvulnerabilitySeconds { get; set; }
        public bool Invulnerable { get; set; }

        double _lastDamageTime = double.NegativeInfinity;

        public event Action<DamageInfo, DamageResult> Damaged;
        public event Action Died;

        public Health(float max)
        {
            if (max <= 0) throw new ArgumentOutOfRangeException(nameof(max));
            Max = max;
            Current = max;
        }

        public void Restore()
        {
            Current = Max;
            _lastDamageTime = double.NegativeInfinity;
        }

        public DamageResult Apply(in DamageInfo info, double now)
        {
            if (IsDead || info.Amount <= 0f || Invulnerable)
                return new DamageResult(0, false, true);
            if (now - _lastDamageTime < InvulnerabilitySeconds)
                return new DamageResult(0, false, true);

            float before = Current;
            Current = MathF.Max(0f, Current - info.Amount);
            _lastDamageTime = now;
            var result = new DamageResult(before - Current, Current <= 0f, false);
            Damaged?.Invoke(info, result);
            if (result.Killed) Died?.Invoke();
            return result;
        }

        public void Tick(double now, float dt)
        {
            if (IsDead || RegenPerSecond <= 0f || Current >= Max) return;
            if (now - _lastDamageTime < RegenDelaySeconds) return;
            Current = MathF.Min(Max, Current + RegenPerSecond * dt);
        }
    }
}
