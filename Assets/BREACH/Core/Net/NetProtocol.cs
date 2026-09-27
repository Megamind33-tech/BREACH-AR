using System;
using System.IO;
using System.Numerics;

namespace Breach.Core.Net
{
    /// <summary>
    /// BREACH wire protocol. Every position/rotation on the wire is in
    /// SHARED space (relative to the calibrated origin marker), never in a
    /// device's own AR session space. Encoding is plain little-endian binary
    /// so it can be unit-tested without Unity or a network.
    /// </summary>
    public static class NetProtocol
    {
        public const int Version = 1;

        // Named-message channels.
        public const string PoseChannel = "breach.pose";       // client → host, unreliable, ~20 Hz
        public const string HunterChannel = "breach.hunter";   // host → all, unreliable, ~20 Hz
        public const string MatchChannel = "breach.match";     // host → all, reliable, on change + 2 Hz
        public const string EventChannel = "breach.event";     // both ways, reliable
        public const string RosterChannel = "breach.roster";   // host → all, reliable, on change

        static void W(BinaryWriter w, Vector3 v) { w.Write(v.X); w.Write(v.Y); w.Write(v.Z); }
        static Vector3 RV(BinaryReader r) => new Vector3(r.ReadSingle(), r.ReadSingle(), r.ReadSingle());
        static void W(BinaryWriter w, Quaternion q) { w.Write(q.X); w.Write(q.Y); w.Write(q.Z); w.Write(q.W); }
        static Quaternion RQ(BinaryReader r) => new Quaternion(r.ReadSingle(), r.ReadSingle(), r.ReadSingle(), r.ReadSingle());

        static byte[] Encode(Action<BinaryWriter> body)
        {
            using (var ms = new MemoryStream(64))
            using (var w = new BinaryWriter(ms))
            {
                w.Write((byte)Version);
                body(w);
                w.Flush();
                return ms.ToArray();
            }
        }

        static T Decode<T>(byte[] data, Func<BinaryReader, T> body)
        {
            if (data == null || data.Length < 1) throw new InvalidDataException("empty message");
            using (var ms = new MemoryStream(data))
            using (var r = new BinaryReader(ms))
            {
                int v = r.ReadByte();
                if (v != Version) throw new InvalidDataException($"protocol version {v}, expected {Version}");
                return body(r);
            }
        }

        // ------------------------------------------------------------ pose

        public static byte[] Encode(in PlayerPose p)
        {
            var c = p;
            return Encode(w =>
            {
                w.Write(c.Sequence);
                W(w, c.Eye);
                W(w, c.Rotation);
                w.Write(c.Health);
                w.Write((byte)c.Flags);
            });
        }

        public static PlayerPose DecodePose(byte[] d) => Decode(d, r => new PlayerPose
        {
            Sequence = r.ReadUInt16(),
            Eye = RV(r),
            Rotation = RQ(r),
            Health = r.ReadSingle(),
            Flags = (PlayerFlags)r.ReadByte(),
        });

        // ------------------------------------------------------------ hunter

        public static byte[] Encode(in HunterSnapshot s)
        {
            var c = s;
            return Encode(w =>
            {
                w.Write(c.Sequence);
                w.Write(c.SpawnId);
                w.Write(c.State);
                W(w, c.Position);
                w.Write(c.FacingYaw);
                w.Write(c.Speed);
                w.Write(c.AttackWindup);
                w.Write(c.Health01);
                w.Write(c.TargetClient);
            });
        }

        public static HunterSnapshot DecodeHunter(byte[] d) => Decode(d, r => new HunterSnapshot
        {
            Sequence = r.ReadUInt16(),
            SpawnId = r.ReadUInt16(),
            State = r.ReadByte(),
            Position = RV(r),
            FacingYaw = r.ReadSingle(),
            Speed = r.ReadSingle(),
            AttackWindup = r.ReadSingle(),
            Health01 = r.ReadSingle(),
            TargetClient = r.ReadUInt64(),
        });

        // ------------------------------------------------------------ match

        public static byte[] Encode(in MatchSnapshot m)
        {
            var c = m;
            return Encode(w =>
            {
                w.Write(c.Phase);
                w.Write(c.Mode);
                w.Write(c.Score);
                w.Write(c.Kills);
                w.Write(c.Headshots);
                w.Write(c.Encounter);
                w.Write(c.LiveSeconds);
                w.Write(c.CountdownRemaining);
            });
        }

