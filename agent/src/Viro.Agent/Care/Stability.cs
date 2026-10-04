using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Text.Json;
using System.Text.RegularExpressions;
using Viro.Agent.Repair;

namespace Viro.Agent.Care;

/// <summary>A program whose window has stopped answering right now.</summary>
public sealed record HungApp(int Pid, string Name, string Title, DateTime StartedUtc, string? Path);
/// <summary>One likely reason Windows crashes or stops responding, with what Windows recorded and what Viro can do about it. Recipe is null when the fix is something only a person can do.</summary>
public sealed record StabilityCause(string Code, string Title, string Detail, string Confidence, string? Recipe, string? RecipeLabel);
public sealed record StabilityEvidence(int BlueScreens, IReadOnlyList<(string code, int times)> BugCheckCodes, int UnexpectedRestarts, int DiskErrors, int HardwareErrors, int DisplayDriverResets, int OutOfMemory, int ShellCrashes, int Freezes, DateTime? LastBlueScreen);

/// <summary>What Windows itself recorded about crashes, restarts and freezes, turned into plain-language likely causes. Reads the System and Application logs; no rights beyond a normal user are needed for most of it.</summary>
public static class StabilityReader
{
    static readonly Dictionary<string, (string meaning, string area)> BugChecks = new(StringComparer.OrdinalIgnoreCase)
    {
        ["0x0000000a"] = ("a driver touched memory it should not (IRQL_NOT_LESS_OR_EQUAL)", "driver"), ["0x000000d1"] = ("a driver used memory at the wrong time (DRIVER_IRQL_NOT_LESS_OR_EQUAL)", "driver"),
        ["0x0000003b"] = ("a system service failed (SYSTEM_SERVICE_EXCEPTION)", "driver"), ["0x0000001a"] = ("memory management failed (MEMORY_MANAGEMENT)", "memory"),
        ["0x00000050"] = ("Windows read memory that is not there (PAGE_FAULT_IN_NONPAGED_AREA)", "memory"), ["0x0000007e"] = ("a system thread failed (SYSTEM_THREAD_EXCEPTION_NOT_HANDLED)", "driver"),
        ["0x000000f4"] = ("a critical Windows process died (CRITICAL_OBJECT_TERMINATION)", "disk"), ["0x00000124"] = ("the hardware reported an error (WHEA_UNCORRECTABLE_ERROR)", "hardware"),
        ["0x0000009f"] = ("a driver did not handle sleep or wake (DRIVER_POWER_STATE_FAILURE)", "driver"), ["0x00000133"] = ("a driver took too long (DPC_WATCHDOG_VIOLATION)", "driver"),
        ["0x00000139"] = ("Windows found corrupted data (KERNEL_SECURITY_CHECK_FAILURE)", "driver"), ["0x000000c2"] = ("a driver used memory badly (BAD_POOL_CALLER)", "driver"),
        ["0x0000007a"] = ("Windows could not read data it needed (KERNEL_DATA_INPAGE_ERROR)", "disk"), ["0x00000116"] = ("the graphics driver stopped responding (VIDEO_TDR_FAILURE)", "graphics"),
        ["0x00000117"] = ("the graphics driver stopped responding (VIDEO_TDR_TIMEOUT_DETECTED)", "graphics"), ["0x0000000e"] = ("a hardware or driver fault (KMODE_EXCEPTION_NOT_HANDLED)", "driver"),
    };

    static string Window(int days) => $"TimeCreated[timediff(@SystemTime) <= {days * 86400000L}]";
    static List<EventRecord> Read(string log, string xpath, int max = 500)
    {
        var o = new List<EventRecord>();
        try
        {
            using var r = new EventLogReader(new EventLogQuery(log, PathType.LogName, xpath) { ReverseDirection = true });
            for (var i = 0; i < max; i++) { var e = r.ReadEvent(); if (e is null) break; o.Add(e); }
        }
        catch (Exception e) when (e is UnauthorizedAccessException or EventLogException) { /* not readable: counted as nothing seen */ }
        return o;
    }
    static int Count(string log, string xpath) { var l = Read(log, xpath); var n = l.Count; foreach (var e in l) e.Dispose(); return n; }

