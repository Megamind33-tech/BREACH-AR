using System.Diagnostics.Eventing.Reader;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using Viro.Agent.Repair;

namespace Viro.Agent.Care;

public enum StartupClass { KEEP, SAFE_TO_DISABLE, ASK }
public sealed record StartupItem(string Location, string Name, string Command, bool Enabled);
public sealed record StartupAssessment(StartupItem Item, StartupClass Class, string Reason);

/// <summary>
/// Which programs that start with Windows can be stopped from doing so without losing anything. Conservative: only consumer launchers, updaters and
/// vendor helper apps are SAFE_TO_DISABLE (each is reversible and the program still opens when the person starts it). Security, drivers, input,
/// audio, backup/sync and anything unknown are KEPT or left for a person.
/// </summary>
public static partial class StartupClassifier
{
    [GeneratedRegex(@"(securityhealth|windowsdefender|defender|avast|avg|kaspersky|mcafee|norton|bitdefender|eset|sophos|malwarebytes|crowdstrike|viro|rtkaud|realtek|waves|nahimic|synaptics|elan|touchpad|precision|igfx|intel.*(graphics|rapid|management)|nvidia(?!.*share)|amd.*(software|radeon)|bluetooth|wlan|wifi|vpn|globalprotect|forti|cisco|onedrive|backup|acronis|veeam|carbonite|teamviewer|anydesk|rustdesk|ctfmon|hotkey|fnkey|bitlocker|tpm|smartcard|fingerprint|windows hello|intune|vmware|virtualbox)", RegexOptions.IgnoreCase)]
    private static partial Regex Keep();
    [GeneratedRegex(@"(spotify|steam|discord|epicgames|epic games|origin|eadesktop|battle\.net|skype|squirrel\.teams|^teams$|ms-teams|msteams|zoom(?!it)|adobe|acrotray|acrobat|creative cloud|ccx|jusched|java update|googleupdate|google update|googlechromeautolaunch|microsoftedgeautolaunch|msedge.*autolaunch|itunes|ipod|quicktime|bonjour|cortana|yourphone|phone link|gamebar|widgets|bingwallpaper|ccleaner|utorrent|bittorrent|qbittorrent|opera.*assistant|hp.*(support|smart|touchpoint|jumpstart|easy)|hpsupport|dell.*(supportassist|techhub|update)|supportassist|lenovo.*(vantage|welcome)|asus.*(armoury|myasus|link|osd)|msi.*(center|dragon)|razer|logitech.*(gaming|lghub|options)|lghub|corsair|steelseries|nzxt|dropbox.*update|grammarly|evernote|slack|whatsapp|telegram|line\.exe|kakao|wechat|dingtalk|baidu|tencent|thunder)", RegexOptions.IgnoreCase)]
    private static partial Regex Consumer();

    public static StartupAssessment Assess(StartupItem i)
    {
        var probe = $"{i.Name} {Path.GetFileNameWithoutExtension(FirstPath(i.Command))}";
        if (Keep().IsMatch(probe)) return new(i, StartupClass.KEEP, "security, hardware support, sync/backup or remote management: kept");
        if (Consumer().IsMatch(probe)) return new(i, StartupClass.SAFE_TO_DISABLE, "a launcher, updater or helper that opens fine when started by hand");
        return new(i, StartupClass.ASK, "not recognised; needs a person's decision");
    }
    public static string FirstPath(string command) { var m = Regex.Match(command ?? "", "^\\s*\"([^\"]+)\"|^\\s*(\\S+)"); return m.Success ? (m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value) : ""; }
}

// ---------------------------------------------------------------------------------------------------------------------
public sealed record BootRecord(DateTime At, double BootSeconds, double? MainPathSeconds, double? PostBootSeconds);
public sealed record StartupDegradation(string Name, double DegradationSeconds, double TotalSeconds);
public sealed record BootEvidence(IReadOnlyList<BootRecord> Boots, IReadOnlyList<StartupDegradation> Degrading);

/// <summary>Measured boot and start-up timings from the Windows Diagnostics-Performance log (needs administrator rights, so the service reads it; null when unreadable).</summary>
public static class BootHistory
{
    const string Log = "Microsoft-Windows-Diagnostics-Performance/Operational";

