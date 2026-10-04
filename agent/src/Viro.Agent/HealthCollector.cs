using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Management;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Viro.Agent;

/// <summary>
/// Collects the raw health snapshot. Facts only: scoring and diagnosis happen server-side.
/// Every section is isolated; a failure is recorded in collectionErrors and that section is omitted (never guessed).
/// </summary>
public static class HealthCollector
{
    static readonly string SystemRoot = Path.GetPathRoot(Environment.SystemDirectory)!;

    static List<ManagementBaseObject> Wmi(string ns, string wql)
    {
        using var s = new ManagementObjectSearcher(new ManagementScope($@"\\.\{ns}"), new ObjectQuery(wql));
        return [.. s.Get().Cast<ManagementBaseObject>()];
    }
    static string? Str(ManagementBaseObject? o, string p) => o?[p]?.ToString()?.Trim() is { Length: > 0 } v ? v : null;
    static double? Dbl(ManagementBaseObject? o, string p) => o?[p] is null ? null : Convert.ToDouble(o[p]);
    static bool? Bool(ManagementBaseObject? o, string p) => o?[p] is bool b ? b : null;

    public static async Task<Dictionary<string, object?>> CollectAsync(UpdateStateCache updates)
    {
        var errors = new List<string>();
        var timings = new System.Collections.Concurrent.ConcurrentDictionary<string, long>();
        T? Try<T>(string name, Func<T> f) { var sw = Stopwatch.StartNew(); try { return f(); } catch (Exception e) { lock (errors) errors.Add($"{name}: {e.GetType().Name}: {e.Message}"); return default; } finally { timings[name] = sw.ElapsedMilliseconds; } }
        object? TryBounded(string name, Func<object?> f, TimeSpan limit)
        {
            var sw = Stopwatch.StartNew(); var task = Task.Run(() => { try { return f(); } catch (Exception e) { lock (errors) errors.Add($"{name}: {e.GetType().Name}: {e.Message}"); return default; } });
            if (task.Wait(limit)) { timings[name] = sw.ElapsedMilliseconds; return task.Result; }
            lock (errors) errors.Add($"{name}: did not finish within {limit.TotalSeconds:0} s and was left out"); timings[name] = sw.ElapsedMilliseconds; return default;
        }

        var perfTask = Task.Run(() => Try("perf", Perf));
        // Slow, administrator-only sections (event logs, shadow copies) run beside the rest, each with a time limit, so one slow log can never hold up the whole report.
        var bootTask = Task.Run(() => TryBounded("boot", () => Care.BootHistory.Read() is { } b ? new { lastBootSeconds = b.Boots.FirstOrDefault()?.BootSeconds, lastBootAt = b.Boots.FirstOrDefault()?.At.ToString("O"), mainPathSeconds = b.Boots.FirstOrDefault()?.MainPathSeconds, postBootSeconds = b.Boots.FirstOrDefault()?.PostBootSeconds, history = b.Boots.Select(x => new { at = x.At.ToString("O"), seconds = x.BootSeconds }).ToList(), degrading = b.Degrading.Select(x => new { name = x.Name, seconds = x.DegradationSeconds }).ToList(), optimizableStartup = Try("startupItems", () => Care.StartupOptimizeRecipe.Items(new Repair.RepairEnv()).Count(i => i.Enabled && Care.StartupClassifier.Assess(i).Class == Care.StartupClass.SAFE_TO_DISABLE)), startupOptimizedAt = Try("startupMarker", () => { var p = Path.Combine(new Repair.RepairEnv().StateDir, Care.StartupOptimizeRecipe.MarkerFile); return File.Exists(p) ? File.ReadAllText(p).Trim() : null; }) } : null, TimeSpan.FromSeconds(60)));
        var resourcesTask = Task.Run(() => TryBounded("resources", () => { var r = Care.ResourceHealth.Collect(); return new { commitPercent = r.CommitPercent, commitUsedMb = r.CommitUsedMb, commitLimitMb = r.CommitLimitMb, ramTotalMb = r.RamTotalMb, topCommit = r.TopCommit.Select(x => new { name = x.Name, privateMb = x.PrivateMb, workingSetMb = x.WorkingSetMb, category = x.Category }).ToList(), lowVirtualMemory24h = r.LowVirtualMemory24h.Select(e => new { at = e.At.ToString("O"), top = e.Top.Select(t => new { name = t.name, mb = t.mb }).ToList() }).ToList(), failedShutdowns7d = r.FailedShutdowns7d, firmwareThrottle24h = r.FirmwareThrottle24h, securityEngines = r.SecurityEngines.Select(x => new { name = x.Name, memoryMb = x.MemoryMb }).ToList() }; }, TimeSpan.FromSeconds(60)));
        var backupTask = Task.Run(() => TryBounded("backup", () => Care.BackupCollector.Collect() is { } b ? new { lastWindowsBackupAt = b.LastWindowsBackupAt?.ToString("O"), lastWindowsBackupFailureAt = b.LastWindowsBackupFailureAt?.ToString("O"), newestRestorePointAt = b.NewestRestorePointAt?.ToString("O"), restorePoints = b.RestorePoints } : null, TimeSpan.FromSeconds(60)));
        var snap = new Dictionary<string, object?>
        {
            ["collectedAt"] = DateTime.UtcNow.ToString("O"),
            ["memory"] = Try("memory", Memory),
            ["volumes"] = Try("volumes", Volumes),
            ["physicalDisks"] = Try("physicalDisks", PhysicalDisks),
            ["startup"] = Try("startup", Startup),
            ["processes"] = Try("processes", Processes),
            ["failedServices"] = Try("services", FailedServices),
            ["defender"] = Try("defender", Defender),
            ["avProducts"] = Try("avProducts", AvProducts),
            ["firewall"] = Try("firewall", Firewall),
            ["crashes"] = Try("crashes", Crashes),
            ["unexpectedShutdowns7d"] = Try("kernelPower", UnexpectedShutdowns),
            ["driverErrors"] = Try("drivers", DriverErrors),
            ["stability"] = Try("stability", StabilityCollector.Collect),
            ["updateSearchStuckMinutes"] = updates.StuckMinutes,
            ["security"] = Try("security", SecurityCollector.Collect),
            ["care"] = Try("care", Care.CareRuntime.State),
            ["printing"] = Try("printing", Care.PrintingFacts.Collect),
            ["startupItems"] = Try("startupItems", () => Care.StartupOptimizeRecipe.Items(new Repair.RepairEnv()).Select(i => { var a = Care.StartupClassifier.Assess(i); return new { location = i.Location, name = i.Name, command = i.Command.Length > 240 ? i.Command[..240] : i.Command, enabled = i.Enabled, cls = a.Class.ToString(), reason = a.Reason }; }).ToList()),
            ["os"] = Try("os", () => { var o = Collectors.Os(); return new { caption = o.Caption, build = o.Build }; }),
            ["updates"] = updates.Latest is { } u ? u with { RebootRequired = RebootRequired() } : null,
        };
        snap["perf"] = await perfTask; snap["boot"] = await bootTask; snap["resources"] = await resourcesTask; snap["backup"] = await backupTask;
        snap["collectionTimingsMs"] = timings.ToDictionary(k => k.Key, k => k.Value);
        if (updates.LastError is { } ue) errors.Add("updates: " + ue);
        snap["collectionErrors"] = errors;
        return snap;
    }

