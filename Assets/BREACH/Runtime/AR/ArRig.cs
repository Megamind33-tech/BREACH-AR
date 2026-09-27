using Breach.Presentation;
using Breach.Util;
using Unity.XR.CoreUtils;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.XR;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

namespace Breach.AR
{
    /// <summary>
    /// Builds the complete AR Foundation rig from code (no scene or prefab
    /// authoring): ARSession, XR Origin, AR camera with background, light
    /// estimation, environment-depth occlusion, plane detection, raycasts and
    /// image tracking. Component set mirrors Unity's arfoundation-samples
    /// "AR Session" + "XR Origin (AR Rig)" (Unity Companion License).
    /// </summary>
    public sealed class ArRig : MonoBehaviour
    {
        public Camera Camera { get; private set; }
        public ARSession Session { get; private set; }
        public XROrigin Origin { get; private set; }
        public ARCameraManager CameraManager { get; private set; }
        public ARPlaneManager Planes { get; private set; }
        public ARRaycastManager Raycasts { get; private set; }
        public ARTrackedImageManager Images { get; private set; }
        public AROcclusionManager Occlusion { get; private set; }
        public Light Sun { get; private set; }

        /// <summary>True when running without a real AR device (editor / desktop): a simulated room is used.</summary>
        public bool Simulated { get; private set; }

        public static ArRig Create(Transform parent, bool simulated)
        {
            var root = new GameObject("BREACH AR Rig");
            root.transform.SetParent(parent, false);
            var rig = root.AddComponent<ArRig>();
            rig.Simulated = simulated;
            if (simulated) rig.BuildSimulated();
            else rig.BuildAr();
            rig.BuildLight();
            return rig;
        }

        void BuildAr()
        {
            var sessionGo = new GameObject("AR Session");
            sessionGo.SetActive(false);
            sessionGo.transform.SetParent(transform, false);
            Session = sessionGo.AddComponent<ARSession>();
            sessionGo.AddComponent<ARInputManager>();

            var originGo = new GameObject("XR Origin");
            originGo.SetActive(false);
            originGo.transform.SetParent(transform, false);
            var offset = new GameObject("Camera Offset");
            offset.transform.SetParent(originGo.transform, false);

            var camGo = new GameObject("AR Camera") { tag = "MainCamera" };
            camGo.transform.SetParent(offset.transform, false);
            Camera = camGo.AddComponent<Camera>();
            ConfigureCamera(Camera);
            camGo.AddComponent<AudioListener>();

            CameraManager = camGo.AddComponent<ARCameraManager>();
            // Environmental HDR on ARCore: real main-light direction/intensity and ambient SH.
            CameraManager.requestedLightEstimation =
                LightEstimation.MainLightDirection | LightEstimation.MainLightIntensity | LightEstimation.AmbientSphericalHarmonics;
            camGo.AddComponent<ARCameraBackground>();

            Occlusion = camGo.AddComponent<AROcclusionManager>();
            Occlusion.requestedEnvironmentDepthMode = EnvironmentDepthMode.Medium;
            Occlusion.environmentDepthTemporalSmoothingRequested = true;
            Occlusion.requestedOcclusionPreferenceMode = OcclusionPreferenceMode.PreferEnvironmentOcclusion;

            var tpd = camGo.AddComponent<TrackedPoseDriver>();
            var pos = new InputAction("BREACH Device Position", InputActionType.Value, "<HandheldARInputDevice>/devicePosition", expectedControlType: "Vector3");
            pos.AddBinding("<XRHMD>/centerEyePosition");
            var rot = new InputAction("BREACH Device Rotation", InputActionType.Value, "<HandheldARInputDevice>/deviceRotation", expectedControlType: "Quaternion");
            rot.AddBinding("<XRHMD>/centerEyeRotation");
            tpd.positionInput = new InputActionProperty(pos);
            tpd.rotationInput = new InputActionProperty(rot);
            tpd.trackingType = TrackedPoseDriver.TrackingType.RotationAndPosition;
            tpd.updateType = TrackedPoseDriver.UpdateType.UpdateAndBeforeRender;

            Origin = originGo.AddComponent<XROrigin>();
            Origin.Camera = Camera;
            Origin.CameraFloorOffsetObject = offset;
            Origin.Origin = originGo;

            Planes = originGo.AddComponent<ARPlaneManager>();
            Planes.planePrefab = BuildPlaneTemplate();
            Planes.requestedDetectionMode = PlaneDetectionMode.Horizontal | PlaneDetectionMode.Vertical;
            Raycasts = originGo.AddComponent<ARRaycastManager>();
            Images = originGo.AddComponent<ARTrackedImageManager>();
            Images.enabled = false; // enabled by MarkerOrigin once a runtime library exists
            Images.requestedMaxNumberOfMovingImages = 1;

            sessionGo.SetActive(true);
            originGo.SetActive(true);
        }

