using System;
using System.Collections.Generic;
using System.Numerics;

namespace Breach.Core.World
{
    public enum SurfaceKind
    {
        HorizontalUp,
        HorizontalDown,
        Vertical,
    }

    /// <summary>Engine-independent snapshot of one detected real-world plane.</summary>
    public sealed class SurfaceSample
    {
        public string Id;
        public SurfaceKind Kind;
        public Vector3 Center;
        /// <summary>Unit normal (for vertical planes: pointing out of the wall toward the observed side).</summary>
        public Vector3 Normal;
        /// <summary>World-space boundary polygon.</summary>
        public List<Vector3> Boundary = new List<Vector3>();
        public float Area;
    }

    /// <summary>
    /// Turns detected planes into gameplay: a floor height, a list of
    /// floor-level tactical points (open floor, wall cover, corners, furniture
    /// cover). This is the "reality is the map" layer.
    /// </summary>
    public sealed class TacticalMapBuilder
    {
        public float FloorGridSpacing = 0.7f;
        public float CoverOffset = 0.42f;
        public float MinRaisedHeight = 0.25f;
        public float MaxRaisedHeight = 1.25f;
        public float DedupeRadius = 0.35f;
        public float MinFloorArea = 0.5f;
        public int MaxPoints = 220;

        public float? FloorY { get; private set; }
        public readonly List<TacticalPoint> Points = new List<TacticalPoint>();
        public float FloorArea { get; private set; }
        public int WallCount { get; private set; }
        public int RaisedCount { get; private set; }

        public void Build(IReadOnlyList<SurfaceSample> surfaces, PlayBoundary boundary = null)
        {
            Points.Clear();
            FloorY = null;
            FloorArea = 0;
            WallCount = 0;
            RaisedCount = 0;
            if (surfaces == null || surfaces.Count == 0) return;

            // Floor = lowest sufficiently large upward-facing plane. Area-weighted
            // choice avoids picking a small low step as the floor.
            SurfaceSample floor = null;
            foreach (var s in surfaces)
            {
                if (s.Kind != SurfaceKind.HorizontalUp || s.Area < MinFloorArea) continue;
                if (floor == null || s.Center.Y < floor.Center.Y - 0.15f ||
                    (MathF.Abs(s.Center.Y - floor.Center.Y) <= 0.15f && s.Area > floor.Area))
                    floor = s;
            }
            if (floor == null) return;
            float floorY = floor.Center.Y;
            FloorY = floorY;

            var floors = new List<SurfaceSample>();
            foreach (var s in surfaces)
                if (s.Kind == SurfaceKind.HorizontalUp && MathF.Abs(s.Center.Y - floorY) < 0.12f)
                {
                    floors.Add(s);
                    FloorArea += s.Area;
                }

            // Open floor grid.
            foreach (var f in floors)
            {
                if (f.Boundary.Count < 3) continue;
                GetBoundsXZ(f.Boundary, out float minX, out float maxX, out float minZ, out float maxZ);
                for (float x = minX + FloorGridSpacing * 0.5f; x < maxX; x += FloorGridSpacing)
                for (float z = minZ + FloorGridSpacing * 0.5f; z < maxZ; z += FloorGridSpacing)
                {
                    if (!PointInPolygonXZ(f.Boundary, x, z)) continue;
                    TryAdd(new TacticalPoint(new Vector3(x, floorY, z), TacticalKind.OpenFloor, Vector3.Zero), boundary);
                }
            }

            foreach (var s in surfaces)
            {
                if (s.Kind == SurfaceKind.Vertical)
                {
                    WallCount++;
                    AddWallPoints(s, floorY, boundary);
                }
                else if (s.Kind == SurfaceKind.HorizontalUp)
                {
                    float h = s.Center.Y - floorY;
                    if (h >= MinRaisedHeight && h <= MaxRaisedHeight)
                    {
                        RaisedCount++;
                        AddFurniturePoints(s, floorY, boundary);
                    }
                }
            }
        }