    public static StabilityEvidence Collect(int days = 30)
    {
        var w = Window(days); var codes = new Dictionary<string, int>(); DateTime? last = null; var blue = 0;
        foreach (var e in Read("System", $"*[System[Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting'] and EventID=1001 and {w}]]"))
        {
            using (e)
            {
                blue++; last ??= e.TimeCreated?.ToUniversalTime();
                var m = e.Properties.Count > 0 ? Regex.Match(e.Properties[0].Value?.ToString() ?? "", @"0x[0-9a-fA-F]+") : Match.Empty;
                if (m.Success) { var c = "0x" + m.Value[2..].PadLeft(8, '0').ToLowerInvariant(); codes[c] = codes.GetValueOrDefault(c) + 1; }
            }
        }
        var power = Count("System", $"*[System[Provider[@Name='Microsoft-Windows-Kernel-Power'] and EventID=41 and {w}]]");
        var disk = Count("System", $"*[System[(Provider[@Name='disk'] and (EventID=7 or EventID=11 or EventID=15 or EventID=51 or EventID=153)) and {w}]]") + Count("System", $"*[System[Provider[@Name='Ntfs'] and (EventID=55 or EventID=98) and {w}]]");
        var whea = Count("System", $"*[System[Provider[@Name='Microsoft-Windows-WHEA-Logger'] and {w}]]");
        var tdr = Count("System", $"*[System[Provider[@Name='Display'] and EventID=4101 and {w}]]");
        var oom = Count("System", $"*[System[Provider[@Name='Microsoft-Windows-Resource-Exhaustion-Detector'] and EventID=2004 and {w}]]");
        var shell = 0; var hang = 0;
        foreach (var e in Read("Application", $"*[System[(Provider[@Name='Application Error'] or Provider[@Name='Application Hang']) and (EventID=1000 or EventID=1002) and {w}]]"))
            using (e)
            {
                var exe = (e.Properties.Count > 0 ? e.Properties[0].Value?.ToString() ?? "" : "").ToLowerInvariant();
                if (Regex.IsMatch(exe, @"explorer\.exe|shellexperiencehost|startmenuexperiencehost|searchhost|searchui|textinputhost|sihost|dwm\.exe")) shell++;
                if (e.Id == 1002) hang++;
            }
        return new(blue, [.. codes.OrderByDescending(x => x.Value).Select(x => (x.Key, x.Value))], power, disk, whea, tdr, oom, shell, hang, last);
    }

