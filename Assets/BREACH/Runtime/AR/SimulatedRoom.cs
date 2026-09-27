using System.Collections.Generic;
using Breach.Core.World;
using Breach.Presentation;
using Breach.Util;
using UnityEngine;
using UnityEngine.InputSystem;
using SVector3 = System.Numerics.Vector3;

namespace Breach.AR
{
    /// <summary>
    /// DEVELOPMENT ONLY. A plain stand-in room for running BREACH in the
    /// editor or on desktop when no AR device is present. It feeds the same
    /// SurfaceSample data a real ARCore scan would. Label: SIMULATED.
    /// </summary>
    public sealed class SimulatedRoom : MonoBehaviour
    {
        public readonly List<SurfaceSample> Surfaces = new List<SurfaceSample>();
        public const float FloorY = 0f;

        public static SimulatedRoom Create(Transform parent)
        {
            var go = new GameObject("SIMULATED ROOM");
            go.transform.SetParent(parent, false);
            var room = go.AddComponent<SimulatedRoom>();
            room.Build();
            return room;
        }

        void Build()
        {
            var floorMat = BreachMaterials.Lit(new Color(0.23f, 0.22f, 0.21f), 0.15f, 0f, ProceduralTextures.Grime);
            var wallMat = BreachMaterials.Lit(new Color(0.52f, 0.5f, 0.47f), 0.08f);
            var furnMat = BreachMaterials.Lit(new Color(0.18f, 0.2f, 0.22f), 0.25f);

            Slab("Floor", new Vector3(0, FloorY - 0.05f, 0), new Vector3(8f, 0.1f, 8f), floorMat);
            AddHorizontal(new Vector3(0, FloorY, 0), 8f, 8f);

            Wall(new Vector3(0, FloorY, 4f), 8f, Vector3.back, wallMat);
            Wall(new Vector3(-4f, FloorY, 0), 8f, Vector3.right, wallMat);
            Wall(new Vector3(4f, FloorY, 1.2f), 5.6f, Vector3.left, wallMat); // gap = doorway at the back-right
            Wall(new Vector3(0.6f, FloorY, -4f), 6.8f, Vector3.forward, wallMat);
            // Interior partial wall — a corner to hide behind.
            Wall(new Vector3(-1.6f, FloorY, 1.6f), 1.8f, Vector3.right, wallMat);

            Furniture("Table", new Vector3(1.6f, FloorY, 1.8f), new Vector3(1.4f, 0.74f, 0.8f), furnMat);
            Furniture("Sofa", new Vector3(-2.2f, FloorY, -2.4f), new Vector3(2.0f, 0.82f, 0.9f), furnMat);
        }

        GameObject Slab(string name, Vector3 center, Vector3 size, Material mat)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = name;
            go.transform.SetParent(transform, false);
            go.transform.position = center;
            go.transform.localScale = size;
            go.GetComponent<MeshRenderer>().sharedMaterial = mat;
            go.layer = Layers.RealWorld;
            return go;
        }

        void AddHorizontal(Vector3 c, float w, float d)
        {
            var s = new SurfaceSample { Kind = SurfaceKind.HorizontalUp, Center = c.ToS(), Normal = SVector3.UnitY, Area = w * d };
            s.Boundary.Add((c + new Vector3(-w / 2, 0, -d / 2)).ToS());
            s.Boundary.Add((c + new Vector3(w / 2, 0, -d / 2)).ToS());
            s.Boundary.Add((c + new Vector3(w / 2, 0, d / 2)).ToS());
            s.Boundary.Add((c + new Vector3(-w / 2, 0, d / 2)).ToS());
            Surfaces.Add(s);
        }

        void Wall(Vector3 baseCenter, float length, Vector3 normal, Material mat)
        {
            const float h = 2.4f;
            var tangent = Vector3.Cross(Vector3.up, normal);
            var go = Slab("Wall", baseCenter + Vector3.up * h / 2 - normal * 0.05f, Vector3.one, mat);
            go.transform.rotation = Quaternion.LookRotation(normal);
            go.transform.localScale = new Vector3(length, h, 0.1f);
            var c = baseCenter + Vector3.up * h / 2;
            var s = new SurfaceSample { Kind = SurfaceKind.Vertical, Center = c.ToS(), Normal = normal.ToS(), Area = length * h };
            s.Boundary.Add((c - tangent * length / 2 - Vector3.up * h / 2).ToS());
            s.Boundary.Add((c + tangent * length / 2 - Vector3.up * h / 2).ToS());
            s.Boundary.Add((c + tangent * length / 2 + Vector3.up * h / 2).ToS());
            s.Boundary.Add((c - tangent * length / 2 + Vector3.up * h / 2).ToS());
            Surfaces.Add(s);
        }

        void Furniture(string name, Vector3 floorCenter, Vector3 size, Material mat)
        {
            Slab(name, floorCenter + Vector3.up * size.y / 2, size, mat);
            AddHorizontal(floorCenter + Vector3.up * size.y, size.x, size.z);
        }
    }

    /// <summary>DEVELOPMENT ONLY: right-mouse look + WASD for the simulated room.</summary>
    public sealed class SimulatedLook : MonoBehaviour
    {
        float _yaw, _pitch;

        void Update()
        {
            var mouse = Mouse.current;
            var kb = Keyboard.current;
            if (mouse != null && (mouse.rightButton.isPressed || Cursor.lockState == CursorLockMode.Locked))
            {
                var d = mouse.delta.ReadValue();
                _yaw += d.x * 0.12f;
                _pitch = Mathf.Clamp(_pitch - d.y * 0.12f, -80f, 80f);
            }
            transform.rotation = Quaternion.Euler(_pitch, _yaw, 0);
            if (kb == null) return;
            var move = Vector3.zero;
            if (kb.wKey.isPressed) move += Vector3.forward;
            if (kb.sKey.isPressed) move += Vector3.back;
            if (kb.aKey.isPressed) move += Vector3.left;
            if (kb.dKey.isPressed) move += Vector3.right;
            var flat = Quaternion.Euler(0, _yaw, 0) * move;
            transform.position += flat * (1.4f * Time.deltaTime);
        }
    }
}
