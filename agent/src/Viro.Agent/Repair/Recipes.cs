using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Viro.Agent.Repair;

public static class Recipes
{
    public static readonly IReadOnlyDictionary<string, IRepairRecipe> All = new IRepairRecipe[]
    {
        new ServicesRestartFailed(), new CleanupSafe(), new PrinterSpooler(), new DnsFlush(), new NetworkReset(),
        new WindowsUpdateReset(), new Sfc(), new DismRestoreHealth(), new StartupDisable(), new DiskCheck(), new OfficeQuickRepair(),
    }.Concat(Protection.Create()).Concat(SecurityRecipeSet.Create()).Concat([new Viro.Agent.Care.MemoryTrimRecipe(), new Viro.Agent.Care.AppRepairRecipe(), new Viro.Agent.Care.AppUninstallRecipe(), new Viro.Agent.Care.PrinterRepairRecipe(), new Viro.Agent.Care.AppUpdateRecipe(), new Viro.Agent.Care.EndHungAppsRecipe(), new Viro.Agent.Care.ShellRepairRecipe(), new Viro.Agent.Care.MemoryTestRecipe(), new Viro.Agent.Care.FastStartupOffRecipe(), new Viro.Agent.WakeOnLanEnableRecipe(), new Viro.Agent.Care.ShutdownSpeedRecipe(), new Viro.Agent.Care.BootDelayServicesRecipe(), new Viro.Agent.Care.StartupOptimizeRecipe(), new Viro.Agent.Care.StartupEnableRecipe()]).ToDictionary(r => r.Id);

    internal static long FreeBytes(RepairEnv env) { try { return new DriveInfo(env.SystemDrive).AvailableFreeSpace; } catch { return -1; } }
}

// ------------------------------------------------------------------------------------------------------------------
sealed class ServicesRestartFailed : IRepairRecipe
{
    public string Id => "services.restart-failed"; public string Title => "Restart failed automatic services";
    public RepairRisk Risk => RepairRisk.Safe; public bool AutoSafe => true; public bool Reversible => false;
    static readonly HashSet<string> Never = new(StringComparer.OrdinalIgnoreCase) { "ViroAgent", "TrustedInstaller" };

    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var failed = c.Services.FailedAutoServices().Where(s => !Never.Contains(s.Name)).ToList();
        return Task.FromResult(new Finding(failed.Count > 0, failed.Count == 0 ? "all automatic services are running" : $"{failed.Count} automatic service(s) failed: {string.Join(", ", failed.Select(f => f.Name))}", failed));
    }
    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var errors = new List<string>();
        foreach (var s in (List<FailedService>)f.Before!)
        {
            try { await c.Services.StartAsync(s.Name, TimeSpan.FromSeconds(30)); }
            catch (Exception e) { errors.Add($"{s.Name}: {(e.InnerException ?? e).Message}"); }
        }
        c.After = new { startErrors = errors };
    }
    public Task<(bool, string)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var still = ((List<FailedService>)f.Before!).Where(s => c.Services.Status(s.Name) != "Running").Select(s => s.Name).ToList();
        return Task.FromResult((still.Count == 0, still.Count == 0 ? "all services are running" : "still not running: " + string.Join(", ", still)));
    }
    public Task RollbackAsync(RepairContext c, JsonElement s, CancellationToken ct) => throw new NotSupportedException();
}