    /// <summary>Turns the evidence into likely causes, most likely first. Each cause names what Windows recorded; nothing is guessed from silence.</summary>
    public static List<StabilityCause> Analyse(StabilityEvidence e, int days = 30)
    {
        var o = new List<StabilityCause>();
        if (e.DiskErrors > 0) o.Add(new("disk", "The disk is reporting errors", $"Windows recorded {e.DiskErrors} disk error(s) in {days} days. A failing or damaged drive makes Windows freeze, crash and corrupt files. Back up your files first.", e.DiskErrors >= 3 ? "high" : "medium", "disk.check", "Check the disk now"));
        if (e.HardwareErrors > 0) o.Add(new("hardware", "The hardware reported errors", $"Windows' hardware error log has {e.HardwareErrors} entr{(e.HardwareErrors == 1 ? "y" : "ies")} (processor, memory or motherboard). Overheating and dust are common causes; a repair shop can check the parts.", e.HardwareErrors >= 3 ? "high" : "medium", null, null));
        var area = e.BugCheckCodes.Select(c => (c.code, c.times, info: BugChecks.TryGetValue(c.code, out var i) ? i : ("an error Windows labelled " + c.code, "unknown"))).ToList();
        var mem = area.Where(a => a.info.Item2 == "memory").Sum(a => a.times);
        if (mem > 0) o.Add(new("memory", "The memory (RAM) may be faulty", $"{mem} blue screen(s) point at memory ({string.Join(", ", area.Where(a => a.info.Item2 == "memory").Select(a => a.info.Item1))}). A memory test at the next restart can confirm it.", "medium", "windows.memory-test", "Test memory at next restart"));
        var drv = area.Where(a => a.info.Item2 is "driver" or "graphics").Sum(a => a.times) + e.DisplayDriverResets;
        if (drv > 0) o.Add(new("driver", "A driver is misbehaving", $"{drv} crash(es) or driver reset(s) point at a driver ({(e.DisplayDriverResets > 0 ? e.DisplayDriverResets + " graphics driver reset(s); " : "")}{string.Join(", ", area.Where(a => a.info.Item2 is "driver" or "graphics").Select(a => a.info.Item1)).Replace("a driver ", "a driver ")}). Updating drivers usually fixes it: use Updates and drivers.", drv >= 3 ? "high" : "medium", null, null));
        var dk = area.Where(a => a.info.Item2 == "disk").Sum(a => a.times);
        if (dk > 0 && e.DiskErrors == 0) o.Add(new("disk-crash", "Windows could not read its own files", $"{dk} blue screen(s) were about reading data. Check the disk and repair system files.", "medium", "windows.sfc", "Repair Windows system files"));
        if (e.ShellCrashes >= 2) o.Add(new("shell", "The desktop (Explorer, Start menu or search) keeps crashing", $"{e.ShellCrashes} crash(es) of Windows' own desktop programs in {days} days. Resetting the desktop and its caches fixes most of these.", e.ShellCrashes >= 4 ? "high" : "medium", "shell.repair", "Repair the Windows desktop"));
        if (e.OutOfMemory > 0) o.Add(new("ram-full", "The PC ran out of memory", $"Windows recorded running out of memory {e.OutOfMemory} time(s); programs freeze or close when that happens. Close heavy programs or add RAM.", "medium", "memory.trim-idle", "Free memory held by idle programs"));
        if (e.UnexpectedRestarts > 0 && e.BlueScreens == 0 && e.DiskErrors == 0 && e.HardwareErrors == 0) o.Add(new("power", "The PC switched off or restarted without warning", $"{e.UnexpectedRestarts} unexpected restart(s) with no crash recorded: usually power, overheating or a battery/charger fault, sometimes Fast Startup. Turning off Fast Startup is a safe thing to try.", "medium", "power.fast-startup-off", "Turn off Fast Startup"));
        if (e.Freezes >= 3) o.Add(new("freezes", "Programs keep freezing", $"{e.Freezes} program freeze(s) in {days} days. Repair the ones that repeat from Repair programs; frozen ones can be closed below.", "medium", null, null));
        if (o.Count == 0) o.Add(new("none", "No crash pattern found", e.UnexpectedRestarts + e.BlueScreens + e.Freezes == 0 ? $"Windows recorded no blue screens, unexpected restarts or freezes in {days} days." : "Windows recorded a few events, but not enough of one kind to point at a cause.", "low", null, null));
        return o;
    }

    public static string Describe(string code) => BugChecks.TryGetValue(code, out var i) ? i.meaning : "an error Windows labelled " + code;
}

public static class HungApps
{
    static readonly Regex Never = new(@"^(explorer|winlogon|csrss|dwm|lsass|services|svchost|smss|wininit|system|registry|fontdrvhost|sihost|ctfmon|viro-agent|viro-compute)$", RegexOptions.IgnoreCase);

    /// <summary>Programs with a window that has stopped answering. Windows' own parts and Viro are never listed (the desktop has its own repair).</summary>
    public static List<HungApp> List()
    {
        var o = new List<HungApp>(); var win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        foreach (var p in Process.GetProcesses())
        {
            using (p)
            {
                try
                {
                    if (p.MainWindowHandle == IntPtr.Zero || p.Responding || Never.IsMatch(p.ProcessName)) continue;
                    string? path = null; try { path = p.MainModule?.FileName; } catch { /* protected process */ }
                    if (path is not null && path.StartsWith(win, StringComparison.OrdinalIgnoreCase)) continue;
                    o.Add(new(p.Id, p.ProcessName, p.MainWindowTitle, p.StartTime.ToUniversalTime(), path));
                }
                catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { /* it exited, or it is not ours to inspect */ }
            }
        }
        return o;
    }

    public static bool Kill(int pid) { try { using var p = Process.GetProcessById(pid); p.Kill(true); return p.WaitForExit(5000); } catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { return false; } }
}

