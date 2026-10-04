using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Viro.Agent.Care;

public sealed record MemoryAction(int Pid, string Name, double Mb);
public sealed record MemoryPlan(double UsedPercent, double TargetPercent, double NeedToFreeMb, IReadOnlyList<MemoryAction> Trim, IReadOnlyList<ProcessCloseAssessment> CloseSuggestions,
    IReadOnlyList<ProcessCloseAssessment> AskUser, string? Note, bool SessionObservable);
public sealed record TrimFailure(string Name, int Error);
public sealed record MemoryRun(double BeforePercent, double AfterPercent, double ReclaimedMb, IReadOnlyList<MemoryAction> Trimmed, bool TargetReached, MemoryPlan Plan, IReadOnlyList<TrimFailure>? Failures = null);

public interface IProcessSource
{
    Task<IReadOnlyList<ProcInfo>> SnapshotAsync(CancellationToken ct);
    (double usedPercent, long totalBytes) Memory();
}
public interface IProcessActions
{
    long WorkingSetOf(int pid); bool TrimWorkingSet(int pid); bool Kill(int pid);
    /// <summary>The Windows error code of the last failed TrimWorkingSet (0 if none).</summary>
    int LastTrimError => 0;
}

/// <summary>
/// Keeps idle programs from holding memory. The one action taken by itself is trimming the working set of programs that are not in use: Windows
/// keeps their pages on its standby list and brings them back on demand, so nothing is closed and no data is lost. Closing anything is a separate,
/// stricter decision (<see cref="ProcessClassifier"/>). Reclaimed memory is measured, never estimated.
/// </summary>
public static class MemoryPlanner
{
    public sealed record Hog(string Name, double PrivateMb, double WorkingSetMb, int Processes, ProcessCloseAssessment Assessment);

    /// <summary>
    /// The program holding the most commit that is not in use: the usual cause of "Windows ran out of memory" (a leak keeps growing while idle, and trimming its
    /// working set returns none of it). It is only ever reported, with its numbers; the person decides.
    /// </summary>
    public static Hog? FindHog(IReadOnlyList<ProcInfo> procs, long totalRamBytes)
    {
        var threshold = Math.Max(2048L * 1048576, totalRamBytes / 4);
        var g = procs.Where(p => ProcessClassifier.Assess(p).CloseRisk != CloseRisk.SYSTEM_CRITICAL).GroupBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
            .Select(x => (name: x.Key, priv: x.Sum(p => p.PrivateBytes), ws: x.Sum(p => p.WorkingSetBytes), n: x.Count(), fg: x.Any(p => p.IsForeground != false), top: x.OrderByDescending(p => p.PrivateBytes).First()))
            .Where(x => x.priv >= threshold && !x.fg).OrderByDescending(x => x.priv).FirstOrDefault();
        return g.name is null ? null : new(g.name, Math.Round(g.priv / 1048576.0), Math.Round(g.ws / 1048576.0), g.n, ProcessClassifier.Assess(g.top));
    }

    public const int MinTrimMb = 80, MinSuggestMb = 30, AskUserMb = 300, MaxTrimsPerPass = 8; public const double IdleCpuPercent = 2;     // a few large programs per pass: trimming dozens at once can make the PC stall while they page back in

