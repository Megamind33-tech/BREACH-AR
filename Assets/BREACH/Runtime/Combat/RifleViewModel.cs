using Breach.Presentation;
using Breach.Util;
using UnityEngine;

namespace Breach.Combat
{
    /// <summary>
    /// First-person BR-16 carbine: a BREACH-original procedural model
    /// (receiver, handguard, barrel, suppressor-style muzzle device, curved
    /// magazine, grip, collapsible stock, low-profile optic). Held low at the
    /// bottom-right so the real room stays dominant. Handles sway, recoil
    /// kick, reload choreography and a brief, small muzzle flash.
    /// </summary>
    public sealed class RifleViewModel : MonoBehaviour
    {
        Transform _pivot, _gun, _mag, _muzzle, _bolt;
        MeshRenderer _flashA, _flashB;
        Light _flashLight;
        Vector3 _restPos = new Vector3(0.155f, -0.165f, 0.34f);
        Vector3 _kickPos, _kickVel;
        Vector3 _kickRot, _kickRotVel;
        float _flashTimer;
        Quaternion _lastCamRot;
        Vector2 _sway;
        float _reloadT = -1f, _reloadDuration = 1f;
        bool _reloadEmpty;
        Vector3 _magRest;
        public Transform Muzzle => _muzzle;

        public static RifleViewModel Create(Camera cam)
        {
            var go = new GameObject("BR-16 Viewmodel") { layer = Layers.ViewModel };
            go.transform.SetParent(cam.transform, false);
            var vm = go.AddComponent<RifleViewModel>();
            vm.Build();
            vm._lastCamRot = cam.transform.rotation;
            return vm;
        }

