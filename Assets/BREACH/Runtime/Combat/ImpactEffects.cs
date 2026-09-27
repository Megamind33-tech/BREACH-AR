using Breach.Presentation;
using UnityEngine;

namespace Breach.Combat
{
    /// <summary>
    /// Restrained impact feedback: a short dark ichor spray on the Hunter and a
    /// small dust puff on real surfaces. No cartoon sparks, no damage numbers.
    /// </summary>
    public sealed class ImpactEffects : MonoBehaviour
    {
        ParticleSystem _ichor, _ichorMist, _dust;

        public static ImpactEffects Create(Transform parent)
        {
            var go = new GameObject("Impact FX");
            go.transform.SetParent(parent, false);
            var fx = go.AddComponent<ImpactEffects>();
            fx._ichor = MakeSystem(go.transform, "Ichor", BreachMaterials.ParticlesAlpha(ProceduralTextures.SoftDot, Color.white),
                new Color(0.16f, 0.035f, 0.025f, 0.95f), new Color(0.08f, 0.02f, 0.015f, 0.9f), 0.25f, 0.45f, 0.012f, 0.035f, 1.4f, 3.2f, 1.6f, 22f);
            fx._ichorMist = MakeSystem(go.transform, "IchorMist", BreachMaterials.ParticlesAlpha(ProceduralTextures.SoftDot, Color.white),
                new Color(0.2f, 0.05f, 0.04f, 0.35f), new Color(0.12f, 0.04f, 0.03f, 0.2f), 0.18f, 0.3f, 0.06f, 0.14f, 0.3f, 0.8f, 0.1f, 60f);
            fx._dust = MakeSystem(go.transform, "Dust", BreachMaterials.ParticlesAlpha(ProceduralTextures.SoftDot, Color.white),
                new Color(0.62f, 0.6f, 0.56f, 0.45f), new Color(0.45f, 0.43f, 0.4f, 0.3f), 0.45f, 0.8f, 0.03f, 0.09f, 0.3f, 1.1f, 0.4f, 35f);
            return fx;
        }

        static ParticleSystem MakeSystem(Transform parent, string name, Material mat, Color a, Color b,
            float lifeMin, float lifeMax, float sizeMin, float sizeMax, float speedMin, float speedMax, float gravity, float coneAngle)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            var ps = go.AddComponent<ParticleSystem>();
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            var main = ps.main;
            main.playOnAwake = false;
            main.loop = false;
            main.duration = 1f;
            main.startLifetime = new ParticleSystem.MinMaxCurve(lifeMin, lifeMax);
            main.startSize = new ParticleSystem.MinMaxCurve(sizeMin, sizeMax);
            main.startSpeed = new ParticleSystem.MinMaxCurve(speedMin, speedMax);
            main.startColor = new ParticleSystem.MinMaxGradient(a, b);
            main.gravityModifier = gravity;
            main.simulationSpace = ParticleSystemSimulationSpace.World;
            main.maxParticles = 300;
            var emission = ps.emission;
            emission.enabled = false;
            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Cone;
            shape.angle = coneAngle;
            shape.radius = 0.01f;
            var col = ps.colorOverLifetime;
            col.enabled = true;
            var g = new Gradient();
            g.SetKeys(new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
                new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(0.6f, 0.5f), new GradientAlphaKey(0f, 1f) });
            col.color = g;
            var sol = ps.sizeOverLifetime;
            sol.enabled = true;
            sol.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.Linear(0, 0.7f, 1, 1.3f));
            var r = go.GetComponent<ParticleSystemRenderer>();
            r.sharedMaterial = mat;
            r.renderMode = ParticleSystemRenderMode.Billboard;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = false;
            return ps;
        }

        static void Burst(ParticleSystem ps, Vector3 pos, Vector3 normal, int count)
        {
            ps.transform.SetPositionAndRotation(pos, Quaternion.LookRotation(normal.sqrMagnitude > 1e-6f ? normal : Vector3.up));
            ps.Emit(count);
        }

        public void HunterHit(Vector3 point, Vector3 shotDir, bool head)
        {
            // Exit-side spray follows the round; a little back-spatter toward the shooter.
            Burst(_ichor, point, shotDir, head ? 16 : 10);
            Burst(_ichor, point, -shotDir, 3);
            Burst(_ichorMist, point, shotDir, head ? 4 : 2);
        }

        public void SurfaceHit(Vector3 point, Vector3 normal)
        {
            Burst(_dust, point + normal * 0.01f, normal, 7);
        }
    }
}
