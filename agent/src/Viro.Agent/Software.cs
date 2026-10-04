using System.Text.RegularExpressions;
using Viro.Agent.Repair;

namespace Viro.Agent;

public sealed record AvailableUpgrade(string Name, string Id, string Version, string Available);

/// <summary>Locates winget for a service running as SYSTEM (the per-user alias is not on SYSTEM's path).</summary>
public static class Winget
{
    public static string? Find(Func<string, bool>? exists = null, Func<string, IEnumerable<string>>? dirs = null)
    {
        exists ??= File.Exists; dirs ??= p => Directory.Exists(Path.GetDirectoryName(p)!) ? Directory.EnumerateDirectories(Path.GetDirectoryName(p)!, Path.GetFileName(p)) : [];
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WindowsApps", "Microsoft.DesktopAppInstaller_*_8wekyb3d8bbwe");
        foreach (var d in dirs(root).OrderByDescending(x => x, StringComparer.OrdinalIgnoreCase))
        {
            var exe = Path.Combine(d, "winget.exe"); if (exists(exe)) return exe;
        }
        var alias = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WindowsApps", "winget.exe");
        return exists(alias) ? alias : null;
    }

    /// <summary>
    /// SYSTEM cannot start winget.exe from C:\Windows\System32 as the working directory (sharing violation); running it from its own
    /// package folder works. Returns the executable and arguments to hand to the process runner.
    /// </summary>
    public static (string exe, string args) Command(string wingetPath, string args)
    {
        var dir = Path.GetDirectoryName(wingetPath);
        return string.IsNullOrEmpty(dir) ? (wingetPath, args) : ("cmd.exe", $"/d /c cd /d \"{dir}\" && \"{Path.GetFileName(wingetPath)}\" {args}");
    }

    /// <summary>Parses the table printed by "winget upgrade": header row, dashed separator, then columns aligned to the header positions.</summary>
    public static List<AvailableUpgrade> ParseUpgrades(string output)
    {
        var lines = output.Replace("\r", "").Split('\n');
        var sep = Array.FindIndex(lines, l => Regex.IsMatch(l, @"^-{5,}\s*$"));
        if (sep < 1) return [];
        var header = lines[sep - 1];
        int Col(params string[] names) { foreach (var n in names) { var i = header.IndexOf(n, StringComparison.Ordinal); if (i >= 0) return i; } return -1; }
        int cName = Col("Name"), cId = Col("Id"), cVer = Col("Version"), cAvail = Col("Available"), cSrc = Col("Source");
        if (cName < 0 || cId < 0 || cVer < 0 || cAvail < 0) return [];
        var res = new List<AvailableUpgrade>();
        foreach (var l in lines.Skip(sep + 1))
        {
            if (l.Trim().Length == 0 || l.Length <= cAvail) continue;
            if (Regex.IsMatch(l.Trim(), @"^\d+ upgrades? available", RegexOptions.IgnoreCase)) break;
            string Slice(int a, int b) => (b > a && a < l.Length ? l[a..Math.Min(b, l.Length)] : a < l.Length ? l[a..] : "").Trim();
            var src = cSrc > 0 ? cSrc : l.Length;
            res.Add(new(Slice(cName, cId), Slice(cId, cVer), Slice(cVer, cAvail), Slice(cAvail, src)));
        }
        return res;
    }
}

/// <summary>software.install / software.update / software.uninstall { wingetId }. The server only issues these for packages the organization approved.</summary>
public sealed partial class SoftwareActionHandler(string type, IProcessRunner? proc = null, Func<string?>? findWinget = null) : IJobHandler
{
    public string Type => type;
    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9.+_-]{1,100}$")] private static partial Regex Id();

    static Task<ProcResult> Run(IProcessRunner r, string winget, string args, TimeSpan t, CancellationToken ct) { var (e, a) = Winget.Command(winget, args); return r.RunAsync(e, a, t, ct); }

    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var id = ctx.Job.Params.GetProperty("wingetId").GetString()!;
        if (!Id().IsMatch(id)) return new(false, null, "invalid package id");
        var winget = (findWinget ?? (() => Winget.Find()))();
        if (winget is null) return new(false, null, "winget (App Installer) is not available on this PC");
        var runner = proc ?? new SystemProcessRunner();
        const string common = "--exact --silent --accept-source-agreements --disable-interactivity";
        var verb = type switch { "software.install" => $"install --id {id} {common} --accept-package-agreements", "software.update" => $"upgrade --id {id} {common} --accept-package-agreements", _ => $"uninstall --id {id} {common}" };
        var before = await Run(runner, winget, $"list --id {id} --exact --accept-source-agreements", TimeSpan.FromMinutes(2), ct);
        var wasInstalled = before.ExitCode == 0;
        var r = await Run(runner, winget, verb, TimeSpan.FromMinutes(30), ct);
        var after = await Run(runner, winget, $"list --id {id} --exact --accept-source-agreements", TimeSpan.FromMinutes(2), ct);
        var nowInstalled = after.ExitCode == 0;
        var noUpdate = r.Output.Contains("No available upgrade found", StringComparison.OrdinalIgnoreCase) || r.Output.Contains("No newer package versions", StringComparison.OrdinalIgnoreCase);
        var verified = type == "software.uninstall" ? !nowInstalled : nowInstalled;
        var ok = (r.ExitCode == 0 || (type == "software.update" && noUpdate)) && verified;
        return new(ok, new { wingetId = id, action = type, wasInstalled, nowInstalled, exitCode = r.ExitCode, alreadyUpToDate = noUpdate, output = r.Output.Length > 800 ? r.Output[^800..] : r.Output.Trim() },
            ok ? null : r.TimedOut ? "timed out after 30 minutes" : (r.ExitCode != 0 && !(type == "software.update" && noUpdate)) ? $"winget failed (exit {r.ExitCode})" : $"winget finished but the package is {(nowInstalled ? "still" : "not")} installed");
    }
}

/// <summary>software.check-updates: which installed apps have newer versions available through winget.</summary>
public sealed class SoftwareCheckUpdatesHandler(IProcessRunner? proc = null, Func<string?>? findWinget = null) : IJobHandler
{
    public string Type => "software.check-updates";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var winget = (findWinget ?? (() => Winget.Find()))();
        if (winget is null) return new(false, null, "winget (App Installer) is not available on this PC");
        var (we, wa) = Winget.Command(winget, "upgrade --accept-source-agreements --disable-interactivity");
        var r = await (proc ?? new SystemProcessRunner()).RunAsync(we, wa, TimeSpan.FromMinutes(5), ct, System.Text.Encoding.UTF8);
        var list = Winget.ParseUpgrades(r.Output);
        return new(true, new { checkedAt = DateTime.UtcNow.ToString("O"), count = list.Count, upgrades = list });
    }
}