        void Build()
        {
            int L = Layers.ViewModel;
            var polymer = BreachMaterials.Lit(new Color(0.085f, 0.088f, 0.09f), 0.28f, 0f, ProceduralTextures.Grime);
            var metal = BreachMaterials.Lit(new Color(0.13f, 0.135f, 0.14f), 0.55f, 0.85f, ProceduralTextures.Grime);
            var tan = BreachMaterials.Lit(new Color(0.36f, 0.33f, 0.27f), 0.22f, 0f, ProceduralTextures.Grime);
            var glass = BreachMaterials.Lit(new Color(0.04f, 0.05f, 0.06f), 0.95f, 0.2f);
            var reticleMat = BreachMaterials.LitEmissive(Color.black, new Color(0.9f, 0.18f, 0.12f) * 1.2f);

            _pivot = new GameObject("Pivot") { layer = L }.transform;
            _pivot.SetParent(transform, false);
            _pivot.localPosition = _restPos;
            _gun = new GameObject("Gun") { layer = L }.transform;
            _gun.SetParent(_pivot, false);
            _gun.localRotation = Quaternion.Euler(0.5f, -1.8f, 0f);

            // Dimensions in metres, +Z = toward muzzle. Overall ~0.82 m.
            var P = new System.Action<string, Mesh, Material, Vector3, Vector3>((n, m, mat, pos, rot) =>
                MeshFactory.Part(n, _gun, m, mat, pos, Quaternion.Euler(rot), L).GetComponent<MeshRenderer>().shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off);

            P("UpperReceiver", MeshFactory.ChamferBox(new Vector3(0.034f, 0.036f, 0.2f), 0.005f), metal, new Vector3(0, 0.0f, 0.0f), Vector3.zero);
            P("Rail", MeshFactory.ChamferBox(new Vector3(0.022f, 0.008f, 0.19f), 0.002f), metal, new Vector3(0, 0.022f, 0.0f), Vector3.zero);
            P("LowerReceiver", MeshFactory.ChamferBox(new Vector3(0.03f, 0.04f, 0.13f), 0.004f), polymer, new Vector3(0, -0.036f, -0.02f), Vector3.zero);
            P("MagWell", MeshFactory.ChamferBox(new Vector3(0.032f, 0.03f, 0.045f), 0.004f), polymer, new Vector3(0, -0.052f, 0.03f), Vector3.zero);
            P("TriggerGuard", MeshFactory.ChamferBox(new Vector3(0.012f, 0.006f, 0.05f), 0.002f), polymer, new Vector3(0, -0.07f, -0.02f), Vector3.zero);
            P("Grip", MeshFactory.ChamferBox(new Vector3(0.028f, 0.085f, 0.034f), 0.008f), polymer, new Vector3(0, -0.085f, -0.058f), new Vector3(-18f, 0, 0));
            // Handguard: octagonal free-float tube with a subtle ridge pattern.
            P("Handguard", MeshFactory.Loft(Vector3.forward * 0.25f, t => 0.022f, new Vector2(1f, 1.05f), 8, 1, 8, 0.05f), tan, new Vector3(0, -0.002f, 0.1f), Vector3.zero);
            P("HandguardRail", MeshFactory.ChamferBox(new Vector3(0.018f, 0.007f, 0.24f), 0.002f), metal, new Vector3(0, 0.023f, 0.225f), Vector3.zero);
            P("Barrel", MeshFactory.Cylinder(0.0085f, 0.16f, 12), metal, new Vector3(0, -0.002f, 0.34f), Vector3.zero);
            P("MuzzleDevice", MeshFactory.Loft(Vector3.forward * 0.07f, t => 0.0135f, Vector2.one, 12, 1, 6, 0.08f), metal, new Vector3(0, -0.002f, 0.49f), Vector3.zero);
            P("GasBlock", MeshFactory.ChamferBox(new Vector3(0.02f, 0.02f, 0.02f), 0.003f), metal, new Vector3(0, 0.0f, 0.36f), Vector3.zero);
            // Stock: buffer tube + collapsible stock body.
            P("BufferTube", MeshFactory.Cylinder(0.013f, 0.16f, 12), metal, new Vector3(0, 0.002f, -0.26f), Vector3.zero);
            P("Stock", MeshFactory.ChamferBox(new Vector3(0.036f, 0.07f, 0.11f), 0.01f), polymer, new Vector3(0, -0.014f, -0.24f), new Vector3(4f, 0, 0));
            P("StockPad", MeshFactory.ChamferBox(new Vector3(0.038f, 0.085f, 0.012f), 0.004f), polymer, new Vector3(0, -0.02f, -0.3f), Vector3.zero);
            P("ChargingHandle", MeshFactory.ChamferBox(new Vector3(0.03f, 0.006f, 0.014f), 0.002f), metal, new Vector3(0, 0.02f, -0.1f), Vector3.zero);
            // Low-profile optic: housing, lens, tiny reticle.
            P("OpticBase", MeshFactory.ChamferBox(new Vector3(0.026f, 0.01f, 0.05f), 0.002f), metal, new Vector3(0, 0.03f, -0.005f), Vector3.zero);
            P("OpticHousing", MeshFactory.Loft(Vector3.forward * 0.055f, t => 0.017f + 0.002f * t, new Vector2(1.1f, 1f), 12, 2), polymer, new Vector3(0, 0.05f, -0.03f), Vector3.zero);
            P("OpticLens", MeshFactory.Loft(Vector3.forward * 0.002f, t => 0.0155f, new Vector2(1.1f, 1f), 12, 1), glass, new Vector3(0, 0.05f, 0.022f), Vector3.zero);
            P("Reticle", MeshFactory.ChamferBox(new Vector3(0.0018f, 0.0018f, 0.0005f), 0.0003f), reticleMat, new Vector3(0, 0.05f, 0.0235f), Vector3.zero);

            var mag = MeshFactory.Part("Magazine", _gun, MeshFactory.Loft(Vector3.down * 0.12f, t => 0.013f, new Vector2(1.1f, 2.3f), 8, 6, bend: new Vector3(0, 0, 0.018f)),
                polymer, new Vector3(0, -0.06f, 0.03f), Quaternion.Euler(-8f, 0, 0), L);
            mag.GetComponent<MeshRenderer>().shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            _mag = mag.transform;
            _magRest = _mag.localPosition;
            _bolt = _gun.Find("ChargingHandle");

            _muzzle = new GameObject("Muzzle") { layer = L }.transform;
            _muzzle.SetParent(_gun, false);
            _muzzle.localPosition = new Vector3(0, -0.002f, 0.565f);

            // Flash: two crossed quads + a very short point light that also lights the real-room illusion.
            var flashMat = BreachMaterials.ParticlesAdditive(ProceduralTextures.MuzzleFlash);
            // A faces back toward the shooter (star burst); B is a side plane stretched along the bore.
            _flashA = MeshFactory.Part("FlashA", _muzzle, MeshFactory.Quad(0.09f), flashMat, new Vector3(0, 0, 0.03f), Quaternion.Euler(-90f, 0, 0), L).GetComponent<MeshRenderer>();
            _flashB = MeshFactory.Part("FlashB", _muzzle, MeshFactory.Quad(0.06f), flashMat, new Vector3(0, 0, 0.05f), Quaternion.Euler(0, 0, 90f), L).GetComponent<MeshRenderer>();
            _flashB.transform.localScale = new Vector3(1f, 1f, 1.9f);
            _flashA.enabled = _flashB.enabled = false;
            _flashA.shadowCastingMode = _flashB.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            var lightGo = new GameObject("FlashLight");
            lightGo.transform.SetParent(_muzzle, false);
            lightGo.transform.localPosition = new Vector3(0, 0, 0.05f);
            _flashLight = lightGo.AddComponent<Light>();
            _flashLight.type = LightType.Point;
            _flashLight.range = 3.5f;
            _flashLight.intensity = 0f;
            _flashLight.color = new Color(1f, 0.72f, 0.45f);
            _flashLight.shadows = LightShadows.None;
        }

