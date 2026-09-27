using System.Collections.Generic;
using Breach.Core.Combat;
using Breach.Presentation;
using Breach.Util;
using UnityEngine;

namespace Breach.Hunter
{
    /// <summary>Maps a Hunter collider to a damage zone.</summary>
    public sealed class HunterHitbox : MonoBehaviour
    {
        public HitZone Zone;
        public HunterActor Owner;
    }

    /// <summary>
    /// THE HUNTER's body: a gaunt, hunched biomechanical humanoid built from
    /// lofted meshes on a 15-bone skeleton. Organic grey hide with dark
    /// armour plates along the spine and forearms, a single narrow sensor
    /// slit instead of eyes, long arms ending in claws. BREACH-original art.
    /// </summary>
    public sealed class HunterBody
    {
        public Transform Root, Pelvis, Spine, Chest, Neck, Head;
        public Transform ShoulderL, UpperArmL, ForearmL, HandL;
        public Transform ShoulderR, UpperArmR, ForearmR, HandR;
        public Transform ThighL, ShinL, FootL, ThighR, ShinR, FootR;
        public Renderer Sensor;
        public readonly List<Collider> Hitboxes = new List<Collider>();
        public readonly List<Renderer> Renderers = new List<Renderer>();
        public Material SkinMaterial, PlateMaterial, SensorMaterial;

        public const float PelvisHeight = 0.92f;

        static Mesh _thigh, _shin, _upperArm, _forearm, _torso, _abdomen, _neck, _head, _jaw, _claw, _plate, _foot, _hand, _shoulderPlate;