        public static MatchSnapshot DecodeMatch(byte[] d) => Decode(d, r => new MatchSnapshot
        {
            Phase = r.ReadByte(),
            Mode = r.ReadByte(),
            Score = r.ReadInt32(),
            Kills = r.ReadInt32(),
            Headshots = r.ReadInt32(),
            Encounter = r.ReadInt32(),
            LiveSeconds = r.ReadSingle(),
            CountdownRemaining = r.ReadSingle(),
        });

        // ------------------------------------------------------------ events

        public static byte[] Encode(in GameEvent e)
        {
            var c = e;
            return Encode(w =>
            {
                w.Write((byte)c.Kind);
                w.Write(c.SpawnId);
                w.Write(c.Client);
                w.Write(c.Zone);
                w.Write(c.Flag);
                w.Write(c.Amount);
                W(w, c.Point);
                W(w, c.Direction);
            });
        }

        public static GameEvent DecodeEvent(byte[] d) => Decode(d, r => new GameEvent
        {
            Kind = (GameEventKind)r.ReadByte(),
            SpawnId = r.ReadUInt16(),
            Client = r.ReadUInt64(),
            Zone = r.ReadByte(),
            Flag = r.ReadBoolean(),
            Amount = r.ReadSingle(),
            Point = RV(r),
            Direction = RV(r),
        });

        // ------------------------------------------------------------ roster

        public static byte[] Encode(RosterEntry[] roster)
        {
            return Encode(w =>
            {
                w.Write((byte)roster.Length);
                foreach (var e in roster)
                {
                    w.Write(e.Client);
                    w.Write((byte)e.Flags);
                    w.Write(e.Health);
                    w.Write(e.Callsign ?? "");
                }
            });
        }

        public static RosterEntry[] DecodeRoster(byte[] d) => Decode(d, r =>
        {
            int n = r.ReadByte();
            var arr = new RosterEntry[n];
            for (int i = 0; i < n; i++)
                arr[i] = new RosterEntry { Client = r.ReadUInt64(), Flags = (PlayerFlags)r.ReadByte(), Health = r.ReadSingle(), Callsign = r.ReadString() };
            return arr;
        });
    }

    [Flags]
    public enum PlayerFlags : byte
    {
        None = 0,
        Alive = 1 << 0,
        OriginLocked = 1 << 1,
        /// <summary>Room scanned and safety confirmed; ready for the host to begin.</summary>
        Ready = 1 << 2,
    }

    public struct PlayerPose
    {
        public ushort Sequence;
        public Vector3 Eye;
        public Quaternion Rotation;
        public float Health;
        public PlayerFlags Flags;
    }

    public struct HunterSnapshot
    {
        public ushort Sequence;
        /// <summary>Increments every spawn so clients can tell a new Hunter from a late packet of the old one.</summary>
        public ushort SpawnId;
        public byte State;
        public Vector3 Position;
        public float FacingYaw;
        public float Speed;
        public float AttackWindup;
        public float Health01;
        public ulong TargetClient;
    }

    public struct MatchSnapshot
    {
        public byte Phase;
        public byte Mode;
        public int Score;
        public int Kills;
        public int Headshots;
        public int Encounter;
        public float LiveSeconds;
        public float CountdownRemaining;
    }

    public enum GameEventKind : byte
    {
        /// <summary>client → host: "my round hit the Hunter" (host validates).</summary>
        ShotClaim = 1,
        /// <summary>host → all: a validated hit (Amount = damage applied, Flag = killed).</summary>
        HunterHit = 2,
        /// <summary>host → all: the Hunter's strike landed on Client (Amount = damage).</summary>
        HunterStrike = 3,
        /// <summary>host → all: new Hunter spawned at Point.</summary>
        HunterSpawned = 4,
        /// <summary>host → all: Hunter killed (Flag = headshot, Client = shooter).</summary>
        HunterKilled = 5,
        /// <summary>client → host: the local player went down.</summary>
        PlayerDown = 6,
        /// <summary>host → all: the host asks everyone to start their scan/safety flow.</summary>
        LobbyStart = 7,
    }

    public struct GameEvent
    {
        public GameEventKind Kind;
        public ushort SpawnId;
        public ulong Client;
        public byte Zone;
        public bool Flag;
        public float Amount;
        public Vector3 Point;
        public Vector3 Direction;
    }

    public struct RosterEntry
    {
        public ulong Client;
        public PlayerFlags Flags;
        public float Health;
        public string Callsign;
    }
}
