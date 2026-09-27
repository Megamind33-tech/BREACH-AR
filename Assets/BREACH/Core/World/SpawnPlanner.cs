using System;
using System.Collections.Generic;
using System.Numerics;

namespace Breach.Core.World
{
    public sealed class SpawnRules
    {
        public float MinDistance = 2.2f;
        public float MaxDistance = 6.5f;
        /// <summary>Points within this yaw of the player's view are considered visible.</summary>
        public float ViewHalfAngle = 42f;
        /// <summary>Preferred minimum distance from the previous spawn.</summary>
        public float AvoidPreviousRadius = 1.5f;
    }

    /// <summary>
    /// Chooses where the Hunter enters the room: out of the player's view,
    /// preferring real cover, within the safe boundary, and not where it
    /// last appeared. Deterministic given the same seed.
    /// </summary>
    public sealed class SpawnPlanner
    {
        readonly SpawnRules _rules;
        readonly Random _rng;
        Vector3? _previous;

        public SpawnPlanner(SpawnRules rules = null, int seed = 7)
        {
            _rules = rules ?? new SpawnRules();
            _rng = new Random(seed);
        }

        public SpawnRules Rules => _rules;

        public float Score(in TacticalPoint p, Vector3 eye, Vector3 forward, PlayBoundary boundary,
            Func<Vector3, bool> hasLineOfSight)
        {
            float dist = ViewGeometry.HorizontalDistance(p.Position, eye);
            if (dist < _rules.MinDistance || dist > _rules.MaxDistance) return float.NegativeInfinity;
            if (boundary != null && !boundary.Contains(p.Position, -1.0f)) return float.NegativeInfinity;

            float yaw = ViewGeometry.YawAngleFromView(eye, forward, p.Position);
            bool inView = yaw < _rules.ViewHalfAngle;
            bool visible = inView && (hasLineOfSight == null || hasLineOfSight(p.Position));
            if (visible) return float.NegativeInfinity;

            float score = 0f;
            // Hidden by real geometry even though inside the view cone is the best ambush.
            if (inView) score += 3f;
            // Behind the player is strong; to the side is good.
            score += (yaw / 180f) * 2f;
            score += p.Kind switch
            {
                TacticalKind.Corner => 2.5f,
                TacticalKind.FurnitureCover => 2.2f,
                TacticalKind.WallCover => 1.8f,
                _ => 0f,
            };
            // Mid-range is scarier than max-range.
            float ideal = (_rules.MinDistance + _rules.MaxDistance) * 0.45f;
            score -= MathF.Abs(dist - ideal) * 0.35f;
            if (_previous.HasValue && ViewGeometry.HorizontalDistance(_previous.Value, p.Position) < _rules.AvoidPreviousRadius)
                score -= 3f;
            // Small jitter so equal points don't always resolve the same way.
            score += (float)_rng.NextDouble() * 0.4f;
            return score;
        }

        /// <summary>
        /// Pick the best candidate. If no candidate qualifies (e.g. room not scanned
        /// yet), fall back to a point behind the player on the floor.
        /// </summary>
        public TacticalPoint Choose(IReadOnlyList<TacticalPoint> candidates, Vector3 eye, Vector3 forward,
            float floorY, PlayBoundary boundary = null, Func<Vector3, bool> hasLineOfSight = null)
        {
            float best = float.NegativeInfinity;
            TacticalPoint bestPoint = default;
            bool found = false;
            if (candidates != null)
            {
                for (int i = 0; i < candidates.Count; i++)
                {
                    float s = Score(candidates[i], eye, forward, boundary, hasLineOfSight);
                    if (s > best)
                    {
                        best = s;
                        bestPoint = candidates[i];
                        found = true;
                    }
                }
            }

            if (!found) bestPoint = Fallback(eye, forward, floorY, boundary);
            _previous = bestPoint.Position;
            return bestPoint;
        }

        public TacticalPoint Fallback(Vector3 eye, Vector3 forward, float floorY, PlayBoundary boundary)
        {
            var f = new Vector3(forward.X, 0, forward.Z);
            f = f.LengthSquared() < 1e-6f ? Vector3.UnitZ : Vector3.Normalize(f);
            // Behind and to one side, randomised.
            float side = _rng.NextDouble() < 0.5 ? -1f : 1f;
            float angle = (150f + (float)_rng.NextDouble() * 40f) * side * MathF.PI / 180f;
            var dir = Vector3.Transform(f, Quaternion.CreateFromAxisAngle(Vector3.UnitY, angle));
            float dist = Math.Clamp((_rules.MinDistance + _rules.MaxDistance) * 0.45f, _rules.MinDistance, _rules.MaxDistance);
            if (boundary != null)
            {
                float maxFromEye = boundary.Radius + ViewGeometry.HorizontalDistance(boundary.Center, eye);
                dist = MathF.Min(dist, MathF.Max(_rules.MinDistance, maxFromEye - 0.3f));
            }
            var pos = new Vector3(eye.X, floorY, eye.Z) + dir * dist;
            return new TacticalPoint(pos, TacticalKind.OpenFloor, Vector3.Zero);
        }
    }
}