        public static HunterBody Build(Transform parent, HunterActor owner)
        {
            var b = new HunterBody();
            b.SkinMaterial = BreachMaterials.Lit(new Color(0.30f, 0.29f, 0.28f), 0.42f, 0f, ProceduralTextures.Grime);
            b.PlateMaterial = BreachMaterials.Lit(new Color(0.105f, 0.11f, 0.115f), 0.52f, 0.65f, ProceduralTextures.Grime);
            // Restrained: a dim, narrow slit — enough to find the head in low light, not a glowing toy.
            b.SensorMaterial = BreachMaterials.LitEmissive(new Color(0.05f, 0.02f, 0.02f), new Color(0.75f, 0.16f, 0.07f) * 1.3f);
            BuildMeshes();

            int layer = Layers.Hunter;
            b.Root = new GameObject("Hunter Rig").transform;
            b.Root.SetParent(parent, false);
            b.Root.gameObject.layer = layer;

            b.Pelvis = Bone("Pelvis", b.Root, new Vector3(0, PelvisHeight, 0), layer);
            b.Spine = Bone("Spine", b.Pelvis, new Vector3(0, 0.17f, -0.01f), layer);
            b.Chest = Bone("Chest", b.Spine, new Vector3(0, 0.24f, 0.0f), layer);
            b.Neck = Bone("Neck", b.Chest, new Vector3(0, 0.25f, 0.03f), layer);
            b.Head = Bone("Head", b.Neck, new Vector3(0, 0.12f, 0.03f), layer);

            b.ShoulderL = Bone("Shoulder.L", b.Chest, new Vector3(-0.2f, 0.19f, 0f), layer);
            b.UpperArmL = Bone("UpperArm.L", b.ShoulderL, new Vector3(-0.03f, 0f, 0f), layer);
            b.ForearmL = Bone("Forearm.L", b.UpperArmL, new Vector3(0, -0.36f, 0), layer);
            b.HandL = Bone("Hand.L", b.ForearmL, new Vector3(0, -0.36f, 0), layer);
            b.ShoulderR = Bone("Shoulder.R", b.Chest, new Vector3(0.2f, 0.19f, 0f), layer);
            b.UpperArmR = Bone("UpperArm.R", b.ShoulderR, new Vector3(0.03f, 0f, 0f), layer);
            b.ForearmR = Bone("Forearm.R", b.UpperArmR, new Vector3(0, -0.36f, 0), layer);
            b.HandR = Bone("Hand.R", b.ForearmR, new Vector3(0, -0.36f, 0), layer);

            b.ThighL = Bone("Thigh.L", b.Pelvis, new Vector3(-0.11f, -0.04f, 0), layer);
            b.ShinL = Bone("Shin.L", b.ThighL, new Vector3(0, -0.44f, 0), layer);
            b.FootL = Bone("Foot.L", b.ShinL, new Vector3(0, -0.44f, 0), layer);
            b.ThighR = Bone("Thigh.R", b.Pelvis, new Vector3(0.11f, -0.04f, 0), layer);
            b.ShinR = Bone("Shin.R", b.ThighR, new Vector3(0, -0.44f, 0), layer);
            b.FootR = Bone("Foot.R", b.ShinR, new Vector3(0, -0.44f, 0), layer);

            // --- skin ---
            b.Add(MeshFactory.Part("Abdomen", b.Pelvis, _abdomen, b.SkinMaterial, new Vector3(0, -0.05f, 0), Quaternion.identity, layer));
            b.Add(MeshFactory.Part("Torso", b.Spine, _torso, b.SkinMaterial, Vector3.zero, Quaternion.identity, layer));
            b.Add(MeshFactory.Part("Neck", b.Neck, _neck, b.SkinMaterial, Vector3.zero, Quaternion.identity, layer));
            b.Add(MeshFactory.Part("Skull", b.Head, _head, b.SkinMaterial, new Vector3(0, 0.02f, -0.06f), Quaternion.identity, layer));
            b.Add(MeshFactory.Part("Jaw", b.Head, _jaw, b.PlateMaterial, new Vector3(0, -0.035f, 0.0f), Quaternion.Euler(12f, 0, 0), layer));
            var sensor = MeshFactory.Part("Sensor", b.Head, MeshFactory.ChamferBox(new Vector3(0.1f, 0.012f, 0.02f), 0.004f),
                b.SensorMaterial, new Vector3(0, 0.035f, 0.115f), Quaternion.Euler(-6f, 0, 0), layer);
            b.Sensor = sensor.GetComponent<Renderer>();
            b.Add(sensor);

            foreach (var (upper, fore, hand, side) in new[] { (b.UpperArmL, b.ForearmL, b.HandL, -1f), (b.UpperArmR, b.ForearmR, b.HandR, 1f) })
            {
                b.Add(MeshFactory.Part("UpperArm", upper, _upperArm, b.SkinMaterial, Vector3.zero, Quaternion.identity, layer));
                b.Add(MeshFactory.Part("Forearm", fore, _forearm, b.SkinMaterial, Vector3.zero, Quaternion.identity, layer));
                b.Add(MeshFactory.Part("ForearmPlate", fore, _plate, b.PlateMaterial, new Vector3(side * 0.018f, -0.16f, 0.03f), Quaternion.Euler(0, 0, 0), layer));
                b.Add(MeshFactory.Part("Hand", hand, _hand, b.SkinMaterial, Vector3.zero, Quaternion.identity, layer));
                for (int i = 0; i < 3; i++)
                {
                    float spread = (i - 1) * 0.028f;
                    b.Add(MeshFactory.Part("Claw", hand, _claw, b.PlateMaterial, new Vector3(spread, -0.085f, 0.012f),
                        Quaternion.Euler(12f + i * 4f, 0, (i - 1) * -8f), layer));
                }
                b.Add(MeshFactory.Part("ShoulderPlate", upper, _shoulderPlate, b.PlateMaterial, new Vector3(side * 0.02f, 0.01f, 0), Quaternion.Euler(0, 0, side * -18f), layer));
            }

            foreach (var (thigh, shin, foot) in new[] { (b.ThighL, b.ShinL, b.FootL), (b.ThighR, b.ShinR, b.FootR) })
            {
                b.Add(MeshFactory.Part("Thigh", thigh, _thigh, b.SkinMaterial, Vector3.zero, Quaternion.identity, layer));
                b.Add(MeshFactory.Part("Shin", shin, _shin, b.SkinMaterial, Vector3.zero, Quaternion.identity, layer));
                b.Add(MeshFactory.Part("ShinPlate", shin, _plate, b.PlateMaterial, new Vector3(0, -0.17f, 0.045f), Quaternion.identity, layer));
                b.Add(MeshFactory.Part("Foot", foot, _foot, b.SkinMaterial, new Vector3(0, 0.02f, 0.02f), Quaternion.identity, layer));
            }

            // Dorsal armour plates down the spine — the "robotic" read.
            for (int i = 0; i < 5; i++)
            {
                var parentBone = i < 3 ? b.Chest : b.Spine;
                float y = i < 3 ? 0.2f - i * 0.085f : 0.16f - (i - 3) * 0.09f;
                b.Add(MeshFactory.Part("DorsalPlate", parentBone, _plate, b.PlateMaterial, new Vector3(0, y, -0.11f),
                    Quaternion.Euler(-78f, 0, 0) * Quaternion.Euler(0, 0, 90f), layer));
            }

            // --- hitboxes (also ragdoll colliders) ---
            b.Hitbox(b.Head, HitZone.Head, owner, new Vector3(0, 0.02f, 0.02f), 0.095f, 0.25f, 2);
            b.Hitbox(b.Neck, HitZone.Head, owner, new Vector3(0, 0.06f, 0), 0.055f, 0.14f, 1);
            b.Hitbox(b.Chest, HitZone.Body, owner, new Vector3(0, 0.1f, 0), 0.16f, 0.4f, 1);
            b.Hitbox(b.Spine, HitZone.Body, owner, new Vector3(0, 0.08f, 0), 0.13f, 0.28f, 1);
            b.Hitbox(b.Pelvis, HitZone.Body, owner, new Vector3(0, -0.03f, 0), 0.14f, 0.3f, 0);
            foreach (var bone in new[] { b.UpperArmL, b.UpperArmR, b.ForearmL, b.ForearmR })
                b.Hitbox(bone, HitZone.Limb, owner, new Vector3(0, -0.18f, 0), 0.05f, 0.38f, 1);
            foreach (var bone in new[] { b.ThighL, b.ThighR, b.ShinL, b.ShinR })
                b.Hitbox(bone, HitZone.Limb, owner, new Vector3(0, -0.22f, 0), 0.065f, 0.46f, 1);

            return b;
        }

