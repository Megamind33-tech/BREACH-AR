# Building BREACH-dev.apk without ever opening Unity

```
push to GitHub ──► GitHub Actions ──► core-tests (dotnet) ──► android (Unity 6 headless, game-ci)
                                                                  │
                                                                  └──► artifact: BREACH-dev-apk / BREACH-dev.apk
```

Workflow: `.github/workflows/breach-build.yml`. Entry point inside Unity:
`Breach.EditorTools.BuildScript.BuildAndroidCI` (`Assets/BREACH/Editor/BuildScript.cs`), which

1. generates the URP template materials (`MaterialForge`),
2. creates the single empty bootstrap scene (the game builds itself at runtime),
3. writes build info (commit, branch, run number) into the APK,
4. applies player settings (IL2CPP, ARM64, landscape, `com.breach.ar`),
5. runs project validation (fonts, materials/shaders, audio, marker, ARCore loader, URP) and refuses to build on any failure,
6. builds `build/Android/BREACH-dev.apk` and exits 0/1.

Pinned stack (copied from Unity's own `arfoundation-samples` `6.3` branch, not guessed):
Unity **6000.3.1f1**, AR Foundation **6.3.5**, ARCore XR Plugin **6.3.5**, URP **17.3.0**, Input System **1.19.0**.

## The one infrastructure blocker: a Unity license for CI  — STATUS: BLOCKING

Unity will not run (even headless) without an activated license. This is the only step that needs a human, and it does **not** involve the Unity Editor:

Add these **repository secrets** (GitHub → repo → Settings → Secrets and variables → Actions):

| Secret | What |
|---|---|
| `UNITY_EMAIL` | Unity ID e-mail (free account at id.unity.com) |
| `UNITY_PASSWORD` | Unity ID password |
| `UNITY_LICENSE` | Contents of a Unity license file (`Unity_lic.ulf`) — **Personal** licenses |
| `UNITY_SERIAL` | Serial key — **Pro/Plus** licenses only (use instead of `UNITY_LICENSE`) |

Getting `Unity_lic.ulf` for a free Personal license (per game-ci's activation docs): sign in to **Unity Hub** once on any computer and activate a Personal license; the file is then at
`C:\ProgramData\Unity\Unity_lic.ulf` (Windows), `/Library/Application Support/Unity/Unity_lic.ulf` (macOS) or `~/.local/share/unity3d/Unity/Unity_lic.ulf` (Linux). Paste its full contents into `UNITY_LICENSE`. (Unity Hub is the launcher/licence manager — not the Editor.)

Alternative with no local install at all: **Unity Build Automation** (cloud, configured in the Unity web dashboard): connect this GitHub repo, target Android, set the custom build method to `Breach.EditorTools.BuildScript.BuildAndroid`.

Until a license exists the `android` job fails early with a clear "Unity license missing" error; `core-tests` still runs.

## Local (optional, for someone who does have Unity)

```
Unity -batchmode -nographics -quit -projectPath . -buildTarget Android \
      -executeMethod Breach.EditorTools.BuildScript.BuildAndroidCI -logFile -
```
Validation only (no APK): `-executeMethod Breach.EditorTools.BuildScript.ValidateCI`.

## Regenerating owned assets

```
pip install numpy scipy pillow
python3 Tools/audio/generate_sfx.py       # 33 original sound effects
python3 Tools/marker/generate_marker.py   # origin marker image + printable A4 PDF
dotnet test Tools/CoreTests/Tests/Breach.Core.Tests.csproj
```
