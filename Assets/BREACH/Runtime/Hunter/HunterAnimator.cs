using Breach.Core.Hunter;
using UnityEngine;

namespace Breach.Hunter
{
    /// <summary>
    /// Fully procedural animation for the Hunter: two-bone leg IK keeps feet
    /// planted while the body crouches, a speed-driven gait, hunched spine,
    /// wind-up and swipe attacks, spring-based hit flinches, and sudden
    /// unnatural head twitches while it stalks.
    /// </summary>
    /// <summary>What the animator needs — from the local brain (host/solo) or a network snapshot (client).</summary>
    public struct HunterAnimInput
    {
        public HunterState State;
        public float Speed;
        public float AttackWindup;

        public static HunterAnimInput From(HunterBrain b) =>
            new HunterAnimInput { State = b.State, Speed = b.CurrentSpeed, AttackWindup = b.AttackWindup };
    }

    public sealed class HunterAnimator
    {
        readonly HunterBody _b;
        float _phase;
        float _crouch = 1f, _lean, _rushBlend, _gaitAmp;
        Vector3 _flinch;          // x = pitch back, y = yaw, z = roll (degrees), decays
        Vector3 _flinchVel;
        float _nextTwitch;
        Quaternion _twitch = Quaternion.identity, _twitchTarget = Quaternion.identity;
        float _twitchHold;
        float _strikeT = -1f;
        float _lastFootPhaseL, _lastFootPhaseR;
        HunterState _prevState;

        const float Thigh = 0.44f, Shin = 0.44f;

        public System.Action Footstep;

        public HunterAnimator(HunterBody body)
        {
            _b = body;
            _nextTwitch = Time.time + Random.Range(1f, 3f);
        }

        /// <summary>Called when a round lands: kick the torso away from the shot.</summary>
        public void Flinch(Vector3 shotDirWorld, bool head)
        {
            var local = _b.Root.InverseTransformDirection(shotDirWorld);
            float strength = head ? 1.6f : 1f;
            _flinchVel += new Vector3(Mathf.Clamp(local.z, -1f, 1f) * 260f, local.x * 220f, Random.Range(-140f, 140f)) * strength;
        }