        void AddWallPoints(SurfaceSample wall, float floorY, PlayBoundary boundary)
        {
            var n = new Vector3(wall.Normal.X, 0, wall.Normal.Z);
            if (n.LengthSquared() < 1e-4f) return;
            n = Vector3.Normalize(n);
            var tangent = Vector3.Cross(Vector3.UnitY, n);

            // Extent of the wall along its tangent.
            float minT = float.MaxValue, maxT = float.MinValue;
            var c = new Vector3(wall.Center.X, floorY, wall.Center.Z);
            if (wall.Boundary.Count >= 2)
            {
                foreach (var b in wall.Boundary)
                {
                    float t = Vector3.Dot(new Vector3(b.X, floorY, b.Z) - c, tangent);
                    minT = MathF.Min(minT, t);
                    maxT = MathF.Max(maxT, t);
                }
            }
            else
            {
                minT = -0.5f;
                maxT = 0.5f;
            }
            if (maxT - minT < 0.3f) return;

            // Cover points along the observed face.
            for (float t = minT + 0.3f; t <= maxT - 0.3f + 1e-3f; t += 0.8f)
                TryAdd(new TacticalPoint(c + tangent * t + n * CoverOffset, TacticalKind.WallCover, n), boundary);

            // Corners: at each end, and just around the end (hidden behind the wall).
            foreach (float end in new[] { minT, maxT })
            {
                float outward = end == minT ? -1f : 1f;
                var endPoint = c + tangent * end;
                TryAdd(new TacticalPoint(endPoint + n * CoverOffset + tangent * outward * 0.15f, TacticalKind.Corner, n), boundary);
                TryAdd(new TacticalPoint(endPoint + tangent * outward * 0.45f - n * 0.5f, TacticalKind.Corner, -n), boundary);
            }
        }

        void AddFurniturePoints(SurfaceSample top, float floorY, PlayBoundary boundary)
        {
            if (top.Boundary.Count < 3) return;
            var c = new Vector3(top.Center.X, floorY, top.Center.Z);
            // Sample the perimeter, then push each sample outward from the centre.
            float perimeter = 0;
            for (int i = 0; i < top.Boundary.Count; i++)
                perimeter += Vector3.Distance(top.Boundary[i], top.Boundary[(i + 1) % top.Boundary.Count]);
            int samples = Math.Clamp((int)(perimeter / 0.7f), 4, 16);
            for (int k = 0; k < samples; k++)
            {
                var b = SampleOnPolygon(top.Boundary, perimeter * k / samples);
                var flat = new Vector3(b.X, floorY, b.Z);
                var outward = flat - c;
                if (outward.LengthSquared() < 1e-4f) continue;
                outward = Vector3.Normalize(outward);
                TryAdd(new TacticalPoint(flat + outward * CoverOffset, TacticalKind.FurnitureCover, outward), boundary);
            }
        }

        void TryAdd(in TacticalPoint p, PlayBoundary boundary)
        {
            if (Points.Count >= MaxPoints) return;
            if (boundary != null && !boundary.Contains(p.Position, -0.5f)) return;
            for (int i = 0; i < Points.Count; i++)
            {
                if (ViewGeometry.HorizontalDistance(Points[i].Position, p.Position) < DedupeRadius)
                {
                    // Cover beats open floor at the same spot.
                    if (p.IsCover && !Points[i].IsCover) Points[i] = p;
                    return;
                }
            }
            Points.Add(p);
        }

        static Vector3 SampleOnPolygon(List<Vector3> poly, float distance)
        {
            for (int i = 0; i < poly.Count; i++)
            {
                var a = poly[i];
                var b = poly[(i + 1) % poly.Count];
                float len = Vector3.Distance(a, b);
                if (distance <= len && len > 1e-5f) return Vector3.Lerp(a, b, distance / len);
                distance -= len;
            }
            return poly[0];
        }

        static void GetBoundsXZ(List<Vector3> poly, out float minX, out float maxX, out float minZ, out float maxZ)
        {
            minX = minZ = float.MaxValue;
            maxX = maxZ = float.MinValue;
            foreach (var p in poly)
            {
                minX = MathF.Min(minX, p.X);
                maxX = MathF.Max(maxX, p.X);
                minZ = MathF.Min(minZ, p.Z);
                maxZ = MathF.Max(maxZ, p.Z);
            }
        }

        public static bool PointInPolygonXZ(List<Vector3> poly, float x, float z)
        {
            bool inside = false;
            for (int i = 0, j = poly.Count - 1; i < poly.Count; j = i++)
            {
                float xi = poly[i].X, zi = poly[i].Z, xj = poly[j].X, zj = poly[j].Z;
                if ((zi > z) != (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi + 1e-9f) + xi)
                    inside = !inside;
            }
            return inside;
        }
    }
}
