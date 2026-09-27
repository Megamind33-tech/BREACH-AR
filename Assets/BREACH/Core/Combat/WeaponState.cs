using System;

namespace Breach.Core.Combat
{
    public enum FireOutcome
    {
        Fired,
        Cooldown,
        DryFire,
        Reloading,
        Blocked,
    }

    public readonly struct ShotSolution
    {
        public readonly FireOutcome Outcome;
        /// <summary>Aim offset (degrees) applied to the camera-forward ray. +pitch = up.</summary>
        public readonly float PitchOffset;
        public readonly float YawOffset;
        public readonly int ShotIndexInBurst;

        public ShotSolution(FireOutcome outcome, float pitch, float yaw, int shotIndex)
        {
            Outcome = outcome;
            PitchOffset = pitch;
            YawOffset = yaw;
            ShotIndexInBurst = shotIndex;
        }

        public bool Fired => Outcome == FireOutcome.Fired;
    }

    /// <summary>
    /// Engine-independent rifle state machine: fire rate, magazine, reserve,
    /// reload timing, recoil and spread. Time is supplied by the caller so the
    /// model is deterministic and testable.
    /// Pattern reference: ShootAR (MIT) Player.Shoot cooldown/ammo gate, rewritten.
    /// </summary>
    public sealed class WeaponState
    {
        readonly WeaponSpec _spec;
        readonly Random _rng;

        double _nextShotTime;
        double _reloadEndsAt = -1;
        bool _reloadFromEmpty;
        int _burstShots;
        double _lastShotTime = double.NegativeInfinity;

        public WeaponState(WeaponSpec spec, int seed = 1337)
        {
            _spec = spec ?? throw new ArgumentNullException(nameof(spec));
            _rng = new Random(seed);
            AmmoInMagazine = spec.MagazineSize;
            Reserve = spec.StartingReserve;
        }

        public WeaponSpec Spec => _spec;
        public int AmmoInMagazine { get; private set; }
        public int Reserve { get; private set; }
        public bool IsReloading => _reloadEndsAt >= 0;
        public float RecoilPitch { get; private set; }
        public float Spread { get; private set; }
        public int ShotsFired { get; private set; }

        public event Action<bool> ReloadStarted;   // arg: from empty
        public event Action ReloadCompleted;

        public float ReloadProgress(double now)
        {
            if (!IsReloading) return 0f;
            double duration = _reloadFromEmpty ? _spec.EmptyReloadSeconds : _spec.TacticalReloadSeconds;
            double start = _reloadEndsAt - duration;
            return (float)Math.Clamp((now - start) / duration, 0.0, 1.0);
        }

        public bool CanReload =>
            !IsReloading && AmmoInMagazine < _spec.MagazineSize && (Reserve > 0 || _spec.InfiniteReserve);

        public void Reset()
        {
            AmmoInMagazine = _spec.MagazineSize;
            Reserve = _spec.StartingReserve;
            _reloadEndsAt = -1;
            _nextShotTime = 0;
            _burstShots = 0;
            RecoilPitch = 0;
            Spread = 0;
            ShotsFired = 0;
        }

        public void AddReserve(int rounds)
        {
            if (rounds > 0) Reserve += rounds;
        }

        /// <summary>Advance time-based systems: reload completion and recoil recovery.</summary>
        public void Tick(double now, float dt)
        {
            if (IsReloading && now >= _reloadEndsAt)
                CompleteReload();

            // Recoil only recovers once the trigger has paused for a moment.
            if (now - _lastShotTime > _spec.SecondsBetweenShots * 1.5)
            {
                RecoilPitch = MathF.Max(0f, RecoilPitch - _spec.RecoilRecoveryPerSecond * dt);
                Spread = MathF.Max(0f, Spread - _spec.SpreadRecoveryPerSecond * dt);
                if (RecoilPitch <= 0f) _burstShots = 0;
            }
        }

        public bool BeginReload(double now)
        {
            if (!CanReload) return false;
            _reloadFromEmpty = AmmoInMagazine == 0;
            double duration = _reloadFromEmpty ? _spec.EmptyReloadSeconds : _spec.TacticalReloadSeconds;
            _reloadEndsAt = now + duration;
            ReloadStarted?.Invoke(_reloadFromEmpty);
            return true;
        }

        public void CancelReload() => _reloadEndsAt = -1;

        void CompleteReload()
        {
            _reloadEndsAt = -1;
            int needed = _spec.MagazineSize - AmmoInMagazine;
            int taken = _spec.InfiniteReserve ? needed : Math.Min(needed, Reserve);
            if (!_spec.InfiniteReserve) Reserve -= taken;
            AmmoInMagazine += taken;
            ReloadCompleted?.Invoke();
        }

        public ShotSolution TryFire(double now)
        {
            if (IsReloading) return new ShotSolution(FireOutcome.Reloading, 0, 0, _burstShots);
            if (now < _nextShotTime) return new ShotSolution(FireOutcome.Cooldown, 0, 0, _burstShots);
            if (AmmoInMagazine <= 0)
            {
                _nextShotTime = now + 0.25; // limit dry-fire click spam
                return new ShotSolution(FireOutcome.DryFire, 0, 0, _burstShots);
            }

            AmmoInMagazine--;
            ShotsFired++;
            _nextShotTime = now + _spec.SecondsBetweenShots;
            _lastShotTime = now;

            // Spread cone sample (uniform in disc) + accumulated vertical recoil.
            float spread = _spec.BaseSpreadDegrees + Spread;
            double angle = _rng.NextDouble() * Math.PI * 2.0;
            double radius = Math.Sqrt(_rng.NextDouble()) * spread;
            float pitch = RecoilPitch + (float)(Math.Sin(angle) * radius);
            float yaw = (float)(Math.Cos(angle) * radius);

            _burstShots++;
            RecoilPitch = MathF.Min(_spec.RecoilMaxPitch, RecoilPitch + _spec.RecoilPitchPerShot);
            // Yaw jitter grows with burst length so short controlled bursts stay tight.
            float yawKick = (float)(_rng.NextDouble() * 2.0 - 1.0) * _spec.RecoilYawJitter * MathF.Min(1f, _burstShots / 4f);
            yaw += yawKick;
            Spread = MathF.Min(_spec.MaxSpreadDegrees, Spread + _spec.SpreadPerShot);

            return new ShotSolution(FireOutcome.Fired, pitch, yaw, _burstShots);
        }
    }
}