    // ---- performance ----------------------------------------------------------------
    static object Perf()
    {
        double? Avg(Func<double?> read, int n = 3) { var v = new List<double>(); for (var i = 0; i < n; i++) { if (read() is { } x) v.Add(x); Thread.Sleep(1000); } return v.Count > 0 ? Math.Round(v.Average(), 1) : null; }
        using var cpu = Make("Processor", "% Processor Time", "_Total");
        using var freq = Make("Processor Information", "% of Maximum Frequency", "_Total");
        using var lat = Make("PhysicalDisk", "Avg. Disk sec/Transfer", "_Total");
        using var q = Make("PhysicalDisk", "Current Disk Queue Length", "_Total");
        cpu?.NextValue(); freq?.NextValue(); lat?.NextValue(); q?.NextValue(); Thread.Sleep(1000);
        var m = new Native.MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<Native.MEMORYSTATUSEX>() };
        Native.GlobalMemoryStatusEx(ref m);
        var latMs = Avg(() => lat is null ? null : lat.NextValue() * 1000.0);
        return new
        {
            cpuAvgPercent = Avg(() => cpu?.NextValue()),
            cpuFrequencyPercent = Avg(() => freq?.NextValue(), 2),
            ramPercent = (double)m.dwMemoryLoad,
            commitPercent = m.ullTotalPageFile > 0 ? Math.Round(100.0 * (m.ullTotalPageFile - m.ullAvailPageFile) / m.ullTotalPageFile, 1) : (double?)null,
            diskLatencyMs = latMs,
            diskQueue = Avg(() => q?.NextValue(), 2),
        };
    }
    static PerformanceCounter? Make(string cat, string counter, string inst)
    {
        try { return new PerformanceCounter(cat, counter, inst, readOnly: true); } catch { return null; }
    }

    static object Memory()
    {
        var m = new Native.MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<Native.MEMORYSTATUSEX>() };
        if (!Native.GlobalMemoryStatusEx(ref m)) throw new InvalidOperationException("GlobalMemoryStatusEx failed");
        return new { totalBytes = (long)m.ullTotalPhys, availableBytes = (long)m.ullAvailPhys };
    }

    static object Volumes() => DriveInfo.GetDrives().Where(d => d.DriveType == DriveType.Fixed && d.IsReady)
        .Select(d => new { name = d.Name.TrimEnd('\\'), totalBytes = d.TotalSize, freeBytes = d.AvailableFreeSpace, isSystem = string.Equals(d.Name, SystemRoot, StringComparison.OrdinalIgnoreCase) }).ToList();

    // ---- storage health ---------------------------------------------------------------
    static object PhysicalDisks()
    {
        const string ns = @"root\Microsoft\Windows\Storage";
        var boot = new HashSet<string>();
        try { foreach (var d in Wmi(ns, "SELECT Number,IsBoot FROM MSFT_Disk")) if (Bool(d, "IsBoot") == true) boot.Add(Str(d, "Number")!); } catch { /* optional */ }
        var rel = new Dictionary<string, ManagementBaseObject>();
        try { foreach (var r in Wmi(ns, "SELECT DeviceId,Temperature,Wear,ReadErrorsUncorrected,WriteErrorsUncorrected,PowerOnHours FROM MSFT_StorageReliabilityCounter")) if (Str(r, "DeviceId") is { } id) rel[id] = r; } catch { /* optional: needs supported drive/driver */ }
        var all = Wmi(ns, "SELECT DeviceId,FriendlyName,MediaType,HealthStatus,Size FROM MSFT_PhysicalDisk");
        return all.Select(p =>
        {
            var id = Str(p, "DeviceId");
            rel.TryGetValue(id ?? "", out var r);
            return new
            {
                name = Str(p, "FriendlyName"),
                mediaType = Convert.ToInt32(p["MediaType"] ?? 0) switch { 3 => "HDD", 4 => "SSD", 5 => "SCM", _ => "Unspecified" },
                health = Convert.ToInt32(p["HealthStatus"] ?? 5) switch { 0 => "Healthy", 1 => "Warning", 2 => "Unhealthy", _ => (string?)null },
                sizeBytes = Dbl(p, "Size"),
                temperatureC = Dbl(r, "Temperature") is > 0 and var t ? t : (double?)null,
                wearPercent = Dbl(r, "Wear"),
                readErrorsUncorrected = Dbl(r, "ReadErrorsUncorrected"),
                writeErrorsUncorrected = Dbl(r, "WriteErrorsUncorrected"),
                powerOnHours = Dbl(r, "PowerOnHours"),
                isSystem = id is not null && boot.Contains(id),
            };
        }).ToList();
    }

    // ---- startup, processes, services ---------------------------------------------------
    static object Startup() => Wmi(@"root\cimv2", "SELECT Name,Command,Location FROM Win32_StartupCommand")
        .Select(s => new { name = Str(s, "Name") ?? "(unnamed)", command = Str(s, "Command"), location = Str(s, "Location") }).ToList();

    static object Processes()
    {
        var groups = new Dictionary<string, (int n, long ws)>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in Process.GetProcesses())
        {
            using (p)
            {
                try { var (n, ws) = groups.GetValueOrDefault(p.ProcessName); groups[p.ProcessName] = (n + 1, ws + p.WorkingSet64); } catch { /* process exited / access denied */ }
            }
        }
        return groups.OrderByDescending(g => g.Value.ws).Take(40).Select(g => new { name = g.Key, count = g.Value.n, workingSetBytes = g.Value.ws }).ToList();
    }

    static object FailedServices() => Wmi(@"root\cimv2", "SELECT Name,DisplayName,ExitCode FROM Win32_Service WHERE StartMode='Auto' AND State='Stopped'")
        .Where(s => Convert.ToInt32(s["ExitCode"] ?? 0) is not (0 or 1077)) // 0 = clean stop, 1077 = trigger/never-started
        .Select(s => new { name = Str(s, "Name")!, displayName = Str(s, "DisplayName"), exitCode = Dbl(s, "ExitCode") }).Take(50).ToList();

    // ---- security -----------------------------------------------------------------------
    static object? Defender()
    {
        var st = Wmi(@"root\Microsoft\Windows\Defender", "SELECT AntivirusEnabled,RealTimeProtectionEnabled,AntivirusSignatureAge,QuickScanAge FROM MSFT_MpComputerStatus").FirstOrDefault();
        if (st is null) return null;
        int? threats = null;
        try { threats = Wmi(@"root\Microsoft\Windows\Defender", "SELECT IsActive FROM MSFT_MpThreat").Count(t => Bool(t, "IsActive") == true); } catch { /* optional */ }
        static double? Days(double? d) => d is null or >= 4294967295 ? null : d; // 0xFFFFFFFF = never
        return new { antivirusEnabled = Bool(st, "AntivirusEnabled"), realTimeProtection = Bool(st, "RealTimeProtectionEnabled"), signatureAgeDays = Days(Dbl(st, "AntivirusSignatureAge")), quickScanAgeDays = Days(Dbl(st, "QuickScanAge")), activeThreats = threats };
    }

    static object AvProducts() => Wmi(@"root\SecurityCenter2", "SELECT displayName FROM AntiVirusProduct").Select(a => Str(a, "displayName")).Where(n => n is not null).ToList();

    static object Firewall()
    {
        bool? Profile(string n) => Registry.GetValue($@"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\{n}", "EnableFirewall", null) is int v ? v == 1 : null;
        return new { domain = Profile("DomainProfile"), @private = Profile("StandardProfile"), @public = Profile("PublicProfile") };
    }

    // ---- reliability ----------------------------------------------------------------------
    static object Crashes()
    {
        var result = new Dictionary<(string app, string kind), (int n, DateTime last)>();
        var q = new EventLogQuery("Application", PathType.LogName, "*[System[((Provider[@Name='Application Error'] and EventID=1000) or (Provider[@Name='Application Hang'] and EventID=1002)) and TimeCreated[timediff(@SystemTime) <= 604800000]]]");
        using var r = new EventLogReader(q);
        for (var e = r.ReadEvent(); e != null; e = r.ReadEvent())
            using (e)
            {
                var kind = e.Id == 1002 ? "hang" : "crash";
                var app = e.Properties.Count > 0 ? e.Properties[0].Value?.ToString() : null;
                if (string.IsNullOrWhiteSpace(app)) continue;
                var key = (app, kind); var cur = result.GetValueOrDefault(key);
                result[key] = (cur.n + 1, e.TimeCreated is { } t && t > cur.last ? t : cur.last);
            }
        return result.OrderByDescending(x => x.Value.n).Take(50).Select(x => new { app = x.Key.app, kind = x.Key.kind, count = x.Value.n, lastAt = x.Value.last == default ? null : x.Value.last.ToUniversalTime().ToString("O") }).ToList();
    }

    static int UnexpectedShutdowns()
    {
        var q = new EventLogQuery("System", PathType.LogName, "*[System[Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=41) and TimeCreated[timediff(@SystemTime) <= 604800000]]]");
        using var r = new EventLogReader(q);
        var n = 0;
        for (var e = r.ReadEvent(); e != null; e = r.ReadEvent()) { using (e) n++; }
        return n;
    }

    static object DriverErrors() => Wmi(@"root\cimv2", "SELECT Name,ConfigManagerErrorCode FROM Win32_PnPEntity WHERE ConfigManagerErrorCode <> 0")
        .Select(d => (name: Str(d, "Name") ?? "Unknown device", code: Convert.ToInt32(d["ConfigManagerErrorCode"])))
        .Where(d => d.code is not (22 or 24)) // 22 = disabled by user, 24 = not present
        .Select(d => new { d.name, d.code }).Take(50).ToList();

    static bool? RebootRequired()
    {
        try
        {
            using var hk = Registry.LocalMachine;
            return hk.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired") is not null
                || hk.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") is not null;
        }
        catch { return null; }
    }
}

