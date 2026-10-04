using System.ComponentModel;
using System.Diagnostics;
using System.Management;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Viro.Agent.Care;

/// <summary>
/// The controlled measurement behind upgrade advice: short, non-destructive and safe. It measures single- and multi-thread processor speed, speed under a
/// sustained load (with temperature and clock), memory bandwidth and latency, and the system drive's reads, then compares like with like after a part is
/// replaced. It stops at once if the processor gets too hot, refuses to run on battery, and removes its one temporary file. Nothing is written outside it.
/// </summary>
public static class UpgradeBenchmark
{
    public const int Version = 1;
    public sealed record Options(double SingleSeconds = 3, double SustainedSeconds = 30, int MemoryMB = 128, int StorageMB = 256, double StorageSeconds = 3, double AbortTempC = 95,
        double QuietBelowPercent = 35, int QuietWaitSeconds = 60, Func<double?>? TempReader = null, Func<double?>? FrequencyReader = null, bool SkipStorage = false, string? StorageDir = null, bool IgnoreBatteryCheck = false);

    static long _sink;

    public static Dictionary<string, object?> Run(Options o, CancellationToken ct)
    {
        var metrics = new Dictionary<string, object?>(); var unavailable = new List<object>(); var started = DateTime.UtcNow;
        var safety = new Dictionary<string, object?> { ["aborted"] = false, ["reason"] = null, ["maxTempC"] = null, ["abortAtC"] = o.AbortTempC };
        var result = new Dictionary<string, object?> { ["version"] = Version, ["metrics"] = metrics, ["safety"] = safety, ["unavailable"] = unavailable, ["startedAt"] = started.ToString("O") };
        if (!o.IgnoreBatteryCheck && OnBattery(out var pct)) { safety["aborted"] = true; safety["reason"] = $"The computer is running on battery ({pct}%). The measurement needs mains power so that results before and after a change are comparable."; return result; }
        var temp = o.TempReader ?? DefaultTemp(); var freq = o.FrequencyReader ?? DefaultFrequency();
        double? maxTemp = null; bool Hot() { var t = temp(); if (t is null) return false; maxTemp = maxTemp is null ? t : Math.Max(maxTemp.Value, t.Value); safety["maxTempC"] = Math.Round(maxTemp.Value, 1); if (t >= o.AbortTempC) { safety["aborted"] = true; safety["reason"] = $"Stopped at {t:0}°C: the processor reached the safety limit of {o.AbortTempC:0}°C."; return true; } return false; }
        if (temp() is null) unavailable.Add(new { component = "Temperature", reason = "This computer's firmware does not report a processor temperature to Windows, so heat is not part of this measurement." });
        var idle = temp(); if (idle is not null) metrics["idleTempC"] = Math.Round(idle.Value, 1);
        // Other programs using the processor make every figure unreliable: wait for the computer to settle, and say so when it never does.
        var load = BackgroundLoad(ct); for (var waited = 0; load > o.QuietBelowPercent && waited < o.QuietWaitSeconds && !ct.IsCancellationRequested; waited += 5) { Thread.Sleep(4000); load = BackgroundLoad(ct); }
        safety["backgroundLoadPercent"] = load; safety["noisy"] = load > o.QuietBelowPercent;

        // ---- single thread, then all threads
        metrics["cpuSingleScore"] = Math.Round(Score(1, o.SingleSeconds, ct), 1); if (Hot()) return Finish(result, started);
        var threads = Environment.ProcessorCount;
        metrics["cpuMultiScore"] = Math.Round(Score(threads, o.SingleSeconds, ct), 1); if (Hot()) return Finish(result, started);

        // ---- sustained all-thread load in windows: does the speed hold, and what does the heat do
        var windows = Math.Max(2, (int)Math.Round(o.SustainedSeconds / 5)); var winSeconds = o.SustainedSeconds / windows; var scores = new List<double>(); var freqs = new List<double>(); double firstFreq = 0;
        for (var w = 0; w < windows && !ct.IsCancellationRequested; w++)
        {
            using var sampler = new CancellationTokenSource();
            var watch = Task.Run(() => { while (!sampler.IsCancellationRequested) { try { Task.Delay(1000, sampler.Token).Wait(sampler.Token); } catch (OperationCanceledException) { break; } var f = freq(); if (f is not null) freqs.Add(f.Value); if (Hot()) { sampler.Cancel(); } } });
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, sampler.Token);
            var s = Score(threads, winSeconds, linked.Token); sampler.Cancel(); try { watch.Wait(2000); } catch { /* sampler stopped */ }
            if ((bool)safety["aborted"]!) { return Finish(result, started); }
            scores.Add(s); if (w == 0 && freqs.Count > 0) firstFreq = freqs.Average();
        }
        if (scores.Count >= 2)
        {
            var tail = scores.Skip(Math.Max(0, scores.Count - 2)).Average();
            metrics["cpuSustainedScore"] = Math.Round(tail, 1);
            metrics["cpuSustainedRatio"] = Math.Round(tail / scores.Max(), 3);
            if (freqs.Count > 0) { metrics["clockSustainedMHz"] = Math.Round(freqs.Skip(freqs.Count / 2).DefaultIfEmpty(freqs.Average()).Average()); if (firstFreq > 0) metrics["clockHeldRatio"] = Math.Round(Math.Min(1.5, freqs.Skip(freqs.Count / 2).DefaultIfEmpty(firstFreq).Average() / firstFreq), 3); }
        }
        if (maxTemp is not null) metrics["peakTempC"] = Math.Round(maxTemp.Value, 1);

