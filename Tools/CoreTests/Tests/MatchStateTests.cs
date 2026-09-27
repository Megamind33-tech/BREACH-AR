using Breach.Core.Diagnostics;
using Breach.Core.Match;
using NUnit.Framework;

namespace Breach.Core.Tests
{
    public class MatchStateTests
    {
        [Test]
        public void FullLoopScanCountdownKillIntermissionNextEncounter()
        {
            var m = new MatchState(new MatchConfig());
            int encounters = 0;
            m.EncounterStarted += _ => encounters++;
            m.BeginScanning(0);
            Assert.That(m.Phase, Is.EqualTo(MatchPhase.Scanning));
            m.ArenaReady(5);
            Assert.That(m.Phase, Is.EqualTo(MatchPhase.Countdown));
            m.Tick(5 + m.Config.CountdownSeconds + 0.01, 0.016f);
            Assert.That(m.Phase, Is.EqualTo(MatchPhase.Live));
            Assert.That(encounters, Is.EqualTo(1));

            m.RecordShot(true, true);
            m.RecordShot(false, false);
            m.HunterKilled(100, headshot: true, headshotBonus: 50, now: 20);
            Assert.That(m.Score, Is.EqualTo(150));
            Assert.That(m.Kills, Is.EqualTo(1));
            Assert.That(m.Accuracy, Is.EqualTo(0.5f).Within(1e-4));
            Assert.That(m.Phase, Is.EqualTo(MatchPhase.Intermission));

            m.Tick(20 + m.Config.IntermissionSeconds + 0.01, 0.016f);
            Assert.That(m.Phase, Is.EqualTo(MatchPhase.Live));
            Assert.That(encounters, Is.EqualTo(2));
            Assert.That(m.Encounter, Is.EqualTo(1));
        }

        [Test]
        public void TrainingModeCannotDie()
        {
            var m = new MatchState(new MatchConfig { Mode = MatchMode.Training });
            m.BeginScanning(0);
            m.ArenaReady(0);
            m.Tick(10, 0.1f);
            m.PlayerKilled(11);
            Assert.That(m.Phase, Is.EqualTo(MatchPhase.Live));
        }

        [Test]
        public void HuntModeEndsOnPlayerDeath()
        {
            var m = new MatchState(new MatchConfig());
            m.BeginScanning(0);
            m.ArenaReady(0);
            m.Tick(10, 0.1f);
            m.PlayerKilled(11);
            Assert.That(m.Phase, Is.EqualTo(MatchPhase.PlayerDown));
        }

        [Test]
        public void KillingShotResolvedAfterPhaseFlipStillCounts()
        {
            var m = new MatchState(new MatchConfig());
            m.BeginScanning(0);
            m.ArenaReady(0);
            m.Tick(10, 0.1f);
            m.HunterKilled(100, false, 50, 11);
            m.RecordShot(true, false);
            Assert.That(m.ShotsHit, Is.EqualTo(1));
        }

        [Test]
        public void ShotsOutsideLiveAreNotCounted()
        {
            var m = new MatchState(new MatchConfig());
            m.BeginScanning(0);
            m.RecordShot(true, false);
            Assert.That(m.ShotsFired, Is.EqualTo(0));
        }
    }

    public class DiagnosticsTests
    {
        [Test]
        public void ReportContainsSectionsAndRows()
        {
            var r = new DiagnosticsReport()
                .Section("BUILD").Row("commit", "abc123")
                .Section("AR").Row("tracking", "Tracking").Row("planes", 4f, "0");
            var text = r.ToText();
            StringAssert.Contains("[BUILD]", text);
            StringAssert.Contains("commit", text);
            StringAssert.Contains("abc123", text);
            StringAssert.Contains("planes", text);
        }

        [Test]
        public void FrameStatsComputesAverageAndLows()
        {
            var s = new FrameStats(200);
            for (int i = 0; i < 99; i++) s.Add(1 / 60f);
            s.Add(1 / 10f);
            Assert.That(s.AverageFps, Is.InRange(55f, 60f));
            Assert.That(s.OnePercentLowFps, Is.EqualTo(10f).Within(0.5f));
            Assert.That(s.WorstFrameMs, Is.EqualTo(100f).Within(0.5f));
        }
    }
}