// ------------------------------------------------------------------------------------------------------------------
sealed class CleanupSafe : IRepairRecipe
{
    public string Id => "cleanup.safe"; public string Title => "Clean safe temporary files and caches";
    public RepairRisk Risk => RepairRisk.Safe; public bool AutoSafe => true; public bool Reversible => false;
    const long WorthCleaning = 50L * 1024 * 1024;

    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var prev = Cleanup.Preview(c.Env, Cleanup.SafeIds, ct: ct);
        var total = prev.Sum(p => p.BytesFound);
        return Task.FromResult(new Finding(total >= WorthCleaning, $"{total / 1048576} MB of safe files can be removed", new { recoverableBytes = total, categories = prev, systemDriveFreeBytes = Recipes.FreeBytes(c.Env) }));
    }
    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var before = Recipes.FreeBytes(c.Env);
        var res = await Cleanup.RunAsync(c.Env, c.Proc, Cleanup.SafeIds, approveReview: false, ct: ct);
        c.After = new { freedBytes = res.Sum(r => r.BytesFreed), filesRemoved = res.Sum(r => r.FilesRemoved), skippedInUse = res.Sum(r => r.Skipped), categories = res, systemDriveFreeBefore = before, systemDriveFreeAfter = Recipes.FreeBytes(c.Env) };
    }
    public Task<(bool, string)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        dynamic a = c.After!; long freed = a.freedBytes;
        return Task.FromResult((freed > 0, freed > 0 ? $"freed {freed / 1048576} MB" : "nothing could be removed (files in use)"));
    }
    public Task RollbackAsync(RepairContext c, JsonElement s, CancellationToken ct) => throw new NotSupportedException();
}

// ------------------------------------------------------------------------------------------------------------------
sealed class PrinterSpooler : IRepairRecipe
{
    public string Id => "printer.spooler"; public string Title => "Repair the print spooler (clears stuck print jobs)";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => false;
    static string Queue(RepairEnv e) => Path.Combine(e.WindowsDir, "System32", "spool", "PRINTERS");

    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var status = c.Services.Status("Spooler");
        if (status is null) return Task.FromResult(new Finding(false, "the Print Spooler service is not installed"));
        var stuck = Directory.Exists(Queue(c.Env)) ? Directory.EnumerateFiles(Queue(c.Env)).Count(p => DateTime.UtcNow - File.GetLastWriteTimeUtc(p) > TimeSpan.FromMinutes(15)) : 0;
        var needed = status != "Running" || stuck > 0;
        return Task.FromResult(new Finding(needed, $"spooler is {status}; {stuck} stuck print file(s)", new { status, stuck }));
    }
    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        await c.Services.StopAsync("Spooler", TimeSpan.FromSeconds(45));
        if (Directory.Exists(Queue(c.Env))) foreach (var p in Directory.EnumerateFiles(Queue(c.Env))) { try { File.Delete(p); } catch { /* still locked */ } }
        await c.Services.StartAsync("Spooler", TimeSpan.FromSeconds(45));
    }
    public Task<(bool, string)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var left = Directory.Exists(Queue(c.Env)) ? Directory.EnumerateFiles(Queue(c.Env)).Count() : 0;
        var ok = c.Services.Status("Spooler") == "Running" && left == 0;
        return Task.FromResult((ok, ok ? "spooler running, print queue empty" : $"spooler {c.Services.Status("Spooler")}, {left} file(s) left in queue"));
    }
    public Task RollbackAsync(RepairContext c, JsonElement s, CancellationToken ct) => throw new NotSupportedException();
}

// ------------------------------------------------------------------------------------------------------------------
sealed class DnsFlush : IRepairRecipe
{
    public string Id => "dns.flush"; public string Title => "Flush the DNS resolver cache";
    public RepairRisk Risk => RepairRisk.Safe; public bool AutoSafe => true; public bool Reversible => false;
    public async Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        if (!c.Env.NetworkLinkUp()) return new(false, "no network link, so DNS cannot be judged");
        var ok = await c.Env.CanResolveAsync(ct);
        return new(!ok, ok ? "name resolution works" : "network link is up but name resolution fails", new { resolves = ok });
    }
    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var r = await c.Proc.RunAsync("ipconfig.exe", "/flushdns", TimeSpan.FromSeconds(30), ct);
        if (r.ExitCode != 0) throw new InvalidOperationException("ipconfig /flushdns failed: " + r.Output.Trim());
    }
    public async Task<(bool, string)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var ok = await c.Env.CanResolveAsync(ct);
        return (ok, ok ? "name resolution works after flush" : "name resolution still fails (consider the network reset recipe)");
    }
    public Task RollbackAsync(RepairContext c, JsonElement s, CancellationToken ct) => throw new NotSupportedException();
}

