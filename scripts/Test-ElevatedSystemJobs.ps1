<#
  Elevated live test of the heavy system jobs on this PC, run by the real SYSTEM service:
    -Phase repairs : DISM CheckHealth (+RestoreHealth only if damage is found), sfc /scannow, chkdsk /scan (online, read-only)
    -Phase dism    : DISM RestoreHealth alone, with a long limit (run after a reboot: a pending reboot stalls component servicing)
    -Phase office  : Microsoft 365 / Office Quick Repair through the real agent (refuses to run while an Office application is open); records Office version before and after
    -Phase drivers : staged driver rollout of the least critical pending driver on this PC (install, health verification), then rollback
    -Phase protect : the safe ransomware, attack-surface and privacy controls through the real agent, then a live rollback of one of them
    -Phase investigate : read-only security investigation of this PC (startup entries, tasks, proxy, DNS, hosts, Defender policy), no changes
    -Phase care : start-up time, backup and heat readings from the real health report, memory analysis and trim, battery diagnosis, then start-up optimization and its rollback
    -Phase updates : Windows Update scan, then install of pending SECURITY updates (never drivers, never an automatic reboot)
  Installs the MSI, enrolls against local Control, runs the jobs, always uninstalls. Log: $Log.
#>
param(
  [ValidateSet('repairs', 'updates', 'dism', 'drivers', 'office', 'protect', 'investigate', 'care', 'quick', 'window')][string]$Phase = 'repairs',
  [string]$Log = "$env:TEMP\viro-elevated-$Phase.log",
  [string]$Server = 'http://localhost:8080',
  [string]$Msi = 'C:\breach ar\dist\ViroAgent-0.1.0.msi',
  [string]$OwnerEmail = 'owner@local.test', [string]$OwnerPassword = 'dev-password-12345'
)
$ErrorActionPreference = 'Continue'
[IO.File]::WriteAllText($Log, '')
function L($m) { Add-Content -Path $Log -Value ("{0:HH:mm:ss} {1}" -f (Get-Date), $m) }
function Api($method, $path, $body, $tok) {
  $h = @{ 'content-type' = 'application/json' }; if ($tok) { $h.authorization = "Bearer $tok" }
  $a = @{ Method = $method; Uri = "$Server$path"; Headers = $h }; if ($null -ne $body) { $a.Body = ($body | ConvertTo-Json -Depth 8) }
  Invoke-RestMethod @a
}
function Svc($n) { Get-CimInstance Win32_Service -Filter "Name='$n'" | Select-Object Name, State, StartName }
function Waiter($what, $seconds, [scriptblock]$cond) { for ($i = 0; $i -lt $seconds; $i += 5) { if (& $cond) { return $true }; Start-Sleep 5 }; L "TIMEOUT waiting for: $what"; return $false }
function PendingReboot { (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') }

try {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  L "elevated=$admin phase=$Phase; reboot pending before: $(PendingReboot)"
  if (-not $admin) { L 'ABORT: not elevated'; return }
  $tok = (Api Post '/api/v1/auth/login' @{ email = $OwnerEmail; password = $OwnerPassword }).token
  $et = (Api Post '/api/v1/enrollment-tokens' @{} $tok).token
  $p = Start-Process msiexec -ArgumentList '/i', "`"$Msi`"", '/qn', "SERVER_URL=$Server", "ENROLL_TOKEN=$et", '/l*v', "`"$env:TEMP\viro-msi-$Phase.log`"" -Wait -PassThru
  L "msiexec exit code: $($p.ExitCode); service: $((Svc 'ViroAgent').State) as $((Svc 'ViroAgent').StartName)"
  $dev = $null
  $null = Waiter 'device online' 150 { $d = (Api Get '/api/v1/devices' $null $tok).devices | Where-Object { $_.status -eq 'online' } | Select-Object -First 1; if ($d) { $script:dev = $d; $true } }
  $devId = $dev.id; L "device online: $($dev.hostname) id=$devId"
  function Job($type, $params) { (Api Post '/api/v1/jobs' @{ type = $type; params = $params; target = @{ deviceIds = @($devId) } } $tok).jobs[0].id }
  function Result($id) { (Api Get "/api/v1/jobs?deviceId=$devId&limit=50" $null $tok).jobs | Where-Object { $_.id -eq $id } }
  function RunOne($label, $type, $params, $maxSeconds) {
    $t0 = Get-Date; $id = Job $type $params
    $null = Waiter "$label to finish" $maxSeconds { (Result $id).status -notin 'queued', 'running' }
    $j = Result $id
    L ("{0,-28} {1,-10} {2:N0}s  {3}{4}" -f $label, $j.status, ((Get-Date) - $t0).TotalSeconds, $j.summary, $(if ($j.error) { "  ERROR: $($j.error)" } else { '' }))
    $j
  }

  if ($Phase -eq 'repairs') {
    $j = RunOne 'repair windows.dism' 'repair.run' @{ recipe = 'windows.dism' } 3600
    $j = RunOne 'repair windows.sfc' 'repair.run' @{ recipe = 'windows.sfc' } 3600
    $j = RunOne 'repair disk.check' 'repair.run' @{ recipe = 'disk.check' } 2700
    L ("repair details (last job): " + ($j.result | ConvertTo-Json -Depth 6 -Compress))
  }
  elseif ($Phase -eq 'protect') {
    L ("Defender before: " + ((Get-MpPreference | Select-Object EnableControlledFolderAccess, PUAProtection, EnableNetworkProtection | ConvertTo-Json -Compress)))
    $recipes = 'protect.ransomware-audit', 'protect.asr-ransomware', 'protect.pua', 'protect.firewall', 'protect.smb1-off', 'protect.llmnr-off', 'protect.ps-logging', 'privacy.telemetry-minimum', 'privacy.advertising-id', 'privacy.activity-history', 'privacy.consumer-features'
    # start the rollback demonstration from a known state: the advertising-ID policy is removed first so the recipe has something to change
    Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AdvertisingInfo' -Name DisabledByGroupPolicy -ErrorAction SilentlyContinue
    $done = @{}; foreach ($r in $recipes) { $done[$r] = RunOne "repair $r" 'repair.run' @{ recipe = $r } 300 }
    L ("Defender after:  " + ((Get-MpPreference | Select-Object EnableControlledFolderAccess, PUAProtection, EnableNetworkProtection | ConvertTo-Json -Compress)))
    $null = RunOne 'health.check' 'health.check' @{} 300
    $ov = Api Get '/api/v1/protection/overview' $null $tok
    L ("protection overview: score=$($ov.score) " + (($ov.controls | ForEach-Object { "$($_.id)=on:$($_.on)/off:$($_.off)/unknown:$($_.unknown)/na:$($_.notApplicable)" }) -join ' '))
    # live rollback of one control, then re-apply it
    $rid = (Api Get "/api/v1/jobs/$($done['privacy.advertising-id'].id)" $null $tok).result.repairId
    L "advertising-id before rollback: $((Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AdvertisingInfo' -ErrorAction SilentlyContinue).DisabledByGroupPolicy); repair id $rid"
    if ($rid) { $null = RunOne 'rollback advertising-id' 'repair.rollback' @{ repairId = $rid } 300
      L "advertising-id after rollback:  $((Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AdvertisingInfo' -ErrorAction SilentlyContinue).DisabledByGroupPolicy)  (blank = value removed)"
      $null = RunOne 'repair privacy.advertising-id (again)' 'repair.run' @{ recipe = 'privacy.advertising-id' } 300 }
  }
  elseif ($Phase -eq 'investigate') {
    $j = RunOne 'security.investigate' 'security.investigate' @{} 300
    $full = Api Get "/api/v1/jobs/$($j.id)" $null $tok
    L ("counts: " + ($full.result.counts | ConvertTo-Json -Compress) + "; suspicious: $($full.result.suspiciousCount); limits: $($full.result.limits)")
    foreach ($x in $full.result.findings) { L ("  [{0}/{1}] {2} '{3}' -> {4} | recipe: {5}" -f $x.severity, $x.confidence, $x.kind, $x.name, $x.evidence, $x.recipe) }
  }
  elseif ($Phase -eq 'care') {
    $null = RunOne 'health.check' 'health.check' @{} 600
    $dv = Api Get "/api/v1/devices/$devId" $null $tok
    L ("health findings: " + (($dv.health.deductions | ForEach-Object { "$($_.code)=$($_.remedy)" }) -join ', '))
    $cr = Api Get "/api/v1/devices/$devId/care" $null $tok
    L ("care: boots=" + ($cr.boots | ConvertTo-Json -Compress) + " bootComparison=" + ($cr.bootComparison | ConvertTo-Json -Compress) + " battery=" + ($cr.battery | ConvertTo-Json -Depth 4 -Compress))
    $j = RunOne 'security.investigate' 'security.investigate' @{} 300
    $full = Api Get "/api/v1/jobs/$($j.id)" $null $tok
    L ("investigate counts: " + ($full.result.counts | ConvertTo-Json -Compress) + "; suspicious: $($full.result.suspiciousCount)")
    foreach ($x in $full.result.findings) { L ("  [{0}/{1}] {2} '{3}' -> {4} | recipe: {5}" -f $x.severity, $x.confidence, $x.kind, $x.name, $x.evidence, $x.recipe) }
    $j = RunOne 'memory.analyze' 'memory.analyze' @{} 300
    $full = Api Get "/api/v1/jobs/$($j.id)" $null $tok
    L ("memory: used $($full.result.plan.usedPercent)% target $($full.result.plan.targetPercent)%; idle trimmable MB: " + (($full.result.plan.trim | Measure-Object -Property mb -Sum).Sum) + "; note: $($full.result.plan.note); session observable: $($full.result.plan.sessionObservable)")
    $j = RunOne 'repair memory.trim-idle' 'repair.run' @{ recipe = 'memory.trim-idle' } 300
    $full = Api Get "/api/v1/jobs/$($j.id)" $null $tok
    L ("trim result: " + ($full.result.after | ConvertTo-Json -Depth 4 -Compress))
    $j = RunOne 'battery.diagnose' 'battery.diagnose' @{} 300
    $full = Api Get "/api/v1/jobs/$($j.id)" $null $tok
    L ("battery: " + ($full.result | ConvertTo-Json -Depth 6 -Compress))
    $j = RunOne 'repair startup.optimize' 'repair.run' @{ recipe = 'startup.optimize' } 300
    $full = Api Get "/api/v1/jobs/$($j.id)" $null $tok
    L ("startup.optimize before: " + ($full.result.before | ConvertTo-Json -Depth 6 -Compress))
    L ("startup.optimize steps: " + (($full.result.steps | ForEach-Object { "$($_.name)=$($_.ok) $($_.detail)" }) -join ' | '))
    if ($full.result.applied -and $full.result.repairId) {
      $null = RunOne 'rollback startup.optimize (leaves your start-up programs as they were)' 'repair.rollback' @{ repairId = $full.result.repairId } 300
    }
  }
  elseif ($Phase -eq 'quick') {
    $t0 = Get-Date; $null = RunOne 'health.check' 'health.check' @{} 900
    L ("health.check wall time: {0:N0}s" -f ((Get-Date) - $t0).TotalSeconds)
    $j = RunOne 'repair memory.trim-idle' 'repair.run' @{ recipe = 'memory.trim-idle' } 300
    $full = Api Get "/api/v1/jobs/$($j.id)" $null $tok
    L ("trim: " + ($full.result.summary) + " | after: " + ($full.result.after | ConvertTo-Json -Depth 5 -Compress))
  }
  elseif ($Phase -eq 'window') {
    $null = RunOne 'health.check' 'health.check' @{} 900
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $exe = 'C:\Program Files\Viro\Agent\viro-agent.exe'
    foreach ($page in 'overview', 'security', 'care', 'updates', 'activity') {
      $p = Start-Process $exe -ArgumentList 'app', '--page', $page -PassThru; Start-Sleep -Seconds 22
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
      $bmp.Save("$env:TEMP\viro-window-$page.png"); L "window page '$page': screenshot saved ($(if ($p.HasExited) { 'window exited early' } else { 'window open' }))"
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
  }
  elseif ($Phase -eq 'dism') {
    $j = RunOne 'repair windows.dism' 'repair.run' @{ recipe = 'windows.dism' } 7500
    L ("details: " + ($j.result | ConvertTo-Json -Depth 6 -Compress))
  }
  elseif ($Phase -eq 'office') {
    $apps = 'outlook', 'winword', 'excel', 'powerpnt', 'onenote', 'msaccess', 'mspub', 'visio'
    $open = Get-Process $apps -ErrorAction SilentlyContinue
    L ("Office before: version " + (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration' -ErrorAction SilentlyContinue).VersionToReport + "; apps open: " + $(if ($open) { ($open | ForEach-Object Name) -join ',' } else { 'none' }))
    $j = RunOne 'repair office.quick-repair' 'repair.run' @{ recipe = 'office.quick-repair' } 3300
    $res = (Api Get "/api/v1/jobs?deviceId=$devId&limit=20" $null $tok).jobs | Where-Object { $_.type -eq 'repair.run' } | Select-Object -First 1
    L ("job result: " + ($res | ConvertTo-Json -Depth 8 -Compress))
    L ("Office after: version " + (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration' -ErrorAction SilentlyContinue).VersionToReport)
  }
  elseif ($Phase -eq 'drivers') {
    $j = RunOne 'updates.scan' 'updates.scan' @{} 1200
    $ov = Api Get '/api/v1/drivers/overview' $null $tok
    L ("pending driver updates: " + (($ov.updates | ForEach-Object { "$($_.model) [$($_.class)] $($_.version)" }) -join ' | '))
    $pick = $ov.updates | Where-Object { $_.model -match 'Card ?Reader' } | Select-Object -First 1
    if (-not $pick) { L 'no card-reader driver pending; not installing anything else automatically'; return }
    L "chosen: $($pick.title)"
    $ro = Api Post '/api/v1/driver-rollouts' @{ updateId = $pick.id; deviceId = $devId } $tok
    L "rollout $($ro.id) started at stage $($ro.stage)"
    $null = Waiter 'test-stage device verified or failed' 2400 { $r = Api Get "/api/v1/driver-rollouts/$($ro.id)" $null $tok; $r.devices | Where-Object { $_.status -in 'verified', 'failed', 'installed' } }
    $r = Api Get "/api/v1/driver-rollouts/$($ro.id)" $null $tok
    L ("rollout status=$($r.status) devices: " + (($r.devices | ForEach-Object { "$($_.hostname) $($_.status) health $($_.health_before)->$($_.health_after) $($_.detail)" }) -join '; '))
    $rb = Api Post "/api/v1/driver-rollouts/$($ro.id)/rollback" @{} $tok
    L ("rollback: queued=$($rb.rollbackQueued) couldNotDetermine=$($rb.couldNotDetermine)")
    $null = Waiter 'rollback job finished' 900 { -not ((Api Get "/api/v1/jobs?deviceId=$devId&limit=20" $null $tok).jobs | Where-Object { $_.type -eq 'driver.rollback' -and $_.status -in 'queued', 'running' }) }
    foreach ($x in ((Api Get "/api/v1/jobs?deviceId=$devId&limit=20" $null $tok).jobs | Where-Object { $_.type -in 'driver.install', 'driver.rollback' })) { L ("  {0,-16} {1,-10} {2}{3}" -f $x.type, $x.status, $x.summary, $(if ($x.error) { " ERROR: $($x.error)" } else { '' })) }
  }
  else {
    $j = RunOne 'updates.scan' 'updates.scan' @{} 1500
    $ov = Api Get '/api/v1/updates/overview' $null $tok
    L ("Windows Update says: " + $ov.pendingTotal + " software update(s) pending, " + $ov.pendingSecurity + " security: " + (($ov.topUpdates | ForEach-Object { "$($_.title) [$($_.kb)]" }) -join ' | '))
    # Install a small, real selection: the security updates if any, otherwise up to two other pending software updates (never drivers).
    $ids = @($ov.topUpdates | Where-Object { $_.security } | Select-Object -First 3 | ForEach-Object id)
    if (-not $ids.Count) { $ids = @($ov.topUpdates | Select-Object -First 2 | ForEach-Object id) }
    if (-not $ids.Count) { L 'nothing pending: there is no update package to install on this PC right now'; return }
    L ("installing: " + (($ov.topUpdates | Where-Object { $ids -contains $_.id } | ForEach-Object { $_.title }) -join ' | '))
    $j = RunOne 'updates.install' 'updates.install' @{ scope = 'all'; updateIds = $ids } 7200
    $inst = (Api Get "/api/v1/jobs?deviceId=$devId&limit=20" $null $tok).jobs | Where-Object { $_.type -eq 'updates.install' } | Select-Object -First 1
    L ("install job: status=$($inst.status) summary=$($inst.summary) error=$($inst.error)")
    L "reboot pending after: $(PendingReboot)"
    # verify with a fresh scan: the installed updates must no longer be pending
    $j = RunOne 'updates.scan (verify)' 'updates.scan' @{} 1500
    $ov2 = Api Get '/api/v1/updates/overview' $null $tok
    $still = @($ov2.topUpdates | Where-Object { $ids -contains $_.id })
    L ("after install: " + $ov2.pendingTotal + " pending; of the installed ones still pending: " + $still.Count)
  }
}
catch { L "SCRIPT ERROR: $($_ | Out-String)" }
finally {
  try { $dst = "$env:TEMP\viro-agent-logs-$Phase"; New-Item -ItemType Directory -Force $dst | Out-Null; Copy-Item 'C:\ProgramData\Viro\Agent\logs\*.log' $dst -Force -ErrorAction SilentlyContinue; L "agent logs kept in $dst" } catch { }
  $p = Start-Process msiexec -ArgumentList '/x', "`"$Msi`"", '/qn' -Wait -PassThru
  L "uninstall exit $($p.ExitCode); service: $(if (Svc 'ViroAgent') { 'STILL PRESENT' } else { 'removed' })"
  L 'DONE'
}
