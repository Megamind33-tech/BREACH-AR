using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Management;
using System.Runtime.InteropServices;
using System.Xml.Linq;

namespace Viro.Agent;

/// <summary>
/// Lightweight operational benchmark: a handful of cheap, repeatable measurements of how the PC behaves when nothing special is asked of it.
/// Every value is measured on this machine; a metric that cannot be read is reported as null, never guessed. It is meant to be run before
/// and after a repair so the improvement is a measured difference, not a claim.
/// </summary>
public static class Benchmark
{
    public sealed record Result(Dictionary<string, object?> Metrics, List<string> Errors);

    public static async Task<Result> RunAsync(CancellationToken ct, int cpuSamples = 6, TimeSpan? cpuInterval = null)
    {
        var sw = Stopwatch.StartNew();
        var errors = new List<string>();
        T? Try<T>(string name, Func<T> f) { try { return f(); } catch (Exception e) { errors.Add($"{name}: {e.GetType().Name}: {e.Message}"); return default; } }

        // CPU: average utilisation over a few seconds (the benchmark itself is nearly idle, so this is the machine's background load).
        Collectors.CpuPercent();
        var samples = new List<double>();
        for (var i = 0; i < cpuSamples; i++)
        {
            await Task.Delay(cpuInterval ?? TimeSpan.FromSeconds(1), ct);
            if (Collectors.CpuPercent() is { } c) samples.Add(c);
        }

        var m = new Native.MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<Native.MEMORYSTATUSEX>() };
        var haveMem = Native.GlobalMemoryStatusEx(ref m);
        var sys = new DriveInfo(Path.GetPathRoot(Environment.SystemDirectory)!);

        var metrics = new Dictionary<string, object?>
        {
            ["cpuAvgPercent"] = samples.Count == 0 ? null : Math.Round(samples.Average(), 1),
            ["cpuSamples"] = samples.Count,
            ["ramPercent"] = haveMem ? (double)m.dwMemoryLoad : null,
            ["ramUsedBytes"] = haveMem ? (long)(m.ullTotalPhys - m.ullAvailPhys) : null,
            ["startupCount"] = Try("startup", () => Wmi("SELECT Name FROM Win32_StartupCommand").Count),
            ["runningServices"] = Try("services", () => Wmi("SELECT Name FROM Win32_Service WHERE State='Running'").Count),
            ["processCount"] = Try("processes", () => Process.GetProcesses().Length),
            ["bootSeconds"] = Try("boot", LastBootSeconds),
            ["uptimeSeconds"] = Environment.TickCount64 / 1000,
            ["systemFreeBytes"] = sys.IsReady ? sys.AvailableFreeSpace : null,
            ["diskSyncWriteMs"] = Try("disk", () => DiskSyncWriteMs(ct)),
        };
        metrics["durationMs"] = sw.ElapsedMilliseconds;
        metrics["measuredAt"] = DateTime.UtcNow.ToString("O");
        metrics["agentVersion"] = Collectors.AgentVersion;
        return new(metrics, errors);
    }

    static List<ManagementBaseObject> Wmi(string query)
    {
        using var s = new ManagementObjectSearcher(query);
        return s.Get().Cast<ManagementBaseObject>().ToList();
    }

    /// <summary>Boot duration of the most recent boot as recorded by Windows itself (Diagnostics-Performance event 100); null when the log has none.</summary>
    public static double? LastBootSeconds()
    {
        var q = new EventLogQuery("Microsoft-Windows-Diagnostics-Performance/Operational", PathType.LogName, "*[System[(EventID=100)]]") { ReverseDirection = true };
        using var r = new EventLogReader(q);
        using var e = r.ReadEvent();
        return e is null ? null : ParseBootSeconds(e.ToXml());
    }

    /// <summary>Extracts BootTime (milliseconds) from the event XML.</summary>
    public static double? ParseBootSeconds(string xml)
    {
        var doc = XDocument.Parse(xml);
        var d = doc.Descendants().FirstOrDefault(x => x.Name.LocalName == "Data" && (string?)x.Attribute("Name") == "BootTime");
        return d is not null && double.TryParse(d.Value, out var ms) && ms > 0 ? Math.Round(ms / 1000.0, 1) : null;
    }

    /// <summary>Average time for a 4 KB write that must reach the disk (write-through). A rising value means the storage is slow or busy.</summary>
    static double DiskSyncWriteMs(CancellationToken ct, int writes = 32)
    {
        var dir = Path.Combine(Path.GetTempPath(), "viro-bench-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var buf = new byte[4096]; Random.Shared.NextBytes(buf);
            using var fs = new FileStream(Path.Combine(dir, "probe.bin"), FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
            var sw = Stopwatch.StartNew();
            for (var i = 0; i < writes; i++) { ct.ThrowIfCancellationRequested(); fs.Write(buf, 0, buf.Length); fs.Flush(true); }
            return Math.Round(sw.Elapsed.TotalMilliseconds / writes, 2);
        }
        finally { try { Directory.Delete(dir, true); } catch { /* temp dir: best effort */ } }
    }
}

public sealed class BenchmarkHandler : IJobHandler
{
    public string Type => "benchmark.run";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var r = await Benchmark.RunAsync(ct);
        return new(true, new { metrics = r.Metrics, errors = r.Errors });
    }
}