sealed class NetworkReset : IRepairRecipe
{
    public string Id => "network.reset"; public string Title => "Reset the network stack (Winsock and TCP/IP)";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => false;
    public async Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var link = c.Env.NetworkLinkUp(); var dns = link && await c.Env.CanResolveAsync(ct);
        return new(link && !dns, link ? (dns ? "network works" : "link is up but name resolution fails") : "no network link", new { link, resolves = dns });
    }
    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        foreach (var a in new[] { "winsock reset", "int ip reset" })
        {
            var r = await c.Proc.RunAsync("netsh.exe", a, TimeSpan.FromSeconds(60), ct);
            if (r.ExitCode != 0) throw new InvalidOperationException($"netsh {a} failed: {r.Output.Trim()}");
        }
        c.RebootRequired = true;
    }
    public Task<(bool, string)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct) =>
        Task.FromResult((true, "Winsock and TCP/IP were reset; a restart is required for it to take effect"));
    public Task RollbackAsync(RepairContext c, JsonElement s, CancellationToken ct) => throw new NotSupportedException();
}

// ------------------------------------------------------------------------------------------------------------------
sealed class WindowsUpdateReset : IRepairRecipe
{
    public string Id => "windows.update-reset"; public string Title => "Reset Windows Update components";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => true;
    static readonly string[] Svcs = ["wuauserv", "bits", "cryptsvc"];
    static string SD(RepairEnv e) => Path.Combine(e.WindowsDir, "SoftwareDistribution");
    static string Cat(RepairEnv e) => Path.Combine(e.WindowsDir, "System32", "catroot2");

    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var mode = c.Services.StartMode("wuauserv");
        var disabled = string.Equals(mode, "Disabled", StringComparison.OrdinalIgnoreCase);
        return Task.FromResult(new Finding(disabled || c.Force, disabled ? "the Windows Update service is disabled" : "no fault detected (run with force to reset anyway)", new { wuauservStartMode = mode }));
    }
    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var tag = ".viro-bak-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss");
        foreach (var s in Svcs.Reverse()) if (c.Services.Status(s) is not null) await c.Services.StopAsync(s, TimeSpan.FromSeconds(60));
        var moved = new List<object>();
        foreach (var dir in new[] { SD(c.Env), Cat(c.Env) })
            if (Directory.Exists(dir)) { var to = dir + tag; Directory.Move(dir, to); moved.Add(new { from = dir, to }); }
        c.RollbackState["moved"] = moved;
        foreach (var s in Svcs) if (c.Services.Status(s) is not null) await c.Services.StartAsync(s, TimeSpan.FromSeconds(60));
    }
    public Task<(bool, string)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var running = Svcs.Where(s => c.Services.Status(s) is not null).All(s => c.Services.Status(s) == "Running");
        return Task.FromResult((running, running ? "Windows Update services restarted with fresh caches" : "Windows Update services did not all start"));
    }
    public async Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        foreach (var s in Svcs.Reverse()) if (c.Services.Status(s) is not null) await c.Services.StopAsync(s, TimeSpan.FromSeconds(60));
        foreach (var m in saved.GetProperty("moved").EnumerateArray())
        {
            var from = m.GetProperty("from").GetString()!; var to = m.GetProperty("to").GetString()!;
            if (!Directory.Exists(to)) continue;
            if (Directory.Exists(from)) Directory.Delete(from, true);
            Directory.Move(to, from);
        }
        foreach (var s in Svcs) if (c.Services.Status(s) is not null) await c.Services.StartAsync(s, TimeSpan.FromSeconds(60));
    }
}

