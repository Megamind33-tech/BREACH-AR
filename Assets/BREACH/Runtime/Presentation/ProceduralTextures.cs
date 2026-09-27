using UnityEngine;

namespace Breach.Presentation
{
    /// <summary>Small textures generated at startup — no external image assets required.</summary>
    public static class ProceduralTextures
    {
        static Texture2D _softDot, _blobShadow, _flash, _grime, _scanGrid, _white, _streak;

        static Texture2D New(int size, string name, TextureWrapMode wrap = TextureWrapMode.Clamp)
        {
            return new Texture2D(size, size, TextureFormat.RGBA32, true)
            {
                name = name,
                wrapMode = wrap,
                filterMode = FilterMode.Bilinear,
                anisoLevel = 2,
            };
        }

        public static Texture2D White
        {
            get
            {
                if (_white != null) return _white;
                _white = New(4, "BREACH_White");
                var px = new Color32[16];
                for (int i = 0; i < px.Length; i++) px[i] = new Color32(255, 255, 255, 255);
                _white.SetPixels32(px);
                _white.Apply();
                return _white;
            }
        }

        /// <summary>Soft round particle (smoke / dust / fluid).</summary>
        public static Texture2D SoftDot
        {
            get
            {
                if (_softDot != null) return _softDot;
                const int s = 64;
                _softDot = New(s, "BREACH_SoftDot");
                var px = new Color[s * s];
                for (int y = 0; y < s; y++)
                for (int x = 0; x < s; x++)
                {
                    float dx = (x + 0.5f) / s * 2 - 1, dy = (y + 0.5f) / s * 2 - 1;
                    float d = Mathf.Sqrt(dx * dx + dy * dy);
                    float a = Mathf.Clamp01(1 - d);
                    a = a * a * (3 - 2 * a);
                    px[y * s + x] = new Color(1, 1, 1, a);
                }
                _softDot.SetPixels(px);
                _softDot.Apply();
                return _softDot;
            }
        }

        /// <summary>Contact shadow under the Hunter — the cheapest cure for "floating".</summary>
        public static Texture2D BlobShadow
        {
            get
            {
                if (_blobShadow != null) return _blobShadow;
                const int s = 128;
                _blobShadow = New(s, "BREACH_BlobShadow");
                var px = new Color[s * s];
                for (int y = 0; y < s; y++)
                for (int x = 0; x < s; x++)
                {
                    float dx = (x + 0.5f) / s * 2 - 1, dy = (y + 0.5f) / s * 2 - 1;
                    float d = Mathf.Sqrt(dx * dx + dy * dy);
                    float a = Mathf.Clamp01(1 - d);
                    a = Mathf.Pow(a, 1.6f);
                    px[y * s + x] = new Color(0, 0, 0, a);
                }
                _blobShadow.SetPixels(px);
                _blobShadow.Apply();
                return _blobShadow;
            }
        }

        /// <summary>Muzzle flash: tight hot core with a few short, irregular prongs.</summary>
        public static Texture2D MuzzleFlash
        {
            get
            {
                if (_flash != null) return _flash;
                const int s = 128;
                _flash = New(s, "BREACH_MuzzleFlash");
                var px = new Color[s * s];
                var rng = new System.Random(4);
                var prong = new float[5];
                for (int i = 0; i < prong.Length; i++) prong[i] = 0.55f + (float)rng.NextDouble() * 0.45f;
                for (int y = 0; y < s; y++)
                for (int x = 0; x < s; x++)
                {
                    float dx = (x + 0.5f) / s * 2 - 1, dy = (y + 0.5f) / s * 2 - 1;
                    float r = Mathf.Sqrt(dx * dx + dy * dy);
                    float ang = Mathf.Atan2(dy, dx);
                    float petals = 0f;
                    for (int i = 0; i < prong.Length; i++)
                    {
                        float pa = i * Mathf.PI * 2 / prong.Length + 0.3f;
                        float da = Mathf.DeltaAngle(ang * Mathf.Rad2Deg, pa * Mathf.Rad2Deg) * Mathf.Deg2Rad;
                        petals = Mathf.Max(petals, Mathf.Exp(-da * da * 60f) * Mathf.Clamp01(1 - r / prong[i]));
                    }
                    float core = Mathf.Exp(-r * r * 18f);
                    float a = Mathf.Clamp01(core + petals * 0.8f);
                    var c = Color.Lerp(new Color(1f, 0.55f, 0.2f), new Color(1f, 0.93f, 0.8f), core);
                    px[y * s + x] = new Color(c.r, c.g, c.b, a);
                }
                _flash.SetPixels(px);
                _flash.Apply();
                return _flash;
            }
        }

