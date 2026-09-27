using System;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem.UI;
using UnityEngine.UI;

namespace Breach.UI
{
    /// <summary>
    /// BREACH visual language: near-black translucent panels only when needed,
    /// off-white condensed type, a single restrained accent (desaturated amber)
    /// for state, no gradients, glows or rounded "mobile game" buttons.
    /// </summary>
    public static class Palette
    {
        public static readonly Color Text = new Color(0.93f, 0.93f, 0.91f, 1f);
        public static readonly Color TextDim = new Color(0.93f, 0.93f, 0.91f, 0.55f);
        public static readonly Color TextFaint = new Color(0.93f, 0.93f, 0.91f, 0.3f);
        public static readonly Color Accent = new Color(0.86f, 0.62f, 0.26f, 1f);
        public static readonly Color Danger = new Color(0.82f, 0.22f, 0.16f, 1f);
        public static readonly Color Panel = new Color(0.03f, 0.035f, 0.04f, 0.72f);
        public static readonly Color Scrim = new Color(0f, 0f, 0f, 0.55f);
        public static readonly Color Line = new Color(0.93f, 0.93f, 0.91f, 0.22f);
        public static readonly Color Shadow = new Color(0f, 0f, 0f, 0.55f);
    }

    public static class UiFactory
    {
        static Font _regular, _bold;

        public static Font Regular => _regular != null ? _regular : (_regular = LoadFont("Fonts/BarlowCondensed-Medium"));
        public static Font Bold => _bold != null ? _bold : (_bold = LoadFont("Fonts/BarlowCondensed-SemiBold"));

        static Font LoadFont(string path)
        {
            var f = Resources.Load<Font>(path);
            if (f == null)
            {
                Debug.LogWarning("[BREACH] Font missing: " + path);
                f = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            }
            return f;
        }

