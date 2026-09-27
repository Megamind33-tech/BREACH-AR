# BREACH AR — one-command local Android build (Windows PowerShell).
#   .\build.ps1             build BREACH-dev.apk
#   .\build.ps1 validate    validation only
#   $env:UNITY_PATH = "C:\...\Unity.exe"; .\build.ps1
param([string]$Mode = "build")
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$version = ((Get-Content ProjectSettings/ProjectVersion.txt | Select-String '^m_EditorVersion: ').ToString() -replace 'm_EditorVersion: ', '').Trim()
$method = if ($Mode -eq "validate") { "Breach.EditorTools.BuildScript.ValidateCI" } else { "Breach.EditorTools.BuildScript.BuildAndroidCI" }
$unity = $env:UNITY_PATH
if (-not $unity) { $unity = "C:\Program Files\Unity\Hub\Editor\$version\Editor\Unity.exe" }
if (-not (Test-Path $unity)) { Write-Error "Unity $version not found. Install it with Android Build Support or set UNITY_PATH."; exit 2 }
New-Item -ItemType Directory -Force build | Out-Null
Write-Host "Using $unity -> $method"
$p = Start-Process -FilePath $unity -Wait -PassThru -NoNewWindow -ArgumentList @(
  "-batchmode", "-nographics", "-quit", "-projectPath", "`"$PWD`"", "-buildTarget", "Android",
  "-executeMethod", $method, "-customBuildPath", "build/Android/BREACH-dev.apk", "-logFile", "build/unity-build.log")
Write-Host "---- BREACH lines from build/unity-build.log ----"
Select-String -Path build/unity-build.log -Pattern '\[BREACH\]|error CS|Error:' | Select-Object -Last 60 | ForEach-Object { $_.Line }
if ($p.ExitCode -eq 0) { Write-Host "OK: $(if ($Mode -eq 'validate') {'validation passed'} else {'build/Android/BREACH-dev.apk'})" }
else { Write-Host "FAILED (exit $($p.ExitCode)). Send build/unity-build.log back to the agent." }
exit $p.ExitCode
