using Breach.Core.Combat;
using NUnit.Framework;

namespace Breach.Core.Tests
{
    public class WeaponStateTests
    {
        [Test]
        public void FiresAtRatedCadenceAndConsumesAmmo()
        {
            var spec = WeaponSpec.DefaultRifle();
            var w = new WeaponState(spec);
            Assert.That(w.TryFire(0).Fired, Is.True);
            Assert.That(w.TryFire(0.01).Outcome, Is.EqualTo(FireOutcome.Cooldown));
            Assert.That(w.TryFire(spec.SecondsBetweenShots + 1e-4).Fired, Is.True);
            Assert.That(w.AmmoInMagazine, Is.EqualTo(spec.MagazineSize - 2));
        }

        [Test]
        public void EmptyMagazineDryFiresUntilReloaded()
        {
            var spec = WeaponSpec.DefaultRifle();
            var w = new WeaponState(spec);
            double t = 0;
            for (int i = 0; i < spec.MagazineSize; i++, t += 1) Assert.That(w.TryFire(t).Fired, Is.True);
            Assert.That(w.TryFire(t).Outcome, Is.EqualTo(FireOutcome.DryFire));

            Assert.That(w.BeginReload(t), Is.True);
            Assert.That(w.TryFire(t + 0.1).Outcome, Is.EqualTo(FireOutcome.Reloading));
            w.Tick(t + spec.EmptyReloadSeconds - 0.01, 0.016f);
            Assert.That(w.IsReloading, Is.True, "empty reload uses the longer duration");
            w.Tick(t + spec.EmptyReloadSeconds + 0.01, 0.016f);
            Assert.That(w.IsReloading, Is.False);
            Assert.That(w.AmmoInMagazine, Is.EqualTo(spec.MagazineSize));
            Assert.That(w.Reserve, Is.EqualTo(spec.StartingReserve - spec.MagazineSize));
        }

        [Test]
        public void TacticalReloadIsFasterAndTakesOnlyWhatIsNeeded()
        {
            var spec = WeaponSpec.DefaultRifle();
            var w = new WeaponState(spec);
            for (int i = 0; i < 5; i++) w.TryFire(i);
            Assert.That(w.BeginReload(10), Is.True);
            w.Tick(10 + spec.TacticalReloadSeconds + 0.01, 0.016f);
            Assert.That(w.AmmoInMagazine, Is.EqualTo(spec.MagazineSize));
            Assert.That(w.Reserve, Is.EqualTo(spec.StartingReserve - 5));
        }

        [Test]
        public void CannotReloadFullOrWithoutReserve()
        {
            var spec = WeaponSpec.DefaultRifle();
            spec.StartingReserve = 0;
            var w = new WeaponState(spec);
            Assert.That(w.BeginReload(0), Is.False, "full magazine");
            w.TryFire(0);
            Assert.That(w.BeginReload(1), Is.False, "no reserve");
        }

        [Test]
        public void InfiniteReserveNeverDepletes()
        {
            var spec = WeaponSpec.DefaultRifle();
            spec.InfiniteReserve = true;
            spec.StartingReserve = 0;
            var w = new WeaponState(spec);
            for (int i = 0; i < 10; i++) w.TryFire(i);
            Assert.That(w.BeginReload(20), Is.True);
            w.Tick(30, 0.016f);
            Assert.That(w.AmmoInMagazine, Is.EqualTo(spec.MagazineSize));
        }

        [Test]
        public void RecoilClimbsDuringBurstAndRecoversAfterRelease()
        {
            var spec = WeaponSpec.DefaultRifle();
            var w = new WeaponState(spec);
            double t = 0;
            for (int i = 0; i < 6; i++, t += spec.SecondsBetweenShots + 1e-4) w.TryFire(t);
            float climbed = w.RecoilPitch;
            Assert.That(climbed, Is.GreaterThan(spec.RecoilPitchPerShot * 5f));
            Assert.That(climbed, Is.LessThanOrEqualTo(spec.RecoilMaxPitch));
            for (int i = 0; i < 120; i++) { t += 1 / 60.0; w.Tick(t, 1 / 60f); }
            Assert.That(w.RecoilPitch, Is.EqualTo(0).Within(1e-4));
            Assert.That(w.Spread, Is.EqualTo(0).Within(1e-4));
        }

        [Test]
        public void ShotOffsetsStayInsideSpreadPlusRecoil()
        {
            var spec = WeaponSpec.DefaultRifle();
            var w = new WeaponState(spec, seed: 5);
            var s = w.TryFire(0);
            float bound = spec.BaseSpreadDegrees + spec.RecoilYawJitter + 1e-3f;
            Assert.That(System.Math.Abs(s.YawOffset), Is.LessThanOrEqualTo(bound));
            Assert.That(System.Math.Abs(s.PitchOffset), Is.LessThanOrEqualTo(spec.BaseSpreadDegrees + 1e-3f));
        }

        [Test]
        public void ReloadEventsFire()
        {
            var w = new WeaponState(WeaponSpec.DefaultRifle());
            bool started = false, done = false;
            w.ReloadStarted += _ => started = true;
            w.ReloadCompleted += () => done = true;
            w.TryFire(0);
            w.BeginReload(1);
            w.Tick(10, 0.016f);
            Assert.That(started && done, Is.True);
        }
    }
}
