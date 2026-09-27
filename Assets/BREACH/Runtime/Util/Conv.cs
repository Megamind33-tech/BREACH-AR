using SVector3 = System.Numerics.Vector3;
using SQuaternion = System.Numerics.Quaternion;
using UnityEngine;

namespace Breach.Util
{
    /// <summary>Conversions between the engine-independent core math and UnityEngine types.</summary>
    public static class Conv
    {
        public static SVector3 ToS(this Vector3 v) => new SVector3(v.x, v.y, v.z);
        public static Vector3 ToU(this SVector3 v) => new Vector3(v.X, v.Y, v.Z);
        public static SQuaternion ToS(this Quaternion q) => new SQuaternion(q.x, q.y, q.z, q.w);
        public static Quaternion ToU(this SQuaternion q) => new Quaternion(q.X, q.Y, q.Z, q.W);
    }

    public static class Layers
    {
        public const int Default = 0;
        public const int IgnoreRaycast = 2;
        public const int UI = 5;
        public const int RealWorld = 10;
        public const int Hunter = 11;
        public const int ViewModel = 12;
        public const int HunterRagdoll = 13;

        public static int Mask(params int[] layers)
        {
            int m = 0;
            foreach (var l in layers) m |= 1 << l;
            return m;
        }

        public static void SetRecursively(GameObject go, int layer)
        {
            go.layer = layer;
            foreach (Transform t in go.transform) SetRecursively(t.gameObject, layer);
        }
    }
}