    public static BootEvidence? Read(int max = 12)
    {
        try
        {
            var boots = new List<BootRecord>(); var deg = new Dictionary<string, StartupDegradation>(StringComparer.OrdinalIgnoreCase);
            foreach (var (id, limit) in new[] { (100, max), (101, 120) })
            {
                using var r = new EventLogReader(new EventLogQuery(Log, PathType.LogName, $"*[System[(EventID={id})]]") { ReverseDirection = true });
                for (var n = 0; n < limit; n++)
                {
                    using var ev = r.ReadEvent(); if (ev is null) break;
                    var d = Fields(ev);
                    if (id == 100 && d.TryGetValue("BootTime", out var bt) && double.TryParse(bt, out var ms) && ms > 0)
                        boots.Add(new(ev.TimeCreated?.ToUniversalTime() ?? DateTime.UtcNow, Math.Round(ms / 1000, 1), d.TryGetValue("MainPathBootTime", out var mp) && double.TryParse(mp, out var m1) ? Math.Round(m1 / 1000, 1) : null, d.TryGetValue("BootPostBootTime", out var pb) && double.TryParse(pb, out var p1) ? Math.Round(p1 / 1000, 1) : null));
                    else if (id == 101 && (d.GetValueOrDefault("FriendlyName") ?? d.GetValueOrDefault("Name")) is { Length: > 0 } nm && double.TryParse(d.GetValueOrDefault("DegradationTime"), out var dg) && dg > 0)
                    { var prev = deg.GetValueOrDefault(nm); if (prev is null || dg / 1000 > prev.DegradationSeconds) deg[nm] = new(nm, Math.Round(dg / 1000, 1), double.TryParse(d.GetValueOrDefault("TotalTime"), out var tt) ? Math.Round(tt / 1000, 1) : 0); }
                }
            }
            return new(boots.OrderByDescending(b => b.At).ToList(), deg.Values.OrderByDescending(x => x.DegradationSeconds).Take(15).ToList());
        }
        catch (Exception e) when (e is UnauthorizedAccessException or EventLogException or InvalidOperationException) { return null; }
    }

    public static Dictionary<string, string> Fields(EventRecord ev)
    {
        var d = new Dictionary<string, string>(); var x = System.Xml.Linq.XDocument.Parse(ev.ToXml());
        foreach (var e in x.Descendants().Where(e => e.Name.LocalName == "Data" && e.Attribute("Name") is not null)) d[e.Attribute("Name")!.Value] = e.Value;
        return d;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
/// <summary>startup.enable { entries }: turns start-up programs back on (the reverse of startup.disable), so a choice can always be changed. Reversible.</summary>
public sealed class StartupEnableRecipe : IRepairRecipe
{
    public string Id => "startup.enable"; public string Title => "Let selected start-up programs start with Windows again";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => true;
    sealed record Target(string Location, string Name);
    static List<Target> Requested(RepairContext c)
    {
        if (c.Options.ValueKind != JsonValueKind.Object || !c.Options.TryGetProperty("entries", out var e) || e.ValueKind != JsonValueKind.Array) throw new ArgumentException("options.entries is required");
        return [.. e.EnumerateArray().Select(x => new Target(x.GetProperty("location").GetString()!, x.GetProperty("name").GetString()!))];
    }
    static bool IsDisabled(RepairContext c, Target t) { var slot = c.Env.StartupSlots().FirstOrDefault(s => string.Equals(s.Location, t.Location, StringComparison.OrdinalIgnoreCase)); using var ap = slot?.OpenApproved(false); return ap?.GetValue(t.Name) is byte[] b && b.Length > 0 && (b[0] & 1) == 1; }

    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var off = Requested(c).Where(t => IsDisabled(c, t)).ToList();
        return Task.FromResult(new Finding(off.Count > 0, off.Count == 0 ? "none of the named start-up programs is disabled" : $"{off.Count} start-up program(s) will be turned back on: {string.Join(", ", off.Select(o => o.Name))}", off));
    }
    public Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var slots = c.Env.StartupSlots(); var prior = new List<object>(); c.RollbackState["entries"] = prior;
        foreach (var t in (List<Target>)f.Before!)
        {
            var slot = slots.First(s => string.Equals(s.Location, t.Location, StringComparison.OrdinalIgnoreCase));
            using var ap = slot.OpenApproved(true) ?? throw new InvalidOperationException($"cannot open the StartupApproved key for {t.Location} (administrator rights are required)");
            var old = ap.GetValue(t.Name) as byte[]; prior.Add(new { location = t.Location, name = t.Name, previous = old is null ? null : Convert.ToBase64String(old) });
            var enabled = new byte[12]; enabled[0] = 0x02; ap.SetValue(t.Name, enabled, RegistryValueKind.Binary);
        }
        return Task.CompletedTask;
    }
    public Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var still = ((List<Target>)f.Before!).Where(t => IsDisabled(c, t)).Select(t => t.Name).ToList();
        return Task.FromResult((still.Count == 0, still.Count == 0 ? "they start with Windows again" : "still disabled: " + string.Join(", ", still)));
    }
    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        var slots = c.Env.StartupSlots();
        foreach (var e in saved.GetProperty("entries").EnumerateArray())
        {
            var slot = slots.First(s => string.Equals(s.Location, e.GetProperty("location").GetString(), StringComparison.OrdinalIgnoreCase));
            using var ap = slot.OpenApproved(true) ?? throw new InvalidOperationException("cannot open StartupApproved key"); var name = e.GetProperty("name").GetString()!;
            if (e.GetProperty("previous").ValueKind == JsonValueKind.String) ap.SetValue(name, Convert.FromBase64String(e.GetProperty("previous").GetString()!), RegistryValueKind.Binary); else ap.DeleteValue(name, false);
        }
        return Task.CompletedTask;
    }
}

