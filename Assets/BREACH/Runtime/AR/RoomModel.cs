using System.Collections.Generic;
using Breach.Core.World;
using Breach.Presentation;
using Breach.Util;
using UnityEngine;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;
using SVector3 = System.Numerics.Vector3;

namespace Breach.AR
{
    /// <summary>
    /// The room as the game understands it: detected real planes converted
    /// into a floor height and floor-level tactical points (cover, corners,
    /// furniture), plus line-of-sight queries against real walls/furniture.
    /// </summary>
    public sealed class RoomModel : MonoBehaviour
    {
        static Material _scanMaterial;
        public static Material ScanMaterial
        {
            get
            {
                if (_scanMaterial == null)
                    _scanMaterial = BreachMaterials.UnlitTransparent(new Color(0.85f, 0.88f, 0.9f, 0.22f), ProceduralTextures.ScanGrid);
                return _scanMaterial;
            }
        }

        ArRig _rig;
        SimulatedRoom _sim;
        readonly List<SurfaceSample> _surfaces = new List<SurfaceSample>();
        readonly TacticalMapBuilder _builder = new TacticalMapBuilder();
        float _nextRebuild;
        bool _scanVisible = true;
        GameObject _floorCatcher;
        float _scanAlpha = 0.22f;

        public PlayBoundary Boundary { get; set; }
        public float? FloorY => _builder.FloorY;
        public IReadOnlyList<TacticalPoint> Points => _builder.Points;
        public float FloorArea => _builder.FloorArea;
        public int WallCount => _builder.WallCount;
        public int RaisedCount => _builder.RaisedCount;
        public int PlaneCount { get; private set; }
        /// <summary>When true the tactical map stops changing (locked for the match) — planes still refine.</summary>
        public bool Frozen { get; set; }

        public static int LineOfSightMask => Layers.Mask(Layers.RealWorld);

        public void Init(ArRig rig, SimulatedRoom sim)
        {
            _rig = rig;
            _sim = sim;
            _floorCatcher = new GameObject("Floor Catcher");
            _floorCatcher.transform.SetParent(transform, false);
            _floorCatcher.layer = Layers.Default;
            var box = _floorCatcher.AddComponent<BoxCollider>();
            box.size = new Vector3(40f, 0.1f, 40f);
            _floorCatcher.SetActive(false);
        }

        public bool ScanVisible
        {
            get => _scanVisible;
            set
            {
                _scanVisible = value;
                if (_rig != null && _rig.Planes != null)
                    foreach (var p in _rig.Planes.trackables)
                    {
                        var mr = p.GetComponent<MeshRenderer>();
                        if (mr != null) mr.enabled = value;
                    }
            }
        }

        void Update()
        {
            // New planes appear with the renderer enabled; enforce the current visibility.
            if (!_scanVisible && _rig != null && _rig.Planes != null)
                foreach (var p in _rig.Planes.trackables)
                {
                    var mr = p.GetComponent<MeshRenderer>();
                    if (mr != null && mr.enabled) mr.enabled = false;
                }

            // Subtle breathing on the scan grid so it reads as "scanning", not decoration.
            if (_scanVisible)
            {
                _scanAlpha = 0.14f + 0.08f * (0.5f + 0.5f * Mathf.Sin(Time.time * 2.2f));
                BreachMaterials.SetColor(ScanMaterial, new Color(0.85f, 0.88f, 0.9f, _scanAlpha));
            }

            if (Time.unscaledTime < _nextRebuild) return;
            _nextRebuild = Time.unscaledTime + 0.5f;
            if (!Frozen) Rebuild();
        }

        public void Rebuild()
        {
            _surfaces.Clear();
            if (_sim != null)
            {
                _surfaces.AddRange(_sim.Surfaces);
            }
            else if (_rig != null && _rig.Planes != null)
            {
                foreach (var plane in _rig.Planes.trackables)
                {
                    if (plane.subsumedBy != null) continue;
                    if (plane.trackingState == TrackingState.None) continue;
                    var s = ToSample(plane);
                    if (s != null) _surfaces.Add(s);
                }
            }
            PlaneCount = _surfaces.Count;
            _builder.Build(_surfaces, Boundary);

            if (_builder.FloorY.HasValue)
            {
                _floorCatcher.SetActive(true);
                _floorCatcher.transform.position = new Vector3(0, _builder.FloorY.Value - 0.05f, 0);
            }
        }

        static SurfaceSample ToSample(ARPlane plane)
        {
            SurfaceKind kind;
            switch (plane.alignment)
            {
                case PlaneAlignment.HorizontalUp: kind = SurfaceKind.HorizontalUp; break;
                case PlaneAlignment.HorizontalDown: kind = SurfaceKind.HorizontalDown; break;
                case PlaneAlignment.Vertical: kind = SurfaceKind.Vertical; break;
                default: return null;
            }
            var s = new SurfaceSample
            {
                Id = plane.trackableId.ToString(),
                Kind = kind,
                Center = plane.center.ToS(),
                Normal = plane.normal.ToS(),
                Area = plane.size.x * plane.size.y,
            };
            var boundary = plane.boundary;
            var t = plane.transform;
            for (int i = 0; i < boundary.Length; i++)
            {
                var b = boundary[i];
                s.Boundary.Add(t.TransformPoint(new Vector3(b.x, 0f, b.y)).ToS());
            }
            return s;
        }

        /// <summary>
        /// Line of sight from the player's eye to a standing Hunter at a floor position.
        /// Visible if any of three body heights is unobstructed by real geometry.
        /// </summary>
        public bool HasLineOfSight(Vector3 eye, Vector3 floorPoint)
        {
            float[] heights = { 0.35f, 0.9f, 1.45f };
            foreach (var h in heights)
            {
                var target = floorPoint + Vector3.up * h;
                var dir = target - eye;
                float dist = dir.magnitude;
                if (dist < 0.05f) return true;
                if (!Physics.Raycast(eye, dir / dist, dist - 0.05f, LineOfSightMask, QueryTriggerInteraction.Ignore))
                    return true;
            }
            return false;
        }

        public bool IsWalkable(Vector3 fromFloor, Vector3 toFloor)
        {
            // Knee-height sweep against real vertical surfaces and furniture.
            var a = fromFloor + Vector3.up * 0.4f;
            var b = toFloor + Vector3.up * 0.4f;
            var dir = b - a;
            float dist = dir.magnitude;
            if (dist < 1e-3f) return true;
            return !Physics.SphereCast(a, 0.12f, dir / dist, out _, dist, LineOfSightMask, QueryTriggerInteraction.Ignore);
        }

        public SVector3 PlayerFloor(Vector3 eye) =>
            new SVector3(eye.x, FloorY ?? eye.y - 1.4f, eye.z);
    }
}
