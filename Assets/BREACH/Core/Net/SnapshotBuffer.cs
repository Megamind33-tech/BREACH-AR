using System;
using System.Numerics;

namespace Breach.Core.Net
{
    /// <summary>
    /// Time-stamped position/yaw buffer for rendering a remote entity slightly
    /// in the past (interpolation delay), with bounded extrapolation and a
    /// teleport threshold. Concept from the Beyblade AR donor's
    /// MySynchronizationScript (MoveTowards + teleport), rewritten.
    /// </summary>
    public sealed class SnapshotBuffer
    {
        struct Sample
        {
            public double Time;
            public Vector3 Position;
            public float Yaw;
        }

        readonly Sample[] _ring;
        int _count, _head;

        public float InterpolationDelay { get; set; } = 0.1f;
        public float MaxExtrapolation { get; set; } = 0.25f;
        public float TeleportDistance { get; set; } = 2.5f;

        public SnapshotBuffer(int capacity = 32)
        {
            _ring = new Sample[Math.Max(4, capacity)];
        }

        public int Count => _count;

        public void Clear()
        {
            _count = 0;
            _head = 0;
        }

        public void Add(double time, Vector3 position, float yaw)
        {
            if (_count > 0)
            {
                var last = Get(_count - 1);
                if (time <= last.Time) return; // out of order / duplicate
                if (Vector3.Distance(last.Position, position) > TeleportDistance) Clear();
            }
            _ring[_head] = new Sample { Time = time, Position = position, Yaw = yaw };
            _head = (_head + 1) % _ring.Length;
            if (_count < _ring.Length) _count++;
        }

        Sample Get(int i)
        {
            int start = (_head - _count + _ring.Length) % _ring.Length;
            return _ring[(start + i) % _ring.Length];
        }

        /// <summary>Sample the entity at (now - InterpolationDelay).</summary>
        public bool TrySample(double now, out Vector3 position, out float yaw)
        {
            position = default;
            yaw = 0;
            if (_count == 0) return false;
            double t = now - InterpolationDelay;
            var first = Get(0);
            if (_count == 1 || t <= first.Time)
            {
                position = first.Position;
                yaw = first.Yaw;
                if (_count == 1) return true;
                return true;
            }
            for (int i = 0; i < _count - 1; i++)
            {
                var a = Get(i);
                var b = Get(i + 1);
                if (t >= a.Time && t <= b.Time)
                {
                    float k = (float)((t - a.Time) / Math.Max(1e-6, b.Time - a.Time));
                    position = Vector3.Lerp(a.Position, b.Position, k);
                    yaw = LerpAngle(a.Yaw, b.Yaw, k);
                    return true;
                }
            }
            // Past the newest sample: extrapolate briefly along the last velocity.
            var p = Get(_count - 2);
            var q = Get(_count - 1);
            double dt = Math.Min(t - q.Time, MaxExtrapolation);
            double span = Math.Max(1e-6, q.Time - p.Time);
            var vel = (q.Position - p.Position) / (float)span;
            position = q.Position + vel * (float)dt;
            yaw = q.Yaw;
            return true;
        }

        public static float LerpAngle(float a, float b, float t)
        {
            float d = (b - a) % 360f;
            if (d > 180f) d -= 360f;
            if (d < -180f) d += 360f;
            return a + d * t;
        }
    }
}
