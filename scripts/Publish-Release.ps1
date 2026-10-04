<#
  Publishes an agent release to Viro Control for staged rollout.
    1. zips dist\viro-agent.exe (the signed executable produced by Build-Installer.ps1)
    2. uploads the package with the SHA-256 of the executable inside it; Control signs the manifest with its release key
    3. the release starts as a DRAFT. Activate and advance it stage by stage (each step is a separate command):
         Set-Stage -Version 0.2.0 -Status active            # internal ring only
         Set-Stage -Version 0.2.0 -Stage pilot
         Set-Stage -Version 0.2.0 -Stage 10 ; -Stage 50 ; -Stage 100
       Watch failures between steps; Control halts a release by itself when devices fail to update or roll back.
  Usage:  .\Publish-Release.ps1 -Server https://control.example.com -PlatformKey $env:VIRO_PLATFORM_KEY -Version 0.2.0
#>
param([Parameter(Mandatory)][string]$Server, [Parameter(Mandatory)][string]$PlatformKey, [Parameter(Mandatory)][string]$Version, [string]$Notes = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $root 'dist\viro-agent.exe'
if (-not (Test-Path $exe)) { throw 'dist\viro-agent.exe not found; run Build-Installer.ps1 first' }
$sig = Get-AuthenticodeSignature $exe
if ($sig.Status -eq 'NotSigned') { Write-Warning 'viro-agent.exe is not code-signed. Production releases must be signed.' }
$actual = (& $exe version).Trim()
if ($actual -ne $Version) { throw "the executable reports version $actual, not $Version" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) "viro-release-$Version.zip"
if (Test-Path $tmp) { [IO.File]::Delete($tmp) }
$cexe = Join-Path $root 'dist\viro-compute.exe'
$paths = @($exe); $cq = ''
if (Test-Path $cexe) { $paths += $cexe; $cq = "&computeExeSha256=$((Get-FileHash $cexe -Algorithm SHA256).Hash.ToLower())" }   # the compute worker travels in the same package so it updates with the agent
Compress-Archive -Path $paths -DestinationPath $tmp
$exeHash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
$qs = "version=$Version&exeSha256=$exeHash$cq" + $(if ($Notes) { "&notes=" + [uri]::EscapeDataString($Notes) } else { '' })
$r = Invoke-RestMethod -Method Post -Uri "$Server/api/v1/platform/releases?$qs" -Headers @{ 'x-platform-key' = $PlatformKey } -ContentType 'application/octet-stream' -InFile $tmp
Write-Host "Uploaded ${Version}: package sha256 $($r.sha256), status $($r.status), stage $($r.stage)"

function Set-Stage {
  param([string]$Version, [ValidateSet('active', 'halted')][string]$Status, [ValidateSet('internal', 'pilot', '10', '50', '100')][string]$Stage)
  $body = @{}; if ($Status) { $body.status = $Status }; if ($Stage) { $body.stage = $Stage }
  Invoke-RestMethod -Method Patch -Uri "$Server/api/v1/platform/releases/$Version" -Headers @{ 'x-platform-key' = $PlatformKey } -ContentType 'application/json' -Body ($body | ConvertTo-Json)
}
Write-Host "Next: Set-Stage -Version $Version -Status active   (then advance the stage while watching /api/v1/platform/releases)"

