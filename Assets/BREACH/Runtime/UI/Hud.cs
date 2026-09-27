using Breach.Core.Combat;
using UnityEngine;
using UnityEngine.UI;

namespace Breach.UI
{
    /// <summary>
    /// Combat HUD. Only: score/timer (top), crosshair (centre), ammo (bottom
    /// right), health (bottom left), and temporary hit marker, damage
    /// direction, threat indicator and boundary warning. The camera feed
    /// is the game — everything here is small and quiet.
    /// </summary>
    public sealed class Hud : MonoBehaviour
    {
        Canvas _canvas;
        RectTransform _root;
        Text _score, _timer, _kills, _ammo, _reserve, _reloadText, _healthText, _boundary, _threatText, _centerMessage;
        Image _healthFill, _ammoFill, _reloadFill, _vignette, _hurtFlash;
        RectTransform _crosshair, _hitMarker, _damageArc, _threat;
        Image[] _crossLines = new Image[4];
        Image[] _hitLines = new Image[4];
        Image _crossDot, _damageArcImg, _threatImg;
        float _hitTimer, _hitDuration, _damageTimer, _threatTimer, _messageTimer;
        bool _hitKill;
        float _lowHealth;
        public RectTransform ReloadHitArea { get; private set; }
        public RectTransform PauseHitArea { get; private set; }
        public Button PauseButton { get; private set; }
        public Button ReloadButton { get; private set; }

        public static Hud Create(Transform parent)
        {
            var go = new GameObject("HUD");
            go.transform.SetParent(parent, false);
            var hud = go.AddComponent<Hud>();
            hud.Build();
            return hud;
        }

        void Build()
        {
            _canvas = UiFactory.CreateCanvas(transform, "HUD Canvas", 10);
            _root = (RectTransform)_canvas.transform;

            // Low-health vignette and hurt flash sit under everything.
            _vignette = UiFactory.Fill(_root, new Color(0.45f, 0.03f, 0.02f, 0f), "Vignette", UiFactory.VignetteSprite);
            _hurtFlash = UiFactory.Fill(_root, new Color(0.5f, 0.05f, 0.03f, 0f), "HurtFlash", UiFactory.VignetteSprite);

            // --- top: score | timer ---
            var top = new Vector2(0.5f, 1f);
            _score = UiFactory.LabelAt(_root, "0", 34, Palette.Text, TextAnchor.MiddleRight, top, new Vector2(1f, 1f), new Vector2(-18, -26), new Vector2(240, 44), true, "Score");
            UiFactory.Box(_root, Palette.Line, top, new Vector2(0.5f, 1f), new Vector2(0, -32), new Vector2(2, 30), "ScoreDivider");
            _timer = UiFactory.LabelAt(_root, "00:00", 34, Palette.TextDim, TextAnchor.MiddleLeft, top, new Vector2(0f, 1f), new Vector2(18, -26), new Vector2(240, 44), false, "Timer");
            _kills = UiFactory.LabelAt(_root, "", 22, Palette.TextFaint, TextAnchor.MiddleCenter, top, new Vector2(0.5f, 1f), new Vector2(0, -72), new Vector2(300, 30), false, "Kills");
            _boundary = UiFactory.LabelAt(_root, "", 26, Palette.Accent, TextAnchor.MiddleCenter, top, new Vector2(0.5f, 1f), new Vector2(0, -112), new Vector2(900, 36), true, "Boundary");

            // --- centre: crosshair ---
            _crosshair = UiFactory.Rect("Crosshair", _root, new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(80, 80));
            for (int i = 0; i < 4; i++)
            {
                bool vertical = i < 2;
                _crossLines[i] = UiFactory.Box(_crosshair, new Color(1, 1, 1, 0.88f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero,
                    vertical ? new Vector2(2, 13) : new Vector2(13, 2), "Line");
                _crossLines[i].gameObject.AddComponent<Outline>().effectColor = new Color(0, 0, 0, 0.45f);
            }
            _crossDot = UiFactory.Box(_crosshair, new Color(1, 1, 1, 0.9f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(3, 3), "Dot");
            _crossDot.gameObject.AddComponent<Outline>().effectColor = new Color(0, 0, 0, 0.45f);

            _hitMarker = UiFactory.Rect("HitMarker", _root, new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(60, 60));
            for (int i = 0; i < 4; i++)
            {
                _hitLines[i] = UiFactory.Box(_hitMarker, new Color(1, 1, 1, 0), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f),
                    new Vector2((i % 2 == 0 ? -1 : 1) * 13, (i < 2 ? 1 : -1) * 13), new Vector2(2, 12), "Tick");
                _hitLines[i].rectTransform.localRotation = Quaternion.Euler(0, 0, (i % 2 == 0 ? 1 : -1) * (i < 2 ? 45 : -45));
            }

            _damageArc = UiFactory.Rect("DamageDirection", _root, new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(10, 10));
            _damageArcImg = UiFactory.Box(_damageArc, new Color(0.85f, 0.2f, 0.15f, 0f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0, 230), new Vector2(260, 60), "Arc", UiFactory.ArcSprite);

            _threat = UiFactory.Rect("Threat", _root, new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(10, 10));
            _threatImg = UiFactory.Box(_threat, new Color(1f, 1f, 1f, 0f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0, 380), new Vector2(44, 44), "Chevron", UiFactory.ChevronSprite);
            _threatText = UiFactory.LabelAt(_threat, "", 20, Palette.TextDim, TextAnchor.MiddleCenter, new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0, 340), new Vector2(200, 26), true, "ThreatLabel");

            _centerMessage = UiFactory.LabelAt(_root, "", 30, Palette.Text, TextAnchor.MiddleCenter, new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0, -150), new Vector2(1200, 40), true, "CenterMessage");

