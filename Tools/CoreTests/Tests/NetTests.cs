using System.Net;
using System.Numerics;
using Breach.Core.Match;
using Breach.Core.Net;
using NUnit.Framework;

namespace Breach.Core.Tests
{
    public class ProtocolTests
    {
        [Test]
        public void PoseRoundTrips()
        {
            var p = new PlayerPose { Sequence = 513, Subject = 4, Eye = new Vector3(1, 1.5f, -2), Rotation = Quaternion.CreateFromYawPitchRoll(0.3f, 0.1f, 0), Health = 74, Flags = PlayerFlags.Alive | PlayerFlags.OriginLocked };
            var q = NetProtocol.DecodePose(NetProtocol.Encode(p));
            Assert.That(q.Sequence, Is.EqualTo(513));
            Assert.That(q.Subject, Is.EqualTo(4UL));
            Assert.That(q.Eye, Is.EqualTo(p.Eye));
            Assert.That(q.Rotation, Is.EqualTo(p.Rotation));
            Assert.That(q.Health, Is.EqualTo(74));
            Assert.That(q.Flags, Is.EqualTo(PlayerFlags.Alive | PlayerFlags.OriginLocked));
        }

        [Test]
        public void HunterMatchEventRosterRoundTrip()
        {
            var h = new HunterSnapshot { Sequence = 9, SpawnId = 3, State = 4, Position = new Vector3(2, 0, 3), FacingYaw = 170, Speed = 3.1f, AttackWindup = 0.5f, Health01 = 0.4f, TargetClient = 7 };
            var h2 = NetProtocol.DecodeHunter(NetProtocol.Encode(h));
            Assert.That(h2.SpawnId, Is.EqualTo(3));
            Assert.That(h2.Position, Is.EqualTo(h.Position));
            Assert.That(h2.TargetClient, Is.EqualTo(7UL));

            var m = new MatchSnapshot { Phase = 3, Mode = 0, Score = 450, Kills = 3, Headshots = 1, Encounter = 3, LiveSeconds = 121.5f, CountdownRemaining = 0 };
            var m2 = NetProtocol.DecodeMatch(NetProtocol.Encode(m));
            Assert.That(m2.Score, Is.EqualTo(450));
            Assert.That(m2.LiveSeconds, Is.EqualTo(121.5f));

            var e = new GameEvent { Kind = GameEventKind.ShotClaim, SpawnId = 3, Client = 2, Zone = 1, Flag = true, Amount = 34, Point = new Vector3(1, 1, 1), Direction = Vector3.UnitZ };
            var e2 = NetProtocol.DecodeEvent(NetProtocol.Encode(e));
            Assert.That(e2.Kind, Is.EqualTo(GameEventKind.ShotClaim));
            Assert.That(e2.Client, Is.EqualTo(2UL));
            Assert.That(e2.Flag, Is.True);
            Assert.That(e2.Direction, Is.EqualTo(Vector3.UnitZ));

            var roster = new[] { new RosterEntry { Client = 0, Flags = PlayerFlags.Ready, Health = 100, Callsign = "HOST" }, new RosterEntry { Client = 1, Flags = PlayerFlags.Alive, Health = 50, Callsign = "B" } };
            var r2 = NetProtocol.DecodeRoster(NetProtocol.Encode(roster));
            Assert.That(r2.Length, Is.EqualTo(2));
            Assert.That(r2[1].Callsign, Is.EqualTo("B"));
        }

        [Test]
        public void RejectsWrongVersion()
        {
            var bytes = NetProtocol.Encode(new PlayerPose());
            bytes[0] = 99;
            Assert.Throws<System.IO.InvalidDataException>(() => NetProtocol.DecodePose(bytes));
        }
    }

    public class SnapshotBufferTests
    {
        [Test]
        public void InterpolatesBetweenSamples()
        {
            var b = new SnapshotBuffer { InterpolationDelay = 0.1f };
            b.Add(1.0, new Vector3(0, 0, 0), 0);
            b.Add(1.1, new Vector3(1, 0, 0), 90);
            Assert.That(b.TrySample(1.15, out var p, out var yaw), Is.True);
            Assert.That(p.X, Is.EqualTo(0.5f).Within(1e-4));
            Assert.That(yaw, Is.EqualTo(45f).Within(1e-3));
        }

        [Test]
        public void ExtrapolatesBrieflyThenHolds()
        {
            var b = new SnapshotBuffer { InterpolationDelay = 0f, MaxExtrapolation = 0.2f };
            b.Add(1.0, Vector3.Zero, 0);
            b.Add(1.1, new Vector3(1, 0, 0), 0);
            b.TrySample(1.2, out var p, out _);
            Assert.That(p.X, Is.EqualTo(2f).Within(1e-3));
            b.TrySample(5.0, out var far, out _);
            Assert.That(far.X, Is.EqualTo(3f).Within(1e-3), "extrapolation capped");
        }

