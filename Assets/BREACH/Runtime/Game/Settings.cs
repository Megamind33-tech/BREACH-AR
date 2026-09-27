using UnityEngine;

namespace Breach.Game
{
    public static class Settings
    {
        const string KHaptics = "breach.haptics";
        const string KVolume = "breach.volume";
        const string KLeftHanded = "breach.lefthanded";
        const string KArenaRadius = "breach.arenaRadius";

        public static bool Haptics
        {
            get => PlayerPrefs.GetInt(KHaptics, 1) == 1;
            set { PlayerPrefs.SetInt(KHaptics, value ? 1 : 0); PlayerPrefs.Save(); }
        }

        public static float Volume
        {
            get => PlayerPrefs.GetFloat(KVolume, 1f);
            set { PlayerPrefs.SetFloat(KVolume, Mathf.Clamp01(value)); PlayerPrefs.Save(); }
        }

        /// <summary>Fire zone on the left half instead of the right.</summary>
        public static bool LeftHanded
        {
            get => PlayerPrefs.GetInt(KLeftHanded, 0) == 1;
            set { PlayerPrefs.SetInt(KLeftHanded, value ? 1 : 0); PlayerPrefs.Save(); }
        }

        /// <summary>Radius (m) of the safe play area.</summary>
        public static float ArenaRadius
        {
            get => PlayerPrefs.GetFloat(KArenaRadius, 3f);
            set { PlayerPrefs.SetFloat(KArenaRadius, Mathf.Clamp(value, 1.5f, 6f)); PlayerPrefs.Save(); }
        }
    }

    public static class BuildInfo
    {
        static string _text;

        /// <summary>Written by the editor build step; "local" when running an unbuilt project.</summary>
        public static string Text
        {
            get
            {
                if (_text != null) return _text;
                var asset = Resources.Load<TextAsset>("Generated/BuildInfo");
                _text = asset != null ? asset.text.Trim() : "local (not a CI build)";
                return _text;
            }
        }
    }
}
