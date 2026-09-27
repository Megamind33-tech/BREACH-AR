using System.Numerics;
using Breach.Core.Combat;
using NUnit.Framework;

namespace Breach.Core.Tests
{
    public class HealthTests
    {
        static DamageInfo Dmg(float a) => new DamageInfo(a, HitZone.Body, 1, Vector3.UnitZ);

        [Test]
        public void KillsAtZeroAndIgnoresFurtherDamage()
        {
            var h = new Health(100);
            bool died = false;
            h.Died += () => died = true;
            Assert.That(h.Apply(Dmg(60), 0).Killed, Is.False);
            var r = h.Apply(Dmg(60), 1);
            Assert.That(r.Killed && died, Is.True);
            Assert.That(r.Applied, Is.EqualTo(40).Within(1e-4));
            Assert.That(h.Apply(Dmg(10), 2).Ignored, Is.True);
        }

        [Test]
        public void InvulnerabilityWindowBlocksDoubleHits()
        {
            var h = new Health(100) { InvulnerabilitySeconds = 0.5f };
            h.Apply(Dmg(10), 0);
            Assert.That(h.Apply(Dmg(10), 0.2).Ignored, Is.True);
            Assert.That(h.Apply(Dmg(10), 0.6).Ignored, Is.False);
            Assert.That(h.Current, Is.EqualTo(80).Within(1e-4));
        }

        [Test]
        public void RegeneratesOnlyAfterDelay()
        {
            var h = new Health(100) { RegenDelaySeconds = 4, RegenPerSecond = 10 };
            h.Apply(Dmg(50), 0);
            h.Tick(3, 1);
            Assert.That(h.Current, Is.EqualTo(50).Within(1e-4));
            h.Tick(5, 1);
            Assert.That(h.Current, Is.EqualTo(60).Within(1e-4));
            for (int i = 0; i < 20; i++) h.Tick(6 + i, 1);
            Assert.That(h.Current, Is.EqualTo(100).Within(1e-4));
        }

        [Test]
        public void HeadshotMultiplierIsHighest()
        {
            Assert.That(DamageInfo.ZoneMultiplier(HitZone.Head), Is.GreaterThan(DamageInfo.ZoneMultiplier(HitZone.Body)));
            Assert.That(DamageInfo.ZoneMultiplier(HitZone.Limb), Is.LessThan(DamageInfo.ZoneMultiplier(HitZone.Body)));
        }
    }
}
