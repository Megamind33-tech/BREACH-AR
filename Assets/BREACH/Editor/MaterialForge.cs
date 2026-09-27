using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace Breach.EditorTools
{
    /// <summary>
    /// Generates the URP template materials BREACH clones at runtime. Keeping
    /// them in Resources guarantees the shaders — and the exact keyword
    /// variants (transparency, emission) — survive build-time stripping.
    /// </summary>
    public static class MaterialForge
    {
        public const string Folder = "Assets/BREACH/Resources/Generated/Materials";

        [MenuItem("BREACH/Generate Materials")]
        public static void Generate()
        {
            Directory.CreateDirectory(Folder);

            Save("BREACH_Lit", Lit(false));
            Save("BREACH_LitEmissive", Lit(true));
            Save("BREACH_Unlit", Unlit(false));
            Save("BREACH_UnlitTransparent", Unlit(true));
            Save("BREACH_ParticlesAdditive", Particles(additive: true));
            Save("BREACH_ParticlesAlpha", Particles(additive: false));
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log("[BREACH] Template materials generated in " + Folder);
        }

        static Shader Require(string name)
        {
            var s = Shader.Find(name);
            if (s == null) throw new System.Exception("[BREACH] Required shader not found: " + name);
            return s;
        }

        static Material Lit(bool emissive)
        {
            var m = new Material(Require("Universal Render Pipeline/Lit"));
            m.SetColor("_BaseColor", Color.white);
            m.SetFloat("_Smoothness", 0.3f);
            m.SetFloat("_Metallic", 0f);
            if (emissive)
            {
                m.EnableKeyword("_EMISSION");
                m.SetColor("_EmissionColor", Color.white);
                m.globalIlluminationFlags = MaterialGlobalIlluminationFlags.None;
            }
            return m;
        }

        static Material Unlit(bool transparent)
        {
            var m = new Material(Require("Universal Render Pipeline/Unlit"));
            m.SetColor("_BaseColor", Color.white);
            if (transparent) MakeTransparent(m, additive: false);
            return m;
        }

        static Material Particles(bool additive)
        {
            var m = new Material(Require("Universal Render Pipeline/Particles/Unlit"));
            m.SetColor("_BaseColor", Color.white);
            MakeTransparent(m, additive);
            if (m.HasProperty("_Cull")) m.SetFloat("_Cull", (float)CullMode.Off);
            return m;
        }

        static void MakeTransparent(Material m, bool additive)
        {
            m.SetFloat("_Surface", 1f);
            m.SetFloat("_Blend", additive ? 2f : 0f);
            m.SetFloat("_SrcBlend", (float)BlendMode.SrcAlpha);
            m.SetFloat("_DstBlend", additive ? (float)BlendMode.One : (float)BlendMode.OneMinusSrcAlpha);
            if (m.HasProperty("_SrcBlendAlpha")) m.SetFloat("_SrcBlendAlpha", (float)BlendMode.One);
            if (m.HasProperty("_DstBlendAlpha")) m.SetFloat("_DstBlendAlpha", additive ? (float)BlendMode.One : (float)BlendMode.OneMinusSrcAlpha);
            m.SetFloat("_ZWrite", 0f);
            m.SetOverrideTag("RenderType", "Transparent");
            m.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
            m.renderQueue = (int)RenderQueue.Transparent;
        }

        static void Save(string name, Material m)
        {
            var path = $"{Folder}/{name}.mat";
            var existing = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (existing != null)
            {
                existing.shader = m.shader;
                existing.CopyPropertiesFromMaterial(m);
                existing.shaderKeywords = m.shaderKeywords;
                existing.renderQueue = m.renderQueue;
                existing.SetOverrideTag("RenderType", m.GetTag("RenderType", false));
                EditorUtility.SetDirty(existing);
            }
            else
            {
                m.name = name;
                AssetDatabase.CreateAsset(m, path);
            }
        }
    }
}