        public void Tick(in HunterAnimInput brain, float dt, Vector3 playerEyeWorld)
        {
            var state = brain.State;
            if (state == HunterState.Attacking && _prevState != HunterState.Attacking) _strikeT = -1f;
            _prevState = state;

            float targetCrouch, targetLean, targetRush;
            switch (state)
            {
                case HunterState.Emerging: targetCrouch = 1f; targetLean = 55f; targetRush = 0f; break;
                case HunterState.Stalking: targetCrouch = 0.6f; targetLean = 28f; targetRush = 0f; break;
                case HunterState.Repositioning: targetCrouch = 0.5f; targetLean = 38f; targetRush = 0.6f; break;
                case HunterState.Rushing: targetCrouch = 0.45f; targetLean = 46f; targetRush = 1f; break;
                case HunterState.Attacking: targetCrouch = 0.35f; targetLean = 22f; targetRush = 0f; break;
                case HunterState.Retreating: targetCrouch = 0.55f; targetLean = 34f; targetRush = 0.5f; break;
                case HunterState.Staggered: targetCrouch = 0.65f; targetLean = 8f; targetRush = 0f; break;
                default: targetCrouch = 0.6f; targetLean = 25f; targetRush = 0f; break;
            }
            float k = 1f - Mathf.Exp(-dt * (state == HunterState.Emerging ? 2.5f : 7f));
            _crouch = Mathf.Lerp(_crouch, targetCrouch, k);
            _lean = Mathf.Lerp(_lean, targetLean, k);
            _rushBlend = Mathf.Lerp(_rushBlend, targetRush, k);

            // --- gait ---
            float speed = brain.Speed;
            float stride = Mathf.Lerp(0.85f, 1.5f, _rushBlend);
            _phase += speed / stride * Mathf.PI * 2f * dt;
            _gaitAmp = Mathf.Lerp(_gaitAmp, Mathf.Clamp01(speed / 0.6f), 1f - Mathf.Exp(-dt * 8f));
            float strideHalf = Mathf.Lerp(0.16f, 0.34f, _rushBlend) * _gaitAmp;
            float lift = Mathf.Lerp(0.07f, 0.14f, _rushBlend) * _gaitAmp;

            float bob = Mathf.Abs(Mathf.Sin(_phase)) * 0.035f * _gaitAmp;
            float pelvisY = HunterBody.PelvisHeight - _crouch * 0.3f + bob;
            _b.Pelvis.localPosition = new Vector3(0, pelvisY, -_lean * 0.002f);
            // Pelvis stays upright so the leg IK (solved in pelvis space) keeps feet planted; lean lives in the spine.
            _b.Pelvis.localRotation = Quaternion.Euler(0f, Mathf.Sin(_phase) * 6f * _gaitAmp, Mathf.Sin(_phase) * 3f * _gaitAmp);

            float hipHeight = pelvisY - 0.04f - 0.03f;
            LegIK(_b.ThighL, _b.ShinL, _b.FootL, hipHeight, Mathf.Sin(_phase) * strideHalf, Mathf.Max(0, Mathf.Cos(_phase)) * lift);
            LegIK(_b.ThighR, _b.ShinR, _b.FootR, hipHeight, Mathf.Sin(_phase + Mathf.PI) * strideHalf, Mathf.Max(0, Mathf.Cos(_phase + Mathf.PI)) * lift);

            float pl = Mathf.Repeat(_phase, Mathf.PI * 2f), pr = Mathf.Repeat(_phase + Mathf.PI, Mathf.PI * 2f);
            if (_gaitAmp > 0.3f && ((pl < _lastFootPhaseL && pl < 1f) || (pr < _lastFootPhaseR && pr < 1f))) Footstep?.Invoke();
            _lastFootPhaseL = pl;
            _lastFootPhaseR = pr;

            // --- flinch spring (critically damped-ish) ---
            _flinchVel += (-_flinch * 180f - _flinchVel * 22f) * dt;
            _flinch += _flinchVel * dt;

            // --- spine / head ---
            float breathe = Mathf.Sin(Time.time * 1.7f) * 1.6f;
            float spineLean = _lean * 0.6f - _flinch.x * 0.4f;
            float chestLean = _lean * 0.4f + breathe - _flinch.x * 0.6f;
            _b.Spine.localRotation = Quaternion.Euler(spineLean, -Mathf.Sin(_phase) * 5f * _gaitAmp + _flinch.y * 0.4f, _flinch.z * 0.3f);
            _b.Chest.localRotation = Quaternion.Euler(chestLean, _flinch.y * 0.6f, _flinch.z * 0.5f);

            float totalLean = _lean * 1.0f + _lean * 0.25f;
            // Head tracks the player, clamped, then twitches.
            var headLook = Quaternion.identity;
            var toPlayer = _b.Neck.parent.InverseTransformPoint(playerEyeWorld);
            if (state != HunterState.Dead)
            {
                float yaw = Mathf.Clamp(Mathf.Atan2(toPlayer.x, toPlayer.z) * Mathf.Rad2Deg, -55f, 55f);
                headLook = Quaternion.Euler(0, yaw, 0);
            }
            UpdateTwitch(state, dt);
            _b.Neck.localRotation = Quaternion.Euler(-totalLean * 0.55f, 0, 0) * Quaternion.Slerp(Quaternion.identity, headLook, 0.5f);
            _b.Head.localRotation = Quaternion.Euler(-totalLean * 0.3f - _flinch.x * 0.5f, 0, _flinch.z * 0.4f)
                                    * Quaternion.Slerp(Quaternion.identity, headLook, 0.5f) * _twitch;

            // --- arms ---
            float swing = Mathf.Sin(_phase) * Mathf.Lerp(18f, 42f, _rushBlend) * _gaitAmp;
            float reach = Mathf.Lerp(-28f, 20f, _rushBlend); // stalk: reaching forward; rush: trailing
            ArmPose(_b.UpperArmL, _b.ForearmL, reach - swing, -35f, -8f);
            ArmPose(_b.UpperArmR, _b.ForearmR, reach + swing, -35f, 8f);

            if (state == HunterState.Attacking)
            {
                float w = brain.AttackWindup;
                if (w >= 1f && _strikeT < 0f) _strikeT = 0f;
                if (_strikeT >= 0f) _strikeT += dt;
                if (_strikeT < 0f)
                {
                    // Coil: right arm drawn high and back, torso twisting away.
                    float e = w * w * (3f - 2f * w);
                    ArmPose(_b.UpperArmR, _b.ForearmR, Mathf.Lerp(reach, -160f, e), Mathf.Lerp(-35f, -70f, e), Mathf.Lerp(8f, 40f, e));
                    _b.Chest.localRotation *= Quaternion.Euler(-8f * e, 22f * e, 0);
                }
                else
                {
                    // Swipe: fast diagonal slash across the body.
                    float s = Mathf.Clamp01(_strikeT / 0.14f);
                    float e = 1f - (1f - s) * (1f - s);
                    ArmPose(_b.UpperArmR, _b.ForearmR, Mathf.Lerp(-160f, -35f, e), Mathf.Lerp(-70f, -5f, e), Mathf.Lerp(40f, -35f, e));
                    _b.Chest.localRotation *= Quaternion.Euler(12f * e, Mathf.Lerp(22f, -26f, e), 0);
                }
            }
        }

