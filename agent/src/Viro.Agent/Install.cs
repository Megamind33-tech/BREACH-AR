using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Viro.Agent.Repair;

namespace Viro.Agent;

public sealed record InstallOptions(string? Server, string? Token, string? InstallDir = null, bool KeepData = false, bool Force = false, bool ProtectDataDir = true);

/// <summary>
/// Installs the agent as a Windows service: files in Program Files, identity enrollment, a locked-down data folder
/// and a service that starts automatically and restarts itself after a crash. Requires administrator rights.
/// </summary>
public sealed class Installer(IProcessRunner proc, Func<bool> isElevated, Action<string> say, Func<string, ControlClient>? clientFactory = null)
{
    public const string ServiceName = "ViroAgent";
    public static string DefaultInstallDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Viro", "Agent");
    static readonly TimeSpan T = TimeSpan.FromSeconds(60);

    public static bool IsElevated()
    {
        using var id = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
    }

    /// <summary>Full install from a downloaded/copied binary: place files, then <see cref="SetupAsync"/>.</summary>
    public async Task<int> InstallAsync(InstallOptions o, string sourceExe, CancellationToken ct)
    {
        if (!isElevated()) { say("Installation needs administrator rights. Run this from an elevated prompt."); return 5; }
        var dir = o.InstallDir ?? DefaultInstallDir;
        var target = Path.Combine(dir, "viro-agent.exe");
        try
        {
            Directory.CreateDirectory(dir);
            if (await ServiceExistsAsync(ct)) { say("Existing installation found: stopping it for upgrade."); await StopAsync(ct); }
            CopyProgramFiles(Path.GetDirectoryName(sourceExe)!, sourceExe, dir);
            say($"Installed files to {dir}");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { say("Could not write program files: " + e.Message); return 1; }
        return await SetupAsync(o with { InstallDir = dir }, target, ct);
    }

    static void CopyProgramFiles(string sourceDir, string sourceExe, string dir)
    {
        // Single-file publish: just the exe. Framework-dependent layout: the exe plus its sibling files.
        var files = Directory.EnumerateFiles(sourceDir).Where(f => !f.EndsWith(".pdb", StringComparison.OrdinalIgnoreCase)).ToList();
        if (files.Count > 60 || files.Count == 0) files = [sourceExe];
        foreach (var f in files)
        {
            var dest = Path.Combine(dir, Path.GetFileName(f));
            if (string.Equals(Path.GetFullPath(f), Path.GetFullPath(dest), StringComparison.OrdinalIgnoreCase)) continue;
            File.Copy(f, dest, overwrite: true);
        }
    }

    /// <summary>Enroll (when a token is given), secure the data folder, register and start the service. Used by MSI and by install.</summary>
    public async Task<int> SetupAsync(InstallOptions o, string exePath, CancellationToken ct)
    {
        if (!isElevated()) { say("Setup needs administrator rights."); return 5; }
        Directory.CreateDirectory(AgentConfig.DataDir);
        if (o.ProtectDataDir) ProtectDataDirectory(AgentConfig.DataDir);

        var cfg = AgentConfig.Load();
        if (o.Token is not null)
        {
            if (o.Server is null) { say("--server is required together with --token."); return 2; }
            try
            {
                var client = (clientFactory ?? (u => new ControlClient(u)))(o.Server);
                if (cfg.IsEnrolled)
                {
                    // Workspace guard: a PC that already belongs to a workspace is never moved to another one by accident. The code is looked up first (nothing is used up), and a different workspace is refused unless the move was asked for explicitly.
                    var target = await client.CheckEnrollmentAsync(o.Token, ct);
                    if (target.OrganizationId != cfg.OrganizationId && !o.Force)
                    {
                        say($"This PC already belongs to a workspace and was not changed. The code you used is for '{target.OrganizationName}'. To move this PC there on purpose, repeat the connection and confirm the move.");
                        return 3;
                    }
                    say(target.OrganizationId == cfg.OrganizationId ? "This code is for the workspace this PC is already in; reconnecting it." : $"Moving this PC to '{target.OrganizationName}' as requested.");
                }
                var r = await client.EnrollAsync(o.Token, Collectors.MachineGuid(), Environment.MachineName, Collectors.AgentVersion, ct);
                cfg = new AgentConfig { ServerUrl = o.Server.TrimEnd('/'), DeviceId = r.DeviceId, HeartbeatIntervalSeconds = r.HeartbeatIntervalSeconds, JobSigningPublicKey = r.JobSigningPublicKey, OrganizationId = r.OrganizationId };
                cfg.SetSecret(r.DeviceSecret); cfg.Save();
                say($"Enrolled as device {r.DeviceId}");
            }
            catch (Exception e) { say("Enrollment failed: " + e.Message); return 1; }
        }
        else if (!cfg.IsEnrolled) { say("This device is not enrolled. Provide --server and --token."); return 2; }
        else say("Already enrolled; keeping existing identity.");

        var bin = $"\"\\\"{exePath}\\\"\"";
        var exists = await ServiceExistsAsync(ct);
        var create = exists ? "config" : "create";
        var r1 = await proc.RunAsync("sc.exe", $"{create} {ServiceName} binPath= {bin} start= delayed-auto obj= LocalSystem DisplayName= \"Viro Agent\"", T, ct);
        if (r1.ExitCode != 0) { say($"Could not register the service: {r1.Output.Trim()}"); return 1; }
        await proc.RunAsync("sc.exe", $"description {ServiceName} \"Viro WorkCare endpoint agent: health, repair, security and maintenance for this PC. Managed by your organization.\"", T, ct);
        // Restart automatically after a crash: 5s, 5s, then 60s; reset the failure counter after a day.
        await proc.RunAsync("sc.exe", $"failure {ServiceName} reset= 86400 actions= restart/5000/restart/5000/restart/60000", T, ct);
        await proc.RunAsync("sc.exe", $"failureflag {ServiceName} 1", T, ct);
        // A service that is already running keeps the identity it loaded at start. When a new identity was just enrolled (a join or a move), it is restarted so it reports to the right workspace at once.
        if (exists && o.Token is not null) await StopAsync(ct);
        var r2 = await proc.RunAsync("sc.exe", $"start {ServiceName}", T, ct);
        if (r2.ExitCode != 0 && !r2.Output.Contains("1056") /* already running */) { say($"Service registered but did not start: {r2.Output.Trim()}"); return 1; }
        say("Viro Agent service is installed and running.");
        return 0;
    }

    /// <summary>Remove only the service registration (used by the MSI, which removes the files and data itself).</summary>
    public async Task<int> TeardownAsync(CancellationToken ct)
    {
        if (!isElevated()) { say("Teardown needs administrator rights."); return 5; }
        await SayGoodbyeAsync(ct);
        if (await ServiceExistsAsync(ct))
        {
            await StopAsync(ct);
            var d = await proc.RunAsync("sc.exe", $"delete {ServiceName}", T, ct);
            if (d.ExitCode != 0) { say("Could not remove the service: " + d.Output.Trim()); return 1; }
        }
        say("Service removed.");
        // A real uninstall (the MSI does not call this for upgrades) ends this device's identity; Control was told above.
        try { if (Directory.Exists(AgentConfig.DataDir)) Directory.Delete(AgentConfig.DataDir, true); say("Agent data removed."); } catch (Exception e) { say("Could not remove all agent data: " + e.Message); }
        return 0;
    }

    public async Task<int> UninstallAsync(InstallOptions o, CancellationToken ct)
    {
        if (!isElevated()) { say("Uninstall needs administrator rights."); return 5; }
        await SayGoodbyeAsync(ct);
        var dir = o.InstallDir ?? DefaultInstallDir;
        if (await ServiceExistsAsync(ct))
        {
            await StopAsync(ct);
            var d = await proc.RunAsync("sc.exe", $"delete {ServiceName}", T, ct);
            if (d.ExitCode != 0) { say("Could not remove the service: " + d.Output.Trim()); return 1; }
            say("Service removed.");
        }
        if (!o.KeepData) { try { if (Directory.Exists(AgentConfig.DataDir)) Directory.Delete(AgentConfig.DataDir, true); say("Agent data removed."); } catch (Exception e) { say("Could not remove all agent data: " + e.Message); } }
        // The running executable cannot delete itself; a detached command removes the folder a moment after we exit.
        if (Directory.Exists(dir))
            await proc.RunAsync("cmd.exe", $"/c start \"\" /b cmd /c \"ping 127.0.0.1 -n 4 >nul & rmdir /s /q \"{dir}\"\"", TimeSpan.FromSeconds(10), ct);
        say("Viro Agent has been uninstalled.");
        return 0;
    }

    /// <summary>Lets Control know this is an intentional removal (so it is not mistaken for a device that vanished).</summary>
    async Task SayGoodbyeAsync(CancellationToken ct)
    {
        var cfg = AgentConfig.Load(); if (!cfg.IsEnrolled) return;
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct); cts.CancelAfter(TimeSpan.FromSeconds(10));
            var client = (clientFactory ?? (u => new ControlClient(u)))(cfg.ServerUrl); client.UseDevice(cfg.DeviceId, cfg.DeviceSecret);
            await client.GoodbyeAsync(cts.Token); say("Control was told this computer is being uninstalled.");
        }
        catch { /* best effort */ }
    }

    async Task<bool> ServiceExistsAsync(CancellationToken ct) => (await proc.RunAsync("sc.exe", $"query {ServiceName}", T, ct)).ExitCode != 1060;

    async Task StopAsync(CancellationToken ct)
    {
        await proc.RunAsync("sc.exe", $"stop {ServiceName}", T, ct);
        for (var i = 0; i < 20; i++)
        {
            var q = await proc.RunAsync("sc.exe", $"query {ServiceName}", T, ct);
            if (q.ExitCode == 1060 || q.Output.Contains("STOPPED")) return;
            await Task.Delay(500, ct);
        }
    }

    /// <summary>Only SYSTEM and Administrators may read the agent's configuration (it holds the device credential).</summary>
    public static void ProtectDataDirectory(string dir)
    {
        var di = new DirectoryInfo(dir);
        var sec = new DirectorySecurity();
        sec.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in new[] { WellKnownSidType.LocalSystemSid, WellKnownSidType.BuiltinAdministratorsSid })
            sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid, null), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        di.SetAccessControl(sec);
    }

    public async Task<object> StatusAsync(CancellationToken ct)
    {
        var q = await proc.RunAsync("sc.exe", $"query {ServiceName}", T, ct);
        var installed = q.ExitCode != 1060;
        var state = !installed ? "not installed" : q.Output.Contains("RUNNING") ? "running" : q.Output.Contains("STOPPED") ? "stopped" : "unknown";
        var cfg = AgentConfig.Load();
        return new { installed, service = state, version = Collectors.AgentVersion, enrolled = cfg.IsEnrolled, deviceId = cfg.DeviceId == "" ? null : cfg.DeviceId, server = cfg.ServerUrl == "" ? null : cfg.ServerUrl, dataDir = AgentConfig.DataDir, logDir = FileLog.LogDir, jobsEnabled = cfg.JobSigningPublicKey != "" };
    }
}