        // ---- memory
        try { var (bw, lat) = Memory(o.MemoryMB, ct); metrics["memBandwidthMBs"] = Math.Round(bw); metrics["memLatencyNs"] = Math.Round(lat, 1); }
        catch (OutOfMemoryException) { unavailable.Add(new { component = "Memory", reason = "Not enough free memory to run the memory measurement safely." }); }
        if (Hot()) return Finish(result, started);

        // ---- the system drive: reads only, from one temporary file that is deleted afterwards
        if (!o.SkipStorage)
        {
            try { var (seq, iops, lat) = Storage(o, ct); metrics["seqReadMBs"] = Math.Round(seq); metrics["rndRead4kIops"] = Math.Round(iops); metrics["rndReadLatencyUs"] = Math.Round(lat, 1); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or NotSupportedException) { unavailable.Add(new { component = "Storage", reason = e.Message }); }
        }
        return Finish(result, started);
    }

    static Dictionary<string, object?> Finish(Dictionary<string, object?> r, DateTime started) { ((Dictionary<string, object?>)r["safety"]!)["durationSeconds"] = Math.Round((DateTime.UtcNow - started).TotalSeconds, 1); return r; }

    // ---- processor ----------------------------------------------------------------------------------------------------------------------------
    static double Score(int threads, double seconds, CancellationToken ct)
    {
        var total = 0L; var sw = Stopwatch.StartNew(); var ms = (long)(seconds * 1000);
        Parallel.For(0, threads, new ParallelOptions { MaxDegreeOfParallelism = threads, CancellationToken = CancellationToken.None }, t =>
        {
            ulong x = 88172645463325252UL + (ulong)t * 7919; double f = 1.0; long n = 0; var local = Stopwatch.StartNew();
            while (local.ElapsedMilliseconds < ms && !ct.IsCancellationRequested)
            {
                for (var i = 0; i < 20_000; i++) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; f = f * 1.0000001 + (x & 0xFF) * 1e-9; }
                n += 20_000;
            }
            Interlocked.Add(ref total, n); Interlocked.Exchange(ref _sink, (long)x ^ (long)f);
        });
        return total / Math.Max(0.001, sw.Elapsed.TotalSeconds) / 1e6;
    }

    static double BackgroundLoad(CancellationToken ct)
    {
        try { using var c = new PerformanceCounter("Processor", "% Processor Time", "_Total"); c.NextValue(); Thread.Sleep(1000); return Math.Round(c.NextValue(), 0); }
        catch (Exception e) when (e is InvalidOperationException or Win32Exception or UnauthorizedAccessException) { return -1; }
    }

    // ---- memory --------------------------------------------------------------------------------------------------------------------------------
    static (double bandwidthMBs, double latencyNs) Memory(int mb, CancellationToken ct)
    {
        mb = Math.Min(mb, FreeMemoryMB() / 8); if (mb < 16) throw new OutOfMemoryException();
        var workers = Math.Min(4, Environment.ProcessorCount); var per = mb / workers * 1024 * 1024 / 2; long bytes = 0; var sw = Stopwatch.StartNew();
        Parallel.For(0, workers, _ =>
        {
            var src = new byte[per]; var dst = new byte[per]; new Random(7).NextBytes(src); long n = 0; var l = Stopwatch.StartNew();
            while (l.ElapsedMilliseconds < 2500 && !ct.IsCancellationRequested) { Buffer.BlockCopy(src, 0, dst, 0, per); n += per; }
            Interlocked.Add(ref bytes, n); Interlocked.Exchange(ref _sink, dst[per / 2]);
        });
        var bw = bytes / Math.Max(0.001, sw.Elapsed.TotalSeconds) / 1e6;
        // latency: follow a random cycle through memory so every access waits for the one before it
        var count = Math.Min(16 * 1024 * 1024, mb * 1024 * 1024 / 4); var next = new int[count]; for (var i = 0; i < count; i++) next[i] = i;
        var rnd = new Random(11); for (var i = count - 1; i > 0; i--) { var j = rnd.Next(i); (next[i], next[j]) = (next[j], next[i]); }   // Sattolo's shuffle: one cycle through every slot
        var steps = 0L; var lw = Stopwatch.StartNew(); var p = 0;
        while (lw.ElapsedMilliseconds < 1500 && !ct.IsCancellationRequested) { for (var i = 0; i < 100_000; i++) p = next[p]; steps += 100_000; }
        Interlocked.Exchange(ref _sink, p); return (bw, lw.Elapsed.TotalMilliseconds * 1e6 / Math.Max(1, steps));
    }
    static int FreeMemoryMB() { try { using var s = new ManagementObjectSearcher("SELECT FreePhysicalMemory FROM Win32_OperatingSystem"); foreach (ManagementObject m in s.Get()) return (int)(Convert.ToInt64(m["FreePhysicalMemory"]) / 1024); } catch (ManagementException) { } return 512; }

    // ---- storage -------------------------------------------------------------------------------------------------------------------------------
    const FileOptions NoBuffering = (FileOptions)0x20000000;
    static (double seqMBs, double iops, double latencyUs) Storage(Options o, CancellationToken ct)
    {
        var dir = o.StorageDir ?? Path.Combine(Path.GetTempPath(), "viro-bench"); Directory.CreateDirectory(dir);
        foreach (var old in Directory.EnumerateFiles(dir, "viro-bench-*.tmp")) { try { File.Delete(old); } catch (IOException) { } }
        var size = (long)o.StorageMB * 1024 * 1024; var root = Path.GetPathRoot(Path.GetFullPath(dir))!; var drive = new DriveInfo(root);
        if (drive.AvailableFreeSpace < size * 3) throw new IOException("Not enough free space on the system drive to run the drive measurement safely.");
        var path = Path.Combine(dir, $"viro-bench-{Guid.NewGuid():N}.tmp");
        try
        {
            using (var w = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 20, FileOptions.WriteThrough)) { var block = new byte[1 << 20]; new Random(3).NextBytes(block); for (long done = 0; done < size; done += block.Length) w.Write(block, 0, block.Length); w.Flush(true); }
            using SafeFileHandle h = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.Read, NoBuffering);
            var raw = GC.AllocateUninitializedArray<byte>((1 << 20) + 4096, pinned: true); var off = (int)((4096 - (long)Marshal.UnsafeAddrOfPinnedArrayElement(raw, 0) % 4096) % 4096);
            var big = new Span<byte>(raw, off, 1 << 20); var small = big.Slice(0, 4096);
            long read = 0; var sw = Stopwatch.StartNew(); for (long pos = 0; pos + big.Length <= size && !ct.IsCancellationRequested; pos += big.Length) read += RandomAccess.Read(h, big, pos);
            var seq = read / Math.Max(0.001, sw.Elapsed.TotalSeconds) / 1e6;
            var rnd = new Random(5); long ios = 0; sw.Restart(); var blocks = size / 4096;
            while (sw.Elapsed.TotalSeconds < o.StorageSeconds && !ct.IsCancellationRequested) { RandomAccess.Read(h, small, rnd.NextInt64(blocks) * 4096); ios++; }
            var secs = Math.Max(0.001, sw.Elapsed.TotalSeconds); return (seq, ios / secs, secs * 1e6 / Math.Max(1, ios));
        }
        finally { try { File.Delete(path); } catch (IOException) { } }
    }

    // ---- sensors and power ---------------------------------------------------------------------------------------------------------------------
    static Func<double?> DefaultTemp() => () =>
    {
        try { double? max = null; using var s = new ManagementObjectSearcher(@"root\WMI", "SELECT CurrentTemperature FROM MSAcpi_ThermalZoneTemperature"); foreach (ManagementObject m in s.Get()) { var c = Convert.ToDouble(m["CurrentTemperature"]) / 10.0 - 273.15; if (c is > 0 and < 150) max = max is null ? c : Math.Max(max.Value, c); } return max; }
        catch (Exception e) when (e is ManagementException or UnauthorizedAccessException or InvalidCastException) { return null; }
    };
    static Func<double?> DefaultFrequency()
    {
        PerformanceCounter? c = null; try { c = new PerformanceCounter("Processor Information", "Processor Frequency", "_Total"); c.NextValue(); } catch (Exception e) when (e is InvalidOperationException or UnauthorizedAccessException) { c = null; }
        return () => { try { return c?.NextValue(); } catch (InvalidOperationException) { return null; } };
    }
    static bool OnBattery(out int percent)
    {
        percent = 100;
        try { using var s = new ManagementObjectSearcher("SELECT BatteryStatus,EstimatedChargeRemaining FROM Win32_Battery"); foreach (ManagementObject m in s.Get()) { if (Convert.ToInt32(m["BatteryStatus"]) == 1) { percent = Convert.ToInt32(m["EstimatedChargeRemaining"]); return true; } } } catch (ManagementException) { }
        return false;
    }
}

public sealed class UpgradeBenchmarkHandler : IJobHandler
{
    public string Type => "benchmark.upgrade";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var purpose = ctx.Job.Params.TryGetProperty("purpose", out var p) && p.ValueKind == System.Text.Json.JsonValueKind.String ? p.GetString() : "baseline";
        var r = await Task.Run(() => UpgradeBenchmark.Run(new UpgradeBenchmark.Options(), ct), ct);
        r["purpose"] = purpose;
        var safety = (Dictionary<string, object?>)r["safety"]!;
        return (bool)safety["aborted"]! ? new JobOutcome(false, r, (string?)safety["reason"] ?? "The measurement was stopped for safety.") : new JobOutcome(true, r);
    }
}