            // --- bottom right: ammo (also the reload tap target) ---
            var br = new Vector2(1f, 0f);
            ReloadHitArea = UiFactory.Rect("AmmoBlock", _root, br, br, new Vector2(1f, 0f), new Vector2(-56, 44), new Vector2(300, 130));
            var hit = ReloadHitArea.gameObject.AddComponent<Image>();
            hit.color = new Color(0, 0, 0, 0.001f);
            ReloadButton = ReloadHitArea.gameObject.AddComponent<Button>();
            ReloadButton.transition = Selectable.Transition.None;
            _ammo = UiFactory.LabelAt(ReloadHitArea, "30", 64, Palette.Text, TextAnchor.LowerRight, br, new Vector2(1f, 0f), new Vector2(-96, 22), new Vector2(160, 70), true, "Ammo");
            _reserve = UiFactory.LabelAt(ReloadHitArea, "120", 28, Palette.TextDim, TextAnchor.LowerLeft, br, new Vector2(1f, 0f), new Vector2(-2, 30), new Vector2(90, 40), false, "Reserve");
            UiFactory.LabelAt(ReloadHitArea, "BR-16", 18, Palette.TextFaint, TextAnchor.LowerRight, br, new Vector2(1f, 0f), new Vector2(-2, 92), new Vector2(200, 24), false, "WeaponName");
            var ammoBg = UiFactory.Box(ReloadHitArea, Palette.Line, br, new Vector2(1f, 0f), new Vector2(0, 12), new Vector2(240, 3), "AmmoTrack");
            _ammoFill = UiFactory.Box(ammoBg.rectTransform, Palette.Text, new Vector2(1f, 0.5f), new Vector2(1f, 0.5f), Vector2.zero, new Vector2(240, 3), "AmmoFill");
            _reloadText = UiFactory.LabelAt(_root, "", 22, Palette.Accent, TextAnchor.MiddleCenter, new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0, -70), new Vector2(300, 28), true, "Reload");
            var reloadBg = UiFactory.Box(_root, new Color(1, 1, 1, 0f), new Vector2(0.5f, 0.5f), new Vector2(0.5f, 0.5f), new Vector2(0, -88), new Vector2(120, 2), "ReloadTrack");
            _reloadFill = UiFactory.Box(reloadBg.rectTransform, Palette.Accent, new Vector2(0f, 0.5f), new Vector2(0f, 0.5f), Vector2.zero, new Vector2(0, 2), "ReloadFill");

