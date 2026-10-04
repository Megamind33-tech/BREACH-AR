using System.Diagnostics.Eventing.Reader;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using Viro.Agent.Repair;

namespace Viro.Agent.Care;

/// <summary>A program installed on this PC. Kind says how Windows can repair it: "msi" (Windows Installer), "appx" (Microsoft Store app) or "other" (no built-in repair).</summary>
public sealed record InstalledApp(string Name, string Version, string Publisher, string Kind, string? Id);
/// <summary>A program that crashed or froze recently, as Windows recorded it.</summary>
public sealed record AppCrash(string Exe, int Crashes, int Hangs, DateTime LastAt, string? MatchedApp);

public static partial class AppInventory
{
    [DllImport("msi.dll", CharSet = CharSet.Unicode)] static extern int MsiQueryProductState(string product);
    [GeneratedRegex(@"^\{[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}\}$")] public static partial Regex ProductCode();
    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$")] public static partial Regex PackageName();

    /// <summary>Programs from the Windows "Installed apps" list. Windows Installer ones can be repaired by Windows itself.</summary>
    public static List<InstalledApp> Registered()
    {
        var o = new Dictionary<string, InstalledApp>(StringComparer.OrdinalIgnoreCase);
        const string path = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", wow = @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
        foreach (var (hive, sub) in new[] { (Registry.LocalMachine, path), (Registry.LocalMachine, wow), (Registry.CurrentUser, path) })
        {
            using var root = hive.OpenSubKey(sub); if (root is null) continue;
            foreach (var n in root.GetSubKeyNames())
            {
                try
                {
                    using var k = root.OpenSubKey(n); if (k is null) continue;
                    if (k.GetValue("DisplayName") is not string name || name.Length == 0 || k.GetValue("SystemComponent") is 1 || k.GetValue("ParentKeyName") is not null || k.GetValue("ReleaseType") is "Update" or "Security Update" or "Hotfix") continue;
                    var msi = k.GetValue("WindowsInstaller") is 1 && ProductCode().IsMatch(n);
                    var key = name + "|" + (k.GetValue("DisplayVersion") as string);
                    o[key] = new(name, k.GetValue("DisplayVersion") as string ?? "", k.GetValue("Publisher") as string ?? "", msi ? "msi" : "other", msi ? n : null);
                }
                catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException) { /* not readable: skip it */ }
            }
        }
        return [.. o.Values.OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase)];
    }

    /// <summary>Microsoft Store apps for the current user (or every user when running as administrator).</summary>
    public static async Task<List<InstalledApp>> StoreAppsAsync(IProcessRunner proc, bool allUsers, CancellationToken ct)
    {
        var cmd = $"Get-AppxPackage{(allUsers ? " -AllUsers" : "")} | Where-Object {{ -not $_.IsFramework -and -not $_.NonRemovable }} | Select-Object Name,Version,Publisher | ConvertTo-Json -Compress";
        var r = await proc.RunAsync("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"{cmd}\"", TimeSpan.FromSeconds(60), ct);
        if (r.ExitCode != 0 || string.IsNullOrWhiteSpace(r.Output)) return [];
        try
        {
            using var d = JsonDocument.Parse(r.Output.Trim()); var items = d.RootElement.ValueKind == JsonValueKind.Array ? d.RootElement.EnumerateArray().ToList() : [d.RootElement];
            return [.. items.Select(x => new InstalledApp(x.GetProperty("Name").GetString() ?? "", x.GetProperty("Version").GetString() ?? "", Regex.Match(x.GetProperty("Publisher").GetString() ?? "", @"CN=([^,]+)").Groups[1].Value, "appx", x.GetProperty("Name").GetString()))
                .Where(a => PackageName().IsMatch(a.Name)).OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase)];
        }
        catch (JsonException) { return []; }
    }

    /// <summary>Windows Installer's own verdict on a product: 5 means installed and healthy.</summary>
    public static int MsiState(string productCode) { try { return MsiQueryProductState(productCode); } catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException) { return -99; } }

    /// <summary>Programs that crashed or froze in the last days (Application log; readable without administrator rights), matched to an installed program where the name allows.</summary>
    public static List<AppCrash> Crashes(IReadOnlyList<InstalledApp> installed, int days = 7)
    {
        var o = new Dictionary<string, (int crash, int hang, DateTime last)>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var q = $"*[System[(Provider[@Name='Application Error'] or Provider[@Name='Application Hang']) and (EventID=1000 or EventID=1002) and TimeCreated[timediff(@SystemTime) <= {days * 86400000L}]]]";
            using var r = new EventLogReader(new EventLogQuery("Application", PathType.LogName, q) { ReverseDirection = true });
            for (var n = 0; n < 600; n++)
            {
                using var ev = r.ReadEvent(); if (ev is null) break;
                if (ev.Properties.Count == 0 || ev.Properties[0].Value is not string exe || exe.Length == 0) continue;
                var cur = o.GetValueOrDefault(Path.GetFileName(exe)); var at = ev.TimeCreated?.ToUniversalTime() ?? DateTime.UtcNow;
                var shown = Path.GetFileName(exe); o[shown] = (cur.crash + (ev.Id == 1000 ? 1 : 0), cur.hang + (ev.Id == 1002 ? 1 : 0), at > cur.last ? at : cur.last);
            }
        }
        catch (Exception e) when (e is UnauthorizedAccessException or EventLogException) { return []; }
        return [.. o.OrderByDescending(x => x.Value.crash + x.Value.hang).Take(15).Select(x => new AppCrash(x.Key, x.Value.crash, x.Value.hang, x.Value.last, Match(x.Key, installed)))];
    }

    public static string? Match(string exe, IReadOnlyList<InstalledApp> installed)
    {
        var stem = Path.GetFileNameWithoutExtension(exe); if (stem.Length < 4) return null;
        return installed.FirstOrDefault(a => a.Name.Contains(stem, StringComparison.OrdinalIgnoreCase) || stem.Contains(a.Name.Split(' ')[0], StringComparison.OrdinalIgnoreCase) && a.Name.Split(' ')[0].Length >= 4)?.Name;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
/// <summary>
/// app.repair { kind: "msi" | "appx", id }: asks Windows to repair one program. For Windows Installer programs this reinstalls damaged or missing program files (settings and
/// your data are not touched); for Microsoft Store apps it re-registers the app. Verified afterwards by asking Windows whether the program is healthy.
/// </summary>
public sealed class AppRepairRecipe(Func<string, int>? msiState = null) : IRepairRecipe
{
    public string Id => "app.repair"; public string Title => "Repair a program (restore its damaged or missing files)";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => false;
    readonly Func<string, int> state = msiState ?? AppInventory.MsiState;

    static (string kind, string id) Request(RepairContext c)
    {
        string S(string n) => c.Options.ValueKind == JsonValueKind.Object && c.Options.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
        var kind = S("kind"); var id = S("id");
        if (kind == "msi" && AppInventory.ProductCode().IsMatch(id)) return (kind, id);
        if (kind == "appx" && AppInventory.PackageName().IsMatch(id)) return (kind, id);
        throw new ArgumentException("options.kind must be msi (with the product code) or appx (with the package name)");
    }

    public async Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var (kind, id) = Request(c);
        if (kind == "msi")
        {
            var s = state(id);
            return s is -1 or 1 or 2 ? new(false, "Windows does not have this program installed for this user, so there is nothing to repair") : new(true, s == 5 ? "Windows reports it healthy; it will be checked and any damaged files restored" : $"Windows reports it is not fully installed (state {s}); its files will be restored", new { kind, id, state = s });
        }
        var r = await c.Proc.RunAsync("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"(Get-AppxPackage -Name '{id}' | Select-Object -First 1).PackageFullName\"", TimeSpan.FromSeconds(60), ct);
        return r.ExitCode == 0 && r.Output.Trim().Length > 0 ? new(true, "the Store app will be re-registered", new { kind, id }) : new(false, "that Store app is not installed for this user");
    }

    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var (kind, id) = Request(c);
        if (kind == "msi")
        {
            // /fa: reinstall every file regardless of version, rewrite registry entries and shortcuts. Quiet, and never restarts the PC by itself.
            var r = await c.Proc.RunAsync("msiexec.exe", $"/fa {id} /qn /norestart", TimeSpan.FromMinutes(30), ct);
            if (r.TimedOut) throw new InvalidOperationException("Windows Installer did not finish in 30 minutes");
            if (r.ExitCode == 3010 || r.ExitCode == 1641) c.RebootRequired = true;
            else if (r.ExitCode != 0) throw new InvalidOperationException(r.ExitCode switch
            {
                1730 or 1925 => "this repair needs administrator rights: use Run as administrator",
                1612 or 1706 => "Windows needs the program's original installer to repair it, and cannot find it",
                1618 => "another installation is running; try again in a few minutes",
                _ => $"Windows Installer returned code {r.ExitCode}",
            });
            c.After = new { kind, id, installerExit = r.ExitCode };
        }
        else
        {
            var elevated = Installer.IsElevated();
            var r = await c.Proc.RunAsync("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"$ErrorActionPreference='Stop'; Get-AppxPackage{(elevated ? " -AllUsers" : "")} -Name '{id}' | ForEach-Object {{ Add-AppxPackage -DisableDevelopmentMode -Register ($_.InstallLocation + '\\AppxManifest.xml') }}\"", TimeSpan.FromMinutes(5), ct);
            if (r.ExitCode != 0) throw new InvalidOperationException("Windows could not re-register the app: " + r.Output.Trim().Split('\n').FirstOrDefault()?.Trim());
            c.After = new { kind, id };
        }
    }

    public async Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var (kind, id) = Request(c);
        if (kind == "msi") { var s = state(id); return (s == 5, s == 5 ? "Windows Installer reports the program is installed and healthy" : $"Windows Installer still reports state {s}"); }
        var r = await c.Proc.RunAsync("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"(Get-AppxPackage -Name '{id}' | Select-Object -First 1).Status\"", TimeSpan.FromSeconds(60), ct);
        var st = r.Output.Trim(); return (st.Equals("Ok", StringComparison.OrdinalIgnoreCase), st.Equals("Ok", StringComparison.OrdinalIgnoreCase) ? "Windows reports the app is registered and healthy" : $"Windows reports the app status as '{(st.Length == 0 ? "unknown" : st)}'");
    }

    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct) => Task.CompletedTask;     // a repair only restores files the program already owned; there is nothing of yours to put back
}
