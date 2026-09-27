using System.Numerics;

namespace Breach.Core.World
{
    public enum BoundaryStatus
    {
        Inside,
        Warning,
        Outside,
    }

    /// <summary>
    /// Circular safe-play area established before a match. The player is
    /// warned when approaching the edge; gameplay never asks them to run.
    /// </summary>
    public sealed class PlayBoundary
    {
        public Vector3 Center { get; private set; }
        public float Radius { get; private set; }
        public float WarningBand { get; }

        public PlayBoundary(Vector3 center, float radius, float warningBand = 0.6f)
        {
            Center = center;
            Radius = radius;
            WarningBand = warningBand;
        }

        public void Recenter(Vector3 center, float radius)
        {
            Center = center;
            Radius = radius;
        }

        public BoundaryStatus Evaluate(Vector3 position)
        {
            float d = ViewGeometry.HorizontalDistance(position, Center);
            if (d > Radius) return BoundaryStatus.Outside;
            if (d > Radius - WarningBand) return BoundaryStatus.Warning;
            return BoundaryStatus.Inside;
        }

        public bool Contains(Vector3 position, float margin = 0f) =>
            ViewGeometry.HorizontalDistance(position, Center) <= Radius - margin;
    }
}