// ---------------------------------------------------------------------------------------------------------------------
/// <summary>apps.end-hung { pids }: closes programs that have stopped responding. Each is re-checked first (same program, still frozen) so a recycled process id can never close the wrong thing. Anything unsaved in a frozen program is already out of reach.</summary>
public sealed class EndHungAppsRecipe(Func<IReadOnlyList<HungApp>>? list = null, Func<int, bool>? kill = null) : IRepairRecipe
{
    public string Id => "apps.end-hung"; public string Title => "Close programs that have stopped responding";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => false;
    readonly Func<IReadOnlyList<HungApp>> now = list ?? (() => HungApps.List());
    readonly Func<int, bool> end = kill ?? HungApps.Kill;

    List<HungApp> Targets(RepairContext c)
    {
        if (c.Options.ValueKind != JsonValueKind.Object || !c.Options.TryGetProperty("pids", out var p) || p.ValueKind != JsonValueKind.Array) throw new ArgumentException("options.pids is required");
        var want = p.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.Number).Select(x => x.GetInt32()).ToHashSet();
        return [.. now().Where(h => want.Contains(h.Pid))];
    }
    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var t = Targets(c);
        return Task.FromResult(new Finding(t.Count > 0, t.Count == 0 ? "none of the chosen programs is frozen any more" : $"{t.Count} frozen program(s) will be closed: {string.Join(", ", t.Select(x => x.Name))}", t));
    }
    public Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var failed = new List<string>();
        foreach (var h in (List<HungApp>)f.Before!) if (!end(h.Pid)) failed.Add(h.Name);
        c.After = new { closed = ((List<HungApp>)f.Before!).Count - failed.Count, failed };
        if (failed.Count > 0 && failed.Count == ((List<HungApp>)f.Before!).Count) throw new InvalidOperationException("Windows would not close: " + string.Join(", ", failed));
        return Task.CompletedTask;
    }
    public Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var still = now().Where(h => ((List<HungApp>)f.Before!).Any(t => t.Pid == h.Pid && t.StartedUtc == h.StartedUtc)).Select(h => h.Name).ToList();
        return Task.FromResult((still.Count == 0, still.Count == 0 ? "the frozen programs are closed; open them again when you need them" : "still running: " + string.Join(", ", still)));
    }
    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct) => Task.CompletedTask;
}

/// <summary>shell.repair: resets the Windows desktop when it keeps crashing or freezing: clears the icon and thumbnail caches, re-registers the Start menu, search and shell components, then restarts Explorer. Nothing of yours is touched.</summary>
public sealed class ShellRepairRecipe : IRepairRecipe
{
    public string Id => "shell.repair"; public string Title => "Repair the Windows desktop (Start menu, search, icons)";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => false;
    const string Pkgs = "Microsoft.Windows.ShellExperienceHost,Microsoft.Windows.StartMenuExperienceHost,MicrosoftWindows.Client.CBS,Microsoft.Windows.Search,MicrosoftWindows.Client.Core,Microsoft.UI.Xaml.CBS";

    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct) => Task.FromResult(new Finding(true, "the icon and thumbnail caches will be rebuilt and the Start menu and search components re-registered; Explorer restarts (open folder windows close)"));

    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var steps = new List<string>();
        // Windows rebuilds both caches by itself; a damaged one is a classic cause of a crashing or frozen desktop.
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        foreach (var pat in new[] { "IconCache.db" }) TryDelete(Path.Combine(local, pat));
        var ex = Path.Combine(local, "Microsoft", "Windows", "Explorer");
        if (Directory.Exists(ex)) foreach (var file in Directory.EnumerateFiles(ex, "*cache_*.db").Concat(Directory.EnumerateFiles(ex, "iconcache_*.db"))) TryDelete(file);
        var r = await c.Proc.RunAsync("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"foreach($n in '{Pkgs}'.Split(',')){{ Get-AppxPackage -Name $n -ErrorAction SilentlyContinue | ForEach-Object {{ Add-AppxPackage -DisableDevelopmentMode -Register ($_.InstallLocation + '\\AppxManifest.xml') -ErrorAction SilentlyContinue }} }}\"", TimeSpan.FromMinutes(5), ct);
        steps.Add(r.ExitCode == 0 ? "shell components re-registered" : "re-registering shell components did not fully succeed");
        await ShellRestart.RestartAsync(c.Proc, ct); steps.Add("Explorer restarted");
        c.After = new { steps };
    }

    static void TryDelete(string f) { try { File.Delete(f); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { /* in use: Windows recreates it after the restart */ } }

    public async Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var ok = await ShellRestart.ExplorerRespondingAsync(TimeSpan.FromSeconds(20), ct);
        return (ok, ok ? "the Windows desktop is running and answering" : "Explorer did not come back; sign out and in, or restart the PC");
    }
    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct) => Task.CompletedTask;
}

