using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Viro.Agent.Repair;

namespace Viro.Agent.Care;

public sealed record Leftover(string Id, string Kind, string Path, long Bytes);

/// <summary>
/// After a program is uninstalled, what it left behind that carries its own name: its folders in the usual places and its Start menu shortcuts. A match must be exact (the folder
/// is named for the program, not merely similar), and never a system or shared location. Nothing is deleted: matches are moved aside so the removal can be undone.
/// </summary>
public static partial class LeftoverScan
{
    [GeneratedRegex(@"\b(x64|x86|32-bit|64-bit|\(.*?\)|v?\d+(\.\d+)+|\d{4})\b", RegexOptions.IgnoreCase)] private static partial Regex Noise();
    [GeneratedRegex(@"[^a-z0-9]")] private static partial Regex NonAlnum();
    [GeneratedRegex(@"\b(inc|ltd|llc|corp|corporation|co|gmbh)\b\.?", RegexOptions.IgnoreCase)] private static partial Regex Company();

    public static string Norm(string s) => NonAlnum().Replace(Company().Replace(Noise().Replace(s ?? "", " "), " ").ToLowerInvariant(), "");
    public static string IdOf(string path) => Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(path.ToLowerInvariant())))[..12].ToLowerInvariant();

    public static IReadOnlyList<string> Roots(RepairEnv env) =>
    [
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), env.ProgramDataDir,
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
    ];
    public static IReadOnlyList<string> StartMenus(RepairEnv env) =>
    [
        Path.Combine(env.ProgramDataDir, @"Microsoft\Windows\Start Menu\Programs"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Windows\Start Menu\Programs"),
    ];

    static long Size(string dir) => AppSizer.FolderSize(dir, CancellationToken.None, 40_000) ?? 0;

    public static List<Leftover> Find(string appName, string? publisher, RepairEnv env, Func<string, bool>? stillInUse = null)
    {
        var o = new List<Leftover>(); var want = Norm(appName); if (want.Length < 4) return o;            // a very short name matches too much to be safe
        var pub = Norm(publisher ?? "");
        foreach (var root in Roots(env).Where(Directory.Exists))
        {
            foreach (var d in SafeDirs(root))
            {
                var n = Norm(Path.GetFileName(d));
                var hit = n == want || (pub.Length >= 3 && n == pub && Directory.Exists(Path.Combine(d, appName)));
                var target = n == want ? d : hit ? Path.Combine(d, appName) : null;
                if (target is null || !AppGuard.SafeFolder(target, env) || (stillInUse?.Invoke(target) ?? false)) continue;
                o.Add(new(IdOf(target), "folder", target, Size(target)));
            }
        }
        foreach (var menu in StartMenus(env).Where(Directory.Exists))
        {
            foreach (var e in Directory.EnumerateFileSystemEntries(menu))
            {
                var isDir = Directory.Exists(e); var n = Norm(isDir ? Path.GetFileName(e) : Path.GetFileNameWithoutExtension(e));
                if (n != want || (!isDir && !e.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase))) continue;
                o.Add(new(IdOf(e), isDir ? "folder" : "shortcut", e, isDir ? Size(e) : new FileInfo(e).Length));
            }
        }
        return [.. o.DistinctBy(x => x.Path, StringComparer.OrdinalIgnoreCase)];
    }

    static IEnumerable<string> SafeDirs(string root) { try { return Directory.GetDirectories(root); } catch (Exception e) when (e is UnauthorizedAccessException or IOException) { return []; } }
}

/// <summary>app.leftovers { name, publisher?, ids[] }: moves the chosen leftovers of an uninstalled program aside. It looks for them again itself and only touches what it finds now.</summary>
public sealed class AppLeftoversRecipe : IRepairRecipe
{
    public string Id => "app.leftovers"; public string Title => "Remove what an uninstalled program left behind";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => true;

    static string S(RepairContext c, string n) => c.Options.ValueKind == JsonValueKind.Object && c.Options.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
    static List<string> Ids(RepairContext c) => c.Options.ValueKind == JsonValueKind.Object && c.Options.TryGetProperty("ids", out var v) && v.ValueKind == JsonValueKind.Array ? [.. v.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0)] : [];
    List<Leftover> Chosen(RepairContext c) { var ids = Ids(c); return [.. LeftoverScan.Find(S(c, "name"), S(c, "publisher"), c.Env).Where(l => ids.Contains(l.Id))]; }

    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        if (S(c, "name").Length < 2 || Ids(c).Count == 0) throw new ArgumentException("options need name and ids");
        var l = Chosen(c); return Task.FromResult(l.Count == 0 ? new Finding(false, "those leftovers are already gone") : new(true, $"{l.Count} item{(l.Count == 1 ? "" : "s")} left behind by {S(c, "name")} will be moved aside", new { items = l.Select(x => x.Path) }));
    }

    public Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var q = Path.Combine(c.Env.StateDir, "quarantine", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(q); var moved = new List<object>(); var i = 0;
        foreach (var l in Chosen(c))
        {
            var dest = Path.Combine(q, (i++).ToString());
            try { if (l.Kind == "shortcut") { Directory.CreateDirectory(dest); File.Move(l.Path, Path.Combine(dest, Path.GetFileName(l.Path))); } else AppUninstallRecipe.MoveDir(l.Path, Path.Combine(dest, "folder")); moved.Add(new Dictionary<string, string> { ["from"] = l.Path, ["to"] = dest, ["kind"] = l.Kind }); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { /* in use or protected: left where it is */ }
        }
        if (moved.Count == 0) throw new InvalidOperationException("nothing could be moved: the files are in use or protected");
        c.RollbackState["moved"] = moved; c.After = new { moved = moved.Count };
        return Task.CompletedTask;
    }

    public Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var still = Chosen(c).Count; return Task.FromResult((still == 0, still == 0 ? "the leftovers are gone from where they were" : $"{still} item(s) are still there"));
    }

    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        if (!saved.TryGetProperty("moved", out var m)) return Task.CompletedTask;
        foreach (var x in m.EnumerateArray())
        {
            string from = x.GetProperty("from").GetString()!, to = x.GetProperty("to").GetString()!; var kind = x.GetProperty("kind").GetString();
            if (kind == "shortcut") { var f = Directory.GetFiles(to).FirstOrDefault(); if (f is not null && !File.Exists(from)) { Directory.CreateDirectory(Path.GetDirectoryName(from)!); File.Move(f, from); } }
            else if (Directory.Exists(Path.Combine(to, "folder")) && !Directory.Exists(from)) AppUninstallRecipe.MoveDir(Path.Combine(to, "folder"), from);
        }
        return Task.CompletedTask;
    }
}
