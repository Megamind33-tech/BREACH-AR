<#
  Publishes the built MSI to a Viro Control server so administrators can download their one-file installer from the console
  ("Add computers"). Run after Build-Installer.ps1.
    .\scripts\Publish-Installer.ps1 -Server https://control.example.com -PlatformKey <key> [-Msi dist\ViroAgent-0.1.0.msi]
#>
param([Parameter(Mandatory)][string]$Server, [Parameter(Mandatory)][string]$PlatformKey, [string]$Msi)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $Msi) { $Msi = (Get-ChildItem (Join-Path $root 'dist\ViroAgent-*.msi') | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName }
if (-not $Msi -or -not (Test-Path $Msi)) { throw 'No MSI found; run scripts\Build-Installer.ps1 first.' }
$r = Invoke-RestMethod -Method Put -Uri "$($Server.TrimEnd('/'))/api/v1/platform/installer" -Headers @{ 'x-platform-key' = $PlatformKey } -ContentType 'application/octet-stream' -InFile $Msi
Write-Host "Published $(Split-Path $Msi -Leaf): $([int]($r.size / 1MB)) MB, sha256 $($r.sha256)"
