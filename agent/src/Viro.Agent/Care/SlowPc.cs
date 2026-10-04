using System.Diagnostics.Eventing.Reader;
using System.Text.Json;
using System.Text.RegularExpressions;
using Viro.Agent.Repair;

namespace Viro.Agent.Care;

public sealed record ShutdownRecord(DateTime At, double Seconds);
/// <summary>Something Windows itself recorded as holding up start-up or shutdown, and for how long.</summary>
public sealed record SlowItem(string Name, string Kind, double Seconds, int Times);
public sealed record ShutdownEvidence(IReadOnlyList<ShutdownRecord> Shutdowns, IReadOnlyList<SlowItem> Culprits, IReadOnlyList<SlowItem> SlowServices);

/// <summary>What Windows measured about how long this PC takes to switch off and what delayed it (Diagnostics-Performance log; administrator rights are needed to read it, so null when unreadable).</summary>
public static class ShutdownHistory
{
    const string Log = "Microsoft-Windows-Diagnostics-Performance/Operational";

    public static ShutdownEvidence? Read(int max = 20)
    {
        try
        {
            var shut = new List<ShutdownRecord>(); var culprits = new Dictionary<string, SlowItem>(StringComparer.OrdinalIgnoreCase); var services = new Dictionary<string, SlowItem>(StringComparer.OrdinalIgnoreCase);
            foreach (var id in new[] { 200, 201, 202, 203, 103 })
            {
                using var r = new EventLogReader(new EventLogQuery(Log, PathType.LogName, $"*[System[(EventID={id})]]") { ReverseDirection = true });
                for (var n = 0; n < (id == 200 ? max : 150); n++)
                {
                    using var ev = r.ReadEvent(); if (ev is null) break;
                    var d = BootHistory.Fields(ev);
                    if (id == 200) { if (Seconds(d, "ShutdownTime") is { } s && s > 0) shut.Add(new(ev.TimeCreated?.ToUniversalTime() ?? DateTime.UtcNow, s)); continue; }
                    var name = First(d, "FriendlyName", "Name", "ServiceName", "AppName", "FileName"); var secs = Seconds(d, "DegradationTime") ?? Seconds(d, "TotalTime") ?? 0;
                    if (name is null || secs <= 0) continue;
                    var kind = id == 103 ? "service" : Classify(ev);
                    var target = id == 103 ? services : culprits;
                    var prev = target.GetValueOrDefault(name);
                    target[name] = prev is null ? new(name, kind, Math.Round(secs, 1), 1) : prev with { Seconds = Math.Max(prev.Seconds, Math.Round(secs, 1)), Times = prev.Times + 1 };
                }
            }
            return new(shut.OrderByDescending(x => x.At).ToList(), culprits.Values.OrderByDescending(x => x.Seconds).Take(12).ToList(), services.Values.OrderByDescending(x => x.Seconds).Take(15).ToList());
        }
        catch (Exception e) when (e is UnauthorizedAccessException or EventLogException or InvalidOperationException) { return null; }
    }

    static string Classify(EventRecord ev) { string m; try { m = ev.FormatDescription() ?? ""; } catch { m = ""; } return Regex.IsMatch(m, "service", RegexOptions.IgnoreCase) ? "service" : Regex.IsMatch(m, "driver", RegexOptions.IgnoreCase) ? "driver" : "program"; }
    static string? First(Dictionary<string, string> d, params string[] keys) => keys.Select(k => d.GetValueOrDefault(k)).FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));
    static double? Seconds(Dictionary<string, string> d, string key) => double.TryParse(d.GetValueOrDefault(key), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var ms) ? ms / 1000 : null;
}

// ---------------------------------------------------------------------------------------------------------------------
/// <summary>shutdown.speed: puts back the Windows timeouts that decide how long a PC waits before switching off, when something (a tweak tool, an old setting) raised them. Reversible.</summary>
public sealed class ShutdownSpeedRecipe : IRepairRecipe
{
    public string Id => "shutdown.speed"; public string Title => "Speed up shut-down: restore the normal waiting times Windows uses";
    public RepairRisk Risk => RepairRisk.Safe; public bool AutoSafe => true; public bool Reversible => true;
    // Only values clearly above Windows' own defaults are touched; anything at or below default is the person's choice and stays.
    static IEnumerable<ShutdownSetting> Raised(RepairContext c) => c.Env.ReadShutdownSettings().Where(s => s.Current is { } v && v > s.Default);

    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var t = Raised(c).ToList(); var page = c.Env.ClearsPageFileAtShutdown();
        var note = page ? " Windows is also set to wipe the paging file at every shutdown. That is a security setting, so Viro leaves it alone, but it can add minutes to shutdown." : "";
        return Task.FromResult(new Finding(t.Count > 0, t.Count == 0 ? "no shut-down waiting time has been raised above Windows' default." + note : $"{t.Count} waiting time(s) are longer than Windows' default: {string.Join(", ", t.Select(x => $"{x.Name} {x.Current}ms (normal {x.Default}ms)"))}." + note,
            new { raised = t.Select(x => new { x.Where, x.Name, x.Current, x.Default }).ToList(), pageFileWipe = page }));
    }

    public Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var prior = new List<object>(); c.RollbackState["settings"] = prior;      // recorded as it goes, so a failure half-way can still be undone
        foreach (var s in Raised(c).ToList()) { prior.Add(new { s.Where, s.Name, previous = s.Current }); c.Env.WriteShutdownSetting(s.Where, s.Name, s.Default); }
        c.After = new { restored = prior.Count, note = "The saving shows at the next shut-down." };
        return Task.CompletedTask;
    }

    public Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var still = Raised(c).ToList();
        return Task.FromResult((still.Count == 0, still.Count == 0 ? "the waiting times are back to Windows' defaults; the new shut-down time is measured at the next shut-down" : "still raised: " + string.Join(", ", still.Select(x => x.Name))));
    }

    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        foreach (var e in saved.GetProperty("settings").EnumerateArray())
            c.Env.WriteShutdownSetting(e.GetProperty("where").GetString()!, e.GetProperty("name").GetString()!, e.GetProperty("previous").ValueKind == JsonValueKind.Number ? e.GetProperty("previous").GetInt32() : null);
        return Task.CompletedTask;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