            // --- bottom left: health ---
            var bl = new Vector2(0f, 0f);
            _healthText = UiFactory.LabelAt(_root, "100", 30, Palette.Text, TextAnchor.LowerLeft, bl, new Vector2(0f, 0f), new Vector2(56, 58), new Vector2(120, 40), true, "Health");
            var hpBg = UiFactory.Box(_root, Palette.Line, bl, new Vector2(0f, 0f), new Vector2(56, 50), new Vector2(300, 4), "HealthTrack");
            _healthFill = UiFactory.Box(hpBg.rectTransform, Palette.Text, new Vector2(0f, 0.5f), new Vector2(0f, 0.5f), Vector2.zero, new Vector2(300, 4), "HealthFill");

            // --- top left: pause (long-press opens diagnostics) ---
            PauseHitArea = UiFactory.Rect("Pause", _root, new Vector2(0f, 1f), new Vector2(0f, 1f), new Vector2(0f, 1f), new Vector2(36, -26), new Vector2(84, 64));
            var pimg = PauseHitArea.gameObject.AddComponent<Image>();
            pimg.color = new Color(0, 0, 0, 0.001f);
            PauseButton = PauseHitArea.gameObject.AddComponent<Button>();
            PauseButton.transition = Selectable.Transition.None;
            UiFactory.Box(PauseHitArea, Palette.TextDim, new Vector2(0f, 0.5f), new Vector2(0f, 0.5f), new Vector2(20, 0), new Vector2(4, 20), "BarA");
            UiFactory.Box(PauseHitArea, Palette.TextDim, new Vector2(0f, 0.5f), new Vector2(0f, 0.5f), new Vector2(32, 0), new Vector2(4, 20), "BarB");

