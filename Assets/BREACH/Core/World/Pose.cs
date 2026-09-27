using System.Numerics;

namespace Breach.Core.World
{
    /// <summary>Rigid transform (position + rotation). Engine-independent.</summary>
    public readonly struct RigidPose
    {
        public readonly Vector3 Position;
        public readonly Quaternion Rotation;

        public RigidPose(Vector3 position, Quaternion rotation)
        {
            Position = position;
            Rotation = Quaternion.Normalize(rotation);
        }

        public static RigidPose Identity => new RigidPose(Vector3.Zero, Quaternion.Identity);

        public Vector3 TransformPoint(Vector3 local) => Position + Vector3.Transform(local, Rotation);

        public Vector3 InverseTransformPoint(Vector3 world) =>
            Vector3.Transform(world - Position, Quaternion.Inverse(Rotation));

        public Quaternion TransformRotation(Quaternion local) => Rotation * local;

        public Quaternion InverseTransformRotation(Quaternion world) => Quaternion.Inverse(Rotation) * world;

        public RigidPose Inverse()
        {
            var inv = Quaternion.Inverse(Rotation);
            return new RigidPose(Vector3.Transform(-Position, inv), inv);
        }
    }
}
