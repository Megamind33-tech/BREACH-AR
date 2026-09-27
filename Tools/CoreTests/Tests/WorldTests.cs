using System;
using System.Collections.Generic;
using System.Numerics;
using Breach.Core.World;
using NUnit.Framework;

namespace Breach.Core.Tests
{
    public class SharedOriginTests
    {
        static Quaternion Yaw(float deg) => Quaternion.CreateFromAxisAngle(Vector3.UnitY, deg * MathF.PI / 180f);

        [Test]
        public void TwoDevicesAgreeOnSharedCoordinates()
        {
            // The same physical marker and the same physical Hunter position, seen
            // from two AR sessions whose local frames differ by an arbitrary rigid offset.
            var markerA = new RigidPose(new Vector3(1, 0, 2), Yaw(30));
            var deviceBFromA = new RigidPose(new Vector3(-3, 0.2f, 5), Yaw(-110));
            var markerB = new RigidPose(deviceBFromA.TransformPoint(markerA.Position), deviceBFromA.Rotation * markerA.Rotation);

            var a = new SharedOrigin(requiredSamples: 1);
            var b = new SharedOrigin(requiredSamples: 1);
            a.AddMarkerSample(markerA);
            b.AddMarkerSample(markerB);
            Assert.That(a.State, Is.EqualTo(OriginState.Locked));

            var hunterInA = new Vector3(2.5f, 0, -1);
            var hunterInB = deviceBFromA.TransformPoint(hunterInA);
            var sharedA = a.SessionToShared(hunterInA);
            var sharedB = b.SessionToShared(hunterInB);
            Assert.That(Vector3.Distance(sharedA, sharedB), Is.LessThan(1e-4f));

            // And back: B can place A's Hunter correctly.
            Assert.That(Vector3.Distance(b.SharedToSession(sharedA), hunterInB), Is.LessThan(1e-4f));
        }

        [Test]
        public void OriginIsGravityAlignedEvenIfMarkerIsTilted()
        {
            var tilted = Quaternion.CreateFromYawPitchRoll(0.4f, 1.2f, 0.3f);
            var o = new SharedOrigin(1);
            o.AddMarkerSample(new RigidPose(Vector3.Zero, tilted));
            var up = Vector3.Transform(Vector3.UnitY, o.OriginInSession.Rotation);
            Assert.That(Vector3.Distance(up, Vector3.UnitY), Is.LessThan(1e-4f));
        }

        [Test]
        public void AveragesSamplesAndRestartsOnJump()
        {
            var o = new SharedOrigin(requiredSamples: 4, maxJitterMetres: 0.02f);
            o.AddMarkerSample(new RigidPose(new Vector3(0, 0, 0), Quaternion.Identity));
            o.AddMarkerSample(new RigidPose(new Vector3(0.01f, 0, 0), Quaternion.Identity));
            o.AddMarkerSample(new RigidPose(new Vector3(5, 0, 0), Quaternion.Identity)); // tracking jump → restart
            Assert.That(o.SampleCount, Is.EqualTo(1));
            for (int i = 0; i < 3; i++) o.AddMarkerSample(new RigidPose(new Vector3(5.002f * 1, 0, 0), Quaternion.Identity));
            Assert.That(o.State, Is.EqualTo(OriginState.Locked));
            Assert.That(o.OriginInSession.Position.X, Is.EqualTo(5.0015f).Within(0.01f));
        }
    }

    public class SpawnPlannerTests
    {
        [Test]
        public void NeverSpawnsInPlainView()
        {
            var planner = new SpawnPlanner(seed: 3);
            var eye = new Vector3(0, 1.5f, 0);
            var fwd = Vector3.UnitZ;
            var points = new List<TacticalPoint>
            {
                new TacticalPoint(new Vector3(0, 0, 3), TacticalKind.WallCover, Vector3.Zero),     // in view
                new TacticalPoint(new Vector3(0.5f, 0, 4), TacticalKind.Corner, Vector3.Zero),     // in view
                new TacticalPoint(new Vector3(-1, 0, -3), TacticalKind.OpenFloor, Vector3.Zero),   // behind
            };
            for (int i = 0; i < 20; i++)
            {
                var p = planner.Choose(points, eye, fwd, 0f);
                Assert.That(ViewGeometry.YawAngleFromView(eye, fwd, p.Position), Is.GreaterThan(planner.Rules.ViewHalfAngle));
            }
        }