public static class ShellRestart
{
    public static async Task RestartAsync(IProcessRunner proc, CancellationToken ct)
    {
        await proc.RunAsync("taskkill.exe", "/F /IM explorer.exe", TimeSpan.FromSeconds(20), ct);
        await Task.Delay(1500, ct);
        if (!Process.GetProcessesByName("explorer").Any()) { try { Process.Start(new ProcessStartInfo("explorer.exe") { UseShellExecute = true }); } catch (System.ComponentModel.Win32Exception) { /* Windows restarts the shell by itself */ } }
    }
    public static async Task<bool> ExplorerRespondingAsync(TimeSpan within, CancellationToken ct)
    {
        var until = DateTime.UtcNow + within;
        while (DateTime.UtcNow < until)
        {
            foreach (var p in Process.GetProcessesByName("explorer")) using (p) { try { if (p.Responding) return true; } catch (InvalidOperationException) { } }
            await Task.Delay(1000, ct);
        }
        return false;
    }
}

/// <summary>windows.memory-test: schedules Windows' own memory test for the next restart (nothing runs until then). Undo cancels it.</summary>
public sealed class MemoryTestRecipe : IRepairRecipe
{
    public string Id => "windows.memory-test"; public string Title => "Test the memory (RAM) at the next restart";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => true;
    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct) => Task.FromResult(new Finding(true, "Windows' memory test will run when the PC next restarts (about 10 to 20 minutes), then Windows starts normally and shows the result"));
    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var r = await c.Proc.RunAsync("bcdedit.exe", "/bootsequence {memdiag}", TimeSpan.FromSeconds(30), ct);
        if (r.ExitCode != 0) throw new InvalidOperationException("Windows would not schedule the test: " + r.Output.Trim().Split('\n').FirstOrDefault()?.Trim());
        c.RebootRequired = true; c.RollbackState["scheduled"] = true; c.After = new { scheduled = true };
    }
    public async Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var r = await c.Proc.RunAsync("bcdedit.exe", "/enum {bootmgr}", TimeSpan.FromSeconds(30), ct);
        var ok = r.ExitCode == 0 && Regex.IsMatch(r.Output, @"bootsequence\s+\{memdiag\}|bootsequence.*memdiag", RegexOptions.IgnoreCase);
        return (ok, ok ? "the memory test is scheduled for the next restart" : "Windows did not show the test as scheduled");
    }
    public async Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct) => await c.Proc.RunAsync("bcdedit.exe", "/deletevalue {bootmgr} bootsequence", TimeSpan.FromSeconds(30), ct);
}

/// <summary>power.fast-startup-off: turns off Fast Startup, a Windows feature that keeps part of the system in a half-asleep state between shut-downs and is a common cause of odd freezes, failed restarts and strange behaviour after "shut down". Reversible.</summary>
public sealed class FastStartupOffRecipe : IRepairRecipe
{
    public string Id => "power.fast-startup-off"; public string Title => "Turn off Fast Startup (cleaner restarts, fewer freezes)";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => true;
    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct) { var on = c.Env.FastStartupEnabled(); return Task.FromResult(new Finding(on == true, on == true ? "Fast Startup is on; a full shut-down will give Windows a clean start each time (start-up can be a little slower on a mechanical drive)" : on == false ? "Fast Startup is already off" : "Fast Startup is not available on this PC", new { previous = on })); }
    public Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct) { c.RollbackState["previous"] = 1; c.Env.SetFastStartup(false); return Task.CompletedTask; }
    public Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct) { var on = c.Env.FastStartupEnabled(); return Task.FromResult((on == false, on == false ? "Fast Startup is off" : "Fast Startup is still on")); }
    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct) { c.Env.SetFastStartup(true); return Task.CompletedTask; }
}