            SetCombatVisible(false);
        }

        public void SetCombatVisible(bool visible) => _canvas.enabled = visible;

        public void SetScore(int score, int kills)
        {
            _score.text = score.ToString("N0");
            _kills.text = kills > 0 ? $"{kills} DOWN" : "";
        }

        public void SetTimer(double seconds)
        {
            int s = (int)seconds;
            _timer.text = $"{s / 60:00}:{s % 60:00}";
        }

        public void SetAmmo(int mag, int magSize, int reserve, bool infinite)
        {
            _ammo.text = mag.ToString();
            _ammo.color = mag == 0 ? Palette.Danger : mag <= magSize / 4 ? Palette.Accent : Palette.Text;
            _reserve.text = infinite ? "—" : reserve.ToString();
            _ammoFill.rectTransform.sizeDelta = new Vector2(240f * mag / Mathf.Max(1, magSize), 3);
        }

        public void SetReload(bool reloading, float progress, bool empty, bool canReload)
        {
            if (reloading)
            {
                _reloadText.text = "RELOADING";
                _reloadFill.rectTransform.sizeDelta = new Vector2(120 * progress, 2);
                _reloadFill.transform.parent.GetComponent<Image>().color = Palette.Line;
            }
            else
            {
                _reloadText.text = empty ? (canReload ? "RELOAD" : "NO AMMO") : "";
                _reloadFill.rectTransform.sizeDelta = new Vector2(0, 2);
                _reloadFill.transform.parent.GetComponent<Image>().color = new Color(1, 1, 1, 0);
            }
        }

        public void SetHealth(float normalized, float current)
        {
            _healthText.text = Mathf.CeilToInt(current).ToString();
            var c = normalized < 0.25f ? Palette.Danger : normalized < 0.5f ? Palette.Accent : Palette.Text;
            _healthFill.color = c;
            _healthText.color = c;
            _healthFill.rectTransform.sizeDelta = new Vector2(300f * Mathf.Clamp01(normalized), 4);
            _lowHealth = Mathf.Clamp01((0.5f - normalized) / 0.5f);
        }

        /// <param name="spreadDegrees">current spread</param>
        /// <param name="recoilPitch">aim rise in degrees</param>
        /// <param name="fovDegrees">vertical fov of the camera</param>
        public void SetCrosshair(float spreadDegrees, float recoilPitch, float fovDegrees, float screenHeightRef = 1080f)
        {
            float pxPerDeg = screenHeightRef / Mathf.Max(fovDegrees, 1f);
            float gap = 7f + spreadDegrees * pxPerDeg;
            _crossLines[0].rectTransform.anchoredPosition = new Vector2(0, gap + 6);
            _crossLines[1].rectTransform.anchoredPosition = new Vector2(0, -gap - 6);
            _crossLines[2].rectTransform.anchoredPosition = new Vector2(-gap - 6, 0);
            _crossLines[3].rectTransform.anchoredPosition = new Vector2(gap + 6, 0);
            // The crosshair rises with recoil so it always shows where the next round goes.
            _crosshair.anchoredPosition = new Vector2(0, recoilPitch * pxPerDeg);
        }

        public void ShowHit(HitZone zone, bool kill)
        {
            _hitKill = kill;
            _hitDuration = kill ? 0.4f : zone == HitZone.Head ? 0.2f : 0.13f;
            _hitTimer = _hitDuration;
            float scale = kill ? 1.35f : zone == HitZone.Head ? 1.15f : 1f;
            _hitMarker.localScale = Vector3.one * scale;
        }

        /// <param name="signedYawDegrees">Direction of the attacker relative to view (+ right).</param>
        public void ShowDamage(float signedYawDegrees)
        {
            _damageArc.localRotation = Quaternion.Euler(0, 0, -signedYawDegrees);
            _damageTimer = 1.1f;
            var c = _hurtFlash.color;
            _hurtFlash.color = new Color(c.r, c.g, c.b, 0.55f);
        }

        /// <summary>Brief edge indicator toward an off-screen threat.</summary>
        public void ShowThreat(float signedYawDegrees, string label)
        {
            _threat.localRotation = Quaternion.Euler(0, 0, -signedYawDegrees);
            _threatText.text = label;
            _threatTimer = 1.6f;
        }

        public void SetBoundaryWarning(string text) => _boundary.text = text ?? "";

        public void Flash(string message, float seconds = 1.6f)
        {
            _centerMessage.text = message;
            _messageTimer = seconds;
        }

        void Update()
        {
            float dt = Time.unscaledDeltaTime;
            if (_hitTimer > 0f) _hitTimer -= dt;
            float ha = Mathf.Clamp01(_hitTimer / Mathf.Max(_hitDuration, 1e-3f));
            var hc = _hitKill ? new Color(0.95f, 0.35f, 0.25f, ha) : new Color(1f, 1f, 1f, ha);
            foreach (var l in _hitLines) l.color = hc;

            if (_damageTimer > 0f) _damageTimer -= dt;
            _damageArcImg.color = new Color(0.85f, 0.2f, 0.15f, Mathf.Clamp01(_damageTimer / 0.6f) * 0.85f);

            if (_threatTimer > 0f) _threatTimer -= dt;
            float ta = Mathf.Clamp01(_threatTimer / 0.5f) * 0.8f;
            _threatImg.color = new Color(1f, 1f, 1f, ta);
            _threatText.color = new Color(Palette.TextDim.r, Palette.TextDim.g, Palette.TextDim.b, ta * 0.7f);

            var hf = _hurtFlash.color;
            _hurtFlash.color = new Color(hf.r, hf.g, hf.b, Mathf.MoveTowards(hf.a, 0f, dt * 1.4f));
            float pulse = _lowHealth > 0 ? 0.75f + 0.25f * Mathf.Sin(Time.unscaledTime * 3f) : 0f;
            var vc = _vignette.color;
            _vignette.color = new Color(vc.r, vc.g, vc.b, _lowHealth * 0.55f * pulse);

            if (_messageTimer > 0f)
            {
                _messageTimer -= dt;
                var mc = _centerMessage.color;
                _centerMessage.color = new Color(mc.r, mc.g, mc.b, Mathf.Clamp01(_messageTimer / 0.4f));
            }
        }
    }
}
