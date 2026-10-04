using System.Security.Cryptography;

namespace Viro.Compute;

/// <summary>
/// Compute job classes, lowest priority last. The worker only ever handles classes 5-7; classes 1-4 (user, security, maintenance,
/// critical IT operations) are represented by the signals that make the worker yield.
/// </summary>
public enum WorkClass { PaidCompute = 5, InternalCompute = 6, Fallback = 7 }

public interface IWorkloadProvider
{
    /// <summary>The next workload this PC should run right now, or null (with a reason) if there is none.</summary>
    WorkloadSpec? Next(ComputePolicy policy, long totalMemoryBytes, out string? reason);
}

/// <summary>
/// Chooses what to run, in priority order: (5) paid customer jobs, (6) internal Viro jobs, (7) the fallback workload.
/// Paid and internal jobs will run in an isolated sandbox with no access to the host; none exist yet, so those slots return nothing.
/// The fallback slot runs the Monero/XMRig engine when Control has published one, the policy names a pool and a public payout address, and
/// the engine's checksum matches; otherwise it yields no workload and says why.
/// </summary>
public sealed class WorkloadProvider(string exePath, EngineStore? engines = null) : IWorkloadProvider
{
    /// <summary>The local API endpoint of the mining engine that was last handed out, so the worker can read its hash rate.</summary>
    public (int Port, string Token)? MinerApi { get; private set; }
    public int Cores { get; init; } = Environment.ProcessorCount;

    public WorkloadSpec? Next(ComputePolicy p, long totalMem, out string? reason)
    {
        var memLimit = totalMem * p.MaxMemoryPercent / 100;
        // class 5 / 6: sandboxed customer and internal jobs — interface reserved, no job source yet
        switch (p.Fallback)
        {
            case "selftest":   // a benign CPU-bound test load, used to validate the caps, priorities and guards on a real PC
                reason = null; return new(exePath, "burn", p.MaxCpuPercent, memLimit);
            case "xmrig":
                if (engines is null) { reason = "the mining engine store is unavailable"; return null; }
                if (p.Pool is null) { reason = "no valid mining pool and public payout address are configured"; return null; }
                if (p.Engine is null) { reason = "no mining engine has been published for this organization"; return null; }
                if (engines.NotReadyReason(p.Engine) is { } why) { reason = why; return null; }
                if (string.IsNullOrEmpty(p.WorkerId)) { reason = "this PC has no worker id yet"; return null; }
                var (port, token) = MinerArgs.NewApiEndpoint(); MinerApi = (port, token);
                reason = null; return new(engines.ExePath(p.Engine), MinerArgs.Build(p.Pool, p.WorkerId, p.MaxCpuPercent, Cores, port, token), p.MaxCpuPercent, memLimit);
            default:
                reason = "no workload configured"; return null;
        }
    }
}

/// <summary>The built-in self-test workload: busy hashing threads that print their rate. Exists to prove the limits work, not to produce anything.</summary>
public static class BurnWorkload
{
    public static async Task<int> RunAsync(int seconds, CancellationToken ct)
    {
        var stop = DateTime.UtcNow.AddSeconds(seconds <= 0 ? 3600 : seconds);
        long hashes = 0;
        var threads = Enumerable.Range(0, Environment.ProcessorCount).Select(_ => new Thread(() =>
        {
            var buf = new byte[64]; new Random().NextBytes(buf); long local = 0;
            while (!ct.IsCancellationRequested && DateTime.UtcNow < stop) { for (var i = 0; i < 2000; i++) { buf = SHA256.HashData(buf).Concat(buf.Take(32)).ToArray(); local++; } Interlocked.Add(ref hashes, local); local = 0; }
        }) { IsBackground = true }).ToList();
        foreach (var t in threads) t.Start();
        long last = 0; var t0 = DateTime.UtcNow;
        while (!ct.IsCancellationRequested && DateTime.UtcNow < stop) { await Task.Delay(2000, ct).ContinueWith(_ => { }); var now = Interlocked.Read(ref hashes); Console.WriteLine($"rate={(now - last) / 2.0:0}"); last = now; }
        return 0;
    }
}
