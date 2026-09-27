using UnityEngine;

namespace Breach.Game
{
    /// <summary>
    /// Entry point. BREACH builds its entire runtime from code after the
    /// (empty) scene loads, so no scene or prefab ever needs hand-editing.
    /// </summary>
    public static class BreachBootstrap
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Boot()
        {
            if (Object.FindAnyObjectByType<GameDirector>() != null) return;
            GameDirector.Create();
        }
    }
}
