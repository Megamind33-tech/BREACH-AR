<#
  Builds the distributable Viro software: self-contained single-file agent and compute worker -> (signed) -> MSI -> (signed) + SHA-256 manifest.
    -Sign            sign with the certificate in -CertThumbprint (default: the dev certificate; production must use a CA-issued certificate)
    -Timestamp       RFC3161 timestamp server URL (recommended for production)
  Output: dist\viro-agent.exe, dist\viro-compute.exe, dist\ViroAgent-<version>.msi, dist\SHA256SUMS.txt
#>
param([switch]$Sign, [string]$CertThumbprint, [string]$Timestamp)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$agent = Join-Path $root 'agent'
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null

$version = ([xml](Get-Content (Join-Path $agent 'src\Viro.Agent\Viro.Agent.csproj'))).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
Write-Host "Building Viro $version"

function Publish($proj, $out) {
  dotnet publish (Join-Path $agent "src\$proj") -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -p:DebugType=none -p:Version=$version -o $out | Out-Null
  if ($LASTEXITCODE) { throw "publish of $proj failed" }
}
$agentPub = Join-Path $agent 'publish\agent-win-x64';  Publish 'Viro.Agent' $agentPub
$compPub  = Join-Path $agent 'publish\compute-win-x64'; Publish 'Viro.Compute' $compPub
$exe = Join-Path $agentPub 'viro-agent.exe'; $cexe = Join-Path $compPub 'viro-compute.exe'

function Sign-File($path) {
  if (-not $Sign) { return }
  if (-not $script:CertThumbprint) { $script:CertThumbprint = & (Join-Path $PSScriptRoot 'New-DevCodeSigningCert.ps1') }
  $cert = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My -ErrorAction SilentlyContinue | Where-Object Thumbprint -eq $script:CertThumbprint | Select-Object -First 1
  if (-not $cert) { throw "certificate $script:CertThumbprint not found" }
  $a = @{ FilePath = $path; Certificate = $cert; HashAlgorithm = 'SHA256' }
  if ($Timestamp) { $a.TimestampServer = $Timestamp }
  $r = Set-AuthenticodeSignature @a
  if ($r.Status -notin 'Valid', 'UnknownError') { throw "signing $path failed: $($r.StatusMessage)" }
  Write-Host "signed $(Split-Path $path -Leaf) [$($r.Status)]"
}
Sign-File $exe; Sign-File $cexe
Copy-Item $exe (Join-Path $dist 'viro-agent.exe') -Force
Copy-Item $cexe (Join-Path $dist 'viro-compute.exe') -Force

$msi = Join-Path $dist "ViroAgent-$version.msi"
wix build (Join-Path $agent 'installer\Package.wxs') -d Version=$version -d AgentExe=$exe -d ComputeExe=$cexe -arch x64 -o $msi
if ($LASTEXITCODE) { throw 'wix build failed' }
Sign-File $msi

Get-ChildItem $dist -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' -and $_.Extension -ne '.wixpdb' } | ForEach-Object { "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower())  $($_.Name)" } | Set-Content (Join-Path $dist 'SHA256SUMS.txt')
Get-Content (Join-Path $dist 'SHA256SUMS.txt')
