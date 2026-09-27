using System;
using UnityEngine;
using UnityEngine.UI;

namespace Breach.UI
{
    /// <summary>
    /// Hidden diagnostics screen (Settings → Diagnostics, Pause → Diagnostics,
    /// or long-press the pause button in combat). EXPORT TEST REPORT shares the
    /// plain-text report through Android's share sheet and copies it to the
    /// clipboard, so a tester can return results without knowing Unity.
    /// </summary>
    public sealed class DiagnosticsPanel : MonoBehaviour
    {
        Canvas _canvas;
        Text _body, _status;
        public Func<string> BuildReport;
        float _refresh;

        public bool Visible => _canvas.enabled;

        public static DiagnosticsPanel Create(Transform parent)
        {
            var go = new GameObject("Diagnostics");
            go.transform.SetParent(parent, false);
            var d = go.AddComponent<DiagnosticsPanel>();
            d.Build();
            return d;
        }

        void Build()
        {
            _canvas = UiFactory.CreateCanvas(transform, "Diagnostics Canvas", 40);
            var root = (RectTransform)_canvas.transform;
            var bg = UiFactory.Fill(root, new Color(0.02f, 0.025f, 0.03f, 0.9f), "Backdrop");
            bg.raycastTarget = true; // block touches to the game underneath
            UiFactory.LabelAt(root, "DIAGNOSTICS", 40, Palette.Text, TextAnchor.UpperLeft, new Vector2(0, 1), new Vector2(0, 1), new Vector2(60, -34), new Vector2(800, 50), true);
            _body = UiFactory.LabelAt(root, "", 21, Palette.TextDim, TextAnchor.UpperLeft, new Vector2(0, 1), new Vector2(0, 1), new Vector2(60, -96), new Vector2(1250, 940));
            _body.font = UiFactory.Regular;
            _status = UiFactory.LabelAt(root, "", 22, Palette.Accent, TextAnchor.LowerRight, new Vector2(1, 0), new Vector2(1, 0), new Vector2(-60, 170), new Vector2(600, 30), true);
            UiFactory.TextButton(root, "EXPORT TEST REPORT", 36, new Vector2(1, 0), new Vector2(1, 0), new Vector2(-60, 90), new Vector2(520, 60), Export, TextAnchor.MiddleRight);
            UiFactory.TextButton(root, "CLOSE", 30, new Vector2(1, 1), new Vector2(1, 1), new Vector2(-60, -30), new Vector2(240, 50), () => SetVisible(false), TextAnchor.MiddleRight);
            SetVisible(false);
        }

        public void SetVisible(bool v)
        {
            _canvas.enabled = v;
            _status.text = "";
            _refresh = 0f;
        }

        void Update()
        {
            if (!_canvas.enabled || BuildReport == null) return;
            _refresh -= Time.unscaledDeltaTime;
            if (_refresh > 0f) return;
            _refresh = 0.5f;
            _body.text = BuildReport();
        }

        void Export()
        {
            var text = BuildReport != null ? BuildReport() : "";
            string path = null;
            try
            {
                path = System.IO.Path.Combine(Application.persistentDataPath, $"breach_report_{DateTime.UtcNow:yyyyMMdd_HHmmss}.txt");
                System.IO.File.WriteAllText(path, text);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[BREACH] Could not write report: " + e.Message);
            }
            GUIUtility.systemCopyBuffer = text;
            bool shared = ShareText(text);
            _status.text = shared ? "SHARE SHEET OPENED · COPIED TO CLIPBOARD" : "COPIED TO CLIPBOARD";
            Debug.Log("[BREACH] Test report exported" + (path != null ? " to " + path : ""));
        }

        static bool ShareText(string text)
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            try
            {
                using (var intentClass = new AndroidJavaClass("android.content.Intent"))
                using (var intent = new AndroidJavaObject("android.content.Intent"))
                using (var player = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                using (var activity = player.GetStatic<AndroidJavaObject>("currentActivity"))
                {
                    intent.Call<AndroidJavaObject>("setAction", intentClass.GetStatic<string>("ACTION_SEND"));
                    intent.Call<AndroidJavaObject>("setType", "text/plain");
                    intent.Call<AndroidJavaObject>("putExtra", intentClass.GetStatic<string>("EXTRA_SUBJECT"), "BREACH AR test report");
                    intent.Call<AndroidJavaObject>("putExtra", intentClass.GetStatic<string>("EXTRA_TEXT"), text);
                    using (var chooser = intentClass.CallStatic<AndroidJavaObject>("createChooser", intent, "Send BREACH test report"))
                        activity.Call("startActivity", chooser);
                }
                return true;
            }
            catch (Exception e)
            {
                Debug.LogWarning("[BREACH] Share failed: " + e.Message);
                return false;
            }
#else
            return false;
#endif
        }
    }
}