        public static Canvas CreateCanvas(Transform parent, string name, int order)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            var canvas = go.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = order;
            var scaler = go.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920, 1080);
            scaler.matchWidthOrHeight = 0.6f;
            go.AddComponent<GraphicRaycaster>();
            return canvas;
        }

        public static void EnsureEventSystem(Transform parent)
        {
            if (EventSystem.current != null) return;
            var go = new GameObject("EventSystem");
            go.transform.SetParent(parent, false);
            go.AddComponent<EventSystem>();
            var module = go.AddComponent<InputSystemUIInputModule>();
            module.AssignDefaultActions();
        }

        public static RectTransform Rect(string name, Transform parent, Vector2 anchorMin, Vector2 anchorMax, Vector2 pivot, Vector2 pos, Vector2 size)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchorMin = anchorMin;
            rt.anchorMax = anchorMax;
            rt.pivot = pivot;
            rt.anchoredPosition = pos;
            rt.sizeDelta = size;
            return rt;
        }

        public static RectTransform Stretch(string name, Transform parent)
        {
            var rt = Rect(name, parent, Vector2.zero, Vector2.one, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            return rt;
        }

        public static Text Label(Transform parent, string text, int size, Color color, TextAnchor align, bool bold = false, string name = "Label")
        {
            var rt = Stretch(name, parent);
            var t = rt.gameObject.AddComponent<Text>();
            t.font = bold ? Bold : Regular;
            t.fontSize = size;
            t.color = color;
            t.alignment = align;
            t.text = text;
            t.horizontalOverflow = HorizontalWrapMode.Overflow;
            t.verticalOverflow = VerticalWrapMode.Overflow;
            t.raycastTarget = false;
            var sh = rt.gameObject.AddComponent<Shadow>();
            sh.effectColor = Palette.Shadow;
            sh.effectDistance = new Vector2(1.5f, -1.5f);
            return t;
        }

        public static Text LabelAt(Transform parent, string text, int size, Color color, TextAnchor align, Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 box, bool bold = false, string name = "Label")
        {
            var rt = Rect(name, parent, anchor, anchor, pivot, pos, box);
            var t = rt.gameObject.AddComponent<Text>();
            t.font = bold ? Bold : Regular;
            t.fontSize = size;
            t.color = color;
            t.alignment = align;
            t.text = text;
            t.horizontalOverflow = HorizontalWrapMode.Wrap;
            t.verticalOverflow = VerticalWrapMode.Overflow;
            t.raycastTarget = false;
            var sh = rt.gameObject.AddComponent<Shadow>();
            sh.effectColor = Palette.Shadow;
            sh.effectDistance = new Vector2(1.5f, -1.5f);
            return t;
        }

        public static Image Box(Transform parent, Color color, Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 size, string name = "Box", Sprite sprite = null)
        {
            var rt = Rect(name, parent, anchor, anchor, pivot, pos, size);
            var img = rt.gameObject.AddComponent<Image>();
            img.color = color;
            img.sprite = sprite;
            img.raycastTarget = false;
            return img;
        }

        public static Image Fill(Transform parent, Color color, string name = "Fill", Sprite sprite = null)
        {
            var rt = Stretch(name, parent);
            var img = rt.gameObject.AddComponent<Image>();
            img.color = color;
            img.sprite = sprite;
            img.raycastTarget = false;
            return img;
        }

        /// <summary>
        /// Text-first button: label with a thin rule underneath that turns
        /// accent on press. No rounded pill, no glow.
        /// </summary>
        public static Button TextButton(Transform parent, string text, int size, Vector2 anchor, Vector2 pivot, Vector2 pos, Vector2 box, Action onClick, TextAnchor align = TextAnchor.MiddleLeft)
        {
            var rt = Rect("Button " + text, parent, anchor, anchor, pivot, pos, box);
            var hit = rt.gameObject.AddComponent<Image>();
            hit.color = new Color(0, 0, 0, 0.001f); // invisible hit area
            var btn = rt.gameObject.AddComponent<Button>();
            btn.transition = Selectable.Transition.None;
            var label = Label(rt, text, size, Palette.Text, align, true);
            var rule = Box(rt, Palette.Line, new Vector2(align == TextAnchor.MiddleCenter ? 0.5f : 0f, 0f),
                new Vector2(align == TextAnchor.MiddleCenter ? 0.5f : 0f, 0f), new Vector2(0, 4), new Vector2(align == TextAnchor.MiddleCenter ? 120 : 64, 2), "Rule");
            var press = rt.gameObject.AddComponent<PressFeedback>();
            press.Label = label;
            press.Rule = rule;
            btn.onClick.AddListener(() =>
            {
                Presentation.BreachAudio.Instance?.Play2D(Presentation.Sfx.UiSelect, 0.6f, 0.02f);
                onClick?.Invoke();
            });
            return btn;
        }

        static Sprite _arc, _vignette, _chevron, _gradientLeft;

        /// <summary>Thin arc segment used for damage direction.</summary>
        public static Sprite ArcSprite
        {
            get
            {
                if (_arc != null) return _arc;
                const int w = 256, h = 64;
                var tex = new Texture2D(w, h, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp };
                var px = new Color[w * h];
                for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    float u = (x + 0.5f) / w * 2 - 1;
                    float v = (y + 0.5f) / h;
                    // Crescent: thick in the middle, tapering to the ends.
                    float center = 0.45f + 0.25f * (1 - u * u);
                    float thick = 0.22f * (1 - u * u);
                    float a = Mathf.Clamp01(1 - Mathf.Abs(v - center) / Mathf.Max(thick, 1e-3f));
                    a *= Mathf.Clamp01((1 - Mathf.Abs(u)) * 3f);
                    px[y * w + x] = new Color(1, 1, 1, a);
                }
                tex.SetPixels(px);
                tex.Apply();
                _arc = Sprite.Create(tex, new Rect(0, 0, w, h), new Vector2(0.5f, 0.5f));
                return _arc;
            }
        }

        public static Sprite VignetteSprite
        {
            get
            {
                if (_vignette != null) return _vignette;
                const int s = 128;
                var tex = new Texture2D(s, s, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp };
                var px = new Color[s * s];
                for (int y = 0; y < s; y++)
                for (int x = 0; x < s; x++)
                {
                    float dx = (x + 0.5f) / s * 2 - 1, dy = (y + 0.5f) / s * 2 - 1;
                    float d = Mathf.Sqrt(dx * dx * 0.8f + dy * dy);
                    float a = Mathf.Clamp01((d - 0.55f) / 0.6f);
                    px[y * s + x] = new Color(1, 1, 1, a * a);
                }
                tex.SetPixels(px);
                tex.Apply();
                _vignette = Sprite.Create(tex, new Rect(0, 0, s, s), new Vector2(0.5f, 0.5f));
                return _vignette;
            }
        }

        public static Sprite ChevronSprite
        {
            get
            {
                if (_chevron != null) return _chevron;
                const int s = 64;
                var tex = new Texture2D(s, s, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp };
                var px = new Color[s * s];
                for (int y = 0; y < s; y++)
                for (int x = 0; x < s; x++)
                {
                    float u = (x + 0.5f) / s - 0.5f, v = (y + 0.5f) / s - 0.5f;
                    // Open chevron pointing +Y.
                    float d = Mathf.Abs(v - (0.25f - Mathf.Abs(u) * 1.1f));
                    float a = Mathf.Clamp01(1 - d / 0.045f) * (Mathf.Abs(u) < 0.36f ? 1 : 0);
                    px[y * s + x] = new Color(1, 1, 1, a);
                }
                tex.SetPixels(px);
                tex.Apply();
                _chevron = Sprite.Create(tex, new Rect(0, 0, s, s), new Vector2(0.5f, 0.5f));
                return _chevron;
            }
        }

        /// <summary>Left-to-right darkening so menus read over the live camera.</summary>
        public static Sprite LeftShadeSprite
        {
            get
            {
                if (_gradientLeft != null) return _gradientLeft;
                const int w = 256;
                var tex = new Texture2D(w, 1, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp };
                for (int x = 0; x < w; x++)
                {
                    float t = (float)x / (w - 1);
                    tex.SetPixel(x, 0, new Color(0, 0, 0, Mathf.Lerp(0.82f, 0f, Mathf.SmoothStep(0f, 1f, t))));
                }
                tex.Apply();
                _gradientLeft = Sprite.Create(tex, new Rect(0, 0, w, 1), new Vector2(0.5f, 0.5f));
                return _gradientLeft;
            }
        }
    }

    public sealed class PressFeedback : MonoBehaviour, IPointerDownHandler, IPointerUpHandler, IPointerExitHandler
    {
        public Text Label;
        public Image Rule;

        public void OnPointerDown(PointerEventData e)
        {
            if (Rule != null) Rule.color = Palette.Accent;
            if (Label != null) Label.color = Palette.Accent;
        }

        public void OnPointerUp(PointerEventData e) => Restore();
        public void OnPointerExit(PointerEventData e) => Restore();

        void Restore()
        {
            if (Rule != null) Rule.color = Palette.Line;
            if (Label != null) Label.color = Palette.Text;
        }
    }
}