        [Test]
        public void HiddenBehindRealGeometryInsideViewIsAllowed()
        {
            var planner = new SpawnPlanner(seed: 3);
            var eye = new Vector3(0, 1.5f, 0);
            var points = new List<TacticalPoint> { new TacticalPoint(new Vector3(0, 0, 3.5f), TacticalKind.Corner, Vector3.Zero) };
            var p = planner.Choose(points, eye, Vector3.UnitZ, 0f, hasLineOfSight: _ => false);
            Assert.That(p.Kind, Is.EqualTo(TacticalKind.Corner));
        }

        [Test]
        public void FallbackIsBehindPlayerAtSafeDistance()
        {
            var planner = new SpawnPlanner(seed: 11);
            var eye = new Vector3(1, 1.4f, 1);
            var p = planner.Choose(new List<TacticalPoint>(), eye, Vector3.UnitZ, -0.1f);
            float d = ViewGeometry.HorizontalDistance(p.Position, eye);
            Assert.That(d, Is.InRange(planner.Rules.MinDistance, planner.Rules.MaxDistance));
            Assert.That(ViewGeometry.YawAngleFromView(eye, Vector3.UnitZ, p.Position), Is.GreaterThan(120f));
            Assert.That(p.Position.Y, Is.EqualTo(-0.1f).Within(1e-5));
        }

        [Test]
        public void RespectsBoundary()
        {
            var planner = new SpawnPlanner(seed: 1);
            var boundary = new PlayBoundary(Vector3.Zero, 3f);
            var eye = new Vector3(0, 1.5f, 0);
            var points = new List<TacticalPoint>
            {
                new TacticalPoint(new Vector3(0, 0, -6f), TacticalKind.Corner, Vector3.Zero),     // outside boundary
                new TacticalPoint(new Vector3(0.5f, 0, -2.4f), TacticalKind.OpenFloor, Vector3.Zero),
            };
            var p = planner.Choose(points, eye, Vector3.UnitZ, 0, boundary);
            Assert.That(p.Position.Z, Is.EqualTo(-2.4f).Within(1e-5));
        }
    }

    public class TacticalMapTests
    {
        static SurfaceSample Rect(SurfaceKind kind, Vector3 c, float w, float d, Vector3 normal)
        {
            var s = new SurfaceSample { Kind = kind, Center = c, Normal = normal, Area = w * d };
            s.Boundary.Add(c + new Vector3(-w / 2, 0, -d / 2));
            s.Boundary.Add(c + new Vector3(w / 2, 0, -d / 2));
            s.Boundary.Add(c + new Vector3(w / 2, 0, d / 2));
            s.Boundary.Add(c + new Vector3(-w / 2, 0, d / 2));
            return s;
        }

        static SurfaceSample Wall(Vector3 baseCenter, float length, Vector3 normal, float height = 2f)
        {
            var n = Vector3.Normalize(normal);
            var t = Vector3.Cross(Vector3.UnitY, n);
            var c = baseCenter + Vector3.UnitY * height / 2;
            var s = new SurfaceSample { Kind = SurfaceKind.Vertical, Center = c, Normal = n, Area = length * height };
            s.Boundary.Add(c - t * length / 2 - Vector3.UnitY * height / 2);
            s.Boundary.Add(c + t * length / 2 - Vector3.UnitY * height / 2);
            s.Boundary.Add(c + t * length / 2 + Vector3.UnitY * height / 2);
            s.Boundary.Add(c - t * length / 2 + Vector3.UnitY * height / 2);
            return s;
        }

