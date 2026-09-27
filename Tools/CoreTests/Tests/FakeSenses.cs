using System.Collections.Generic;
using System.Numerics;
using Breach.Core.Hunter;
using Breach.Core.World;

namespace Breach.Core.Tests
{
    /// <summary>Scriptable room for driving the Hunter brain in tests.</summary>
    public sealed class FakeSenses : IHunterSenses
    {
        public Vector3 PlayerEye { get; set; } = new Vector3(0, 1.5f, 0);
        public Vector3 PlayerForward { get; set; } = Vector3.UnitZ;
        public float FloorY { get; set; }
        public float ViewHalfAngle = 35f;
        public bool Blind;
        public List<TacticalPoint> Points = new List<TacticalPoint>();
        public IReadOnlyList<TacticalPoint> TacticalPoints => Points;
        /// <summary>Optional wall: blocks paths crossing the plane x = WallX between WallZMin..WallZMax.</summary>
        public float? WallX;
        public float WallZMin = -10, WallZMax = 10;

        public bool PlayerCanSee(Vector3 p) =>
            !Blind && ViewGeometry.YawAngleFromView(PlayerEye, PlayerForward, p) < ViewHalfAngle && IsPathClear(PlayerEye, p);

        public bool IsPathClear(Vector3 a, Vector3 b)
        {
            if (!WallX.HasValue) return true;
            float w = WallX.Value;
            if ((a.X - w) * (b.X - w) >= 0) return true;
            float t = (w - a.X) / (b.X - a.X);
            float z = a.Z + (b.Z - a.Z) * t;
            return z < WallZMin || z > WallZMax;
        }
    }
}