/// <summary>startup.optimize: stops launchers, updaters and vendor helpers from starting with Windows. Reversible (Windows' own StartupApproved switch); nothing is uninstalled.</summary>
public sealed class StartupOptimizeRecipe(Func<BootEvidence?>? boot = null) : IRepairRecipe
{
    public const string MarkerFile = "startup-optimized.txt";
    public string Id => "startup.optimize"; public string Title => "Speed up start-up: stop launchers and updaters from starting with Windows";
    public RepairRisk Risk => RepairRisk.Safe; public bool AutoSafe => true; public bool Reversible => true;

    public static List<StartupItem> Items(RepairEnv env)
    {
        var o = new List<StartupItem>();
        foreach (var slot in env.StartupSlots())
        {
            using var ap = slot.OpenApproved(false);
            foreach (var (n, cmd) in slot.Entries())
            {
                var b = ap?.GetValue(n) as byte[]; o.Add(new(slot.Location, n, cmd, !(b is { Length: > 0 } && (b[0] & 1) == 1)));
            }
        }
        return o;
    }

    (List<StartupAssessment> all, List<StartupAssessment> targets) Analyse(RepairContext c)
    {
        var all = Items(c.Env).Where(i => i.Enabled).Select(StartupClassifier.Assess).ToList();
        return (all, all.Where(a => a.Class == StartupClass.SAFE_TO_DISABLE).ToList());
    }

    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var (all, targets) = Analyse(c); var evidence = (boot ?? (() => BootHistory.Read()))();
        var measured = targets.Sum(t => evidence?.Degrading.FirstOrDefault(d => t.Item.Name.Contains(d.Name, StringComparison.OrdinalIgnoreCase) || d.Name.Contains(t.Item.Name, StringComparison.OrdinalIgnoreCase))?.DegradationSeconds ?? 0);
        return Task.FromResult(new Finding(targets.Count > 0, targets.Count == 0 ? $"{all.Count} start-up program(s), none safe to stop automatically" : $"{targets.Count} of {all.Count} start-up programs can be stopped safely: {string.Join(", ", targets.Select(t => t.Item.Name))}",
            new { targets = targets.Select(t => new { t.Item.Location, t.Item.Name, t.Item.Command, reason = t.Reason }).ToList(), total = all.Count, measuredDelaySeconds = measured > 0 ? measured : (double?)null, lastBootSeconds = evidence?.Boots.FirstOrDefault()?.BootSeconds }));
    }

    public Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var (_, targets) = Analyse(c); var slots = c.Env.StartupSlots(); var prior = new List<object>();
        c.RollbackState["entries"] = prior;      // recorded as it goes, so a failure half-way can still be undone
        foreach (var t in targets)
        {
            var slot = slots.First(s => string.Equals(s.Location, t.Item.Location, StringComparison.OrdinalIgnoreCase));
            using var ap = slot.OpenApproved(true) ?? throw new InvalidOperationException($"cannot open the StartupApproved key for {t.Item.Location} (administrator rights are required)");
            var old = ap.GetValue(t.Item.Name) as byte[]; prior.Add(new { location = t.Item.Location, name = t.Item.Name, previous = old is null ? null : Convert.ToBase64String(old) });
            var disabled = new byte[12]; disabled[0] = 0x03; BitConverter.GetBytes(DateTime.UtcNow.ToFileTimeUtc()).CopyTo(disabled, 4);
            ap.SetValue(t.Item.Name, disabled, RegistryValueKind.Binary);
        }
        c.RollbackState["entries"] = prior; c.After = new { disabled = prior.Count, note = "The saving is measured at the next restart." };
        try { Directory.CreateDirectory(c.Env.StateDir); File.WriteAllText(Path.Combine(c.Env.StateDir, MarkerFile), DateTime.UtcNow.ToString("O")); } catch { /* the marker only lets the health report say "restart to measure" */ }
        return Task.CompletedTask;
    }

    public Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var still = Analyse(c).targets;
        return Task.FromResult((still.Count == 0, still.Count == 0 ? "they no longer start with Windows; the new start-up time is measured at the next restart" : "still enabled: " + string.Join(", ", still.Select(s => s.Item.Name))));
    }

    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        var slots = c.Env.StartupSlots();
        foreach (var e in saved.GetProperty("entries").EnumerateArray())
        {
            var slot = slots.First(s => string.Equals(s.Location, e.GetProperty("location").GetString(), StringComparison.OrdinalIgnoreCase));
            using var ap = slot.OpenApproved(true) ?? throw new InvalidOperationException("cannot open StartupApproved key"); var name = e.GetProperty("name").GetString()!;
            if (e.GetProperty("previous").ValueKind == JsonValueKind.String) ap.SetValue(name, Convert.FromBase64String(e.GetProperty("previous").GetString()!), RegistryValueKind.Binary); else ap.DeleteValue(name, false);
        }
        return Task.CompletedTask;
    }
}
