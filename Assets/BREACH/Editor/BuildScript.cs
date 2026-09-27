using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Breach.EditorTools
{
    /// <summary>
    /// Headless build entry points. No human ever opens the editor:
    ///   Unity -batchmode -quit -projectPath . -buildTarget Android \
    ///         -executeMethod Breach.EditorTools.BuildScript.BuildAndroidCI
    /// Also used by game-ci/unity-builder as its custom buildMethod.
    /// </summary>
    public static class BuildScript
    {
        public const string ScenePath = "Assets/BREACH/Scenes/Breach.unity";
        public const string DefaultApkPath = "build/Android/BREACH-dev.apk";
        const string BuildInfoPath = "Assets/BREACH/Resources/Generated/BuildInfo.txt";

        [MenuItem("BREACH/Build Android APK")]
        public static void BuildAndroid() => Build(exitOnFinish: false);

        /// <summary>CI entry: exits the editor with 0 on success, 1 on failure.</summary>
        public static void BuildAndroidCI()
        {
            try
            {
                Build(exitOnFinish: true);
            }
            catch (Exception e)
            {
                Debug.LogError("[BREACH] Build failed with exception: " + e);
                EditorApplication.Exit(1);
            }
        }

        /// <summary>CI entry: prepare + validate only (no player build). Fast sanity check.</summary>
        public static void ValidateCI()
        {
            try
            {
                Prepare();
                var problems = Validation.Run();
                EditorApplication.Exit(problems == 0 ? 0 : 1);
            }
            catch (Exception e)
            {
                Debug.LogError("[BREACH] Validation crashed: " + e);
                EditorApplication.Exit(1);
            }
        }

        public static void Prepare()
        {
            MaterialForge.Generate();
            EnsureScene();
            WriteBuildInfo();
            ConfigurePlayer();
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
        }

        static void Build(bool exitOnFinish)
        {
            Prepare();
            int problems = Validation.Run();
            if (problems > 0)
            {
                Debug.LogError($"[BREACH] {problems} validation problem(s); refusing to build.");
                if (exitOnFinish) EditorApplication.Exit(1);
                return;
            }

            if (EditorUserBuildSettings.activeBuildTarget != BuildTarget.Android)
                EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Android, BuildTarget.Android);
            EditorUserBuildSettings.buildAppBundle = false;

            string output = Arg("-customBuildPath") ?? DefaultApkPath;
            if (!output.EndsWith(".apk", StringComparison.OrdinalIgnoreCase))
                output = Path.Combine(output, "BREACH-dev.apk");
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output)) ?? ".");

            var options = new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = output,
                target = BuildTarget.Android,
                targetGroup = BuildTargetGroup.Android,
                options = BuildOptions.None,
            };
            Debug.Log($"[BREACH] Building Android APK → {output}");
            var report = BuildPipeline.BuildPlayer(options);
            var summary = report.summary;
            Debug.Log($"[BREACH] Build result: {summary.result}, size {summary.totalSize / (1024 * 1024)} MB, " +
                      $"{summary.totalErrors} errors, {summary.totalWarnings} warnings, {summary.totalTime}");

            bool ok = summary.result == BuildResult.Succeeded;
            if (exitOnFinish) EditorApplication.Exit(ok ? 0 : 1);
        }

        static string Arg(string name)
        {
            var args = Environment.GetCommandLineArgs();
            for (int i = 0; i < args.Length - 1; i++)
                if (args[i] == name) return args[i + 1];
            return null;
        }

        /// <summary>The only scene is empty: BreachBootstrap builds everything at runtime.</summary>
        public static void EnsureScene()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath) ?? "Assets/BREACH/Scenes");
            if (!File.Exists(ScenePath))
            {
                var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                EditorSceneManager.SaveScene(scene, ScenePath);
                Debug.Log("[BREACH] Created bootstrap scene " + ScenePath);
            }
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        }

        static void WriteBuildInfo()
        {
            string sha = Environment.GetEnvironmentVariable("GITHUB_SHA");
            if (string.IsNullOrEmpty(sha)) sha = Git("rev-parse HEAD") ?? "unknown";
            string shortSha = sha.Length > 7 ? sha.Substring(0, 7) : sha;
            string run = Environment.GetEnvironmentVariable("GITHUB_RUN_NUMBER") ?? "local";
            string branch = Environment.GetEnvironmentVariable("GITHUB_REF_NAME") ?? Git("rev-parse --abbrev-ref HEAD") ?? "?";
            string text = $"v{PlayerSettings.bundleVersion} · {shortSha} · {branch} · run {run} · {DateTime.UtcNow:yyyy-MM-dd HH:mm}Z";
            Directory.CreateDirectory(Path.GetDirectoryName(BuildInfoPath) ?? ".");
            File.WriteAllText(BuildInfoPath, text);
            AssetDatabase.ImportAsset(BuildInfoPath);
            Debug.Log("[BREACH] Build info: " + text);
        }

        static string Git(string args)
        {
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo("git", args)
                {
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using (var p = System.Diagnostics.Process.Start(psi))
                {
                    string o = p.StandardOutput.ReadToEnd().Trim();
                    p.WaitForExit(5000);
                    return p.ExitCode == 0 && o.Length > 0 ? o : null;
                }
            }
            catch
            {
                return null;
            }
        }

        static void ConfigurePlayer()
        {
            PlayerSettings.companyName = "BREACH";
            PlayerSettings.productName = "BREACH AR";
            PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Android, "com.breach.ar");
            string version = Environment.GetEnvironmentVariable("BREACH_VERSION");
            if (!string.IsNullOrEmpty(version)) PlayerSettings.bundleVersion = version;
            if (int.TryParse(Environment.GetEnvironmentVariable("GITHUB_RUN_NUMBER"), out int code) && code > 0)
                PlayerSettings.Android.bundleVersionCode = code;
            PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android, ScriptingImplementation.IL2CPP);
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
            PlayerSettings.defaultInterfaceOrientation = UIOrientation.LandscapeLeft;
            PlayerSettings.allowedAutorotateToPortrait = false;
            PlayerSettings.allowedAutorotateToPortraitUpsideDown = false;
            PlayerSettings.allowedAutorotateToLandscapeLeft = true;
            PlayerSettings.allowedAutorotateToLandscapeRight = false;
            EditorUserBuildSettings.development = false;
        }
    }

    /// <summary>Pre-build checks that catch a broken APK before spending build minutes.</summary>
    public static class Validation
    {
        [MenuItem("BREACH/Validate Project")]
        public static void Menu() => Run();

        public static int Run()
        {
            int problems = 0;
            void Fail(string msg) { problems++; Debug.LogError("[BREACH][VALIDATION] " + msg); }
            void Ok(string msg) => Debug.Log("[BREACH][VALIDATION] ok: " + msg);

            foreach (var f in new[] { "Fonts/BarlowCondensed-Medium", "Fonts/BarlowCondensed-SemiBold" })
                if (Resources.Load<Font>(f) == null) Fail("missing font " + f); else Ok(f);

            foreach (var m in new[] { "BREACH_Lit", "BREACH_LitEmissive", "BREACH_Unlit", "BREACH_UnlitTransparent", "BREACH_ParticlesAdditive", "BREACH_ParticlesAlpha" })
            {
                var mat = Resources.Load<Material>("Generated/Materials/" + m);
                if (mat == null || mat.shader == null || !mat.shader.isSupported) Fail("material/shader problem: " + m); else Ok(m + " → " + mat.shader.name);
            }

            if (Resources.Load<TextAsset>("Markers/breach_origin_marker") == null) Fail("missing origin marker bytes");
            else Ok("origin marker");

            int clips = Resources.LoadAll<AudioClip>("Audio").Length;
            if (clips < 20) Fail($"expected ≥20 audio clips, found {clips}"); else Ok($"{clips} audio clips");

            if (!EditorBuildSettings.TryGetConfigObject("com.unity.xr.management.loader_settings", out UnityEngine.Object xr) || xr == null)
                Fail("XR management loader settings not registered (ARCore would not start)");
            else Ok("XR loader settings: " + AssetDatabase.GetAssetPath(xr));

            var xrText = File.Exists("Assets/XR/XRGeneralSettings.asset") ? File.ReadAllText("Assets/XR/XRGeneralSettings.asset") : "";
            if (!xrText.Contains("04940b94cbab8444187b3217d4e40166")) Fail("ARCore loader not assigned for Android");
            else Ok("ARCore loader assigned for Android");

            if (UnityEngine.Rendering.GraphicsSettings.defaultRenderPipeline == null) Fail("no URP asset assigned in Graphics settings");
            else Ok("render pipeline: " + UnityEngine.Rendering.GraphicsSettings.defaultRenderPipeline.name);

            if (!EditorBuildSettings.scenes.Any(s => s.path == BuildScript.ScenePath && s.enabled)) Fail("bootstrap scene not in build settings");
            else Ok("scene " + BuildScript.ScenePath);

            Debug.Log(problems == 0 ? "[BREACH][VALIDATION] PASSED" : $"[BREACH][VALIDATION] FAILED ({problems})");
            return problems;
        }
    }
}