        void UpdateTwitch(HunterState state, float dt)
        {
            bool calm = state == HunterState.Stalking || state == HunterState.Emerging;
            if (calm && Time.time >= _nextTwitch)
            {
                _twitchTarget = Quaternion.Euler(Random.Range(-18f, 12f), Random.Range(-35f, 35f), Random.Range(-38f, 38f));
                _twitchHold = Random.Range(0.25f, 0.8f);
                _nextTwitch = Time.time + Random.Range(1.4f, 4f);
            }
            _twitchHold -= dt;
            if (_twitchHold <= 0f) _twitchTarget = Quaternion.identity;
            // Snap in fast, ease out slowly — reads as wrong, not animated.
            float rate = _twitchHold > 0f ? 40f : 6f;
            _twitch = Quaternion.Slerp(_twitch, _twitchTarget, 1f - Mathf.Exp(-dt * rate));
        }

        static void ArmPose(Transform upper, Transform fore, float pitch, float elbow, float roll)
        {
            upper.localRotation = Quaternion.Euler(pitch, 0, roll);
            fore.localRotation = Quaternion.Euler(elbow, 0, 0);
        }

        /// <summary>Planar two-bone IK (sagittal plane). Positive forward = +Z.</summary>
        static void LegIK(Transform thigh, Transform shin, Transform foot, float hipHeight, float forward, float lift)
        {
            float y = Mathf.Max(0.12f, hipHeight - lift);
            float z = forward;
            float d = Mathf.Clamp(Mathf.Sqrt(y * y + z * z), 0.12f, Thigh + Shin - 0.002f);
            float a1 = Mathf.Acos(Mathf.Clamp((Thigh * Thigh + d * d - Shin * Shin) / (2f * Thigh * d), -1f, 1f));
            float a2 = Mathf.Acos(Mathf.Clamp((Thigh * Thigh + Shin * Shin - d * d) / (2f * Thigh * Shin), -1f, 1f));
            float phi = Mathf.Atan2(z, y);
            // Negative X rotation swings the (-Y) limb forward.
            thigh.localRotation = Quaternion.Euler(-(phi + a1) * Mathf.Rad2Deg, 0, 0);
            shin.localRotation = Quaternion.Euler((Mathf.PI - a2) * Mathf.Rad2Deg, 0, 0);
            // Keep the foot roughly flat.
            foot.localRotation = Quaternion.Euler((phi + a1 - (Mathf.PI - a2)) * Mathf.Rad2Deg, 0, 0);
        }
    }
}
