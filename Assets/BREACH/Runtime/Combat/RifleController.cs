using System;
using System.Collections;
using Breach.Core.Combat;
using Breach.Hunter;
using Breach.Presentation;
using Breach.Util;
using UnityEngine;

namespace Breach.Combat
{
    /// <summary>
    /// Connects aim → shot → authority → damage → reaction → score for the
    /// single BR-16 rifle. Hitscan from the camera centre with recoil/spread
    /// offsets from the core WeaponState.
    /// </summary>
    public sealed class RifleController : MonoBehaviour
    {
        public WeaponState Weapon { get; private set; }
        public RifleViewModel ViewModel { get; private set; }
        public bool InputEnabled { get; set; }
        Camera _cam;
        ImpactEffects _fx;
        FireInput _input;
        Coroutine _reloadAudio;
        bool _wasHeld;

        /// <summary>(hit, zone, killed)</summary>
        public event Action<bool, HitZone, bool> ShotResolved;

        public static int ShotMask => Layers.Mask(Layers.Hunter, Layers.RealWorld, Layers.Default);

        public static RifleController Create(Transform parent, Camera cam, ImpactEffects fx, FireInput input)
        {
            var go = new GameObject("BR-16 Controller");
            go.transform.SetParent(parent, false);
            var rc = go.AddComponent<RifleController>();
            rc._cam = cam;
            rc._fx = fx;
            rc._input = input;
            rc.ViewModel = RifleViewModel.Create(cam);
            rc.Configure(WeaponSpec.DefaultRifle());
            return rc;
        }

        public void Configure(WeaponSpec spec)
        {
            Weapon = new WeaponState(spec, seed: Environment.TickCount);
            Weapon.ReloadStarted += empty =>
            {
                float dur = empty ? spec.EmptyReloadSeconds : spec.TacticalReloadSeconds;
                ViewModel.BeginReload(dur, empty);
                if (_reloadAudio != null) StopCoroutine(_reloadAudio);
                _reloadAudio = StartCoroutine(ReloadAudio(dur, empty));
            };
        }

        public void SetViewModelVisible(bool v) => ViewModel.gameObject.SetActive(v);

        IEnumerator ReloadAudio(float duration, bool empty)
        {
            var a = BreachAudio.Instance;
            yield return new WaitForSeconds(duration * 0.24f);
            a?.Play2D(Sfx.MagOut, 0.9f);
            Haptics.ReloadClick();
            yield return new WaitForSeconds(duration * 0.34f);
            a?.Play2D(Sfx.MagIn, 1f);
            Haptics.ReloadClick();
            if (empty)
            {
                yield return new WaitForSeconds(duration * 0.24f);
                a?.Play2D(Sfx.BoltRelease, 1f);
                Haptics.ReloadClick();
            }
        }

        public void RequestReload()
        {
            if (!InputEnabled) return;
            Weapon.BeginReload(Time.timeAsDouble);
        }

        void Update()
        {
            double now = Time.timeAsDouble;
            Weapon.Tick(now, Time.deltaTime);
            if (!InputEnabled || _input == null)
            {
                _wasHeld = false;
                return;
            }

            if (_input.ReloadPressed) RequestReload();
            bool held = _input.TriggerHeld;
            if (held)
            {
                var shot = Weapon.TryFire(now);
                switch (shot.Outcome)
                {
                    case FireOutcome.Fired:
                        Resolve(shot);
                        break;
                    case FireOutcome.DryFire:
                        if (!_wasHeld || Weapon.AmmoInMagazine == 0)
                        {
                            BreachAudio.Instance?.Play2D(Sfx.DryFire, 0.8f);
                            ViewModel.OnDryFire();
                        }
                        // Modern convenience: an empty trigger pull starts the reload.
                        Weapon.BeginReload(now);
                        break;
                }
            }
            _wasHeld = held;
        }

        void Resolve(ShotSolution shot)
        {
            var audio = BreachAudio.Instance;
            audio?.Play2D(Sfx.RifleShot, 1f, 0.035f);
            if (shot.ShotIndexInBurst % 3 == 1) audio?.Play2D(Sfx.RifleTail, 0.55f, 0.05f);
            Haptics.Shot();
            ViewModel.OnShot(Mathf.Lerp(1f, 0.8f, Mathf.Clamp01(shot.ShotIndexInBurst / 10f)));

            var camT = _cam.transform;
            var dir = camT.rotation * Quaternion.Euler(-shot.PitchOffset, shot.YawOffset, 0f) * Vector3.forward;
            Physics.SyncTransforms();
            bool hitHunter = false, killed = false;
            HitZone zone = HitZone.Body;
            if (Physics.Raycast(camT.position, dir, out var hit, Weapon.Spec.Range, ShotMask, QueryTriggerInteraction.Ignore))
            {
                var hb = hit.collider.GetComponent<HunterHitbox>();
                if (hb != null && hb.Owner != null && hb.Owner.IsAlive)
                {
                    var r = hb.Owner.ReceiveHit(hb, hit.point, dir, Weapon.Spec.Damage);
                    if (!r.Ignored)
                    {
                        hitHunter = true;
                        killed = r.Killed;
                        zone = hb.Zone;
                        audio?.Play2D(killed ? Sfx.KillConfirm : Sfx.HitConfirm, killed ? 0.9f : 0.5f, 0.02f);
                        if (killed) Haptics.Kill(); else Haptics.HitConfirm();
                    }
                }
                else if (hit.collider.gameObject.layer == Layers.RealWorld || hit.collider.gameObject.layer == Layers.Default)
                {
                    _fx?.SurfaceHit(hit.point, hit.normal);
                    var clip = audio?.Clip(Sfx.ImpactSurface);
                    if (clip != null) AudioSource.PlayClipAtPoint(clip, hit.point, 0.7f * audio.MasterVolume);
                }
            }
            ShotResolved?.Invoke(hitHunter, zone, killed);
        }
    }
}
