<#
  End-to-end test of the REAL product on a real Windows PC, run elevated (UAC prompt):
    MSI install -> services -> jobs as SYSTEM -> crash recovery -> compute worker -> signed self-update -> forced-rollback update -> uninstall.
  Needs: Viro Control running at $Server (dev keys), dist\ViroAgent-*.msi, dist\e2e\agent-0.1.1.zip and agent-0.1.2.zip (see docs/RELEASING.md).
  Always uninstalls at the end. Writes a step log to $Log.
#>
param(
  [string]$Log = "$env:TEMP\viro-elevated.log",
  [string]$Server = 'http://localhost:8080',
  [string]$Msi = 'C:\breach ar\dist\ViroAgent-0.1.0.msi',
  [string]$Artifacts = 'C:\breach ar\dist\e2e',
  [string]$OwnerEmail = 'owner@local.test', [string]$OwnerPassword = 'dev-password-12345', [string]$PlatformKey = 'dev-platform-key'
)
$ErrorActionPreference = 'Continue'
[IO.File]::WriteAllText($Log, '')
function L($m) { Add-Content -Path $Log -Value ("{0:HH:mm:ss} {1}" -f (Get-Date), $m) }
function Api($method, $path, $body, $tok, $pk) {
  $h = @{ 'content-type' = 'application/json' }; if ($tok) { $h.authorization = "Bearer $tok" }; if ($pk) { $h['x-platform-key'] = $pk }
  $a = @{ Method = $method; Uri = "$Server$path"; Headers = $h }; if ($null -ne $body) { $a.Body = ($body | ConvertTo-Json -Depth 8) }
  Invoke-RestMethod @a
}
function Svc($n) { Get-CimInstance Win32_Service -Filter "Name='$n'" | Select-Object Name, State, StartMode, StartName, ProcessId, PathName }
function Waiter($what, $seconds, [scriptblock]$cond) { for ($i = 0; $i -lt $seconds; $i += 3) { if (& $cond) { return $true }; Start-Sleep 3 }; L "TIMEOUT waiting for: $what"; return $false }