        [Test]
        public void DerivesFloorCoverCornersAndFurniture()
        {
            var surfaces = new List<SurfaceSample>
            {
                Rect(SurfaceKind.HorizontalUp, new Vector3(0, -1.4f, 0), 4, 4, Vector3.UnitY),       // floor
                Rect(SurfaceKind.HorizontalUp, new Vector3(1, -0.65f, 1), 1.2f, 0.7f, Vector3.UnitY), // table
                Rect(SurfaceKind.HorizontalUp, new Vector3(0, -1.35f, -1.5f), 0.3f, 0.3f, Vector3.UnitY), // small low patch (not floor)
                Wall(new Vector3(0, -1.4f, 2f), 3f, -Vector3.UnitZ),
            };
            var b = new TacticalMapBuilder();
            b.Build(surfaces);
            Assert.That(b.FloorY, Is.EqualTo(-1.4f).Within(1e-4));
            Assert.That(b.WallCount, Is.EqualTo(1));
            Assert.That(b.RaisedCount, Is.EqualTo(1));
            Assert.That(b.Points.Exists(p => p.Kind == TacticalKind.OpenFloor));
            Assert.That(b.Points.Exists(p => p.Kind == TacticalKind.WallCover));
            Assert.That(b.Points.Exists(p => p.Kind == TacticalKind.Corner));
            Assert.That(b.Points.Exists(p => p.Kind == TacticalKind.FurnitureCover));
            foreach (var p in b.Points) Assert.That(p.Position.Y, Is.EqualTo(-1.4f).Within(1e-4), "all points on floor");
            // Wall cover sits on the observed (room) side of the wall.
            foreach (var p in b.Points.FindAll(p => p.Kind == TacticalKind.WallCover))
                Assert.That(p.Position.Z, Is.LessThan(2f));
        }

        [Test]
        public void NoFloorMeansNoMap()
        {
            var b = new TacticalMapBuilder();
            b.Build(new List<SurfaceSample> { Wall(Vector3.Zero, 2, Vector3.UnitX) });
            Assert.That(b.FloorY.HasValue, Is.False);
            Assert.That(b.Points, Is.Empty);
        }

        [Test]
        public void PointsAreDeduplicated()
        {
            var b = new TacticalMapBuilder();
            b.Build(new List<SurfaceSample> { Rect(SurfaceKind.HorizontalUp, Vector3.Zero, 3, 3, Vector3.UnitY) });
            for (int i = 0; i < b.Points.Count; i++)
            for (int j = i + 1; j < b.Points.Count; j++)
                Assert.That(ViewGeometry.HorizontalDistance(b.Points[i].Position, b.Points[j].Position), Is.GreaterThanOrEqualTo(b.DedupeRadius));
        }
    }

    public class GeometryTests
    {
        [Test]
        public void SignedYawIsPositiveToTheRight()
        {
            var eye = Vector3.Zero;
            Assert.That(ViewGeometry.SignedYaw(eye, Vector3.UnitZ, new Vector3(1, 0, 0)), Is.EqualTo(90).Within(0.01));
            Assert.That(ViewGeometry.SignedYaw(eye, Vector3.UnitZ, new Vector3(-1, 0, 0)), Is.EqualTo(-90).Within(0.01));
            Assert.That(Math.Abs(ViewGeometry.SignedYaw(eye, Vector3.UnitZ, new Vector3(0, 0, -1))), Is.EqualTo(180).Within(0.01));
        }

        [Test]
        public void BoundaryStatuses()
        {
            var b = new PlayBoundary(Vector3.Zero, 3f, 0.5f);
            Assert.That(b.Evaluate(new Vector3(1, 5, 0)), Is.EqualTo(BoundaryStatus.Inside));
            Assert.That(b.Evaluate(new Vector3(2.8f, 0, 0)), Is.EqualTo(BoundaryStatus.Warning));
            Assert.That(b.Evaluate(new Vector3(0, 0, 3.2f)), Is.EqualTo(BoundaryStatus.Outside));
        }
    }
}
