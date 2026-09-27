using System.Collections;
using Breach.Core.World;
using Breach.Util;
using UnityEngine;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

namespace Breach.AR
{
    /// <summary>
    /// Tracks the printed BREACH origin marker and feeds its pose into the
    /// shared origin. Uses a runtime (mutable) reference library so no editor
    /// asset authoring is needed. The marker image ships as raw PNG bytes in
    /// Resources/Markers/breach_origin_marker.bytes.
    /// </summary>
    public sealed class MarkerOrigin : MonoBehaviour
    {
        public const string MarkerName = "BREACH_ORIGIN";
        /// <summary>Printed width of the marker image, in metres.</summary>
        public const float MarkerWidthMetres = 0.18f;

        ArRig _rig;
        AddReferenceImageJobState? _job;

        public SharedOrigin Origin { get; } = new SharedOrigin(requiredSamples: 30);
        public string Status { get; private set; } = "not started";
        public TrackingState MarkerTracking { get; private set; } = TrackingState.None;
        public bool Supported { get; private set; }

        public void Init(ArRig rig)
        {
            _rig = rig;
            if (rig.Simulated || rig.Images == null)
            {
                Status = "simulated (no marker tracking)";
                return;
            }
            StartCoroutine(Setup());
        }

        IEnumerator Setup()
        {
            // Adding images to a runtime library requires a running session.
            Status = "waiting for AR session";
            while (ARSession.state < ARSessionState.Ready)
            {
                if (ARSession.state == ARSessionState.Unsupported)
                {
                    Status = "AR unsupported";
                    yield break;
                }
                yield return null;
            }

            var bytes = Resources.Load<TextAsset>("Markers/breach_origin_marker");
            if (bytes == null)
            {
                Status = "marker image missing from build";
                yield break;
            }
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            if (!tex.LoadImage(bytes.bytes, false))
            {
                Status = "marker image failed to decode";
                yield break;
            }

            try
            {
                var lib = _rig.Images.CreateRuntimeLibrary();
                if (lib is MutableRuntimeReferenceImageLibrary mutable)
                {
                    _job = mutable.ScheduleAddImageWithValidationJob(tex, MarkerName, MarkerWidthMetres);
                    _rig.Images.referenceLibrary = mutable;
                    _rig.Images.enabled = true;
                    _rig.Images.trackablesChanged.AddListener(OnChanged);
                    Supported = true;
                    Status = "validating marker image";
                }
                else
                {
                    Status = "device has no mutable image library";
                }
            }
            catch (System.Exception e)
            {
                Status = "image tracking unsupported: " + e.Message;
            }
        }

        void Update()
        {
            if (_job.HasValue && _job.Value.status != AddReferenceImageJobStatus.Pending)
            {
                Status = _job.Value.status == AddReferenceImageJobStatus.Success
                    ? "ready — point camera at marker"
                    : "marker rejected: " + _job.Value.status;
                _job = null;
            }
        }

        void OnDestroy()
        {
            if (_rig != null && _rig.Images != null) _rig.Images.trackablesChanged.RemoveListener(OnChanged);
        }

        void OnChanged(ARTrackablesChangedEventArgs<ARTrackedImage> args)
        {
            foreach (var img in args.added) Consider(img);
            foreach (var img in args.updated) Consider(img);
        }

        void Consider(ARTrackedImage img)
        {
            if (img.referenceImage.name != MarkerName) return;
            MarkerTracking = img.trackingState;
            if (img.trackingState != TrackingState.Tracking) return;
            if (Origin.State == OriginState.Locked) return;
            // Marker image plane: AR Foundation reports +Y as the image normal, +Z as image "up".
            Origin.AddMarkerSample(new RigidPose(img.transform.position.ToS(), img.transform.rotation.ToS()));
            Status = Origin.State == OriginState.Locked
                ? "origin locked"
                : $"calibrating {Origin.SampleCount}/30 — hold steady";
        }

        public void Recalibrate()
        {
            Origin.Reset();
            Status = Supported ? "ready — point camera at marker" : Status;
        }
    }
}
