using System.Numerics;

namespace Breach.Core.World
{
    public enum TacticalKind
    {
        OpenFloor = 0,
        /// <summary>Floor point tucked against a real wall or vertical surface.</summary>
        WallCover = 1,
        /// <summary>Floor point beside a raised horizontal surface (table, sofa, bed).</summary>
        FurnitureCover = 2,
        /// <summary>Floor point near the end of a wall segment — a corner to peek from.</summary>
        Corner = 3,
    }

    /// <summary>A floor-level position the Hunter can occupy, derived from real geometry.</summary>
    public readonly struct TacticalPoint
    {
        public readonly Vector3 Position;
        public readonly TacticalKind Kind;
        /// <summary>Unit horizontal normal pointing away from the cover surface (zero for open floor).</summary>
        public readonly Vector3 CoverNormal;

        public TacticalPoint(Vector3 position, TacticalKind kind, Vector3 coverNormal)
        {
            Position = position;
            Kind = kind;
            CoverNormal = coverNormal;
        }

        public bool IsCover => Kind != TacticalKind.OpenFloor;
    }
}