        void Add(GameObject part)
        {
            var r = part.GetComponent<Renderer>();
            if (r != null)
            {
                Renderers.Add(r);
                r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
            }
        }

        static Transform Bone(string name, Transform parent, Vector3 localPos, int layer)
        {
            var t = new GameObject(name) { layer = layer }.transform;
            t.SetParent(parent, false);
            t.localPosition = localPos;
            return t;
        }

        void Hitbox(Transform bone, HitZone zone, HunterActor owner, Vector3 center, float radius, float height, int direction)
        {
            var c = bone.gameObject.AddComponent<CapsuleCollider>();
            c.center = center;
            c.radius = radius;
            c.height = height;
            c.direction = direction;
            var hb = bone.gameObject.AddComponent<HunterHitbox>();
            hb.Zone = zone;
            hb.Owner = owner;
            Hitboxes.Add(c);
        }

        static void BuildMeshes()
        {
            if (_torso != null) return;
            // Limbs hang along -Y from their joint. Profiles taper with a muscle bulge near the top.
            _thigh = MeshFactory.Loft(Vector3.down * 0.45f, t => Mathf.Lerp(0.075f, 0.045f, t) * (1f + 0.25f * Mathf.Sin(Mathf.PI * Mathf.Min(1f, t * 1.4f))), new Vector2(1f, 1.1f), 10, 8, 3, 0.08f);
            _shin = MeshFactory.Loft(Vector3.down * 0.45f, t => Mathf.Lerp(0.052f, 0.03f, t) * (1f + 0.3f * Mathf.Sin(Mathf.PI * Mathf.Min(1f, t * 2f))), new Vector2(0.9f, 1.15f), 10, 8, 4, 0.1f);
            _upperArm = MeshFactory.Loft(Vector3.down * 0.37f, t => Mathf.Lerp(0.05f, 0.032f, t) * (1f + 0.2f * Mathf.Sin(Mathf.PI * t)), new Vector2(1f, 1f), 9, 7, 3, 0.1f);
            _forearm = MeshFactory.Loft(Vector3.down * 0.37f, t => Mathf.Lerp(0.04f, 0.022f, t) * (1f + 0.25f * Mathf.Sin(Mathf.PI * Mathf.Min(1f, t * 1.6f))), new Vector2(1.1f, 0.9f), 9, 7, 4, 0.12f);
            _hand = MeshFactory.Loft(Vector3.down * 0.09f, t => Mathf.Lerp(0.03f, 0.022f, t), new Vector2(1.3f, 0.55f), 8, 3);
            _claw = MeshFactory.Loft(Vector3.down * 0.13f, t => Mathf.Lerp(0.009f, 0.0005f, t), new Vector2(1f, 0.6f), 6, 5, bend: new Vector3(0, 0, 0.025f));
            _foot = MeshFactory.Loft(Vector3.forward * 0.2f, t => Mathf.Lerp(0.04f, 0.018f, t), new Vector2(1.1f, 0.55f), 8, 4);
            // Ribcage: wide, shallow, ridged — a starved silhouette.
            _torso = MeshFactory.Loft(Vector3.up * 0.46f, t =>
            {
                float chest = Mathf.Sin(Mathf.PI * Mathf.Clamp01(t * 0.95f + 0.05f));
                return 0.1f + 0.075f * chest;
            }, new Vector2(1.25f, 0.8f), 14, 10, 7, 0.12f);
            _abdomen = MeshFactory.Loft(Vector3.up * 0.24f, t => Mathf.Lerp(0.12f, 0.09f, Mathf.Sin(Mathf.PI * t * 0.8f)), new Vector2(1.15f, 0.8f), 12, 5, 5, 0.1f);
            _neck = MeshFactory.Loft(Vector3.up * 0.15f, t => Mathf.Lerp(0.045f, 0.035f, t), new Vector2(1f, 1.1f), 8, 4, 4, 0.15f);
            // Elongated skull pointing forward (+Z), narrowing to a blunt snout.
            _head = MeshFactory.Loft(Vector3.forward * 0.26f, t => 0.075f * Mathf.Sin(Mathf.PI * Mathf.Lerp(0.18f, 0.92f, t)) * Mathf.Lerp(1.05f, 0.7f, t), new Vector2(0.95f, 1.1f), 12, 9, 2, 0.05f);
            _jaw = MeshFactory.Loft(Vector3.forward * 0.2f, t => Mathf.Lerp(0.045f, 0.018f, t), new Vector2(1f, 0.5f), 8, 5);
            _plate = MeshFactory.ChamferBox(new Vector3(0.06f, 0.16f, 0.018f), 0.006f);
            _shoulderPlate = MeshFactory.Loft(Vector3.down * 0.12f, t => Mathf.Lerp(0.075f, 0.055f, t), new Vector2(1f, 1f), 10, 3);
        }
    }
}
