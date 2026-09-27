using UnityEngine;

namespace Breach.Presentation
{
    /// <summary>
    /// Short, shaped vibrations via Android's VibrationEffect (API 26+).
    /// Falls back to Handheld.Vibrate, whose presence in code also makes
    /// Unity add the VIBRATE permission to the manifest.
    /// </summary>
    public static class Haptics
    {
        public static bool Enabled = true;

#if UNITY_ANDROID && !UNITY_EDITOR
        static AndroidJavaObject _vibrator;
        static AndroidJavaClass _effectClass;
        static bool _init;
        static int _sdk;

        static void Init()
        {
            if (_init) return;
            _init = true;
            try
            {
                using (var version = new AndroidJavaClass("android.os.Build$VERSION")) _sdk = version.GetStatic<int>("SDK_INT");
                using (var player = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                using (var activity = player.GetStatic<AndroidJavaObject>("currentActivity"))
                    _vibrator = activity.Call<AndroidJavaObject>("getSystemService", "vibrator");
                if (_sdk >= 26) _effectClass = new AndroidJavaClass("android.os.VibrationEffect");
            }
            catch (System.Exception e)
            {
                Debug.LogWarning("[BREACH] Haptics unavailable: " + e.Message);
                _vibrator = null;
            }
        }
#endif

        /// <param name="milliseconds">Duration.</param>
        /// <param name="amplitude">1..255.</param>
        public static void Pulse(long milliseconds, int amplitude)
        {
            if (!Enabled) return;
#if UNITY_ANDROID && !UNITY_EDITOR
            Init();
            if (_vibrator == null) return;
            try
            {
                if (_effectClass != null)
                {
                    using (var effect = _effectClass.CallStatic<AndroidJavaObject>("createOneShot", milliseconds, Mathf.Clamp(amplitude, 1, 255)))
                        _vibrator.Call("vibrate", effect);
                }
                else
                {
                    _vibrator.Call("vibrate", milliseconds);
                }
            }
            catch (System.Exception)
            {
                Handheld.Vibrate();
            }
#endif
        }

        public static void Shot() => Pulse(14, 150);
        public static void HitConfirm() => Pulse(9, 90);
        public static void Kill() => Pulse(45, 200);
        public static void Hurt() => Pulse(90, 255);
        public static void ReloadClick() => Pulse(8, 70);
    }
}