try {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  L "elevated=$admin user=$env:USERNAME os=$([Environment]::OSVersion.Version)"
  if (-not $admin) { L 'ABORT: not elevated'; return }
  $tok = (Api Post '/api/v1/auth/login' @{ email = $OwnerEmail; password = $OwnerPassword }).token
  $et = (Api Post '/api/v1/enrollment-tokens' @{} $tok).token

  L '=== 1. MSI install (agent + compute worker)'
  $p = Start-Process msiexec -ArgumentList '/i', "`"$Msi`"", '/qn', "SERVER_URL=$Server", "ENROLL_TOKEN=$et", 'INSTALL_COMPUTE=1', '/l*v', "`"$env:TEMP\viro-msi.log`"" -Wait -PassThru
  L "msiexec exit code: $($p.ExitCode)"
  foreach ($s in 'ViroAgent', 'ViroCompute') { $x = Svc $s; L ("service {0}: {1}" -f $s, ($x | Format-List | Out-String).Replace("`r`n", ' | ')) }
  L ("install dir: " + ((Get-ChildItem 'C:\Program Files\Viro\Agent' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name) $([int]($_.Length/1MB))MB" }) -join ', '))
  $acl = (Get-Acl 'C:\ProgramData\Viro\Agent').Access | ForEach-Object { "$($_.IdentityReference):$($_.FileSystemRights)" }
  L "data dir ACL: $($acl -join '; ')"
  L ("agent status: " + ((& 'C:\Program Files\Viro\Agent\viro-agent.exe' status) -join ' ').Replace('  ', ' '))
  $dev = $null
  $null = Waiter 'device online' 120 { $d = (Api Get '/api/v1/devices' $null $tok).devices | Where-Object { $_.status -eq 'online' } | Select-Object -First 1; if ($d) { $script:dev = $d; $true } }
  $devId = $dev.id; L "device online: $($dev.hostname) agent=$($dev.agent_version) id=$devId"

  L '=== 2. jobs executed by the service as SYSTEM'
  function Job($type, $params) { (Api Post '/api/v1/jobs' @{ type = $type; params = $params; target = @{ deviceIds = @($devId) } } $tok).jobs[0].id }
  $safe = @('windows-temp', 'crash-dumps', 'update-leftovers')
  $jobs = [ordered]@{
    'health.check' = @{}; 'security.status' = @{}; 'hardware.diagnose' = @{}; 'updates.scan' = @{}; 'cleanup.preview' = @{}; 'software.check-updates' = @{};
    'message.send' = @{ text = 'Viro end-to-end test: this message was delivered by the SYSTEM service.'; seconds = 8 };
  }
  $ids = @{}
  foreach ($k in $jobs.Keys) { $ids[$k] = Job $k $jobs[$k] }
  $ids['repair:dns.flush'] = Job 'repair.run' @{ recipe = 'dns.flush' }
  $ids['repair:services.restart-failed'] = Job 'repair.run' @{ recipe = 'services.restart-failed' }
  $ids['service.restart:Spooler'] = Job 'service.restart' @{ name = 'Spooler' }
  $ids['cleanup.run(safe system junk)'] = Job 'cleanup.run' @{ categories = $safe }
  $ids['security.scan quick'] = Job 'security.scan' @{ scanType = 'quick' }
  $ids['security.update-signatures'] = Job 'security.update-signatures' @{}
  $null = Waiter 'jobs finished' 600 { -not ((Api Get "/api/v1/jobs?deviceId=$devId&limit=50" $null $tok).jobs | Where-Object { $_.status -in 'queued', 'running' }) }
  $all = (Api Get "/api/v1/jobs?deviceId=$devId&limit=50" $null $tok).jobs
  foreach ($k in $ids.Keys) { $j = $all | Where-Object { $_.id -eq $ids[$k] }; L ("  {0,-34} {1,-10} {2}{3}" -f $k, $j.status, $j.summary, $(if ($j.error) { " ERROR: $($j.error)" } else { '' })) }
  $hw = (Api Get "/api/v1/devices/$devId" $null $tok).hardwareDiagnosis
  L ("hardware diagnosis as SYSTEM: verdict=$($hw.verdict); could not read: " + (($hw.unavailable | ForEach-Object { $_.component }) -join ', '))
  $sec = (Api Get "/api/v1/devices/$devId" $null $tok).health.shield
  L ("Viro Shield: state=$($sec.state) engine=$($sec.engine); posture: " + (($sec.posture | ForEach-Object { "$($_.label)=$($_.ok)" }) -join '; '))

  L '=== 3. crash recovery (kill the agent process; the service manager must restart it)'
  $before = (Svc 'ViroAgent').ProcessId; Stop-Process -Id $before -Force
  $null = Waiter 'agent restarted' 60 { $s = Svc 'ViroAgent'; $s.State -eq 'Running' -and $s.ProcessId -ne $before -and $s.ProcessId -gt 0 }
  $s = Svc 'ViroAgent'; L "agent pid $before -> $($s.ProcessId), state $($s.State)"

  L '=== 4. compute worker service'
  $pol = @{ scope = @{ type = 'org' }; settings = @{ enabled = $true; maxCpuPercent = 10; startAfterIdleMinutes = 1; maxTempC = 90; allowOnBattery = $true; fallback = 'selftest'; pauseOnFullscreen = $false } }
  $org = (Api Get '/api/v1/me' $null $tok).organization.id
  $null = Api Patch "/api/v1/platform/organizations/$org/plan" @{ plan = 'compute_sponsored' } $null $PlatformKey
  $null = Api Put '/api/v1/compute/policy' $pol $tok
  $null = Waiter 'compute worker reporting' 150 { $o = Api Get '/api/v1/compute/overview' $null $tok; $o.devices[0].state -and $o.devices[0].status -ne 'offline' }
  $o = Api Get '/api/v1/compute/overview' $null $tok; L ("compute: status=$($o.devices[0].status) state=$($o.devices[0].state) reason=$($o.devices[0].reason); eligible=$($o.eligible)")
  $comp = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'viro-compute.*(burn|user-probe)' } | ForEach-Object { $_.CommandLine -replace '.*\\viro-compute.exe"?\s*', '' }
  L "compute child processes: $($comp -join ' | ')"
  $null = Api Put '/api/v1/compute/policy' @{ scope = @{ type = 'org' }; settings = @{ enabled = $false } } $tok

  L '=== 5. signed self-update 0.1.0 -> 0.1.1 (real service swap)'
  function Upload($ver) {
    $zip = Join-Path $Artifacts "agent-$ver.zip"; $hash = (Get-FileHash (Join-Path $Artifacts "v0$($ver.Replace('.','').Substring(1))\viro-agent.exe") -Algorithm SHA256).Hash.ToLower()
    $r = Invoke-RestMethod -Method Post -Uri "$Server/api/v1/platform/releases?version=$ver&exeSha256=$hash" -Headers @{ 'x-platform-key' = $PlatformKey } -ContentType 'application/octet-stream' -InFile $zip
    L "uploaded release $ver (package sha $($r.sha256.Substring(0,12))...)"
  }
  Upload '0.1.1'
  $null = Api Patch '/api/v1/platform/releases/0.1.1' @{ status = 'active'; stage = 'internal' } $null $PlatformKey
  $null = Api Patch "/api/v1/devices/$devId" @{ updateRing = 'internal' } $tok
  $ok = Waiter 'agent to become 0.1.1' 240 { (Api Get "/api/v1/devices/$devId" $null $tok).agent_version -eq '0.1.1' }
  Start-Sleep 5
  $d = Api Get "/api/v1/devices/$devId" $null $tok; L "device now reports agent $($d.agent_version); service: $((Svc 'ViroAgent').State); file version: $((& 'C:\Program Files\Viro\Agent\viro-agent.exe' version))"
  L ("update log: " + ((Get-Content 'C:\ProgramData\Viro\Agent\logs\update.log' -ErrorAction SilentlyContinue) -join ' | '))
  L ("releases: " + ((Api Get '/api/v1/platform/releases' $null $null $PlatformKey).releases | ForEach-Object { "$($_.version) $($_.status)/$($_.stage) updated=$($_.updated) failed=$($_.failed)" }) -join '; ')

  L '=== 6. broken update 0.1.2 (passes the version check, never confirms): the agent must roll itself back'
  Upload '0.1.2'
  $null = Api Patch '/api/v1/platform/releases/0.1.2' @{ status = 'active'; stage = 'internal' } $null $PlatformKey
  $null = Waiter 'rollback reported to Control' 420 { (Api Get '/api/v1/platform/releases' $null $null $PlatformKey).releases | Where-Object { $_.version -eq '0.1.2' -and $_.failed -ge 1 } }
  Start-Sleep 5
  $d = Api Get "/api/v1/devices/$devId" $null $tok
  L "after forced rollback: device reports $($d.agent_version); installed exe reports $((& 'C:\Program Files\Viro\Agent\viro-agent.exe' version)); service $((Svc 'ViroAgent').State)"
  L ("update log: " + ((Get-Content 'C:\ProgramData\Viro\Agent\logs\update.log' -ErrorAction SilentlyContinue | Select-Object -Last 6) -join ' | '))
  L ("releases: " + ((Api Get '/api/v1/platform/releases' $null $null $PlatformKey).releases | ForEach-Object { "$($_.version) $($_.status)/$($_.stage) updated=$($_.updated) failed=$($_.failed)" }) -join '; ')
  $null = Api Patch '/api/v1/platform/releases/0.1.2' @{ status = 'halted' } $null $PlatformKey
  $null = Api Patch '/api/v1/platform/releases/0.1.1' @{ status = 'halted' } $null $PlatformKey

  L '=== 7. integrity + audit as seen by Control'
  $alerts = (Api Get '/api/v1/alerts?status=open' $null $tok).alerts | ForEach-Object { "$($_.severity):$($_.code)" }
  L "open alerts: $($alerts -join ', ')"
}
catch { L "SCRIPT ERROR: $($_ | Out-String)" }
finally {
  L '=== 8. uninstall'
  $p = Start-Process msiexec -ArgumentList '/x', "`"$Msi`"", '/qn', '/l*v', "`"$env:TEMP\viro-msi-uninstall.log`"" -Wait -PassThru
  L "msiexec /x exit code: $($p.ExitCode)"
  Start-Sleep 3
  foreach ($s in 'ViroAgent', 'ViroCompute') { L ("service {0} after uninstall: {1}" -f $s, $(if (Svc $s) { 'STILL PRESENT' } else { 'removed' })) }
  L ("install dir after uninstall: " + $(if (Test-Path 'C:\Program Files\Viro\Agent') { 'STILL PRESENT: ' + ((Get-ChildItem 'C:\Program Files\Viro\Agent' | ForEach-Object Name) -join ',') } else { 'removed' }))
  try { $tok2 = (Api Post '/api/v1/auth/login' @{ email = $OwnerEmail; password = $OwnerPassword }).token; $bye = ((Api Get '/api/v1/audit/search?action=device.uninstalled' $null $tok2).entries | Select-Object -First 1); L "Control was told about the uninstall: $([bool]$bye)" } catch { L "could not query Control: $_" }
  L 'DONE'
}
