using System.Numerics;
using Breach.Core.Combat;
using Breach.Core.Hunter;
using Breach.Core.World;
using NUnit.Framework;

namespace Breach.Core.Tests
{
    public class HunterBrainTests
    {
        const float Dt = 1 / 30f;

        static (HunterBrain brain, FakeSenses senses) Make(Vector3 spawn, HunterConfig cfg = null)
        {
            var senses = new FakeSenses();
            var brain = new HunterBrain(cfg ?? new HunterConfig());
            brain.Spawn(new TacticalPoint(spawn, TacticalKind.OpenFloor, Vector3.Zero), 0);
            return (brain, senses);
        }

        static double Run(HunterBrain b, FakeSenses s, double from, double seconds, System.Func<bool> stop = null)
        {
            double t = from;
            for (; t < from + seconds; t += Dt)
            {
                b.Tick(t, Dt, s);
                if (stop != null && stop()) break;
            }
            return t;
        }

        [Test]
        public void EmergesThenStalks()
        {
            var (b, s) = Make(new Vector3(0, 0, -5));
            Assert.That(b.State, Is.EqualTo(HunterState.Emerging));
            Run(b, s, 0, b.Config.EmergeSeconds + 0.1);
            Assert.That(b.State, Is.EqualTo(HunterState.Stalking));
        }

        [Test]
        public void EventuallyReachesAndAttacksAnIdlePlayer()
        {
            var (b, s) = Make(new Vector3(0, 0, -5));
            float struck = -1;
            b.AttackStruck += d => struck = d;
            Run(b, s, 0, 20, () => struck >= 0);
            Assert.That(struck, Is.EqualTo(b.Config.AttackDamage), "strike should land on a stationary player");
        }

        [Test]
        public void StrikeMissesIfPlayerEscapesDuringWindup()
        {
            var (b, s) = Make(new Vector3(0, 0, -5));
            float struck = -1;
            b.AttackWindupStarted += () => s.PlayerEye = new Vector3(0, 1.5f, 10); // player steps away
            b.AttackStruck += d => struck = d;
            Run(b, s, 0, 20, () => struck >= 0);
            Assert.That(struck, Is.EqualTo(0f));
        }

        [Test]
        public void StaysOnFloor()
        {
            var (b, s) = Make(new Vector3(2, 0.3f, -4));
            s.FloorY = -0.02f;
            Run(b, s, 0, 5);
            Assert.That(b.Position.Y, Is.EqualTo(s.FloorY).Within(1e-5));
        }

        [Test]
        public void DiesAfterEnoughBodyHitsAndReportsHeadshotKill()
        {
            var (b, s) = Make(new Vector3(0, 0, 4));
            Run(b, s, 0, 1.5);
            int hits = 0;
            double t = 2;
            while (b.IsAlive && hits < 50)
            {
                b.ApplyHit(new DamageInfo(34, hits >= 3 ? HitZone.Head : HitZone.Body, 1, -Vector3.UnitZ), t);
                t += 0.1;
                hits++;
            }
            Assert.That(b.State, Is.EqualTo(HunterState.Dead));
            Assert.That(b.KilledByHeadshot, Is.True);
            Assert.That(hits, Is.InRange(4, 6));
        }

        [Test]
        public void HeavyBurstStaggers()
        {
            var (b, s) = Make(new Vector3(0, 0, 4));
            Run(b, s, 0, 1.5);
            b.ApplyHit(new DamageInfo(34, HitZone.Body, 1, -Vector3.UnitZ), 2.0);
            b.ApplyHit(new DamageInfo(34, HitZone.Body, 1, -Vector3.UnitZ), 2.1);
            Assert.That(b.State, Is.EqualTo(HunterState.Staggered));
            Run(b, s, 2.1, b.Config.StaggerSeconds + 0.1);
            Assert.That(b.State, Is.Not.EqualTo(HunterState.Staggered));
        }

        [Test]
        public void IgnoresHitsInFirstMomentOfEmerging()
        {
            var (b, _) = Make(new Vector3(0, 0, 4));
            var r = b.ApplyHit(new DamageInfo(500, HitZone.Head, 1, Vector3.UnitZ), 0.05);
            Assert.That(r.Ignored, Is.True);
            Assert.That(b.IsAlive, Is.True);
        }

        [Test]
        public void ReactsToBeingWatched()
        {
            var cfg = new HunterConfig { Aggression = 0f, RushTriggerDistance = 0.1f };
            var (b, s) = Make(new Vector3(0, 0, 8), cfg);
            s.ViewHalfAngle = 90; // stares straight at it
            HunterState seen = HunterState.Dormant;
            b.StateChanged += (_, n) => { if (n == HunterState.Repositioning) seen = n; };
            Run(b, s, 0, cfg.EmergeSeconds + cfg.ExposureTolerance + 1.0);
            Assert.That(seen, Is.EqualTo(HunterState.Repositioning));
        }

        [Test]
        public void MovesFasterWhenUnobserved()
        {
            var cfg = new HunterConfig { RushTriggerDistance = 0.1f, ExposureTolerance = 100f, StalkTimeoutSeconds = 100f };
            var (seenBrain, seen) = Make(new Vector3(0, 0, 6), cfg);
            seen.ViewHalfAngle = 180;
            var (hidBrain, hidden) = Make(new Vector3(0, 0, 6), cfg);
            hidden.Blind = true;
            Run(seenBrain, seen, 0, cfg.EmergeSeconds + 0.6);
            Run(hidBrain, hidden, 0, cfg.EmergeSeconds + 0.6);
            Assert.That(hidBrain.CurrentSpeed, Is.GreaterThan(seenBrain.CurrentSpeed * 1.5f));
        }

        [Test]
        public void NavigatesAroundWall()
        {
            var (b, s) = Make(new Vector3(3, 0, 0));
            s.WallX = 1.5f;
            s.WallZMin = -0.8f;
            s.WallZMax = 0.8f;
            float struck = -1;
            b.AttackStruck += d => struck = d;
            Run(b, s, 0, 25, () => struck >= 0);
            Assert.That(struck, Is.GreaterThan(0f), "Hunter should path around the wall and reach the player");
        }

        [Test]
        public void PrefersHiddenStalkPoints()
        {
            var (b, s) = Make(new Vector3(0, 0, 6));
            s.ViewHalfAngle = 40;
            // One point in plain view, one to the flank out of view.
            s.Points.Add(new TacticalPoint(new Vector3(0, 0, 3), TacticalKind.OpenFloor, Vector3.Zero));
            s.Points.Add(new TacticalPoint(new Vector3(2.6f, 0, 1.2f), TacticalKind.WallCover, -Vector3.UnitX));
            Run(b, s, 0, b.Config.EmergeSeconds + 0.05);
            Assert.That(b.State, Is.EqualTo(HunterState.Stalking));
            Assert.That(Vector3.Distance(b.MoveTarget, new Vector3(2.6f, 0, 1.2f)), Is.LessThan(0.01f));
        }

        [Test]
        public void EncounterScalingIncreasesThreat()
        {
            var a = HunterConfig.ForEncounter(0);
            var z = HunterConfig.ForEncounter(20);
            Assert.That(z.Aggression, Is.GreaterThan(a.Aggression));
            Assert.That(z.StalkSpeed, Is.GreaterThan(a.StalkSpeed));
            Assert.That(z.AttackWindupSeconds, Is.LessThan(a.AttackWindupSeconds));
        }
    }
}
