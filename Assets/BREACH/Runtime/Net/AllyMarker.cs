using Breach.UI;
using UnityEngine;
using UnityEngine.UI;

namespace Breach.Net
{
    /// <summary>
    /// Restrained teammate cue: a small open diamond and callsign floating just
    /// above the teammate's phone. The teammate is physically in the room, so
    /// the camera already shows them — this only confirms who is who and, when
    /// calibration is good, sits right on their device (a live check that both
    /// phones agree on the shared origin).
    /// </summary>
    public sealed class AllyMarker : MonoBehaviour
    {
        Text _label;
        Image _diamond;
        Camera _cam;
        CanvasGroup _group;

        public static AllyMarker Create(Transform parent, Camera cam, string callsign)
        {
            var go = new GameObject("Ally " + callsign);
            go.transform.SetParent(parent, false);
            var canvas = go.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            canvas.worldCamera = cam;
            var rt = (RectTransform)go.transform;
            rt.sizeDelta = new Vector2(300, 120);
            rt.localScale = Vector3.one * 0.0012f;
            var m = go.AddComponent<AllyMarker>();
            m._cam = cam;
            m._group = go.AddComponent<CanvasGroup>();
            m._diamond = UiFactory.Box(rt, new Color(0.55f, 0.78f, 0.9f, 0.85f), new Vector2(0.5f, 0f), new Vector2(0.5f, 0f), new Vector2(0, 6), new Vector2(26, 26), "Diamond", UiFactory.ChevronSprite);
            m._diamond.rectTransform.localRotation = Quaternion.Euler(0, 0, 180f);
            m._label = UiFactory.LabelAt(rt, callsign, 34, new Color(0.8f, 0.9f, 0.95f, 0.9f), TextAnchor.LowerCenter,
                new Vector2(0.5f, 0f), new Vector2(0.5f, 0f), new Vector2(0, 40), new Vector2(300, 44), true, "Callsign");
            return m;
        }

        public void SetState(Vector3 phoneWorldPosition, bool alive, bool fresh)
        {
            transform.position = phoneWorldPosition + Vector3.up * 0.22f;
            var toCam = transform.position - _cam.transform.position;
            if (toCam.sqrMagnitude > 1e-4f) transform.rotation = Quaternion.LookRotation(toCam, Vector3.up);
            // Scale with distance so it stays readable but small.
            float d = Mathf.Sqrt(toCam.magnitude);
            transform.localScale = Vector3.one * 0.0009f * Mathf.Clamp(d, 0.8f, 2.2f);
            _group.alpha = fresh ? 1f : 0.35f;
            var c = alive ? new Color(0.55f, 0.78f, 0.9f, 0.85f) : new Color(0.82f, 0.22f, 0.16f, 0.85f);
            _diamond.color = c;
        }

        public void SetCallsign(string text) => _label.text = text;
    }
}
