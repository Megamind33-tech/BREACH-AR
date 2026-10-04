using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace Viro.Agent.Care;

public sealed record CommitConsumer(string Name, double PrivateMb, double WorkingSetMb, string Category);
public sealed record LowMemoryEvent(DateTime At, IReadOnlyList<(string name, double mb)> Top);
public sealed record EngineMemory(string Name, double MemoryMb);
public sealed record ResourceFacts(double? CommitPercent, double? CommitUsedMb, double? CommitLimitMb, double RamTotalMb, IReadOnlyList<CommitConsumer> TopCommit, IReadOnlyList<LowMemoryEvent> LowVirtualMemory24h,
    int? FailedShutdowns7d, int? FirmwareThrottle24h, IReadOnlyList<EngineMemory> SecurityEngines);

/// <summary>
/// What actually exhausts a PC. Memory trouble is usually not "working set" (what is in RAM right now) but commit: the memory programs have promised
/// themselves, backed by RAM plus the page file. A leaking program can use gigabytes of commit while idle, and trimming its working set does not
/// give any of it back. This reads the real numbers, and the evidence Windows itself recorded (low-virtual-memory diagnoses, failed shutdowns,
/// firmware throttling), so a finding can name the program responsible.
/// </summary>
public static partial class ResourceHealth
{
    [StructLayout(LayoutKind.Sequential)] struct PERFORMANCE_INFORMATION { public uint cb; public nuint CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable, SystemCache, KernelTotal, KernelPaged, KernelNonpaged, PageSize; public uint HandleCount, ProcessCount, ThreadCount; }
    [DllImport("psapi.dll")] static extern bool GetPerformanceInfo(out PERFORMANCE_INFORMATION p, uint size);

    /// <summary>System commit used and limit in MB, and the percentage. Null if Windows does not answer.</summary>
    public static (double usedMb, double limitMb, double percent, double ramMb)? Commit()
    {
        if (!GetPerformanceInfo(out var p, (uint)Marshal.SizeOf<PERFORMANCE_INFORMATION>()) || p.CommitLimit == 0) return null;
        double mb(nuint pages) => (double)pages * (double)p.PageSize / 1048576.0;
        return (Math.Round(mb(p.CommitTotal)), Math.Round(mb(p.CommitLimit)), Math.Round((double)p.CommitTotal / (double)p.CommitLimit * 100, 1), Math.Round(mb(p.PhysicalTotal)));
    }

    [GeneratedRegex(@"([\w.\- ]+?\.exe) \((\d+)\) consumed (\d+) bytes")] private static partial Regex Consumed();
    /// <summary>"The following programs consumed the most virtual memory: Grammarly.Desktop.exe (13844) consumed 5097779200 bytes, chrome.exe ..." as (name, MB).</summary>
    public static List<(string name, double mb)> ParseExhaustion(string message) =>
        [.. Consumed().Matches(message ?? "").Select(m => (Regex.Replace(m.Groups[1].Value.Trim(), @"^and\s+", ""), Math.Round(double.Parse(m.Groups[3].Value) / 1048576.0)))];

    static EventLogReader? Query(string log, string xpath) { try { return new EventLogReader(new EventLogQuery(log, PathType.LogName, xpath) { ReverseDirection = true }); } catch (Exception e) when (e is EventLogException or UnauthorizedAccessException) { return null; } }
    static string Window(TimeSpan span) => $"TimeCreated[timediff(@SystemTime) <= {(long)span.TotalMilliseconds}]";

    public static List<LowMemoryEvent> ReadLowMemory(TimeSpan span, int max = 5)
    {
        var o = new List<LowMemoryEvent>(); using var r = Query("System", $"*[System[Provider[@Name='Microsoft-Windows-Resource-Exhaustion-Detector'] and EventID=2004 and {Window(span)}]]"); if (r is null) return o;
        for (var i = 0; i < max; i++) { using var ev = r.ReadEvent(); if (ev is null) break; o.Add(new(ev.TimeCreated?.ToUniversalTime() ?? DateTime.UtcNow, ParseExhaustion(ev.FormatDescription() ?? ""))); }
        return o;
    }
    static int? Count(string xpath, int cap = 200) { using var r = Query("System", xpath); if (r is null) return null; var n = 0; while (n < cap) { using var ev = r.ReadEvent(); if (ev is null) break; n++; } return n; }
    public static int? FailedShutdowns(TimeSpan span) => Count($"*[System[Provider[@Name='User32'] and EventID=1073 and {Window(span)}]]");
    public static int? FirmwareThrottle(TimeSpan span) => Count($"*[System[Provider[@Name='Microsoft-Windows-Kernel-Processor-Power'] and EventID=37 and {Window(span)}]]");

    static readonly (string engine, string[] processes)[] Engines =
    [("AVG", ["AVGSvc", "AVGUI", "avgsvca"]), ("Avast", ["AvastSvc", "AvastUI"]), ("Malwarebytes", ["MBAMService", "Malwarebytes", "mbamtray"]), ("Microsoft Defender", ["MsMpEng"]), ("Kaspersky", ["avp"]), ("McAfee", ["mcshield", "mfemms"]),
     ("Norton", ["NortonSecurity", "nsWscSvc"]), ("Bitdefender", ["bdservicehost", "vsserv"]), ("ESET", ["ekrn"]), ("Sophos", ["SophosFS", "SAVService"])];

    public static List<EngineMemory> SecurityEnginesRunning(IEnumerable<(string name, long ws)> procs)
    {
        var l = procs.ToList();
        return [.. Engines.Select(e => (e.engine, mb: l.Where(p => e.processes.Contains(p.name, StringComparer.OrdinalIgnoreCase)).Sum(p => p.ws) / 1048576.0)).Where(x => x.mb > 0).Select(x => new EngineMemory(x.engine, Math.Round(x.mb)))];
    }

    /// <summary>Programs holding the most commit, with how each would be treated. Idle-looking big programs are what to look at, never closed automatically.</summary>
    public static List<CommitConsumer> TopCommit(IEnumerable<(string name, long priv, long ws, int session)> procs, int take = 6) =>
        [.. procs.GroupBy(p => p.name, StringComparer.OrdinalIgnoreCase).Select(g => (name: g.Key, priv: g.Sum(x => x.priv), ws: g.Sum(x => x.ws), session: g.Max(x => x.session))).OrderByDescending(x => x.priv).Take(take)
            .Select(x => new CommitConsumer(x.name, Math.Round(x.priv / 1048576.0), Math.Round(x.ws / 1048576.0), ProcessClassifier.Assess(new ProcInfo(0, x.name, null, x.session, false, 0, x.ws, null, null)).Category))];

    public static ResourceFacts Collect()
    {
        var procs = new List<(string name, long priv, long ws, int session)>();
        foreach (var p in Process.GetProcesses()) using (p) { try { procs.Add((p.ProcessName, p.PrivateMemorySize64, p.WorkingSet64, p.SessionId)); } catch { } }
        var c = Commit();
        return new(c?.percent, c?.usedMb, c?.limitMb, c?.ramMb ?? 0, TopCommit(procs), ReadLowMemory(TimeSpan.FromHours(24)), FailedShutdowns(TimeSpan.FromDays(7)), FirmwareThrottle(TimeSpan.FromHours(24)), SecurityEnginesRunning(procs.Select(p => (p.name, p.ws))));
    }
}
