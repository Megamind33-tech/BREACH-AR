using System;
using System.Numerics;

namespace Breach.Core.World
{
    public static class ViewGeometry
    {
        /// <summary>Angle in degrees between the view forward and the direction to a point.</summary>
        public static float AngleFromView(Vector3 eye, Vector3 forward, Vector3 point)
        {
            var to = point - eye;
            float len = to.Length();
            if (len < 1e-5f) return 0f;
            float fl = forward.Length();
            if (fl < 1e-5f) return 180f;
            float cos = Vector3.Dot(to / len, forward / fl);
            return MathF.Acos(Math.Clamp(cos, -1f, 1f)) * (180f / MathF.PI);
        }

        /// <summary>Horizontal-only angle (ignores pitch). Better for "is it behind me" on the floor.</summary>
        public static float YawAngleFromView(Vector3 eye, Vector3 forward, Vector3 point)
        {
            var to = new Vector3(point.X - eye.X, 0, point.Z - eye.Z);
            var f = new Vector3(forward.X, 0, forward.Z);
            if (to.LengthSquared() < 1e-8f || f.LengthSquared() < 1e-8f) return 0f;
            float cos = Vector3.Dot(Vector3.Normalize(to), Vector3.Normalize(f));
            return MathF.Acos(Math.Clamp(cos, -1f, 1f)) * (180f / MathF.PI);
        }

        /// <summary>Signed yaw in degrees (+ = to the right of forward) — used for damage-direction HUD.</summary>
        public static float SignedYaw(Vector3 eye, Vector3 forward, Vector3 point)
        {
            var to = new Vector2(point.X - eye.X, point.Z - eye.Z);
            var f = new Vector2(forward.X, forward.Z);
            if (to.LengthSquared() < 1e-8f || f.LengthSquared() < 1e-8f) return 0f;
            float a = MathF.Atan2(to.X, to.Y) - MathF.Atan2(f.X, f.Y);
            while (a > MathF.PI) a -= 2 * MathF.PI;
            while (a < -MathF.PI) a += 2 * MathF.PI;
            return a * (180f / MathF.PI);
        }

        public static float HorizontalDistance(Vector3 a, Vector3 b)
        {
            float dx = a.X - b.X, dz = a.Z - b.Z;
            return MathF.Sqrt(dx * dx + dz * dz);
        }
    }
}
