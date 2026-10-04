using Viro.Agent.Repair;

namespace Viro.Agent.Care;

public sealed record FixSnapshot(long FreeBytes, double MemoryPercent, int StartupItems);
public sealed record FixStep(string Recipe, string Title, bool Needed, bool Applied, bool Verified, string Summary, string? UndoId, bool NeedsAdmin);
public sealed record FixAllResult(FixSnapshot Before, FixSnapshot After, IReadOnlyList<FixStep> Steps);

/// <summary>One pass through every safe fix, measured before and after. Used by the "Fix my PC" button and by the weekly scheduled care.</summary>
public static class FixAll
{
    public static readonly string[] Recipes = ["cleanup.safe", "memory.trim-idle", "startup.optimize"];

    public static FixSnapshot Snap(LocalActions act)
    {
        var d = new DriveInfo(Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows))!);
        return new(d.AvailableFreeSpace, Math.Round(act.MemoryNow().UsedPercent, 1), act.StartupPrograms().Count(a => a.Item.Enabled));
    }

    public static async Task<FixAllResult> RunAsync(LocalActions act, CancellationToken ct)
    {
        var before = await Task.Run(() => Snap(act), ct); var steps = new List<FixStep>();
        foreach (var recipe in Recipes)
        {
            try
            {
                var r = await act.RunRecipeAsync(recipe, ct);
                steps.Add(new(recipe, r.Title, r.Needed, r.Applied, r.Verified == true, r.Summary, r.RollbackAvailable ? r.RepairId : null, r.Summary.Contains("administrator", StringComparison.OrdinalIgnoreCase)));
            }
            catch (Exception e) when (e is not OperationCanceledException) { steps.Add(new(recipe, recipe, false, false, false, e.Message, null, false)); }
        }
        return new(before, await Task.Run(() => Snap(act), ct), steps);
    }
}

/// <summary>The weekly care task: a Windows scheduled task that runs "viro-agent maintain" as the signed-in person, so it needs no extra rights.</summary>
public sealed class CareSchedule(IProcessRunner proc, string exePath)
{
    public const string TaskName = "Viro WorkCare weekly care";

    public async Task<bool> EnableAsync(CancellationToken ct)
    {
        var r = await proc.RunAsync("schtasks.exe", $"/Create /F /SC WEEKLY /D SUN /ST 11:00 /TN \"{TaskName}\" /TR \"\\\"{exePath}\\\" maintain\" /RL LIMITED", TimeSpan.FromSeconds(30), ct);
        return r.ExitCode == 0;
    }
    public async Task<bool> DisableAsync(CancellationToken ct) => (await proc.RunAsync("schtasks.exe", $"/Delete /F /TN \"{TaskName}\"", TimeSpan.FromSeconds(30), ct)).ExitCode == 0;
    public async Task<(bool Enabled, string? NextRun)> StatusAsync(CancellationToken ct)
    {
        var r = await proc.RunAsync("schtasks.exe", $"/Query /TN \"{TaskName}\" /FO LIST", TimeSpan.FromSeconds(30), ct);
        if (r.ExitCode != 0) return (false, null);
        var next = r.Output.Replace("\r", "").Split('\n').FirstOrDefault(l => l.StartsWith("Next Run Time", StringComparison.OrdinalIgnoreCase));
        return (true, next?.Split(':', 2).ElementAtOrDefault(1)?.Trim());
    }
}
