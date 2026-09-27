using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.EnhancedTouch;
using Touch = UnityEngine.InputSystem.EnhancedTouch.Touch;

namespace Breach.Combat
{
    /// <summary>
    /// Trigger input. On a phone the whole right half of the screen (left in
    /// left-handed mode) is the trigger — press and hold for automatic fire —
    /// so there is no giant FIRE button. UI hit areas are excluded.
    /// Desktop: left mouse fires, R reloads.
    /// </summary>
    public sealed class FireInput : MonoBehaviour
    {
        public RectTransform[] Exclusions = new RectTransform[0];
        public bool LeftHanded;
        public bool TriggerHeld { get; private set; }
        public bool ReloadPressed { get; private set; }

        void OnEnable()
        {
            EnhancedTouchSupport.Enable();
        }

        void Update()
        {
            TriggerHeld = false;
            ReloadPressed = false;

            foreach (var t in Touch.activeTouches)
            {
                if (!t.isInProgress) continue;
                var start = t.startScreenPosition;
                bool inZone = LeftHanded ? start.x < Screen.width * 0.45f : start.x > Screen.width * 0.55f;
                if (!inZone || Excluded(start)) continue;
                TriggerHeld = true;
            }

            var mouse = Mouse.current;
            if (mouse != null && mouse.leftButton.isPressed && !Excluded(mouse.position.ReadValue()) && Touch.activeTouches.Count == 0)
                TriggerHeld = true;
            var kb = Keyboard.current;
            if (kb != null && kb.rKey.wasPressedThisFrame) ReloadPressed = true;
        }

        bool Excluded(Vector2 screenPoint)
        {
            foreach (var r in Exclusions)
                if (r != null && r.gameObject.activeInHierarchy && RectTransformUtility.RectangleContainsScreenPoint(r, screenPoint, null))
                    return true;
            return false;
        }
    }
}