// ------------------------------------------------------------------------------------------------------------------
sealed partial class Sfc : IRepairRecipe
{
    public string Id => "windows.sfc"; public string Title => "System File Checker (sfc /scannow)";
    public RepairRisk Risk => RepairRisk.Safe; public bool AutoSafe => false; public bool Reversible => false;
    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct) => Task.FromResult(new Finding(true, "scan requested"));
    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var r = await c.Proc.RunAsync(Path.Combine(c.Env.WindowsDir, "System32", "sfc.exe"), "/scannow", TimeSpan.FromMinutes(50), ct, Encoding.Unicode);
        c.After = new { exitCode = r.ExitCode, timedOut = r.TimedOut, output = Tail(r.Output) };
    }
    public Task<(bool, string)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        dynamic a = c.After!; string o = a.output; bool to = a.timedOut;
        if (to) return Task.FromResult((false, "sfc did not finish within 50 minutes"));
        if (Ok().IsMatch(o)) return Task.FromResult((true, "no integrity violations found"));
        if (Fixed().IsMatch(o)) return Task.FromResult((true, "corrupt files were found and repaired"));
        if (Unfixed().IsMatch(o)) return Task.FromResult((false, "corrupt files were found that could not be repaired (run the DISM recipe, then sfc again)"));
        if (NeedsAdmin().IsMatch(o)) return Task.FromResult((false, "sfc requires administrator rights; the agent must run as a service (SYSTEM) or elevated"));
        if (Blocked().IsMatch(o)) return Task.FromResult((false, "sfc could not perform the scan (a pending repair or restart blocks it)"));
        return Task.FromResult((false, "sfc output was not recognised (non-English Windows?); see CBS.log"));
    }
    public Task RollbackAsync(RepairContext c, JsonElement s, CancellationToken ct) => throw new NotSupportedException();
    static string Tail(string s) => s.Length > 3000 ? s[^3000..] : s;
    [GeneratedRegex("did not find any integrity violations", RegexOptions.IgnoreCase)] private static partial Regex Ok();
    [GeneratedRegex("found corrupt files and successfully repaired", RegexOptions.IgnoreCase)] private static partial Regex Fixed();
    [GeneratedRegex("found corrupt files but was unable to fix", RegexOptions.IgnoreCase)] private static partial Regex Unfixed();
    [GeneratedRegex("could not perform the requested operation", RegexOptions.IgnoreCase)] private static partial Regex Blocked();
    [GeneratedRegex("must be an administrator", RegexOptions.IgnoreCase)] private static partial Regex NeedsAdmin();
}

sealed class DismRestoreHealth : IRepairRecipe
{
    public string Id => "windows.dism"; public string Title => "Repair the Windows component store (DISM)";
    public RepairRisk Risk => RepairRisk.Safe; public bool AutoSafe => false; public bool Reversible => false;
    string Dism(RepairContext c) => Path.Combine(c.Env.WindowsDir, "System32", "dism.exe");

    public async Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var r = await c.Proc.RunAsync(Dism(c), "/Online /Cleanup-Image /CheckHealth", TimeSpan.FromMinutes(5), ct);
        if (Regex.IsMatch(r.Output, "No component store corruption detected", RegexOptions.IgnoreCase)) return new(c.Force, "component store is healthy", r.Output.Trim());
        if (Regex.IsMatch(r.Output, "component store is repairable", RegexOptions.IgnoreCase)) return new(true, "component store corruption detected and repairable", r.Output.Trim());
        return new(c.Force, $"could not determine component store state (exit {r.ExitCode}): {Truncate(r.Output)}", r.Output.Trim());
    }
    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var r = await c.Proc.RunAsync(Dism(c), "/Online /Cleanup-Image /RestoreHealth", TimeSpan.FromMinutes(50), ct);
        c.After = new { exitCode = r.ExitCode, timedOut = r.TimedOut, output = Truncate(r.Output) };
        if (r.TimedOut) throw new TimeoutException("DISM did not finish within 50 minutes");
        if (r.ExitCode != 0) throw new InvalidOperationException($"DISM RestoreHealth failed (exit {r.ExitCode}): {Truncate(r.Output)}");
    }
    public async Task<(bool, string)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var r = await c.Proc.RunAsync(Dism(c), "/Online /Cleanup-Image /CheckHealth", TimeSpan.FromMinutes(5), ct);
        var ok = Regex.IsMatch(r.Output, "No component store corruption detected", RegexOptions.IgnoreCase);
        return (ok, ok ? "component store is healthy" : "component store still reports corruption");
    }
    public Task RollbackAsync(RepairContext c, JsonElement s, CancellationToken ct) => throw new NotSupportedException();
    static string Truncate(string s) => s.Length > 600 ? s[^600..] : s.Trim();
}