    public static MemoryPlan Plan(IReadOnlyList<ProcInfo> procs, long totalBytes, double usedPercent, double targetPercent)
    {
        var need = Math.Max(0, (usedPercent - targetPercent) / 100.0 * totalBytes / 1048576.0);
        var observable = procs.Any(p => p.IsForeground is not null);
        var assessed = procs.Select(p => (p, a: ProcessClassifier.Assess(p))).ToList();
        // Trimming needs to know the program is not the one being used. If the signed-in session cannot be inspected nothing is trimmed.
        var trim = assessed.Where(x => x.a.CloseRisk != CloseRisk.SYSTEM_CRITICAL && x.p.IsForeground == false && x.p.CpuPercent < IdleCpuPercent && x.p.WorkingSetBytes >= MinTrimMb * 1048576L)
            .OrderByDescending(x => x.p.WorkingSetBytes).Take(MaxTrimsPerPass).Select(x => new MemoryAction(x.p.Pid, x.p.Name, Math.Round(x.p.WorkingSetBytes / 1048576.0))).ToList();
        var close = assessed.Where(x => x.a.CloseRisk == CloseRisk.SAFE && x.p.WorkingSetBytes >= MinSuggestMb * 1048576L).OrderByDescending(x => x.p.WorkingSetBytes).Select(x => x.a).Take(10).ToList();
        var ask = assessed.Where(x => x.a.CloseRisk is CloseRisk.ASK_USER or CloseRisk.HIGH_RISK or CloseRisk.UNKNOWN && x.p.IsForeground == false && x.p.CpuPercent < IdleCpuPercent && x.p.WorkingSetBytes >= AskUserMb * 1048576L)
            .OrderByDescending(x => x.p.WorkingSetBytes).Select(x => x.a).Take(8).ToList();
        string? note = null;
        var totalGb = totalBytes / 1073741824.0;
        if (totalGb <= 4.5) note = $"This PC has {totalGb:0.#} GB of memory. Keeping use under {targetPercent:0}% ({totalGb * targetPercent / 100:0.#} GB) while working is not realistic on this hardware; more memory is the lasting fix.";
        else if (!observable) note = "The signed-in user's session could not be inspected, so no program was trimmed.";
        return new(Math.Round(usedPercent, 1), targetPercent, Math.Round(need), trim, close, ask, note, observable);
    }
}

public sealed class MemoryGuard(IProcessSource src, IProcessActions act, Func<DateTime>? clock = null, TimeSpan? settle = null)
{
    readonly Dictionary<int, DateTime> lastTrim = [];
    readonly Func<DateTime> now = clock ?? (() => DateTime.UtcNow);
    public static readonly TimeSpan PerProcessCooldown = TimeSpan.FromMinutes(15);

    public async Task<MemoryPlan> PlanAsync(double target, CancellationToken ct)
    {
        var (used, total) = src.Memory();
        return MemoryPlanner.Plan(await src.SnapshotAsync(ct), total, used, target);
    }

    /// <summary>Trims idle programs (when the PC is above the target) and measures what that actually freed.</summary>
    public async Task<MemoryRun> RunAsync(double target, CancellationToken ct, bool force = false)
    {
        var (before, total) = src.Memory();
        var plan = MemoryPlanner.Plan(await src.SnapshotAsync(ct), total, before, target);
        var trimmed = new List<MemoryAction>(); var failures = new List<TrimFailure>();
        if (before > target || force)
            foreach (var a in plan.Trim)
            {
                if (lastTrim.TryGetValue(a.Pid, out var t) && now() - t < PerProcessCooldown) continue;       // do not churn the same program's memory over and over
                await Task.Delay(settle is null ? TimeSpan.FromMilliseconds(250) : TimeSpan.Zero, ct);      // spread the work out instead of one burst
                var was = act.WorkingSetOf(a.Pid);
                if (act.TrimWorkingSet(a.Pid)) { lastTrim[a.Pid] = now(); trimmed.Add(a with { Mb = Math.Round((was - act.WorkingSetOf(a.Pid)) / 1048576.0) }); }
                else failures.Add(new(a.Name, act.LastTrimError));
            }
        await Task.Delay(settle ?? TimeSpan.FromSeconds(1), ct);
        var (after, _) = src.Memory();
        return new(Math.Round(before, 1), Math.Round(after, 1), Math.Round((before - after) / 100.0 * total / 1048576.0), trimmed, after <= target, plan, failures);
    }
}

/// <summary>
/// Closing a program is allowed only for one the classifier currently rates SAFE (checked again at the moment of closing, not when it was listed),
/// and only when the policy permits automatic closing. Everything else is left to the person.
/// </summary>
public sealed class SafeIdleAppCloser(IProcessSource src, IProcessActions act)
{
    public sealed record Outcome(string Name, int Pid, bool Closed, string Reason);