        [Test]
        public void TeleportClearsHistory()
        {
            var b = new SnapshotBuffer { InterpolationDelay = 0.1f, TeleportDistance = 2f };
            b.Add(1.0, Vector3.Zero, 0);
            b.Add(1.1, new Vector3(10, 0, 0), 0);
            Assert.That(b.Count, Is.EqualTo(1));
            b.TrySample(1.12, out var p, out _);
            Assert.That(p.X, Is.EqualTo(10f));
        }

        [Test]
        public void AngleLerpTakesShortWay()
        {
            Assert.That(SnapshotBuffer.LerpAngle(350, 10, 0.5f), Is.EqualTo(360f).Within(1e-3));
        }

        [Test]
        public void IgnoresOutOfOrder()
        {
            var b = new SnapshotBuffer();
            b.Add(2.0, Vector3.Zero, 0);
            b.Add(1.5, Vector3.One, 0);
            Assert.That(b.Count, Is.EqualTo(1));
        }
    }

    public class ClaimValidatorTests
    {
        [Test]
        public void AcceptsPlausibleClaim()
        {
            var v = new ClaimValidator();
            v.RecordHunter(10.0, new Vector3(2, 0, 3));
            Assert.That(v.Validate(1, 10.2, true, 5, 5, new Vector3(2.2f, 1.1f, 3.1f), 34), Is.EqualTo(ClaimVerdict.Accepted));
        }

        [Test]
        public void RejectsImplausibleClaims()
        {
            var v = new ClaimValidator();
            v.RecordHunter(10.0, new Vector3(2, 0, 3));
            Assert.That(v.Validate(1, 10.1, false, 5, 5, new Vector3(2, 1, 3), 34), Is.EqualTo(ClaimVerdict.RejectedNoTarget));
            Assert.That(v.Validate(1, 10.1, true, 4, 5, new Vector3(2, 1, 3), 34), Is.EqualTo(ClaimVerdict.RejectedStaleSpawn));
            Assert.That(v.Validate(1, 10.1, true, 5, 5, new Vector3(9, 1, 3), 34), Is.EqualTo(ClaimVerdict.RejectedTooFar));
            Assert.That(v.Validate(1, 10.1, true, 5, 5, new Vector3(2, 1, 3), 500), Is.EqualTo(ClaimVerdict.RejectedDamage));
            Assert.That(v.Validate(1, 11.5, true, 5, 5, new Vector3(2, 1, 3), 34), Is.EqualTo(ClaimVerdict.RejectedTooFar), "stale history");
        }

        [Test]
        public void RateLimitsPerClient()
        {
            var v = new ClaimValidator();
            v.RecordHunter(10.0, Vector3.Zero);
            Assert.That(v.Validate(1, 10.0, true, 1, 1, new Vector3(0, 1, 0), 34), Is.EqualTo(ClaimVerdict.Accepted));
            Assert.That(v.Validate(1, 10.01, true, 1, 1, new Vector3(0, 1, 0), 34), Is.EqualTo(ClaimVerdict.RejectedRate));
            Assert.That(v.Validate(2, 10.01, true, 1, 1, new Vector3(0, 1, 0), 34), Is.EqualTo(ClaimVerdict.Accepted), "other client unaffected");
        }
    }

    public class RoomCodeTests
    {
        [Test]
        public void RoundTripsOnSameNetwork()
        {
            var host = IPAddress.Parse("192.168.1.37");
            var code = RoomCode.FromAddress(host);
            Assert.That(code, Is.EqualTo("1.37"));
            Assert.That(RoomCode.TryResolve(code, IPAddress.Parse("192.168.1.80"), out var resolved), Is.True);
            Assert.That(resolved, Is.EqualTo(host));
        }

        [Test]
        public void ShortAndFullForms()
        {
            Assert.That(RoomCode.TryResolve("37", IPAddress.Parse("10.0.4.2"), out var a), Is.True);
            Assert.That(a, Is.EqualTo(IPAddress.Parse("10.0.4.37")));
            Assert.That(RoomCode.TryResolve("172.16.0.9", IPAddress.Parse("10.0.4.2"), out var b), Is.True);
            Assert.That(b, Is.EqualTo(IPAddress.Parse("172.16.0.9")));
            Assert.That(RoomCode.TryResolve("x.y", IPAddress.Parse("10.0.4.2"), out _), Is.False);
            Assert.That(RoomCode.TryResolve("300", IPAddress.Parse("10.0.4.2"), out _), Is.False);
        }
    }

    public class RemoteMatchTests
    {
        [Test]
        public void ClientMirrorsHostAndDoesNotSelfAdvance()
        {
            var m = new MatchState(new MatchConfig()) { Remote = true };
            MatchPhase seen = MatchPhase.Idle;
            m.PhaseChanged += (_, p) => seen = p;
            m.ApplyRemote(MatchPhase.Countdown, 0, 0, 0, 0, 0, 1);
            m.Tick(100, 1f); // would start the encounter if local
            Assert.That(m.Phase, Is.EqualTo(MatchPhase.Countdown));
            m.ApplyRemote(MatchPhase.Live, 150, 1, 1, 1, 30, 2);
            Assert.That(seen, Is.EqualTo(MatchPhase.Live));
            Assert.That(m.Score, Is.EqualTo(150));
        }
    }
}
