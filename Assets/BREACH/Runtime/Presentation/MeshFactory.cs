using System.Collections.Generic;
using UnityEngine;

namespace Breach.Presentation
{
    /// <summary>
    /// Procedural mesh building blocks. Every BREACH-original model (rifle,
    /// Hunter) is lofted from these at startup so the game ships without
    /// third-party model files.
    /// </summary>
    public static class MeshFactory
    {
        public delegate float RadiusProfile(float t);

        /// <summary>
        /// Loft an elliptical tube along a local axis.
        /// </summary>
        /// <param name="axis">Direction and length of the tube (from origin).</param>
        /// <param name="profile">Radius at t in [0,1].</param>
        /// <param name="ellipse">Cross-section scale on the two perpendicular axes.</param>
        /// <param name="ridges">Number of longitudinal ridges (0 = smooth).</param>
        /// <param name="ridgeDepth">Relative ridge depth.</param>
        public static Mesh Loft(Vector3 axis, RadiusProfile profile, Vector2 ellipse, int sides = 10, int rings = 8,
            int ridges = 0, float ridgeDepth = 0f, float uvScale = 1f, Vector3? bend = null)
        {
            var mesh = new Mesh { name = "BREACH_Loft" };
            var verts = new List<Vector3>();
            var norms = new List<Vector3>();
            var uvs = new List<Vector2>();
            var tris = new List<int>();

            float length = axis.magnitude;
            var dir = axis / Mathf.Max(length, 1e-5f);
            var refUp = Mathf.Abs(Vector3.Dot(dir, Vector3.forward)) > 0.9f ? Vector3.up : Vector3.forward;
            var u = Vector3.Normalize(Vector3.Cross(dir, refUp));
            var v = Vector3.Cross(u, dir);
            var bendVec = bend ?? Vector3.zero;

            for (int r = 0; r <= rings; r++)
            {
                float t = (float)r / rings;
                float rad = profile(t);
                var center = dir * (length * t) + bendVec * Mathf.Sin(t * Mathf.PI);
                for (int s = 0; s <= sides; s++)
                {
                    float a = (float)s / sides * Mathf.PI * 2f;
                    float ridge = ridges > 0 ? 1f - ridgeDepth * Mathf.Pow(Mathf.Abs(Mathf.Sin(a * ridges * 0.5f)), 3f) : 1f;
                    float cx = Mathf.Cos(a) * ellipse.x, cy = Mathf.Sin(a) * ellipse.y;
                    verts.Add(center + (u * cx + v * cy) * rad * ridge);
                    norms.Add(Vector3.Normalize(u * (Mathf.Cos(a) * ellipse.y) + v * (Mathf.Sin(a) * ellipse.x)));
                    uvs.Add(new Vector2((float)s / sides * uvScale, t * length * uvScale * 2f));
                }
            }

            int stride = sides + 1;
            for (int r = 0; r < rings; r++)
            for (int s = 0; s < sides; s++)
            {
                int i0 = r * stride + s, i1 = i0 + 1, i2 = i0 + stride, i3 = i2 + 1;
                tris.Add(i0); tris.Add(i2); tris.Add(i1);
                tris.Add(i1); tris.Add(i2); tris.Add(i3);
            }

            Cap(verts, norms, uvs, tris, 0, stride, -dir, profile(0f) > 1e-4f, flip: true);
            Cap(verts, norms, uvs, tris, rings * stride, stride, dir, profile(1f) > 1e-4f, flip: false);

            mesh.SetVertices(verts);
            mesh.SetNormals(norms);
            mesh.SetUVs(0, uvs);
            mesh.SetTriangles(tris, 0);
            mesh.RecalculateBounds();
            mesh.RecalculateTangents();
            return mesh;
        }