sealed class DiskCheck : IRepairRecipe
{
    public string Id => "disk.check"; public string Title => "Online disk check (chkdsk /scan)";
    public RepairRisk Risk => RepairRisk.Safe; public bool AutoSafe => false; public bool Reversible => false;
    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct) => Task.FromResult(new Finding(true, "scan requested"));
    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var drive = c.Env.SystemDrive.TrimEnd('\\');
        var r = await c.Proc.RunAsync("chkdsk.exe", $"{drive} /scan", TimeSpan.FromMinutes(40), ct);
        c.After = new { exitCode = r.ExitCode, timedOut = r.TimedOut, output = r.Output.Length > 2000 ? r.Output[^2000..] : r.Output };
    }
    public Task<(bool, string)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        dynamic a = c.After!; string o = a.output; int code = a.exitCode; bool to = a.timedOut;
        if (to) return Task.FromResult((false, "chkdsk did not finish in 40 minutes"));
        if (Regex.IsMatch(o, "found no problems", RegexOptions.IgnoreCase)) return Task.FromResult((true, "the file system is healthy"));
        if (code == 0) return Task.FromResult((true, "chkdsk completed with no reported errors"));
        return Task.FromResult((false, $"chkdsk reported problems (exit {code}); schedule a repair at next restart"));
    }
    public Task RollbackAsync(RepairContext c, JsonElement s, CancellationToken ct) => throw new NotSupportedException();
}

// ------------------------------------------------------------------------------------------------------------------
/// <summary>Disables startup items the way Task Manager does (StartupApproved flag); fully reversible, nothing is deleted.</summary>
sealed class StartupDisable : IRepairRecipe
{
    public string Id => "startup.disable"; public string Title => "Disable selected startup programs";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => true;

