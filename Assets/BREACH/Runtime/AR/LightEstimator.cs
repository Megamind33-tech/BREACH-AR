using UnityEngine;
using UnityEngine.XR.ARFoundation;

namespace Breach.AR
{
    /// <summary>
    /// Applies ARCore light estimation so virtual combatants are lit like
    /// the real room. Pattern from arfoundation-samples BasicLightEstimation.
    /// </summary>
    public sealed class LightEstimator : MonoBehaviour
    {
        ARCameraManager _camera;
        Light _light;

        public float? Brightness { get; private set; }
        public Vector3? MainLightDirection { get; private set; }

        public void Bind(ARCameraManager cameraManager, Light light)
        {
            _light = light;
            _camera = cameraManager;
            if (_camera != null) _camera.frameReceived += OnFrame;
        }

        void OnDestroy()
        {
            if (_camera != null) _camera.frameReceived -= OnFrame;
        }

        void OnFrame(ARCameraFrameEventArgs args)
        {
            var le = args.lightEstimation;
            if (le.averageMainLightBrightness.HasValue)
            {
                Brightness = le.averageMainLightBrightness;
                _light.intensity = Mathf.Clamp(le.averageMainLightBrightness.Value * 1.4f, 0.25f, 2.2f);
            }
            else if (le.averageBrightness.HasValue)
            {
                Brightness = le.averageBrightness;
                _light.intensity = Mathf.Clamp(le.averageBrightness.Value * 1.6f, 0.25f, 2.2f);
            }

            if (le.mainLightColor.HasValue) _light.color = le.mainLightColor.Value;
            else if (le.colorCorrection.HasValue) _light.color = le.colorCorrection.Value;

            if (le.mainLightDirection.HasValue)
            {
                MainLightDirection = le.mainLightDirection;
                _light.transform.rotation = Quaternion.LookRotation(le.mainLightDirection.Value);
            }

            if (le.ambientSphericalHarmonics.HasValue)
            {
                RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Skybox;
                RenderSettings.ambientProbe = le.ambientSphericalHarmonics.Value;
            }
        }
    }
}
