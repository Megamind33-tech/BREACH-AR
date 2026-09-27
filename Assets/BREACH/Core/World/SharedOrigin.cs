using System;
using System.Numerics;

namespace Breach.Core.World
{
    public enum OriginState
    {
        NotCalibrated,
        Calibrating,
        Locked,
    }

    /// <summary>
    /// Shared world origin defined by the physical BREACH marker.
    /// Each device observes the marker in its own AR session space; the
    /// marker pose becomes X=0,Y=0,Z=0 with a shared orientation, so any
    /// session-space point can be expressed in marker ("shared") space and
    /// every device agrees on it.
    ///
    /// To keep the shared frame gravity-aligned regardless of how the marker
    /// is lying, only the marker's yaw is used.
    /// Concept reference: Beyblade AR donor (MIT) sends positions relative to
    /// the battle arena transform; rewritten around an image marker.
    /// </summary>
    public sealed class SharedOrigin
    {
        readonly int _requiredSamples;
        readonly float _maxJitterMetres;
        Vector3 _accumPosition;
        Vector2 _accumForward;
        int _samples;
        Vector3 _firstSample;

        public OriginState State { get; private set; } = OriginState.NotCalibrated;
        public RigidPose OriginInSession { get; private set; } = RigidPose.Identity;
        public int SampleCount => _samples;

        public event Action<RigidPose> Locked;

        public SharedOrigin(int requiredSamples = 30, float maxJitterMetres = 0.03f)
        {
            _requiredSamples = Math.Max(1, requiredSamples);
            _maxJitterMetres = maxJitterMetres;
        }

        public void Reset()
        {
            State = OriginState.NotCalibrated;
            OriginInSession = RigidPose.Identity;
            _samples = 0;
            _accumPosition = Vector3.Zero;
            _accumForward = Vector2.Zero;
        }

        /// <summary>
        /// Feed a tracked marker pose (session space). Samples are averaged
        /// to reduce per-frame tracking noise; a jump larger than the jitter
        /// threshold restarts calibration.
        /// </summary>
        public void AddMarkerSample(RigidPose markerPose)
        {
            if (State == OriginState.Locked) return;

            if (_samples > 0 && Vector3.Distance(markerPose.Position, _firstSample) > _maxJitterMetres * 4f)
            {
                _samples = 0;
                _accumPosition = Vector3.Zero;
                _accumForward = Vector2.Zero;
            }

            if (_samples == 0) _firstSample = markerPose.Position;
            State = OriginState.Calibrating;
            _accumPosition += markerPose.Position;
            _accumForward += YawForward(markerPose.Rotation);
            _samples++;

            if (_samples >= _requiredSamples)
            {
                var pos = _accumPosition / _samples;
                var fwd = _accumForward;
                float yaw = MathF.Atan2(fwd.X, fwd.Y);
                OriginInSession = new RigidPose(pos, Quaternion.CreateFromAxisAngle(Vector3.UnitY, yaw));
                State = OriginState.Locked;
                Locked?.Invoke(OriginInSession);
            }
        }

        /// <summary>Force the origin (e.g. single-player without marker).</summary>
        public void LockAt(RigidPose pose)
        {
            OriginInSession = new RigidPose(pose.Position,
                Quaternion.CreateFromAxisAngle(Vector3.UnitY, YawAngle(pose.Rotation)));
            State = OriginState.Locked;
            Locked?.Invoke(OriginInSession);
        }

        public Vector3 SessionToShared(Vector3 sessionPoint) => OriginInSession.InverseTransformPoint(sessionPoint);
        public Vector3 SharedToSession(Vector3 sharedPoint) => OriginInSession.TransformPoint(sharedPoint);
        public Quaternion SessionToShared(Quaternion q) => OriginInSession.InverseTransformRotation(q);
        public Quaternion SharedToSession(Quaternion q) => OriginInSession.TransformRotation(q);

        /// <summary>Horizontal forward (x,z) of a rotation's +Z axis.</summary>
        static Vector2 YawForward(Quaternion q)
        {
            var f = Vector3.Transform(Vector3.UnitZ, q);
            var v = new Vector2(f.X, f.Z);
            if (v.LengthSquared() < 1e-6f)
            {
                // Marker lying flat and pointing straight up/down: use its up vector instead.
                var u = Vector3.Transform(Vector3.UnitY, q);
                v = new Vector2(u.X, u.Z);
            }
            return v.LengthSquared() < 1e-9f ? new Vector2(0, 1) : Vector2.Normalize(v);
        }

        static float YawAngle(Quaternion q)
        {
            var f = YawForward(q);
            return MathF.Atan2(f.X, f.Y);
        }
    }
}
