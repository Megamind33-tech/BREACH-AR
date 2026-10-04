using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Viro.Agent.Repair;

namespace Viro.Agent;

public sealed record UpdateOffer(string Version, string Url, string Manifest, string Signature, string Sha256, long Size);
public sealed record UpdateResultReport(string Version, string Status, string? Detail);

public sealed class SelfUpdateState
{
    public string? PendingVersion { get; set; }
    public string? PreviousVersion { get; set; }
    public DateTime? LastAttemptUtc { get; set; }
    /// <summary>Versions whose update failed at least once. No longer a permanent ban (see <see cref="SelfUpdater.WantsToUpdate"/>): kept for reports and for state files written by older agents.</summary>
    public List<string> Blocked { get; set; } = [];
    /// <summary>How many times each version failed to apply or had to roll back; drives the retry back-off.</summary>
    public Dictionary<string, int> FailCounts { get; set; } = [];
    public UpdateResultReport? LastResult { get; set; }
}

public sealed class UpdateRejectedException(string message) : Exception(message);

/// <summary>
/// Secure self-update. An update is only ever applied when: the manifest is signed by the pinned server key, the package hash and size
/// match the manifest, the extracted executable's hash matches the signed manifest, and the new executable reports the expected version.
/// The swap is done by a detached script that restores the previous executable if the new agent does not confirm itself within two minutes.
/// </summary>
public sealed partial class SelfUpdater
{
    public const string UpdateTask = "ViroAgentUpdate";
    const long MaxPackageBytes = 300L * 1024 * 1024;
    static readonly TimeSpan RetryAfterFailure = TimeSpan.FromMinutes(30);
    static readonly TimeSpan MaxBackoff = TimeSpan.FromHours(24);
    /// <summary>A version that has failed this many times stops being retried (a genuinely bad build); a newer version is always tried.</summary>
    public const int MaxFailuresPerVersion = 5;
    /// <summary>How long the new agent has to confirm itself before the swap is undone. Generous on purpose: a slow PC or a virus scan of a new file can take minutes.</summary>
    public const int ConfirmSeconds = 300;
    /// <summary>The compute worker executable inside the package, when this release includes one.</summary>
    public string? StagedComputePath { get; private set; }
    readonly string _dataDir, _installDir, _current;
    readonly ECDsa _key;
    readonly IProcessRunner _proc;
    readonly Func<DateTime> _now;
    SelfUpdateState _state;
    string StatePath => Path.Combine(_dataDir, "update-state.json");
    string ConfirmPath => Path.Combine(_dataDir, "update-confirmed.txt");
    string RollbackPath => Path.Combine(_dataDir, "update-rolled-back.json");