        void BuildSimulated()
        {
            var camGo = new GameObject("Simulated Camera") { tag = "MainCamera" };
            camGo.transform.SetParent(transform, false);
            camGo.transform.position = new Vector3(0, 1.45f, 0);
            Camera = camGo.AddComponent<Camera>();
            ConfigureCamera(Camera);
            Camera.clearFlags = CameraClearFlags.SolidColor;
            Camera.backgroundColor = new Color(0.075f, 0.078f, 0.082f);
            camGo.AddComponent<AudioListener>();
            camGo.AddComponent<SimulatedLook>();
        }

        static void ConfigureCamera(Camera cam)
        {
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = Color.black;
            cam.nearClipPlane = 0.02f;
            cam.farClipPlane = 40f;
            cam.allowHDR = false;
            cam.allowMSAA = true;
        }

        void BuildLight()
        {
            var lightGo = new GameObject("Estimated Main Light");
            lightGo.transform.SetParent(transform, false);
            lightGo.transform.rotation = Quaternion.Euler(52f, -30f, 0f);
            Sun = lightGo.AddComponent<Light>();
            Sun.type = LightType.Directional;
            Sun.intensity = 1.0f;
            Sun.color = new Color(1f, 0.97f, 0.92f);
            Sun.shadows = LightShadows.Soft;
            Sun.shadowStrength = 0.6f;
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.36f, 0.37f, 0.4f);
            var est = lightGo.AddComponent<LightEstimator>();
            est.Bind(CameraManager, Sun);
        }

        GameObject BuildPlaneTemplate()
        {
            // Held under an inactive parent so the template itself never runs;
            // AR Foundation's spawner clones it per detected plane.
            var holder = new GameObject("Plane Template Holder");
            holder.SetActive(false);
            holder.transform.SetParent(transform, false);
            var tpl = new GameObject("Real Surface");
            tpl.transform.SetParent(holder.transform, false);
            tpl.layer = Layers.RealWorld;
            tpl.AddComponent<ARPlane>();
            tpl.AddComponent<MeshFilter>();
            var mr = tpl.AddComponent<MeshRenderer>();
            mr.sharedMaterial = RoomModel.ScanMaterial;
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            mr.receiveShadows = false;
            tpl.AddComponent<MeshCollider>();
            tpl.AddComponent<ARPlaneMeshVisualizer>();
            tpl.AddComponent<SurfaceTiling>();
            return tpl;
        }

        public string TrackingSummary()
        {
            if (Simulated) return "SIMULATED";
            return $"{ARSession.state} / {ARSession.notTrackingReason}";
        }
    }

    /// <summary>Keeps the scan-grid texture at a constant world scale on each plane.</summary>
    public sealed class SurfaceTiling : MonoBehaviour
    {
        MeshRenderer _mr;
        MaterialPropertyBlock _mpb;
        static readonly int BaseMapSt = Shader.PropertyToID("_BaseMap_ST");

        void Awake()
        {
            _mr = GetComponent<MeshRenderer>();
            _mpb = new MaterialPropertyBlock();
        }

        void LateUpdate()
        {
            if (_mr == null || !_mr.enabled) return;
            // ARPlaneMeshVisualizer generates UVs in plane space (metres); 8 dots per metre.
            _mr.GetPropertyBlock(_mpb);
            _mpb.SetVector(BaseMapSt, new Vector4(8f, 8f, 0f, 0f));
            _mr.SetPropertyBlock(_mpb);
        }
    }
}