public sealed record UpdateState(int PendingCount, int PendingCriticalCount, List<string> PendingTitles, bool? RebootRequired, int? LastInstallDays);

/// <summary>Windows Update Agent search can take minutes, so it refreshes in the background and snapshots use the latest result.</summary>
public sealed class UpdateStateCache
{
    static readonly TimeSpan MaxAge = TimeSpan.FromHours(6);
    DateTime _at = DateTime.MinValue;
    DateTime _startedAt;
    int _running;

    /// <summary>Minutes the current Windows Update search has been running, once it exceeds 10 (a normal search finishes in seconds to a couple of minutes).</summary>
    public int? StuckMinutes => _running == 1 && DateTime.UtcNow - _startedAt > TimeSpan.FromMinutes(10) ? (int)(DateTime.UtcNow - _startedAt).TotalMinutes : null;
    public UpdateState? Latest { get; private set; }
    public string? LastError { get; private set; }

    public void RefreshIfStale()
    {
        if (DateTime.UtcNow - _at < MaxAge || Interlocked.Exchange(ref _running, 1) == 1) return;
        _startedAt = DateTime.UtcNow;
        _ = Task.Run(() =>
        {
            try { Latest = Search(); LastError = null; _at = DateTime.UtcNow; }
            catch (Exception e) { LastError = $"{e.GetType().Name}: {e.Message}"; _at = DateTime.UtcNow - MaxAge + TimeSpan.FromMinutes(15); }
            finally { Interlocked.Exchange(ref _running, 0); }
        });
    }