    public SelfUpdater(string dataDir, string installDir, string currentVersion, string publicKeySpkiBase64, IProcessRunner? proc = null, Func<DateTime>? now = null)
    {
        (_dataDir, _installDir, _current) = (dataDir, installDir, currentVersion);
        _key = ECDsa.Create(); _key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(publicKeySpkiBase64), out _);
        _proc = proc ?? new SystemProcessRunner(); _now = now ?? (() => DateTime.UtcNow);
        _state = Load();
    }

    public SelfUpdateState State => _state;
    SelfUpdateState Load() { try { return JsonSerializer.Deserialize<SelfUpdateState>(File.ReadAllText(StatePath)) ?? new(); } catch { return new(); } }
    void Save() { Directory.CreateDirectory(_dataDir); var t = StatePath + ".tmp"; File.WriteAllText(t, JsonSerializer.Serialize(_state)); File.Move(t, StatePath, true); }

    public static int CompareVersions(string a, string b)
    {
        var x = a.Split('.').Select(int.Parse).ToArray(); var y = b.Split('.').Select(int.Parse).ToArray();
        for (var i = 0; i < Math.Max(x.Length, y.Length); i++) { var p = i < x.Length ? x[i] : 0; var q = i < y.Length ? y[i] : 0; if (p != q) return p < q ? -1 : 1; }
        return 0;
    }

    /// <summary>Run at process start: learn how the previous update attempt ended.</summary>
    public void RecoverOnStartup()
    {
        if (File.Exists(RollbackPath))
        {
            try
            {
                using var d = JsonDocument.Parse(File.ReadAllText(RollbackPath));
                var v = d.RootElement.GetProperty("version").GetString()!; var why = d.RootElement.TryGetProperty("reason", out var r) ? r.GetString() : null;
                _state.LastResult = new(v, "rolled_back", why); RecordFailure(v);
                _state.PendingVersion = null;
            }
            catch { /* unreadable marker: ignore */ }
            File.Delete(RollbackPath); Save();
        }
        else if (_state.PendingVersion is not null && _state.PendingVersion != _current && !File.Exists(ConfirmPath))
        {
            // The service restarted but is not the version we tried to install and nobody confirmed: treat as failed.
            _state.LastResult = new(_state.PendingVersion, "failed", "the update did not take effect"); RecordFailure(_state.PendingVersion); _state.PendingVersion = null; Save();
        }
    }

    void RecordFailure(string version)
    {
        _state.FailCounts[version] = FailuresOf(version) + 1;
        if (!_state.Blocked.Contains(version)) _state.Blocked.Add(version);
    }

    /// <summary>Failures recorded for a version. A state file from an older agent only has the Blocked list: that counts as one failure.</summary>
    int FailuresOf(string version) => _state.FailCounts.TryGetValue(version, out var n) ? n : _state.Blocked.Contains(version) ? 1 : 0;

    /// <summary>
    /// Whether to start this update now. A failed version is NOT banned for ever (a transient problem such as a locked file or a slow PC must not strand a computer
    /// on an old version): it is retried after a growing wait (30 min, 1 h, 2 h ... at most a day) and only abandoned after <see cref="MaxFailuresPerVersion"/> failures,
    /// when a newer version is still tried straight away. Control halts a release that fails across the fleet.
    /// </summary>
    public bool WantsToUpdate(UpdateOffer o)
    {
        if (CompareVersions(o.Version, _current) <= 0 || _state.PendingVersion is not null) return false;
        var fails = FailuresOf(o.Version);
        if (fails >= MaxFailuresPerVersion) return false;
        if (_state.LastAttemptUtc is null) return true;
        var wait = fails == 0 ? RetryAfterFailure : TimeSpan.FromTicks(Math.Min(MaxBackoff.Ticks, RetryAfterFailure.Ticks * (1L << Math.Min(fails, 6))));
        return _now() - _state.LastAttemptUtc > wait;
    }

    /// <summary>Verify, download, extract and smoke-test. Returns the staged executable path. Throws <see cref="UpdateRejectedException"/> on anything suspicious.</summary>
    public async Task<string> PrepareAsync(UpdateOffer o, Func<Stream, Task> download, CancellationToken ct)
    {
        _state.LastAttemptUtc = _now(); Save();
        if (!Version().IsMatch(o.Version)) throw new UpdateRejectedException("offer has an invalid version");
        bool sigOk; try { sigOk = _key.VerifyData(Encoding.UTF8.GetBytes(o.Manifest), Convert.FromBase64String(o.Signature), HashAlgorithmName.SHA256); } catch (FormatException) { sigOk = false; }
        if (!sigOk) throw new UpdateRejectedException("manifest signature verification failed");
        using var m = JsonDocument.Parse(o.Manifest); var root = m.RootElement;
        if (root.GetProperty("component").GetString() != "agent" || root.GetProperty("version").GetString() != o.Version) throw new UpdateRejectedException("manifest does not describe the offered version");
        var sha = root.GetProperty("sha256").GetString()!.ToLowerInvariant(); var size = root.GetProperty("size").GetInt64(); var exeSha = root.GetProperty("exeSha256").GetString()!.ToLowerInvariant();
        if (size <= 0 || size > MaxPackageBytes) throw new UpdateRejectedException("package size is out of bounds");

        var dir = Path.Combine(_dataDir, "updates", o.Version);
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        Directory.CreateDirectory(dir);
        var zip = Path.Combine(dir, "package.zip");
        await using (var fs = new FileStream(zip, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            await download(new LimitedStream(fs, size));
        }
        var info = new FileInfo(zip);
        if (info.Length != size) throw new UpdateRejectedException($"downloaded {info.Length} bytes, manifest says {size}");
        await using (var rs = File.OpenRead(zip)) if (!Convert.ToHexString(await SHA256.HashDataAsync(rs, ct)).Equals(sha, StringComparison.OrdinalIgnoreCase)) throw new UpdateRejectedException("package hash does not match the signed manifest");

        var stage = Path.Combine(dir, "new");
        try
        {
            using var arc = ZipFile.OpenRead(zip);
            if (arc.Entries.Count > 50 || arc.Entries.Sum(e => e.Length) > 400L * 1024 * 1024) throw new UpdateRejectedException("package contents are out of bounds");
            ZipFile.ExtractToDirectory(zip, stage, overwriteFiles: true);   // entries that escape the folder make this throw
        }
        catch (Exception e) when (e is InvalidDataException or IOException or UnauthorizedAccessException) { throw new UpdateRejectedException("package could not be extracted safely: " + e.Message); }
        var exe = Path.Combine(stage, "viro-agent.exe");
        if (!File.Exists(exe)) throw new UpdateRejectedException("package does not contain viro-agent.exe");
        await using (var es = File.OpenRead(exe)) if (!Convert.ToHexString(await SHA256.HashDataAsync(es, ct)).Equals(exeSha, StringComparison.OrdinalIgnoreCase)) throw new UpdateRejectedException("executable hash does not match the signed manifest");
        var smoke = await _proc.RunAsync(exe, "version", TimeSpan.FromSeconds(30), ct);
        if (smoke.ExitCode != 0 || smoke.Output.Trim() != o.Version) throw new UpdateRejectedException($"new executable reported version \"{smoke.Output.Trim()}\", expected {o.Version}");
        // The compute worker is a separate program: when the signed manifest names one, it is verified the same way and replaced in the same swap, so it never falls behind.
        StagedComputePath = null;
        if (root.TryGetProperty("computeExeSha256", out var cs) && cs.ValueKind == JsonValueKind.String)
        {
            var compute = Path.Combine(stage, "viro-compute.exe");
            if (!File.Exists(compute)) throw new UpdateRejectedException("the manifest lists viro-compute.exe but the package does not contain it");
            await using (var cstream = File.OpenRead(compute)) if (!Convert.ToHexString(await SHA256.HashDataAsync(cstream, ct)).Equals(cs.GetString()!.ToLowerInvariant(), StringComparison.OrdinalIgnoreCase)) throw new UpdateRejectedException("compute worker hash does not match the signed manifest");
            StagedComputePath = compute;
        }
        return exe;
    }

    /// <summary>Records the pending update and starts the detached swap-and-verify script.</summary>
    public async Task ApplyAsync(string stagedExe, string version, string serviceName, CancellationToken ct)
    {
        _state.PendingVersion = version; _state.PreviousVersion = _current; Save();
        if (File.Exists(ConfirmPath)) File.Delete(ConfirmPath);
        var script = BuildScript(serviceName, _installDir, stagedExe, version, _dataDir, StagedComputePath);
        var path = Path.Combine(_dataDir, "apply-update.ps1"); File.WriteAllText(path, script, new UTF8Encoding(true));
        // Not a child of this service: stopping the service must not be able to take the swap script down with it.
        // Task Scheduler runs it as SYSTEM in its own process tree; the script deletes the task when it finishes.
        var create = await _proc.RunAsync("schtasks.exe", $"/create /tn {UpdateTask} /tr \"powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\\"{path}\\\"\" /sc once /st 23:59 /ru SYSTEM /rl HIGHEST /f", TimeSpan.FromSeconds(30), ct);
        if (create.ExitCode != 0) throw new UpdateRejectedException("could not schedule the update task: " + create.Output.Trim());
        // A task made this way will not start on a laptop that is running on battery (Windows default), which left updates queued for ever. Allow battery, no time limit.
        try { await _proc.RunAsync("powershell.exe", $"-NoProfile -ExecutionPolicy Bypass -Command \"Set-ScheduledTask -TaskName {UpdateTask} -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0)) | Out-Null\"", TimeSpan.FromSeconds(30), ct); } catch (Exception) { /* the defaults still work on a desktop */ }
        var run = await _proc.RunAsync("schtasks.exe", $"/run /tn {UpdateTask}", TimeSpan.FromSeconds(30), ct);
        if (run.ExitCode != 0) throw new UpdateRejectedException("could not start the update task: " + run.Output.Trim());
    }

    /// <summary>Called after the first successful heartbeat of a freshly started agent.</summary>
    public void ConfirmIfPending()
    {
        if (_state.PendingVersion != _current) return;
        File.WriteAllText(ConfirmPath, _current);
        _state.LastResult = new(_current, "ok", $"updated from {_state.PreviousVersion}"); _state.PendingVersion = null;
        _state.LastAttemptUtc = null;   // the retry back-off is for failures; a success must not delay the next release
        Save();
    }

    public UpdateResultReport? TakeResult() => _state.LastResult;
    public void AckResult() { if (_state.LastResult is null) return; _state.LastResult = null; Save(); }

    [GeneratedRegex(@"^\d+\.\d+\.\d+$")] private static partial Regex Version();
    [GeneratedRegex(@"^[A-Za-z]:\\[^'""`$;&|<>\r\n%]+$")] private static partial Regex SafePath();
    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,40}$")] private static partial Regex SafeName();

    /// <summary>The swap script. Only validated values are interpolated: a version, a service name and absolute paths without shell metacharacters.</summary>
    public static string BuildScript(string service, string installDir, string stagedExe, string version, string dataDir, string? stagedCompute = null)
    {
        const string task = UpdateTask;
        if (!Version().IsMatch(version) || !SafeName().IsMatch(service) || !SafePath().IsMatch(installDir) || !SafePath().IsMatch(stagedExe) || !SafePath().IsMatch(dataDir) || (stagedCompute is not null && !SafePath().IsMatch(stagedCompute))) throw new ArgumentException("unsafe value in update script");
        var computeLine = stagedCompute is null ? "$stagedCompute = $null" : $"$stagedCompute = '{stagedCompute}'";
        return $$"""
            $svc = '{{service}}'; $ver = '{{version}}'
            $exe = Join-Path '{{installDir}}' 'viro-agent.exe'
            $computeExe = Join-Path '{{installDir}}' 'viro-compute.exe'
            $staged = '{{stagedExe}}'
            {{computeLine}}
            $data = '{{dataDir}}'
            $backup = Join-Path $data 'previous\viro-agent.exe'
            $computeBackup = Join-Path $data 'previous\viro-compute.exe'
            $confirm = Join-Path $data 'update-confirmed.txt'
            $log = Join-Path $data 'logs\update.log'
            $confirmSeconds = {{ConfirmSeconds}}
            New-Item -ItemType Directory -Force (Split-Path $backup), (Split-Path $log) | Out-Null
            function Log($m) { Add-Content -Path $log -Value ("{0:o} {1}" -f (Get-Date).ToUniversalTime(), $m) }
            function WaitStopped($name) { for ($i = 0; $i -lt 60; $i++) { if ((sc.exe query $name | Out-String) -match 'STOPPED|1060') { return }; Start-Sleep 1 } }
            # The service is not the only thing running viro-agent.exe: whoever is signed in also has the Viro window and a helper in their own session, and any of them
            # keeps the file locked. Stopping the service alone is why updates failed on every PC with a person signed in. End them all (they start again on demand).
            function EndEverything {
                try { sc.exe stop ViroCompute | Out-Null; WaitStopped 'ViroCompute' } catch { }
                try { sc.exe stop $svc | Out-Null; WaitStopped $svc } catch { }
                for ($i = 0; $i -lt 30; $i++) {
                    $left = @(Get-Process -Name 'viro-agent', 'viro-compute' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID })
                    if ($left.Count -eq 0) { return }
                    $left | Stop-Process -Force -ErrorAction SilentlyContinue
                    Start-Sleep 1
                }
                Log 'some Viro processes could not be ended; trying anyway'
            }
            # A just-stopped service or an antivirus scan can hold the file for a few seconds: retry instead of failing.
            function CopyRetry($from, $to) {
                for ($i = 1; $i -le 40; $i++) {
                    try { Copy-Item $from $to -Force -ErrorAction Stop; return } catch { if ($i -eq 40) { throw }; Start-Sleep 1 }
                }
            }
            $hadCompute = ((sc.exe query ViroCompute | Out-String) -notmatch '1060')
            function StartServices { sc.exe start $svc | Out-Null; if ($hadCompute) { sc.exe start ViroCompute | Out-Null } }
            function RollBack($why) {
                Log "rolling back: $why"
                try { EndEverything } catch { }
                try { if (Test-Path $backup) { CopyRetry $backup $exe; Log 'previous executable restored' } } catch { Log "restore failed: $_" }
                try { if ((Test-Path $computeBackup) -and $stagedCompute) { CopyRetry $computeBackup $computeExe; Log 'previous compute worker restored' } } catch { Log "compute restore failed: $_" }
                try { @{ version = $ver; reason = $why } | ConvertTo-Json | Set-Content -Path (Join-Path $data 'update-rolled-back.json') } catch { }
                StartServices
            }
            try {
                Start-Sleep 2
                Log "updating to $ver"
                EndEverything
                CopyRetry $exe $backup; Log 'backup taken'
                if ($stagedCompute -and (Test-Path $computeExe)) { CopyRetry $computeExe $computeBackup; Log 'compute backup taken' }
                CopyRetry $staged $exe; Log 'new executable in place'
                if ($stagedCompute) { CopyRetry $stagedCompute $computeExe; Log 'new compute worker in place' }
                StartServices; Log 'services start requested'
                $ok = $false
                for ($i = 0; $i -lt $confirmSeconds; $i++) { Start-Sleep 1; if ((Test-Path $confirm) -and ((Get-Content $confirm -Raw).Trim() -eq $ver)) { $ok = $true; break } }
                if ($ok) { Log "update to $ver confirmed" } else { RollBack "the new agent did not confirm within $confirmSeconds seconds" }
            }
            catch { RollBack "the update script failed: $_" }
            finally { schtasks.exe /delete /tn {{task}} /f | Out-Null }
            """;
    }
}

/// <summary>Stops a download from writing more than the signed manifest allows.</summary>
sealed class LimitedStream(Stream inner, long limit) : Stream
{
    long _written;
    public override void Write(byte[] b, int o, int c) { if ((_written += c) > limit) throw new UpdateRejectedException("download is larger than the signed size"); inner.Write(b, o, c); }
    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> b, CancellationToken ct = default) { if ((_written += b.Length) > limit) throw new UpdateRejectedException("download is larger than the signed size"); await inner.WriteAsync(b, ct); }
    public override bool CanRead => false; public override bool CanSeek => false; public override bool CanWrite => true;
    public override long Length => throw new NotSupportedException(); public override long Position { get => _written; set => throw new NotSupportedException(); }
    public override void Flush() => inner.Flush(); public override int Read(byte[] b, int o, int c) => throw new NotSupportedException();
    public override long Seek(long o, SeekOrigin s) => throw new NotSupportedException(); public override void SetLength(long v) => throw new NotSupportedException();
}
