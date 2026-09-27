using System.Collections.Generic;
using System.Numerics;
using Breach.Core.World;

namespace Breach.Core.Hunter
{
    /// <summary>What the Hunter knows about the room and the player. Supplied by the engine layer.</summary>
    public interface IHunterSenses
    {
        Vector3 PlayerEye { get; }
        Vector3 PlayerForward { get; }
        float FloorY { get; }
        /// <summary>True if the Hunter at this floor position is inside the camera view and not hidden by real geometry.</summary>
        bool PlayerCanSee(Vector3 hunterFloorPosition);
        /// <summary>True if the Hunter can walk directly between two floor points (no real wall in the way).</summary>
        bool IsPathClear(Vector3 from, Vector3 to);
        IReadOnlyList<TacticalPoint> TacticalPoints { get; }
    }
}