    sealed record Target(string Location, string Name);
    static List<Target> Requested(RepairContext c)
    {
        if (c.Options.ValueKind != JsonValueKind.Object || !c.Options.TryGetProperty("entries", out var e) || e.ValueKind != JsonValueKind.Array) throw new ArgumentException("options.entries is required");
        return [.. e.EnumerateArray().Select(x => new Target(x.GetProperty("location").GetString()!, x.GetProperty("name").GetString()!))];
    }

    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var slots = c.Env.StartupSlots();
        var found = new List<object>(); var missing = new List<string>();
        foreach (var t in Requested(c))
        {
            var slot = slots.FirstOrDefault(s => string.Equals(s.Location, t.Location, StringComparison.OrdinalIgnoreCase));
            var cmd = slot?.Command(t.Name);
            if (cmd is null) missing.Add($"{t.Name} ({t.Location})"); else found.Add(new { t.Name, t.Location, command = cmd });
        }
        if (missing.Count > 0) return Task.FromResult(new Finding(false, "startup entries not found (or not in a supported start-up location): " + string.Join(", ", missing)));
        return Task.FromResult(new Finding(true, $"{found.Count} startup entr{(found.Count == 1 ? "y" : "ies")} will be disabled", found));
    }

    public Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var slots = c.Env.StartupSlots(); var prior = new List<object>();
        c.RollbackState["entries"] = prior;      // recorded as it goes, so a failure half-way can still be undone
        foreach (var t in Requested(c))
        {
            var slot = slots.First(s => string.Equals(s.Location, t.Location, StringComparison.OrdinalIgnoreCase));
            using var ap = slot.OpenApproved(true) ?? throw new InvalidOperationException($"cannot open the StartupApproved key for {t.Location} (elevation required)");
            var old = ap.GetValue(t.Name) as byte[];
            prior.Add(new { t.Location, t.Name, previous = old is null ? null : Convert.ToBase64String(old) });
            var disabled = new byte[12]; disabled[0] = 0x03; BitConverter.GetBytes(DateTime.UtcNow.ToFileTimeUtc()).CopyTo(disabled, 4);
            ap.SetValue(t.Name, disabled, RegistryValueKind.Binary);
        }
        c.RollbackState["entries"] = prior;
        return Task.CompletedTask;
    }

    public Task<(bool, string)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var slots = c.Env.StartupSlots(); var bad = new List<string>();
        foreach (var t in Requested(c))
        {
            using var ap = slots.First(s => string.Equals(s.Location, t.Location, StringComparison.OrdinalIgnoreCase)).OpenApproved(false);
            if (!(ap?.GetValue(t.Name) is byte[] b && b.Length > 0 && (b[0] & 1) == 1)) bad.Add(t.Name);
        }
        return Task.FromResult((bad.Count == 0, bad.Count == 0 ? "startup entries are disabled (they can be re-enabled by rollback)" : "not disabled: " + string.Join(", ", bad)));
    }

    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        var slots = c.Env.StartupSlots();
        foreach (var e in saved.GetProperty("entries").EnumerateArray())
        {
            var loc = e.GetProperty("location").GetString()!; var name = e.GetProperty("name").GetString()!;
            var slot = slots.First(s => string.Equals(s.Location, loc, StringComparison.OrdinalIgnoreCase));
            using var ap = slot.OpenApproved(true) ?? throw new InvalidOperationException("cannot open StartupApproved key");
            if (e.TryGetProperty("previous", out var p) && p.ValueKind == JsonValueKind.String) ap.SetValue(name, Convert.FromBase64String(p.GetString()!), RegistryValueKind.Binary);
            else ap.DeleteValue(name, false);
        }
        return Task.CompletedTask;
    }
}

/// <summary>One place Windows starts programs from: a Run key, or a Startup folder (Folder set). Both are switched on and off the way Task Manager does, through StartupApproved.</summary>
public sealed record StartupSlot(string Location, Func<RegistryKey?> OpenRun, Func<bool, RegistryKey?> OpenApproved, string? Folder = null)
{
    static readonly string[] Launchable = [".lnk", ".exe", ".bat", ".cmd", ".url", ".vbs", ".ps1"];
    /// <summary>Everything this place starts, as name and command. For a folder the name is the file name, the command is what its shortcut points to.</summary>
    public IEnumerable<(string name, string command)> Entries()
    {
        if (Folder is null)
        {
            using var run = OpenRun(); if (run is null) return [];
            return [.. run.GetValueNames().Select(n => (n, run.GetValue(n) as string)).Where(x => x.Item2 is not null).Select(x => (x.n, x.Item2!))];
        }
        try { return Directory.Exists(Folder) ? [.. Directory.EnumerateFiles(Folder).Where(f => Launchable.Contains(Path.GetExtension(f), StringComparer.OrdinalIgnoreCase)).Select(f => (Path.GetFileName(f), Resolve(f)))] : []; }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return []; }
    }
    public string? Command(string name) => Entries().Where(e => string.Equals(e.name, name, StringComparison.OrdinalIgnoreCase)).Select(e => e.command).FirstOrDefault();

    static string Resolve(string file)
    {
        if (!file.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase)) return file;
        try
        {
            var t = Type.GetTypeFromProgID("WScript.Shell"); if (t is null) return file;
            dynamic sh = Activator.CreateInstance(t)!; dynamic l = sh.CreateShortcut(file); string target = l.TargetPath; string a = l.Arguments;
            return string.IsNullOrWhiteSpace(target) ? file : (a.Length > 0 ? $"\"{target}\" {a}" : $"\"{target}\"");
        }
        catch (Exception e) when (e is System.Runtime.InteropServices.COMException or InvalidCastException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { return file; }
    }
}
