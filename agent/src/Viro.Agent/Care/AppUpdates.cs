using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Viro.Agent.Repair;

namespace Viro.Agent.Care;

public sealed record AppUpdate(string Name, string Id, string Version, string Available, string Source);

/// <summary>Finds and installs newer versions of the programs on this PC through Windows Package Manager (winget), which ships with current Windows 10 and 11.</summary>
public static partial class AppUpdates
{
    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._+-]{1,120}$")] public static partial Regex PackageId();

    public static string? WingetPath()
    {
        var candidates = new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WindowsApps", "winget.exe") };
        var onPath = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries).Select(d => { try { return Path.Combine(d.Trim(), "winget.exe"); } catch { return ""; } });
        return candidates.Concat(onPath).FirstOrDefault(p => p.Length > 0 && File.Exists(p));
    }

    /// <summary>Programs with a newer version available. Null when winget is not available on this PC (the page says so; nothing is guessed).</summary>
    public static async Task<List<AppUpdate>?> ListAsync(IProcessRunner proc, CancellationToken ct)
    {
        var exe = WingetPath() ?? "winget.exe";
        var r = await proc.RunAsync(exe, "upgrade --accept-source-agreements --disable-interactivity", TimeSpan.FromMinutes(3), ct, Encoding.UTF8);
        if (r.TimedOut || (r.ExitCode != 0 && !Regex.IsMatch(r.Output, @"Name\s+Id\s+Version")) ) return r.ExitCode == unchecked((int)0x8A150014) || r.Output.Contains("No installed package", StringComparison.OrdinalIgnoreCase) ? [] : null;
        return Parse(r.Output);
    }

    /// <summary>Reads winget's table by the column positions in its own header line, so names with spaces stay whole.</summary>
    public static List<AppUpdate> Parse(string output)
    {
        var lines = output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).ToList();      // winget redraws its spinner with carriage returns; each redraw is its own segment
        var h = lines.FindIndex(l => Regex.IsMatch(l, @"^\s*Name\s+Id\s+Version\s+Available"));
        var o = new List<AppUpdate>(); if (h < 0) return o;
        var head = lines[h]; int cId = head.IndexOf("Id", StringComparison.Ordinal), cVer = head.IndexOf("Version", StringComparison.Ordinal), cAv = head.IndexOf("Available", StringComparison.Ordinal), cSrc = head.IndexOf("Source", StringComparison.Ordinal);
        for (var i = h + 1; i < lines.Count; i++)
        {
            var l = lines[i]; if (l.Trim().Length == 0 || l.StartsWith("---") || Regex.IsMatch(l, @"^\s*\d+ upgrades? available", RegexOptions.IgnoreCase) || l.Contains("require explicit targeting", StringComparison.OrdinalIgnoreCase)) { if (l.Trim().Length == 0 || Regex.IsMatch(l, @"upgrades? available", RegexOptions.IgnoreCase)) break; continue; }
            if (l.Length <= cAv) continue;
            string Cut(int a, int b) => (a >= l.Length ? "" : l[a..Math.Min(b < 0 ? l.Length : b, l.Length)]).Trim();
            var name = Cut(0, cId); var id = Cut(cId, cVer); var ver = Cut(cVer, cAv); var av = Cut(cAv, cSrc < 0 ? -1 : cSrc); var src = cSrc < 0 ? "" : Cut(cSrc, -1);
            if (PackageId().IsMatch(id) && av.Length > 0) o.Add(new(name, id, ver.TrimStart('<', '>', ' '), av, src));
        }
        return o;
    }
}

/// <summary>app.update { id }: installs the newer version of one program with winget, silently, after the person chose it. Verified by asking winget whether a newer version is still offered.</summary>
public sealed class AppUpdateRecipe(Func<IProcessRunner, CancellationToken, Task<List<AppUpdate>?>>? list = null) : IRepairRecipe
{
    public string Id => "app.update"; public string Title => "Update a program to its newest version";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => false;
    readonly Func<IProcessRunner, CancellationToken, Task<List<AppUpdate>?>> upgrades = list ?? AppUpdates.ListAsync;

    static string PackageOf(RepairContext c)
    {
        var id = c.Options.ValueKind == JsonValueKind.Object && c.Options.TryGetProperty("id", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
        return AppUpdates.PackageId().IsMatch(id) ? id : throw new ArgumentException("options.id must be a winget package id");
    }

    public async Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var id = PackageOf(c); var all = await upgrades(c.Proc, ct);
        if (all is null) return new(false, "Windows Package Manager (winget) is not available on this PC, so programs cannot be updated from here");
        var u = all.FirstOrDefault(x => string.Equals(x.Id, id, StringComparison.OrdinalIgnoreCase));
        return u is null ? new(false, "no newer version of that program is offered right now") : new(true, $"{u.Name} {u.Version} will be updated to {u.Available}", u);
    }

    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var u = (AppUpdate)f.Before!; var exe = AppUpdates.WingetPath() ?? "winget.exe";
        var r = await c.Proc.RunAsync(exe, $"upgrade --id {u.Id} --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity", TimeSpan.FromMinutes(30), ct, Encoding.UTF8);
        if (r.TimedOut) throw new InvalidOperationException("the update did not finish in 30 minutes");
        if (r.ExitCode == unchecked((int)0x8A150101) || r.ExitCode == 3010 || r.ExitCode == unchecked((int)0x8A150109)) { c.RebootRequired = true; }
        else if (r.ExitCode != 0)
        {
            var why = Regex.IsMatch(r.Output, "in use|running|close", RegexOptions.IgnoreCase) ? "close the program first and try again" : Regex.IsMatch(r.Output, "administrator|elevat|0x80070005", RegexOptions.IgnoreCase) ? "this update needs administrator rights: use Run as administrator" : $"winget returned code 0x{r.ExitCode:X}";
            throw new InvalidOperationException($"{u.Name} was not updated: {why}");
        }
        c.After = new { u.Id, from = u.Version, to = u.Available };
    }

    public async Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var u = (AppUpdate)f.Before!; var after = await upgrades(c.Proc, ct);
        var still = after?.Any(x => string.Equals(x.Id, u.Id, StringComparison.OrdinalIgnoreCase) && x.Available == u.Available) ?? true;
        return (!still, still ? $"winget still offers {u.Available}; the update may need a restart or the program closed" : $"{u.Name} is now up to date");
    }

    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct) => Task.CompletedTask;
}