        /// <summary>Thin elongated streak (tracer / spark).</summary>
        public static Texture2D Streak
        {
            get
            {
                if (_streak != null) return _streak;
                const int s = 64;
                _streak = New(s, "BREACH_Streak");
                var px = new Color[s * s];
                for (int y = 0; y < s; y++)
                for (int x = 0; x < s; x++)
                {
                    float dx = (x + 0.5f) / s * 2 - 1, dy = (y + 0.5f) / s * 2 - 1;
                    float a = Mathf.Exp(-dy * dy * 90f) * Mathf.Clamp01(1 - Mathf.Abs(dx));
                    px[y * s + x] = new Color(1, 1, 1, a);
                }
                _streak.SetPixels(px);
                _streak.Apply();
                return _streak;
            }
        }

        /// <summary>Tiling grime/value-noise used to break up flat surfaces on the Hunter and rifle.</summary>
        public static Texture2D Grime
        {
            get
            {
                if (_grime != null) return _grime;
                const int s = 256;
                _grime = New(s, "BREACH_Grime", TextureWrapMode.Repeat);
                var px = new Color[s * s];
                for (int y = 0; y < s; y++)
                for (int x = 0; x < s; x++)
                {
                    float u = (float)x / s, v = (float)y / s;
                    float n = 0f, amp = 0.5f, f = 4f;
                    for (int o = 0; o < 5; o++)
                    {
                        n += amp * TileNoise(u * f, v * f, (int)f);
                        amp *= 0.5f;
                        f *= 2f;
                    }
                    float g = Mathf.Lerp(0.72f, 1.0f, n);
                    px[y * s + x] = new Color(g, g * 0.985f, g * 0.97f, 1);
                }
                _grime.SetPixels(px);
                _grime.Apply();
                return _grime;
            }
        }

        static float TileNoise(float x, float y, int period)
        {
            // Periodic Perlin sampled on a torus so the texture tiles seamlessly.
            float a = x / period * Mathf.PI * 2, b = y / period * Mathf.PI * 2;
            float r = period / (Mathf.PI * 2);
            return Mathf.PerlinNoise(Mathf.Cos(a) * r + 31.7f + Mathf.Sin(b) * r, Mathf.Sin(a) * r + 11.3f + Mathf.Cos(b) * r);
        }

        /// <summary>Faint dotted grid shown on real surfaces only while scanning.</summary>
        public static Texture2D ScanGrid
        {
            get
            {
                if (_scanGrid != null) return _scanGrid;
                const int s = 64;
                _scanGrid = New(s, "BREACH_ScanGrid", TextureWrapMode.Repeat);
                var px = new Color[s * s];
                for (int y = 0; y < s; y++)
                for (int x = 0; x < s; x++)
                {
                    float dx = Mathf.Abs(x - s / 2f), dy = Mathf.Abs(y - s / 2f);
                    float dot = Mathf.Clamp01(1.8f - Mathf.Sqrt(dx * dx + dy * dy));
                    px[y * s + x] = new Color(1, 1, 1, dot);
                }
                _scanGrid.SetPixels(px);
                _scanGrid.Apply();
                return _scanGrid;
            }
        }
    }
}
