using System.Diagnostics.Eventing.Reader;
using System.Text.RegularExpressions;

namespace Viro.Agent;

/// <summary>
/// Stability evidence: every application crash and hang of the last 14 days with the details Windows recorded (faulting executable and
/// module, exception code, versions), plus what changed on the PC recently (Windows updates, program installs). Individual records are
/// reported, not counts, so the server can correlate them with memory and disk state at the time and judge whether a repair worked
/// by counting only the crashes that happened after it.
/// </summary>
public static class StabilityCollector
{
    public sealed record CrashRecord(string App, string Kind, string? AppVersion, string? Module, string? ModuleVersion, string? ExceptionCode, string At);
    public sealed record ChangeRecord(string Kind, string Name, string At);

    const int MaxCrashes = 300, MaxChanges = 120, Days = 14;

    public static object Collect() => new { windowDays = Days, crashes = Crashes(), recentChanges = Changes() };

    public static List<CrashRecord> Crashes()
    {
        var list = new List<CrashRecord>();
        var ms = Days * 86_400_000L;
        var q = new EventLogQuery("Application", PathType.LogName,
            $"*[System[((Provider[@Name='Application Error'] and EventID=1000) or (Provider[@Name='Application Hang'] and EventID=1002)) and TimeCreated[timediff(@SystemTime) <= {ms}]]]") { ReverseDirection = true };
        using var r = new EventLogReader(q);
        for (var e = r.ReadEvent(); e != null && list.Count < MaxCrashes; e = r.ReadEvent())
            using (e)
            {
                var props = e.Properties.Select(p => p.Value?.ToString()).ToList();
                var rec = Parse(e.Id, props, e.TimeCreated?.ToUniversalTime());
                if (rec is not null) list.Add(rec);
            }
        return list;
    }

    /// <summary>
    /// Application Error (1000): [0] exe, [1] exe version, [2] timestamp, [3] faulting module, [4] module version, [5] timestamp, [6] exception code.
    /// Application Hang (1002): [0] exe, [1] version. Unknown or empty values are null, never guessed.
    /// </summary>
    public static CrashRecord? Parse(int eventId, IReadOnlyList<string?> p, DateTime? at)
    {
        if (at is null || p.Count == 0 || string.IsNullOrWhiteSpace(p[0])) return null;
        string? V(int i) => i < p.Count && !string.IsNullOrWhiteSpace(p[i]) && p[i] != "unknown" ? p[i]!.Trim() : null;
        var app = Path.GetFileName(p[0]!.Trim()).ToLowerInvariant();
        if (eventId == 1002) return new(app, "hang", V(1), null, null, null, at.Value.ToString("O"));
        return new(app, "crash", V(1), V(3), V(4), V(6), at.Value.ToString("O"));
    }

    public static List<ChangeRecord> Changes()
    {
        var list = new List<ChangeRecord>();
        var ms = Days * 86_400_000L;
        void Read(string log, string filter, Func<EventRecord, ChangeRecord?> map)
        {
            var q = new EventLogQuery(log, PathType.LogName, filter) { ReverseDirection = true };
            using var r = new EventLogReader(q);
            for (var e = r.ReadEvent(); e != null && list.Count < MaxChanges; e = r.ReadEvent())
                using (e) { var c = map(e); if (c is not null) list.Add(c); }
        }
        try { Read("System", $"*[System[Provider[@Name='Microsoft-Windows-WindowsUpdateClient'] and (EventID=19) and TimeCreated[timediff(@SystemTime) <= {ms}]]]", e => Update(e)); } catch { /* log unavailable */ }
        try { Read("Application", $"*[System[Provider[@Name='MsiInstaller'] and (EventID=11707 or EventID=11724) and TimeCreated[timediff(@SystemTime) <= {ms}]]]", e => Install(e)); } catch { /* log unavailable */ }
        return list;
    }

    static ChangeRecord? Update(EventRecord e)
    {
        var title = e.Properties.Count > 0 ? e.Properties[0].Value?.ToString() : null;
        return string.IsNullOrWhiteSpace(title) || e.TimeCreated is null ? null : new("windows-update", title.Trim(), e.TimeCreated.Value.ToUniversalTime().ToString("O"));
    }

    static ChangeRecord? Install(EventRecord e)
    {
        string? text; try { text = e.FormatDescription(); } catch { return null; }
        var name = ProductOf(text);
        return name is null || e.TimeCreated is null ? null : new(e.Id == 11724 ? "uninstall" : "install", name, e.TimeCreated.Value.ToUniversalTime().ToString("O"));
    }

    /// <summary>"Product: Microsoft 365 Apps -- Installation completed successfully." -> "Microsoft 365 Apps".</summary>
    public static string? ProductOf(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var m = Regex.Match(text, @"Product:\s*(?<n>.+?)\s*--", RegexOptions.Singleline);
        return m.Success ? m.Groups["n"].Value.Trim() : null;
    }
}
