using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Viro.Agent.Care;
using Viro.Agent.Repair;

namespace Viro.Agent;

/// <summary>What was last heard from Control about lost mode, kept on disk (DPAPI machine-scope, like the device secret) so a PC that is locked and then
/// loses power or network still comes back locked: it does not need to reach Control again to know it should be.</summary>
public sealed record LostModeState(bool Locked, string? SaltB64, string? HashB64, int Iterations, DateTime UpdatedAtUtc)
{
    static string Path => System.IO.Path.Combine(AgentConfig.DataDir, "lost.json");

    public void Save()
    {
        var bytes = ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(this), null, DataProtectionScope.LocalMachine);
        Directory.CreateDirectory(AgentConfig.DataDir);
        var tmp = Path + ".tmp"; File.WriteAllBytes(tmp, bytes); File.Move(tmp, Path, overwrite: true);
    }

    public static LostModeState Load()
    {
        try { return JsonSerializer.Deserialize<LostModeState>(ProtectedData.Unprotect(File.ReadAllBytes(Path), null, DataProtectionScope.LocalMachine)) ?? Unlocked; }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException or CryptographicException or JsonException) { return Unlocked; }
    }

    public static readonly LostModeState Unlocked = new(false, null, null, 0, DateTime.MinValue);
}

/// <summary>
/// A second, plainly-named scheduled task, armed only while a PC is in lost mode, that notices if the main Viro service goes missing and puts it back.
/// It keeps its own copy of the program and of the enrolment it needs, in its own folder, so a removal of the main install alone does not end it.
/// This is a visible, disclosed safety net against an opportunistic removal, not an attempt to survive a determined one: anyone with administrator
/// rights can see this task in Task Scheduler (named exactly what it is) and remove it along with everything else, the same way they could remove
/// any other software with that level of access. It disarms itself the moment the computer is no longer reported lost.
/// </summary>
public sealed class LostGuard(IProcessRunner proc, string exePath)
{
    public const string TaskName = "Viro WorkCare lost-mode guard";
    public static string GuardDir { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Viro", "Guard");
    static string GuardExe => Path.Combine(GuardDir, "viro-agent.exe");
    static string GuardConfig => Path.Combine(GuardDir, "guard.json");
    static readonly TimeSpan T = TimeSpan.FromSeconds(30);

    public async Task ArmAsync(AgentConfig cfg, CancellationToken ct)
    {
        try
        {
            Directory.CreateDirectory(GuardDir);
            if (!string.Equals(Path.GetFullPath(exePath), Path.GetFullPath(GuardExe), StringComparison.OrdinalIgnoreCase)) File.Copy(exePath, GuardExe, overwrite: true);
            File.WriteAllBytes(GuardConfig, ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(cfg), null, DataProtectionScope.LocalMachine));
            Installer.ProtectDataDirectory(GuardDir);
        }
        catch { return; }   // no administrator rights, or the disk is not writable: there is no guard to arm, and lost mode still works the ordinary way
        await proc.RunAsync("schtasks.exe", $"/Create /F /SC MINUTE /MO 15 /TN \"{TaskName}\" /TR \"\\\"{GuardExe}\\\" guard-check\" /RU SYSTEM /RL HIGHEST", T, ct);
    }

    public async Task DisarmAsync(CancellationToken ct)
    {
        await proc.RunAsync("schtasks.exe", $"/Delete /F /TN \"{TaskName}\"", T, ct);
        try { if (Directory.Exists(GuardDir)) Directory.Delete(GuardDir, true); } catch { /* removed on a later disarm, or by hand; not worth failing over */ }
    }