        static void Cap(List<Vector3> verts, List<Vector3> norms, List<Vector2> uvs, List<int> tris, int ringStart, int stride, Vector3 normal, bool needed, bool flip)
        {
            if (!needed) return;
            var c = Vector3.zero;
            for (int s = 0; s < stride - 1; s++) c += verts[ringStart + s];
            c /= stride - 1;
            int centerIndex = verts.Count;
            verts.Add(c); norms.Add(normal); uvs.Add(new Vector2(0.5f, 0.5f));
            int first = verts.Count;
            for (int s = 0; s < stride; s++)
            {
                verts.Add(verts[ringStart + s]);
                norms.Add(normal);
                uvs.Add(new Vector2(0.5f, 0.5f));
            }
            for (int s = 0; s < stride - 1; s++)
            {
                if (flip) { tris.Add(centerIndex); tris.Add(first + s + 1); tris.Add(first + s); }
                else { tris.Add(centerIndex); tris.Add(first + s); tris.Add(first + s + 1); }
            }
        }

        /// <summary>Box with chamfered (bevelled) edges — reads far less "primitive" than a raw cube.</summary>
        public static Mesh ChamferBox(Vector3 size, float chamfer)
        {
            chamfer = Mathf.Min(chamfer, Mathf.Min(size.x, Mathf.Min(size.y, size.z)) * 0.45f);
            var h = size * 0.5f;
            var verts = new List<Vector3>();
            var norms = new List<Vector3>();
            var uvs = new List<Vector2>();
            var tris = new List<int>();

            // Build as the convex hull of 24 inset points, emitting flat faces.
            // 6 main faces
            Face(verts, norms, uvs, tris, Vector3.right, h, chamfer);
            Face(verts, norms, uvs, tris, Vector3.left, h, chamfer);
            Face(verts, norms, uvs, tris, Vector3.up, h, chamfer);
            Face(verts, norms, uvs, tris, Vector3.down, h, chamfer);
            Face(verts, norms, uvs, tris, Vector3.forward, h, chamfer);
            Face(verts, norms, uvs, tris, Vector3.back, h, chamfer);

            // 12 edge bevels + 8 corner triangles.
            var sx = new[] { -1f, 1f };
            foreach (var a in sx)
            foreach (var b in sx)
            {
                // Edges parallel to X, Y, Z
                Quad(verts, norms, uvs, tris,
                    new Vector3(-h.x + chamfer, a * h.y, b * (h.z - chamfer)),
                    new Vector3(h.x - chamfer, a * h.y, b * (h.z - chamfer)),
                    new Vector3(h.x - chamfer, a * (h.y - chamfer), b * h.z),
                    new Vector3(-h.x + chamfer, a * (h.y - chamfer), b * h.z),
                    new Vector3(0, a, b).normalized);
                Quad(verts, norms, uvs, tris,
                    new Vector3(a * h.x, -h.y + chamfer, b * (h.z - chamfer)),
                    new Vector3(a * h.x, h.y - chamfer, b * (h.z - chamfer)),
                    new Vector3(a * (h.x - chamfer), h.y - chamfer, b * h.z),
                    new Vector3(a * (h.x - chamfer), -h.y + chamfer, b * h.z),
                    new Vector3(a, 0, b).normalized);
                Quad(verts, norms, uvs, tris,
                    new Vector3(a * h.x, b * (h.y - chamfer), -h.z + chamfer),
                    new Vector3(a * h.x, b * (h.y - chamfer), h.z - chamfer),
                    new Vector3(a * (h.x - chamfer), b * h.y, h.z - chamfer),
                    new Vector3(a * (h.x - chamfer), b * h.y, -h.z + chamfer),
                    new Vector3(a, b, 0).normalized);
            }
            foreach (var a in sx)
            foreach (var b in sx)
            foreach (var c in sx)
            {
                var p0 = new Vector3(a * h.x, b * (h.y - chamfer), c * (h.z - chamfer));
                var p1 = new Vector3(a * (h.x - chamfer), b * h.y, c * (h.z - chamfer));
                var p2 = new Vector3(a * (h.x - chamfer), b * (h.y - chamfer), c * h.z);
                Tri(verts, norms, uvs, tris, p0, p1, p2, new Vector3(a, b, c).normalized);
            }

            var mesh = new Mesh { name = "BREACH_ChamferBox" };
            mesh.SetVertices(verts);
            mesh.SetNormals(norms);
            mesh.SetUVs(0, uvs);
            mesh.SetTriangles(tris, 0);
            mesh.RecalculateBounds();
            mesh.RecalculateTangents();
            return mesh;
        }