/// <summary>boot.delay-services: third-party services that Windows measured as slowing start-up are started a little after sign-in ("Automatic (Delayed Start)"). They still run; the desktop just appears sooner. Reversible.</summary>
public sealed class BootDelayServicesRecipe(Func<IReadOnlyList<SlowItem>?>? evidence = null) : IRepairRecipe
{
    public string Id => "boot.delay-services"; public string Title => "Speed up start-up: start slow background services after sign-in";
    public RepairRisk Risk => RepairRisk.Safe; public bool AutoSafe => true; public bool Reversible => true;
    // Security products, Windows' own components and Viro start on time or are left to Windows; delaying them would leave a gap or change Windows behaviour.
    static readonly Regex Protected = new(@"defender|msmpeng|sense|windefend|avast|avg|avira|kaspersky|norton|mcafee|sophos|bitdefender|eset|malwarebytes|crowdstrike|sentinel|viro|vpn|firewall|bfe|mpssvc|eventlog|rpcss|dcom|lsm|samss|netlogon|winlogon|dhcp|dnscache|nlasvc|wlansvc|profsvc|power|plugplay", RegexOptions.IgnoreCase);
    const double MinSeconds = 2;

    sealed record Target(string Name, string Display, double Seconds);
    List<Target> Targets(RepairContext c)
    {
        var slow = (evidence ?? (() => ShutdownHistory.Read()?.SlowServices))() ?? [];
        var win = c.Env.WindowsDir;
        var entries = c.Env.ServiceEntries().Where(e => e.DelayedAutostart == 0).ToList();
        return [.. slow.Where(s => s.Seconds >= MinSeconds).Select(s => (s, e: entries.FirstOrDefault(e => string.Equals(e.Name, s.Name, StringComparison.OrdinalIgnoreCase) || string.Equals(e.Display, s.Name, StringComparison.OrdinalIgnoreCase))))
            .Where(x => x.e is not null && !x.e.ImagePath.Contains(win, StringComparison.OrdinalIgnoreCase) && !x.e.ImagePath.Contains("%SystemRoot%", StringComparison.OrdinalIgnoreCase) && !Protected.IsMatch(x.e.Name) && !Protected.IsMatch(x.e.Display))
            .Select(x => new Target(x.e!.Name, x.e.Display, x.s.Seconds))];
    }

    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var t = Targets(c);
        return Task.FromResult(new Finding(t.Count > 0, t.Count == 0 ? "no background service is measurably slowing start-up (or Windows has not recorded any yet)" : $"{t.Count} third-party service(s) slowed start-up: {string.Join(", ", t.Select(x => $"{x.Display} ({x.Seconds:0.#}s)"))}", t));
    }

    public Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var prior = new List<object>(); c.RollbackState["services"] = prior;
        foreach (var t in (List<Target>)f.Before!) { prior.Add(new { t.Name, previous = 0 }); c.Env.SetDelayedStart(t.Name, 1); }
        c.After = new { delayed = prior.Count, note = "The saving is measured at the next restart." };
        return Task.CompletedTask;
    }

    public Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var names = ((List<Target>)f.Before!).Select(t => t.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var still = c.Env.ServiceEntries().Where(e => names.Contains(e.Name) && e.DelayedAutostart != 1).Select(e => e.Name).ToList();
        return Task.FromResult((still.Count == 0, still.Count == 0 ? "they now start a little after sign-in; the new start-up time is measured at the next restart" : "not changed: " + string.Join(", ", still)));
    }

    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        foreach (var e in saved.GetProperty("services").EnumerateArray()) c.Env.SetDelayedStart(e.GetProperty("name").GetString()!, e.GetProperty("previous").GetInt32());
        return Task.CompletedTask;
    }
}
