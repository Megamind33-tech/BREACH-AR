using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace Breach.UI
{
    /// <summary>
    /// Non-combat screens. Every screen is a short transition into play:
    /// menu, settings, safety check, room scan, pause, and after-action.
    /// </summary>
    public sealed class Screens : MonoBehaviour
    {
        Canvas _canvas;
        RectTransform _root;
        readonly Dictionary<string, GameObject> _pages = new Dictionary<string, GameObject>();

        public Action OnPlay, OnTraining, OnSafetyConfirmed, OnBeginMatch, OnResume, OnEndMatch, OnAgain, OnMenu, OnDiagnostics, OnRecalibrate;

        Text _scanTitle, _scanDetail, _scanStats, _countdown, _countdownSub, _resultTitle, _resultStats, _menuFooter, _originStatus;
        Image _scanProgress;
        Button _beginButton;

        public static Screens Create(Transform parent)
        {
            var go = new GameObject("Screens");
            go.transform.SetParent(parent, false);
            var s = go.AddComponent<Screens>();
            s.Build();
            return s;
        }

        GameObject Page(string name, bool shadeLeft, bool scrim)
        {
            var rt = UiFactory.Stretch(name, _root);
            if (scrim) UiFactory.Fill(rt, Palette.Scrim, "Scrim");
            if (shadeLeft)
            {
                var shade = UiFactory.Rect("Shade", rt, new Vector2(0, 0), new Vector2(0.7f, 1), new Vector2(0, 0.5f), Vector2.zero, Vector2.zero);
                var img = shade.gameObject.AddComponent<Image>();
                img.sprite = UiFactory.LeftShadeSprite;
                img.color = Color.white;
                img.raycastTarget = false;
            }
            rt.gameObject.SetActive(false);
            _pages[name] = rt.gameObject;
            return rt.gameObject;
        }

        void Build()
        {
            _canvas = UiFactory.CreateCanvas(transform, "Screens Canvas", 20);
            _root = (RectTransform)_canvas.transform;
            var L = new Vector2(0f, 0.5f);
            var C = new Vector2(0.5f, 0.5f);

            // ---------------- MENU ----------------
            var menu = Page("Menu", shadeLeft: true, scrim: false).transform;
            UiFactory.LabelAt(menu, "BREACH", 150, Palette.Text, TextAnchor.LowerLeft, L, new Vector2(0, 0), new Vector2(150, 150), new Vector2(900, 170), true, "Title");
            UiFactory.LabelAt(menu, "AR", 34, Palette.Accent, TextAnchor.LowerLeft, L, new Vector2(0, 0), new Vector2(158, 120), new Vector2(200, 40), true, "Tag");
            UiFactory.LabelAt(menu, "REALITY IS THE MAP", 24, Palette.TextDim, TextAnchor.LowerLeft, L, new Vector2(0, 0), new Vector2(212, 124), new Vector2(600, 34), false, "Tagline");
            UiFactory.TextButton(menu, "PLAY", 54, L, new Vector2(0, 0.5f), new Vector2(150, 20), new Vector2(520, 76), () => OnPlay?.Invoke());
            UiFactory.TextButton(menu, "TRAINING", 40, L, new Vector2(0, 0.5f), new Vector2(150, -76), new Vector2(520, 60), () => OnTraining?.Invoke());
            UiFactory.TextButton(menu, "SETTINGS", 40, L, new Vector2(0, 0.5f), new Vector2(150, -156), new Vector2(520, 60), () => Show("Settings"));
            _menuFooter = UiFactory.LabelAt(menu, "", 18, Palette.TextFaint, TextAnchor.LowerLeft, new Vector2(0, 0), new Vector2(0, 0), new Vector2(150, 40), new Vector2(1400, 26), false, "Footer");

            // ---------------- SETTINGS ----------------
            var settings = Page("Settings", shadeLeft: true, scrim: false).transform;
            UiFactory.LabelAt(settings, "SETTINGS", 64, Palette.Text, TextAnchor.LowerLeft, L, new Vector2(0, 0), new Vector2(150, 210), new Vector2(800, 80), true);
            SettingRow(settings, "HAPTICS", 120, () => Game.Settings.Haptics ? "ON" : "OFF",
                () => Game.Settings.Haptics = !Game.Settings.Haptics);
            SettingRow(settings, "FIRE SIDE", 50, () => Game.Settings.LeftHanded ? "LEFT" : "RIGHT",
                () => Game.Settings.LeftHanded = !Game.Settings.LeftHanded);
            SettingRow(settings, "VOLUME", -20, () => Mathf.RoundToInt(Game.Settings.Volume * 100) + "%", () =>
            {
                float v = Game.Settings.Volume + 0.25f;
                Game.Settings.Volume = v > 1.01f ? 0f : v;
            });
            SettingRow(settings, "PLAY AREA", -90, () => Game.Settings.ArenaRadius.ToString("0") + " M RADIUS", () =>
            {
                float r = Game.Settings.ArenaRadius + 1f;
                Game.Settings.ArenaRadius = r > 5.01f ? 2f : r;
            });
            UiFactory.TextButton(settings, "DIAGNOSTICS", 36, L, new Vector2(0, 0.5f), new Vector2(150, -160), new Vector2(520, 56), () => OnDiagnostics?.Invoke());
            UiFactory.TextButton(settings, "BACK", 36, L, new Vector2(0, 0.5f), new Vector2(150, -260), new Vector2(520, 56), () => Show("Menu"));

            // ---------------- SAFETY ----------------
            var safety = Page("Safety", shadeLeft: false, scrim: true).transform;
            UiFactory.LabelAt(safety, "CLEAR YOUR SPACE", 60, Palette.Text, TextAnchor.MiddleCenter, C, C, new Vector2(0, 200), new Vector2(1400, 80), true);
            UiFactory.LabelAt(safety,
                "Play indoors or in a private yard — never near roads, stairs, water or strangers.\n" +
                "Keep about three metres clear around you. Move at a walk; the Hunter comes to you.\n" +
                "The game warns you if you leave the play area.",
                28, Palette.TextDim, TextAnchor.MiddleCenter, C, C, new Vector2(0, 40), new Vector2(1300, 200));
            UiFactory.TextButton(safety, "I'M CLEAR", 44, C, C, new Vector2(0, -150), new Vector2(420, 70), () => OnSafetyConfirmed?.Invoke(), TextAnchor.MiddleCenter);
            UiFactory.TextButton(safety, "BACK", 30, C, C, new Vector2(0, -240), new Vector2(300, 50), () => OnMenu?.Invoke(), TextAnchor.MiddleCenter);

            // ---------------- SCAN ----------------
            var scan = Page("Scan", shadeLeft: false, scrim: false).transform;
            var bottom = new Vector2(0.5f, 0f);
            _scanTitle = UiFactory.LabelAt(scan, "SCAN THE FLOOR", 40, Palette.Text, TextAnchor.MiddleCenter, bottom, new Vector2(0.5f, 0f), new Vector2(0, 250), new Vector2(1400, 54), true);
            _scanDetail = UiFactory.LabelAt(scan, "Sweep the phone slowly across the floor, then look at the walls and furniture around you.", 26, Palette.TextDim, TextAnchor.MiddleCenter, bottom, new Vector2(0.5f, 0f), new Vector2(0, 200), new Vector2(1400, 40));
            var track = UiFactory.Box(scan, Palette.Line, bottom, new Vector2(0.5f, 0f), new Vector2(0, 170), new Vector2(420, 3), "ScanTrack");
            _scanProgress = UiFactory.Box(track.rectTransform, Palette.Text, new Vector2(0f, 0.5f), new Vector2(0f, 0.5f), Vector2.zero, new Vector2(0, 3), "ScanFill");
            _scanStats = UiFactory.LabelAt(scan, "", 22, Palette.TextFaint, TextAnchor.MiddleCenter, bottom, new Vector2(0.5f, 0f), new Vector2(0, 136), new Vector2(1400, 30));
            _originStatus = UiFactory.LabelAt(scan, "", 20, Palette.TextFaint, TextAnchor.MiddleCenter, bottom, new Vector2(0.5f, 0f), new Vector2(0, 104), new Vector2(1400, 30));
            _beginButton = UiFactory.TextButton(scan, "BEGIN", 44, bottom, new Vector2(0.5f, 0f), new Vector2(0, 30), new Vector2(360, 64), () => OnBeginMatch?.Invoke(), TextAnchor.MiddleCenter);
            UiFactory.TextButton(scan, "CANCEL", 26, new Vector2(0f, 1f), new Vector2(0f, 1f), new Vector2(40, -30), new Vector2(200, 44), () => OnMenu?.Invoke());

            // ---------------- COUNTDOWN ----------------
            var countdown = Page("Countdown", shadeLeft: false, scrim: false).transform;
            _countdown = UiFactory.LabelAt(countdown, "3", 160, Palette.Text, TextAnchor.MiddleCenter, C, C, new Vector2(0, 40), new Vector2(400, 200), true);
            _countdownSub = UiFactory.LabelAt(countdown, "HUNTER INBOUND", 28, Palette.TextDim, TextAnchor.MiddleCenter, C, C, new Vector2(0, -80), new Vector2(900, 40), true);

            // ---------------- PAUSE ----------------
            var pause = Page("Pause", shadeLeft: true, scrim: true).transform;
            UiFactory.LabelAt(pause, "PAUSED", 80, Palette.Text, TextAnchor.LowerLeft, L, new Vector2(0, 0), new Vector2(150, 130), new Vector2(800, 100), true);
            UiFactory.TextButton(pause, "RESUME", 44, L, new Vector2(0, 0.5f), new Vector2(150, 40), new Vector2(520, 64), () => OnResume?.Invoke());
            UiFactory.TextButton(pause, "RECALIBRATE ORIGIN", 32, L, new Vector2(0, 0.5f), new Vector2(150, -40), new Vector2(520, 54), () => OnRecalibrate?.Invoke());
            UiFactory.TextButton(pause, "DIAGNOSTICS", 32, L, new Vector2(0, 0.5f), new Vector2(150, -104), new Vector2(520, 54), () => OnDiagnostics?.Invoke());
            UiFactory.TextButton(pause, "END MATCH", 32, L, new Vector2(0, 0.5f), new Vector2(150, -168), new Vector2(520, 54), () => OnEndMatch?.Invoke());

            // ---------------- RESULT ----------------
            var result = Page("Result", shadeLeft: true, scrim: true).transform;
            _resultTitle = UiFactory.LabelAt(result, "YOU WERE TAKEN", 80, Palette.Text, TextAnchor.LowerLeft, L, new Vector2(0, 0), new Vector2(150, 150), new Vector2(1200, 100), true);
            _resultStats = UiFactory.LabelAt(result, "", 30, Palette.TextDim, TextAnchor.UpperLeft, L, new Vector2(0, 1), new Vector2(150, 130), new Vector2(1200, 200));
            UiFactory.TextButton(result, "AGAIN", 48, L, new Vector2(0, 0.5f), new Vector2(150, -120), new Vector2(520, 70), () => OnAgain?.Invoke());
            UiFactory.TextButton(result, "MENU", 36, L, new Vector2(0, 0.5f), new Vector2(150, -200), new Vector2(520, 56), () => OnMenu?.Invoke());

            RefreshSettings();
        }

        public void Show(string page)
        {
            foreach (var kv in _pages) kv.Value.SetActive(kv.Key == page);
            if (page == "Settings") RefreshSettings();
        }

        public void HideAll() => Show(null);

        public void SetFooter(string text) => _menuFooter.text = text;

        readonly List<(Text label, Func<string> value)> _settingRows = new List<(Text, Func<string>)>();

        void SettingRow(Transform parent, string name, float y, Func<string> value, Action toggle)
        {
            var L = new Vector2(0f, 0.5f);
            UiFactory.TextButton(parent, name, 36, L, new Vector2(0, 0.5f), new Vector2(150, y), new Vector2(520, 56), () => { toggle(); RefreshSettings(); });
            var t = UiFactory.LabelAt(parent, "", 30, Palette.Accent, TextAnchor.MiddleLeft, L, new Vector2(0, 0.5f), new Vector2(560, y), new Vector2(400, 56), true, name + " Value");
            _settingRows.Add((t, value));
        }

        void RefreshSettings()
        {
            foreach (var (label, value) in _settingRows) label.text = value();
            if (Presentation.BreachAudio.Instance != null) Presentation.BreachAudio.Instance.MasterVolume = Game.Settings.Volume;
            Presentation.Haptics.Enabled = Game.Settings.Haptics;
        }

        public void SetScan(float progress01, bool ready, string stats, string originStatus, string title, string detail)
        {
            _scanProgress.rectTransform.sizeDelta = new Vector2(420 * Mathf.Clamp01(progress01), 3);
            _scanProgress.color = ready ? Palette.Accent : Palette.Text;
            _scanStats.text = stats;
            _originStatus.text = originStatus;
            _scanTitle.text = title;
            _scanDetail.text = detail;
            _beginButton.gameObject.SetActive(ready);
        }

        public void SetCountdown(float remaining)
        {
            int n = Mathf.CeilToInt(remaining);
            _countdown.text = n > 0 ? n.ToString() : "";
            float frac = remaining - Mathf.Floor(remaining);
            _countdown.color = new Color(Palette.Text.r, Palette.Text.g, Palette.Text.b, Mathf.Clamp01(frac * 1.6f));
            _countdownSub.text = "HUNTER INBOUND";
        }

        public void SetResult(string title, string stats)
        {
            _resultTitle.text = title;
            _resultStats.text = stats;
        }
    }
}