        public void OnShot(float intensity = 1f)
        {
            // Kick back and up, small random roll — spring settles it.
            _kickVel += new Vector3(Random.Range(-0.08f, 0.08f), 0.12f, -1.1f) * intensity;
            _kickRotVel += new Vector3(-Random.Range(260f, 340f), Random.Range(-60f, 60f), Random.Range(-90f, 90f)) * intensity;
            _flashTimer = 0.035f;
            _flashA.enabled = _flashB.enabled = true;
            _flashA.transform.localRotation = Quaternion.Euler(-90f, 0, 0) * Quaternion.Euler(0, Random.Range(0f, 360f), 0);
            float s = Random.Range(0.8f, 1.15f);
            _flashA.transform.localScale = new Vector3(s, 1f, s);
            _flashLight.intensity = 2.2f;
        }

        public void OnDryFire()
        {
            _kickRotVel += new Vector3(-20f, 0, 0);
        }

        public void BeginReload(float duration, bool fromEmpty)
        {
            _reloadT = 0f;
            _reloadDuration = Mathf.Max(0.5f, duration);
            _reloadEmpty = fromEmpty;
        }

        public void CancelReload()
        {
            _reloadT = -1f;
            _mag.localPosition = _magRest;
            _mag.gameObject.SetActive(true);
        }

        void LateUpdate()
        {
            float dt = Mathf.Min(Time.deltaTime, 0.05f);
            var cam = transform.parent;

            // Sway: lag behind camera rotation.
            var delta = Quaternion.Inverse(_lastCamRot) * cam.rotation;
            _lastCamRot = cam.rotation;
            var e = delta.eulerAngles;
            float yaw = Mathf.DeltaAngle(0, e.y), pitch = Mathf.DeltaAngle(0, e.x);
            _sway = Vector2.Lerp(_sway, new Vector2(Mathf.Clamp(-yaw * 0.9f, -4f, 4f), Mathf.Clamp(-pitch * 0.9f, -4f, 4f)), 1f - Mathf.Exp(-dt * 10f));

            // Springs.
            _kickVel += (-_kickPos * 220f - _kickVel * 20f) * dt;
            _kickPos += _kickVel * dt * 0.05f;
            _kickRotVel += (-_kickRot * 260f - _kickRotVel * 24f) * dt;
            _kickRot += _kickRotVel * dt * 0.02f;

            float breathe = Mathf.Sin(Time.time * 1.3f) * 0.0015f;
            var reloadOffset = Vector3.zero;
            var reloadRot = Vector3.zero;
            if (_reloadT >= 0f)
            {
                _reloadT += dt;
                float t = Mathf.Clamp01(_reloadT / _reloadDuration);
                // Tilt in, drop mag, insert, (bolt), return.
                float tilt = Mathf.Sin(Mathf.Clamp01(t / 0.92f) * Mathf.PI);
                reloadRot = new Vector3(-14f * tilt, 16f * tilt, 32f * tilt);
                reloadOffset = new Vector3(-0.03f, -0.03f, -0.02f) * tilt;
                if (t < 0.22f) _mag.localPosition = _magRest;
                else if (t < 0.38f) _mag.localPosition = _magRest + Vector3.down * Mathf.Lerp(0f, 0.2f, (t - 0.22f) / 0.16f);
                else if (t < 0.55f) { _mag.gameObject.SetActive(false); }
                else if (t < 0.72f)
                {
                    _mag.gameObject.SetActive(true);
                    _mag.localPosition = _magRest + Vector3.down * Mathf.Lerp(0.12f, 0f, (t - 0.55f) / 0.17f);
                }
                else _mag.localPosition = _magRest;
                if (_reloadEmpty && _bolt != null)
                {
                    float bt = Mathf.InverseLerp(0.78f, 0.9f, t);
                    _bolt.localPosition = new Vector3(0, 0.02f, -0.1f - Mathf.Sin(bt * Mathf.PI) * 0.05f);
                }
                if (t >= 1f) CancelReload();
            }

            _pivot.localPosition = _restPos + _kickPos + reloadOffset + new Vector3(_sway.x * 0.002f, _sway.y * 0.002f + breathe, 0);
            _pivot.localRotation = Quaternion.Euler(_kickRot + reloadRot + new Vector3(_sway.y, _sway.x, 0));

            if (_flashTimer > 0f)
            {
                _flashTimer -= dt;
                _flashLight.intensity = Mathf.Max(0f, _flashTimer / 0.035f) * 2.2f;
                if (_flashTimer <= 0f)
                {
                    _flashA.enabled = _flashB.enabled = false;
                    _flashLight.intensity = 0f;
                }
            }
        }
    }
}