    public async Task<IReadOnlyList<Outcome>> CloseAsync(IEnumerable<int> pids, CancellationToken ct)
    {
        var fresh = (await src.SnapshotAsync(ct)).ToDictionary(p => p.Pid);
        var o = new List<Outcome>();
        foreach (var pid in pids.Distinct())
        {
            if (!fresh.TryGetValue(pid, out var p)) { o.Add(new("?", pid, false, "it is no longer running")); continue; }
            var a = ProcessClassifier.Assess(p);
            if (a.CloseRisk != CloseRisk.SAFE) { o.Add(new(p.Name, pid, false, $"not closed: it is now rated {a.CloseRisk} ({a.BackgroundState})")); continue; }
            o.Add(act.Kill(pid) ? new(p.Name, pid, true, "a background helper with no window, closed") : new(p.Name, pid, false, "it could not be closed"));
        }
        return o;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
public sealed partial class SystemProcessSource(IUserUi? ui = null) : IProcessSource
{
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX s);
    [StructLayout(LayoutKind.Sequential)] struct MEMORYSTATUSEX { public uint dwLength, dwMemoryLoad; public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual; }

    public (double usedPercent, long totalBytes) Memory()
    {
        var m = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        return GlobalMemoryStatusEx(ref m) ? (Math.Round((1 - (double)m.ullAvailPhys / m.ullTotalPhys) * 100, 1), (long)m.ullTotalPhys) : (0, 8L << 30);
    }

    public async Task<IReadOnlyList<ProcInfo>> SnapshotAsync(CancellationToken ct)
    {
        var windows = ui is null ? null : await ui.WindowsAsync(ct);
        var win = windows?.ToDictionary(w => w.Pid, w => w);
        var first = new Dictionary<int, (TimeSpan cpu, DateTime at)>();
        var procs = Process.GetProcesses();
        foreach (var p in procs) { try { first[p.Id] = (p.TotalProcessorTime, DateTime.UtcNow); } catch { } }
        await Task.Delay(1000, ct);
        var o = new List<ProcInfo>(); var cores = Environment.ProcessorCount;
        foreach (var p in procs)
        {
            using (p)
            {
                try
                {
                    var cpu = first.TryGetValue(p.Id, out var f) ? Math.Round((p.TotalProcessorTime - f.cpu).TotalMilliseconds / ((DateTime.UtcNow - f.at).TotalMilliseconds * cores) * 100, 1) : 0;
                    string? path = null; try { path = p.MainModule?.FileName; } catch { }
                    var w = win is not null && win.TryGetValue(p.Id, out var wi) ? wi : null;
                    // A program with no top-level window in the user's session reports HasVisibleWindow=false; "unknown" only when the session could not be inspected.
                    o.Add(new(p.Id, p.ProcessName, path, p.SessionId, false, Math.Max(0, cpu), p.WorkingSet64, win is null ? null : (w?.Visible ?? false), win is null ? null : (w?.Foreground ?? false), p.PrivateMemorySize64));
                }
                catch { /* exited, or access denied */ }
            }
        }
        return o;
    }
}

public sealed partial class SystemProcessActions : IProcessActions
{
    [DllImport("psapi.dll", SetLastError = true)] static extern bool EmptyWorkingSet(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    const uint SetQuota = 0x0100, QueryInfo = 0x0400;

    public long WorkingSetOf(int pid) { try { using var p = Process.GetProcessById(pid); p.Refresh(); return p.WorkingSet64; } catch { return 0; } }
    public int LastTrimError { get; private set; }
    public bool TrimWorkingSet(int pid)
    {
        var h = OpenProcess(SetQuota | QueryInfo, false, pid); if (h == IntPtr.Zero) { LastTrimError = Marshal.GetLastWin32Error(); return false; }
        try { if (EmptyWorkingSet(h)) return true; LastTrimError = Marshal.GetLastWin32Error(); return false; } finally { CloseHandle(h); }
    }
    public bool Kill(int pid) { try { using var p = Process.GetProcessById(pid); p.Kill(); return p.WaitForExit(3000); } catch (Exception e) when (e is ArgumentException or InvalidOperationException or Win32Exception) { return false; } }
}