        static void Face(List<Vector3> v, List<Vector3> n, List<Vector2> uv, List<int> t, Vector3 normal, Vector3 h, float c)
        {
            Vector3 a, b;
            if (normal.x != 0) { a = Vector3.forward; b = Vector3.up; }
            else if (normal.y != 0) { a = Vector3.right; b = Vector3.forward; }
            else { a = Vector3.right; b = Vector3.up; }
            float ea = Vector3.Scale(a, h).magnitude - c;
            float eb = Vector3.Scale(b, h).magnitude - c;
            var center = Vector3.Scale(normal, h);
            Quad(v, n, uv, t, center - a * ea - b * eb, center + a * ea - b * eb, center + a * ea + b * eb, center - a * ea + b * eb, normal);
        }

        static void Quad(List<Vector3> v, List<Vector3> n, List<Vector2> uv, List<int> t, Vector3 p0, Vector3 p1, Vector3 p2, Vector3 p3, Vector3 normal)
        {
            // Ensure outward winding.
            var fn = Vector3.Cross(p1 - p0, p2 - p0);
            if (Vector3.Dot(fn, normal) < 0) { var tmp = p1; p1 = p3; p3 = tmp; }
            int i = v.Count;
            v.Add(p0); v.Add(p1); v.Add(p2); v.Add(p3);
            for (int k = 0; k < 4; k++) n.Add(normal);
            uv.Add(new Vector2(0, 0)); uv.Add(new Vector2(1, 0)); uv.Add(new Vector2(1, 1)); uv.Add(new Vector2(0, 1));
            // Unity front faces: Cross(b - a, c - a) points toward the viewer.
            t.Add(i); t.Add(i + 1); t.Add(i + 2);
            t.Add(i); t.Add(i + 2); t.Add(i + 3);
        }

        static void Tri(List<Vector3> v, List<Vector3> n, List<Vector2> uv, List<int> t, Vector3 p0, Vector3 p1, Vector3 p2, Vector3 normal)
        {
            var fn = Vector3.Cross(p1 - p0, p2 - p0);
            if (Vector3.Dot(fn, normal) < 0) { var tmp = p1; p1 = p2; p2 = tmp; }
            int i = v.Count;
            v.Add(p0); v.Add(p1); v.Add(p2);
            n.Add(normal); n.Add(normal); n.Add(normal);
            uv.Add(Vector2.zero); uv.Add(Vector2.right); uv.Add(Vector2.up);
            t.Add(i); t.Add(i + 1); t.Add(i + 2);
        }

        public static Mesh Cylinder(float radius, float length, int sides = 16) =>
            Loft(Vector3.forward * length, _ => radius, Vector2.one, sides, 1);

        public static Mesh Quad(float size)
        {
            var m = new Mesh { name = "BREACH_Quad" };
            float h = size * 0.5f;
            m.SetVertices(new List<Vector3> { new Vector3(-h, 0, -h), new Vector3(h, 0, -h), new Vector3(h, 0, h), new Vector3(-h, 0, h) });
            m.SetNormals(new List<Vector3> { Vector3.up, Vector3.up, Vector3.up, Vector3.up });
            m.SetUVs(0, new List<Vector2> { new Vector2(0, 0), new Vector2(1, 0), new Vector2(1, 1), new Vector2(0, 1) });
            m.SetTriangles(new[] { 0, 2, 1, 0, 3, 2 }, 0);
            m.RecalculateBounds();
            return m;
        }

        public static GameObject Part(string name, Transform parent, Mesh mesh, Material mat, Vector3 localPos, Quaternion localRot, int layer)
        {
            var go = new GameObject(name) { layer = layer };
            go.transform.SetParent(parent, false);
            go.transform.localPosition = localPos;
            go.transform.localRotation = localRot;
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            var mr = go.AddComponent<MeshRenderer>();
            mr.sharedMaterial = mat;
            return go;
        }
    }
}