    /// <summary>
    /// What the scheduled task actually runs. Whether to act is decided only from files in <see cref="GuardDir"/>, never from the main install's own
    /// data folder: that folder, and the state file in it, are exactly what a normal uninstall removes, and the guard exists for when that happens
    /// while still locked. <see cref="DisarmAsync"/> is what ends it, by removing <see cref="GuardDir"/> once the computer is no longer reported lost.
    /// </summary>
    public static async Task<int> CheckAsync(CancellationToken ct)
    {
        if (!File.Exists(GuardConfig) || !File.Exists(GuardExe)) return 0;
        var proc = new SystemProcessRunner();
        if (await Installer.IsServiceRegisteredAsync(proc, ct)) return 0;
        try
        {
            var cfg = JsonSerializer.Deserialize<AgentConfig>(ProtectedData.Unprotect(File.ReadAllBytes(GuardConfig), null, DataProtectionScope.LocalMachine));
            if (cfg is null || !cfg.IsEnrolled) return 1;
            Directory.CreateDirectory(AgentConfig.DataDir); cfg.Save();
            await new Installer(proc, Installer.IsElevated, _ => { }).SetupAsync(new InstallOptions(Server: null, Token: null), GuardExe, ct);
        }
        catch { /* a best-effort safety net; the device stays listed as lost either way, and an administrator checking on it sees that */ }
        return 0;
    }
}

/// <summary>
/// Keeps the lock screen matched to what Control last said. Driven two ways: <see cref="ApplyServerState"/> is called after every heartbeat with the
/// current answer, and at startup <see cref="EnforceCachedStateAsync"/> re-shows the lock immediately from the cached state, before the first heartbeat
/// has even gone out, which is what makes it still work on a PC that was locked, then rebooted with no network.
/// </summary>
public sealed class LostModeGuard(ControlClient client, ILogger log)
{
    readonly UserUiBridge ui = new(log);
    readonly LostGuard guard = new(new SystemProcessRunner(), Environment.ProcessPath ?? "viro-agent.exe");
    CancellationTokenSource? loopCts;
    LostModeState current = LostModeState.Load();

    public void EnforceCachedStateAsync(CancellationToken appCt) { if (current.Locked) { Start(appCt); _ = guard.ArmAsync(AgentConfig.Load(), CancellationToken.None); } }

    public void ApplyServerState(LostState? server, CancellationToken appCt)
    {
        if (server is null) return;      // an older server that does not know about lost mode: never lock on its account
        if (server.Locked && !current.Locked)
        {
            current = new LostModeState(true, server.SaltB64, server.HashB64, server.Iterations, DateTime.UtcNow); current.Save();
            Start(appCt);
            _ = guard.ArmAsync(AgentConfig.Load(), CancellationToken.None);
        }
        else if (!server.Locked && current.Locked)
        {
            current = LostModeState.Unlocked; current.Save();
            loopCts?.Cancel();
            _ = ui.TellUnlockedAsync(CancellationToken.None);
            _ = guard.DisarmAsync(CancellationToken.None);
        }
        else if (server.Locked && current.Locked && (server.SaltB64 != current.SaltB64 || server.HashB64 != current.HashB64))
        {
            // the passphrase was reset while still locked: keep the lock, but have the next entry checked against the new one
            current = current with { SaltB64 = server.SaltB64, HashB64 = server.HashB64, Iterations = server.Iterations }; current.Save();
        }
    }

    void Start(CancellationToken appCt)
    {
        loopCts?.Cancel();
        loopCts = CancellationTokenSource.CreateLinkedTokenSource(appCt);
        _ = Task.Run(() => LoopAsync(loopCts.Token), loopCts.Token);
    }

    async Task LoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && current.Locked)
        {
            try
            {
                var state = current;    // a passphrase reset mid-lock is picked up on the next attempt via this snapshot
                var unlocked = await ui.LockAsync(state.SaltB64!, state.HashB64!, state.Iterations, ct);
                if (ct.IsCancellationRequested) return;      // cancelled because Control already said unlocked; ApplyServerState has handled the state
                if (unlocked)
                {
                    log.LogWarning("Lost mode: the passphrase was entered correctly on this PC");
                    current = LostModeState.Unlocked; current.Save();
                    await client.ReportRecoveredAsync(ct);
                    return;
                }
            }
            catch (OperationCanceledException) { return; }
            catch (Exception e) { log.LogWarning("Lost-mode lock could not be shown ({Msg}); trying again shortly", e.Message); }
            try { await Task.Delay(TimeSpan.FromSeconds(10), ct); } catch (OperationCanceledException) { return; }   // no signed-in session yet, or the helper failed: try again
        }
    }
}