    static UpdateState Search()
    {
        var t = Type.GetTypeFromProgID("Microsoft.Update.Session") ?? throw new InvalidOperationException("Windows Update Agent unavailable");
        dynamic session = Activator.CreateInstance(t)!;
        dynamic searcher = session.CreateUpdateSearcher();
        dynamic found = searcher.Search("IsInstalled=0 and IsHidden=0");
        int pending = 0, critical = 0; var titles = new List<string>();
        foreach (dynamic u in found.Updates)
        {
            pending++;
            var isCritical = false;
            foreach (dynamic c in u.Categories) { string n = c.Name; if (n is "Critical Updates" or "Security Updates") isCritical = true; }
            if (isCritical) critical++;
            if (titles.Count < 20) titles.Add((string)u.Title);
        }
        int? lastDays = null;
        try
        {
            int total = searcher.GetTotalHistoryCount();
            dynamic hist = searcher.QueryHistory(0, Math.Min(total, 100));
            DateTime? newest = null;
            foreach (dynamic h in hist) if ((int)h.Operation == 1 && (int)h.ResultCode == 2) { var d = (DateTime)h.Date; if (newest is null || d > newest) newest = d; }
            if (newest is { } n) lastDays = (int)(DateTime.Now - n.ToLocalTime()).TotalDays;
        }
        catch { /* history is optional */ }
        return new(pending, critical, titles, null, lastDays);
    }
}
