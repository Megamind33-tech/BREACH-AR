using Viro.Agent.Repair;
namespace Viro.Agent;

/// <summary>
/// When Control says this PC's organization uses compute sponsorship, makes sure the compute worker service exists, with no one running anything by hand.
/// It only registers the service (the worker's own health gate and the signed policy decide whether it ever computes). Tried at most once an hour.
/// </summary>
public sealed class ComputeProvisioner(IProcessRunner proc, string installDir, Func<DateTime>? now = null)
{
    static readonly TimeSpan Every = TimeSpan.FromHours(1), T = TimeSpan.FromSeconds(120);
    readonly Func<DateTime> _now = now ?? (() => DateTime.UtcNow);
    DateTime? _last;

    /// <returns>A short note when something was done or went wrong, null when nothing was needed.</returns>
    public async Task<string?> EnsureAsync(bool wanted, CancellationToken ct)
    {
        if (!wanted) return null;
        if (_last is { } t && _now() - t < Every) return null;
        var exe = Path.Combine(installDir, "viro-compute.exe");
        if (!File.Exists(exe)) return null;                      // an older package without the worker: the next update brings it
        _last = _now();
        if ((await proc.RunAsync("sc.exe", "query ViroCompute", T, ct)).ExitCode != 1060) return null;   // already registered
        var r = await proc.RunAsync(exe, "setup", T, ct);
        return r.ExitCode == 0 ? "Compute worker installed automatically" : $"Compute worker setup failed ({r.ExitCode}): {r.Output.Trim()}";
    }
}
