namespace Viro.Agent.Repair;

/// <summary>
/// Protects the person using the computer. Disruptive repairs (long disk work, repairs that need programs closed) are postponed, never
/// forced, while the PC is busy or running low on battery. Postponing changes nothing: Control keeps the problem open and asks again later.
/// </summary>
public static class DisruptionGuard
{
    public static readonly HashSet<string> Disruptive = ["windows.sfc", "windows.dism", "windows.update-reset", "office.quick-repair", "disk.check"];
    static readonly HashSet<string> DiskHeavy = ["windows.sfc", "windows.dism", "disk.check"];
    public const double BusyCpuPercent = 85;

    /// <summary>A short reason to postpone the repair, or null when it may run now.</summary>
    public static async Task<string?> CheckAsync(string recipe, RepairEnv env, CancellationToken ct)
    {
        if (!Disruptive.Contains(recipe)) return null;
        if (env.Battery() is { onBattery: true } b && (b.percent < 40 || (DiskHeavy.Contains(recipe) && b.percent < 70)))
            return $"the computer is on battery ({b.percent}%). Long repairs wait until it is plugged in";
        if (await env.CpuBusyPercentAsync(ct) is { } cpu && cpu >= BusyCpuPercent)
            return $"the computer is busy (processor {cpu:0}% in use). The repair will run when it is quieter";
        return null;
    }
}
