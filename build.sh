#!/usr/bin/env bash
# BREACH AR — one-command local Android build (macOS / Linux).
#   ./build.sh            build BREACH-dev.apk
#   ./build.sh validate   validation only (no APK)
#   UNITY_PATH=/path/to/Unity ./build.sh
# Requires Unity (version in ProjectSettings/ProjectVersion.txt) with Android Build Support.
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(sed -n 's/^m_EditorVersion: //p' ProjectSettings/ProjectVersion.txt | tr -d '\r')
METHOD=Breach.EditorTools.BuildScript.BuildAndroidCI
[ "${1:-}" = "validate" ] && METHOD=Breach.EditorTools.BuildScript.ValidateCI

if [ -z "${UNITY_PATH:-}" ]; then
  for c in \
    "/Applications/Unity/Hub/Editor/$VERSION/Unity.app/Contents/MacOS/Unity" \
    "$HOME/Unity/Hub/Editor/$VERSION/Editor/Unity" \
    "/opt/unity/editors/$VERSION/Editor/Unity"; do
    [ -x "$c" ] && UNITY_PATH="$c" && break
  done
fi
if [ -z "${UNITY_PATH:-}" ] || [ ! -x "$UNITY_PATH" ]; then
  echo "Unity $VERSION not found. Install it (with Android Build Support) or set UNITY_PATH." >&2
  exit 2
fi

mkdir -p build
echo "Using $UNITY_PATH → $METHOD"
set +e
"$UNITY_PATH" -batchmode -nographics -quit -projectPath "$PWD" -buildTarget Android \
  -executeMethod "$METHOD" -customBuildPath build/Android/BREACH-dev.apk -logFile build/unity-build.log
CODE=$?
set -e
echo "---- BREACH lines from build/unity-build.log ----"
grep -E "\[BREACH\]|error CS|Error:" build/unity-build.log | tail -60 || true
if [ $CODE -eq 0 ]; then
  if [ "${1:-}" = "validate" ]; then echo "OK: validation passed"; else echo "OK: build/Android/BREACH-dev.apk"; fi
else
  echo "FAILED (exit $CODE). Send build/unity-build.log (or the lines above) back to the agent." >&2
fi
exit $CODE
