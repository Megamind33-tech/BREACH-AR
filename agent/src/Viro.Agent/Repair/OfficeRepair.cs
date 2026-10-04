using System.Diagnostics;
using System.Text.Json;
using Microsoft.Win32;

namespace Viro.Agent.Repair;

/// <summary>Thrown by a recipe when the repair is appropriate but cannot run right now (for example the application is open). Nothing was changed.</summary>
public sealed class RepairDeferredException(string reason) : Exception(reason);

public sealed record OfficeInstall(string ClickToRunPath, string Platform, string Culture, string? Version);

/// <summary>
/// Microsoft 365 / Office (Click-to-Run) Quick Repair. It re-validates and restores the Office program files in place: user documents,
/// mail data and settings are not touched, and no Office application is ever closed by Viro: if one is open the repair is deferred.
/// It cannot be rolled back (it only restores files to their intended state), which is why it needs a working diagnosis first and is
/// judged by whether the applications stop crashing, not by the exit code.
/// </summary>
sealed class OfficeQuickRepair : IRepairRecipe
{
    public string Id => "office.quick-repair"; public string Title => "Repair Microsoft 365 / Office (Quick Repair)";
    public RepairRisk Risk => RepairRisk.Safe; public bool AutoSafe => false; public bool Reversible => false;

    public static readonly string[] OfficeApps = ["outlook", "winword", "excel", "powerpnt", "onenote", "msaccess", "mspub", "visio", "winproj"];

    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var o = c.Env.OfficeClickToRun();
        if (o is null) return Task.FromResult(new Finding(false, "no Click-to-Run Office installation was found; this recipe supports Microsoft 365 / Office Click-to-Run only"));
        var open = OfficeApps.Where(c.Env.IsProcessRunning).ToList();
        if (open.Count > 0) throw new RepairDeferredException($"Office is open ({string.Join(", ", open)}). Viro does not close applications; the repair will run when they are closed");
        return Task.FromResult(new Finding(true, $"Office Click-to-Run {o.Version ?? "(version unknown)"} ({o.Platform}, {o.Culture}) is installed and no Office application is open", new { o.Version, o.Platform, o.Culture }));
    }

    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var o = c.Env.OfficeClickToRun() ?? throw new InvalidOperationException("Office Click-to-Run disappeared before the repair");
        // Fixed arguments only: the platform and culture come from Office's own configuration and are validated, never from the caller.
        if (!System.Text.RegularExpressions.Regex.IsMatch(o.Platform, "^(x64|x86)$") || !System.Text.RegularExpressions.Regex.IsMatch(o.Culture, "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$"))
            throw new InvalidOperationException("Office reports an unexpected platform or language; refusing to run the repair");
        var r = await c.Proc.RunAsync(o.ClickToRunPath, $"scenario=Repair platform={o.Platform} culture={o.Culture} forceappshutdown=False RepairType=QuickRepair DisplayLevel=False", TimeSpan.FromMinutes(45), ct);
        if (r.TimedOut) throw new TimeoutException("Office Quick Repair did not finish within 45 minutes");
        if (r.ExitCode != 0) throw new InvalidOperationException($"Office Quick Repair failed (exit {r.ExitCode}): {Truncate(r.Output)}");
        c.After = new { repaired = true };
    }

    public Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        // Technical verification only: Office is still installed and reports a version. Whether the crashes stop is verified by Control over the observation window.
        var o = c.Env.OfficeClickToRun();
        return Task.FromResult(o?.Version is null ? (false, "Office did not report a version after the repair") : (true, $"Quick Repair finished and Office {o.Version} is intact; stability is verified over the following days"));
    }

    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct) => throw new NotSupportedException();
    static string Truncate(string s) => s.Length > 300 ? s[..300] : s.Trim();
}

public partial class RepairEnv
{
    /// <summary>Office Click-to-Run details from the registry, or null when Office is not installed that way.</summary>
    public virtual OfficeInstall? OfficeClickToRun()
    {
        var exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles), @"microsoft shared\ClickToRun\OfficeClickToRun.exe");
        if (!File.Exists(exe)) return null;
        using var k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Office\ClickToRun\Configuration");
        return new(exe, (k?.GetValue("Platform") as string)?.ToLowerInvariant() ?? "x64", k?.GetValue("ClientCulture") as string ?? "en-us", k?.GetValue("VersionToReport") as string);
    }

    public virtual bool IsProcessRunning(string processName)
    {
        try { foreach (var p in Process.GetProcessesByName(processName)) { p.Dispose(); return true; } return false; } catch { return false; }
    }
}
