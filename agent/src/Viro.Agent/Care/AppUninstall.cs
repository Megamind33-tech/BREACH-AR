using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using Viro.Agent.Repair;

namespace Viro.Agent.Care;

/// <summary>One entry from Windows' program registrations, with what is needed to size it up and take it off. Hive is HKLM, HKLM32 (32-bit programs) or HKCU; Hidden entries are ones Windows' own list does not show.</summary>
public sealed record AppEntry(string Key, string Hive, string Name, string Version, string Publisher, string Kind, string? InstallLocation, string? UninstallString, string? QuietUninstallString, long? SizeBytes, string? InstalledOn, bool Hidden, string? HiddenReason);

public interface IAppCatalog
{
    AppEntry? Find(string hive, string key);
    /// <summary>Removes a program's registration (the entry in the Installed apps list). Only used for forced removal.</summary>
    void DeleteRegistration(string hive, string key);
}

public sealed class RegistryAppCatalog : IAppCatalog
{
    public const string Path = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", Wow = @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
    static (RegistryKey root, string sub) Where(string hive) => hive switch
    {
        "HKLM" => (Registry.LocalMachine, Path), "HKLM32" => (Registry.LocalMachine, Wow), "HKCU" => (Registry.CurrentUser, Path),
        _ => throw new ArgumentException("hive must be HKLM, HKLM32 or HKCU"),
    };
    public static string FullPath(string hive, string key) { var (r, s) = Where(hive); return (r == Registry.LocalMachine ? "HKLM" : "HKCU") + "\\" + s + "\\" + key; }

    public AppEntry? Find(string hive, string key)
    {
        var (root, sub) = Where(hive);
        using var k = root.OpenSubKey(sub + "\\" + key);
        return k is null ? null : Read(hive, key, k);
    }
    public void DeleteRegistration(string hive, string key) { var (root, sub) = Where(hive); using var p = root.OpenSubKey(sub, true); p?.DeleteSubKeyTree(key, false); }

    /// <summary>Everything registered, hidden entries included (marked). Updates and patches are left out; they are not programs.</summary>
    public static List<AppEntry> All()
    {
        var o = new List<AppEntry>();
        foreach (var hive in new[] { "HKLM", "HKLM32", "HKCU" })
        {
            var (root, sub) = Where(hive);
            using var r = root.OpenSubKey(sub); if (r is null) continue;
            foreach (var n in r.GetSubKeyNames())
            {
                try { using var k = r.OpenSubKey(n); if (k is not null && Read(hive, n, k) is { } e) o.Add(e); }
                catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException) { }
            }
        }
        return o;
    }

    static AppEntry? Read(string hive, string key, RegistryKey k)
    {
        if (k.GetValue("DisplayName") is not string name || name.Length == 0) return null;
        if (k.GetValue("ReleaseType") is "Update" or "Security Update" or "Hotfix" || Regex.IsMatch(key, @"^KB\d+$")) return null;
        string? hidden = k.GetValue("SystemComponent") is 1 ? "Marked as a system component" : k.GetValue("ParentKeyName") is not null ? "Part of another program" : null;
        var msi = k.GetValue("WindowsInstaller") is 1 && AppInventory.ProductCode().IsMatch(key);
        var loc = (k.GetValue("InstallLocation") as string)?.Trim().Trim('"');
        long? size = k.GetValue("EstimatedSize") is int kb && kb > 0 ? kb * 1024L : null;
        return new(key, hive, name, k.GetValue("DisplayVersion") as string ?? "", k.GetValue("Publisher") as string ?? "", msi ? "msi" : "other",
            string.IsNullOrWhiteSpace(loc) ? null : loc, k.GetValue("UninstallString") as string, k.GetValue("QuietUninstallString") as string, size,
            k.GetValue("InstallDate") as string, hidden is not null, hidden);
    }
}

public static class AppSizer
{
    /// <summary>Total size of a folder, or null when it cannot be read. Bounded so one huge folder cannot stall the list.</summary>
    public static long? FolderSize(string path, CancellationToken ct, int maxFiles = 150_000)
    {
        try
        {
            if (!Directory.Exists(path)) return null;
            long total = 0; var n = 0;
            var opt = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint };
            foreach (var f in new DirectoryInfo(path).EnumerateFiles("*", opt)) { ct.ThrowIfCancellationRequested(); total += f.Length; if (++n >= maxFiles) break; }
            return total;
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException) { return null; }
    }

    /// <summary>Fills in a measured size for programs that did not register one, a few at a time, within the given time budget.</summary>
    public static List<AppEntry> Fill(IReadOnlyList<AppEntry> apps, TimeSpan budget, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew(); var result = apps.ToArray();
        Parallel.For(0, result.Length, new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct }, i =>
        {
            var a = result[i]; if (a.SizeBytes is not null || a.InstallLocation is null || sw.Elapsed > budget) return;
            if (FolderSize(a.InstallLocation, ct) is { } s) result[i] = a with { SizeBytes = s };
        });
        return [.. result];
    }
}

/// <summary>What must never be removed through Viro, however it is asked for: things Windows, other programs or this agent depend on to run.</summary>
public static partial class AppGuard
{
    [GeneratedRegex(@"^(Microsoft Visual C\+\+|Microsoft \.NET|Microsoft Windows Desktop Runtime|Microsoft ASP\.NET|Windows |Microsoft Edge|Microsoft Update Health|Microsoft Visual Studio.*Installer|Microsoft Teams Meeting Add-in)", RegexOptions.IgnoreCase)] private static partial Regex Runtimes();

    /// <summary>The reason this program is protected, or null when it may be removed.</summary>
    public static string? Protected(AppEntry a, RepairEnv env)
    {
        if (a.Name.StartsWith("Viro", StringComparison.OrdinalIgnoreCase)) return "this is Viro itself";
        if (Runtimes().IsMatch(a.Name) && a.Publisher.Contains("Microsoft", StringComparison.OrdinalIgnoreCase)) return "other programs and Windows rely on this Microsoft component";
        if (a.InstallLocation is { } l && !SafeFolder(l, env)) return "its folder is a system location that is not safe to remove";
        return null;
    }

    /// <summary>A folder is only safe to move aside when it is an application folder, not a system or user-data root.</summary>
    public static bool SafeFolder(string path, RepairEnv env)
    {
        string full; try { full = System.IO.Path.GetFullPath(path).TrimEnd('\\'); } catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException) { return false; }
        if (full.Length < 4 || System.IO.Path.GetPathRoot(full)!.TrimEnd('\\').Equals(full, StringComparison.OrdinalIgnoreCase)) return false;
        var windows = env.WindowsDir.TrimEnd('\\');
        if (full.StartsWith(windows, StringComparison.OrdinalIgnoreCase)) return false;
        string[] roots =
        [
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            env.ProgramDataDir, Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        ];
        foreach (var r in roots.Where(r => r.Length > 3))
        {
            var rt = r.TrimEnd('\\');
            if (!full.StartsWith(rt + "\\", StringComparison.OrdinalIgnoreCase)) continue;
            var rel = full[(rt.Length + 1)..];
            if (rel.Equals("WindowsApps", StringComparison.OrdinalIgnoreCase) || rel.StartsWith("Microsoft", StringComparison.OrdinalIgnoreCase) || rel.StartsWith("Windows", StringComparison.OrdinalIgnoreCase)) return false;
            return true;
        }
        // another drive or folder: fine when it is a program folder, not a drive root, a user profile or the Users folder itself
        return !full.Contains(@"\Users\", StringComparison.OrdinalIgnoreCase) && full.Count(ch => ch == '\\') >= 2;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
/// <summary>
/// app.uninstall { kind: "msi" | "appx" | "other", id, hive?, forced? }: takes one program off this PC the way Windows does (its own uninstaller), then checks Windows no longer lists it.
/// With forced:true, a program whose uninstaller is missing or fails is removed by hand: its folder is moved aside (not deleted) and its registration is backed up
/// then removed, so the whole forced removal can be undone. Programs Windows depends on are refused.
/// </summary>
public sealed class AppUninstallRecipe(IAppCatalog? catalog = null) : IRepairRecipe
{
    public string Id => "app.uninstall"; public string Title => "Uninstall a program";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => true;
    readonly IAppCatalog cat = catalog ?? new RegistryAppCatalog();

    static string S(RepairContext c, string n) => c.Options.ValueKind == JsonValueKind.Object && c.Options.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
    static bool Forced(RepairContext c) => c.Options.ValueKind == JsonValueKind.Object && c.Options.TryGetProperty("forced", out var v) && v.ValueKind == JsonValueKind.True;

    static (string kind, string id, string hive) Request(RepairContext c)
    {
        var kind = S(c, "kind"); var id = S(c, "id"); var hive = S(c, "hive"); if (hive.Length == 0) hive = "HKLM";
        if (kind == "appx" && AppInventory.PackageName().IsMatch(id)) return (kind, id, hive);
        if (kind is "msi" or "other" && Regex.IsMatch(id, @"^[^\\/\0]{1,200}$") && hive is "HKLM" or "HKLM32" or "HKCU") return (kind, id, hive);
        throw new ArgumentException("options need kind (msi, appx or other), the program's id and, for registered programs, hive");
    }

    public async Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var (kind, id, hive) = Request(c);
        if (kind == "appx")
        {
            var r = await c.Proc.RunAsync("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"(Get-AppxPackage -Name '{id}' | Select-Object -First 1).PackageFullName\"", TimeSpan.FromSeconds(60), ct);
            return r.ExitCode == 0 && r.Output.Trim().Length > 0 ? new(true, "the Store app will be removed", new { kind, id }) : new(false, "that Store app is not installed for this user");
        }
        var e = cat.Find(hive, id);
        if (e is null) return new(false, "Windows no longer lists this program, so there is nothing to uninstall");
        if (AppGuard.Protected(e, c.Env) is { } why) throw new InvalidOperationException($"{e.Name} is protected: {why}");
        return new(true, $"{e.Name} {e.Version}".Trim() + " will be uninstalled", new { name = e.Name, version = e.Version, sizeBytes = e.SizeBytes, kind });
    }

    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var (kind, id, hive) = Request(c);
        if (kind == "appx") { await RemoveStoreApp(c, id, ct); c.After = new { kind, id }; return; }
        var e = cat.Find(hive, id) ?? throw new InvalidOperationException("the program is no longer registered");
        string? failure = null;
        try { await RunUninstaller(c, e, ct); }
        catch (InvalidOperationException x) when (Forced(c)) { failure = x.Message; }
        if (failure is null && await Gone(hive, id, ct)) { c.After = new { kind, id, forced = false }; return; }
        if (failure is null && !Forced(c)) throw new InvalidOperationException("the uninstaller finished but Windows still lists the program");
        if (!Forced(c)) throw new InvalidOperationException(failure!);
        // Forced removal: the program's own uninstaller is broken or missing. Move its files aside and remove its registration, recording how to put both back.
        await ForceRemove(c, e, hive, id, ct);
        c.After = new { kind, id, forced = true, normalFailure = failure };
    }

    async Task<bool> Gone(string hive, string id, CancellationToken ct)
    {
        for (var i = 0; i < 20; i++) { if (cat.Find(hive, id) is null) return true; await Task.Delay(i < 3 ? 100 : 1500, ct); }   // some uninstallers hand off to a helper and return at once
        return false;
    }

    static async Task RemoveStoreApp(RepairContext c, string id, CancellationToken ct)
    {
        var elevated = Installer.IsElevated();
        var r = await c.Proc.RunAsync("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"$ErrorActionPreference='Stop'; Get-AppxPackage{(elevated ? " -AllUsers" : "")} -Name '{id}' | Remove-AppxPackage{(elevated ? " -AllUsers" : "")}\"", TimeSpan.FromMinutes(5), ct);
        if (r.ExitCode != 0) throw new InvalidOperationException("Windows could not remove the app: " + r.Output.Trim().Split('\n').FirstOrDefault()?.Trim());
    }

    /// <summary>Picks the program's own quiet uninstall command and runs it. Never runs anything but what the program registered itself.</summary>
    static async Task RunUninstaller(RepairContext c, AppEntry e, CancellationToken ct)
    {
        string exe, args;
        if (e.Kind == "msi") { exe = "msiexec.exe"; args = $"/x {e.Key} /qn /norestart"; }
        else if (e.QuietUninstallString is { Length: > 0 } q) (exe, args) = Command.Split(q);
        else if (e.UninstallString is { Length: > 0 } u) { (exe, args) = Command.Split(u); args = Command.Silence(exe, args); }
        else throw new InvalidOperationException("this program did not register an uninstaller");
        if (!exe.Equals("msiexec.exe", StringComparison.OrdinalIgnoreCase) && !(Path.IsPathRooted(exe) && File.Exists(exe))) throw new InvalidOperationException("the program's uninstaller file is missing: " + exe);
        var r = await c.Proc.RunAsync(exe, args, TimeSpan.FromMinutes(20), ct);
        if (r.TimedOut) throw new InvalidOperationException("the uninstaller did not finish in 20 minutes");
        if (r.ExitCode is 3010 or 1641) { c.RebootRequired = true; return; }
        if (r.ExitCode == 1605) return;                                                                                  // Windows Installer: already not installed
        if (r.ExitCode != 0) throw new InvalidOperationException(r.ExitCode switch
        {
            1730 or 1925 => "this needs administrator rights: use Run as administrator",
            1618 => "another installation is running; try again in a few minutes",
            1603 => "the program's uninstaller failed (Windows Installer error 1603)",
            _ => $"the program's uninstaller returned code {r.ExitCode}",
        });
    }

    async Task ForceRemove(RepairContext c, AppEntry e, string hive, string id, CancellationToken ct)
    {
        if (hive != "HKCU" && !Installer.IsElevated()) throw new InvalidOperationException("forced removal needs administrator rights: use Run as administrator");
        var q = Path.Combine(c.Env.StateDir, "quarantine", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(q);
        var reg = Path.Combine(q, "registration.reg");
        var export = await c.Proc.RunAsync("reg.exe", $"export \"{RegistryAppCatalog.FullPath(hive, id)}\" \"{reg}\" /y", TimeSpan.FromSeconds(30), ct);
        if (export.ExitCode != 0) throw new InvalidOperationException("could not back up the program's registration, so nothing was changed");
        c.RollbackState["hive"] = hive; c.RollbackState["key"] = id; c.RollbackState["regFile"] = reg;
        if (e.InstallLocation is { } loc && Directory.Exists(loc))
        {
            StopProcessesIn(loc);
            var moved = Path.Combine(q, "files");
            try { MoveDir(loc, moved); }
            catch (Exception x) when (x is IOException or UnauthorizedAccessException) { throw new InvalidOperationException("could not move the program's folder aside (a file is in use or protected): " + x.Message); }
            c.RollbackState["originalFolder"] = loc; c.RollbackState["movedFolder"] = moved;
        }
        cat.DeleteRegistration(hive, id);
    }

    static void StopProcessesIn(string folder)
    {
        var prefix = Path.GetFullPath(folder).TrimEnd('\\') + "\\";
        foreach (var p in Process.GetProcesses())
        {
            try { if (p.MainModule?.FileName is { } f && f.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) { p.Kill(true); p.WaitForExit(5000); } }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException or NotSupportedException) { }
            finally { p.Dispose(); }
        }
    }

    internal static void MoveDir(string from, string to)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(to)!);
        try { Directory.Move(from, to); return; } catch (IOException) when (!Path.GetPathRoot(from)!.Equals(Path.GetPathRoot(to), StringComparison.OrdinalIgnoreCase)) { }
        CopyDir(from, to); Directory.Delete(from, true);                                                                    // different drive: copy then delete
    }
    static void CopyDir(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true);
        foreach (var d in Directory.GetDirectories(from)) CopyDir(d, Path.Combine(to, Path.GetFileName(d)));
    }

    public async Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var (kind, id, hive) = Request(c);
        if (kind == "appx")
        {
            var r = await c.Proc.RunAsync("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"(Get-AppxPackage -Name '{id}' | Select-Object -First 1).PackageFullName\"", TimeSpan.FromSeconds(60), ct);
            var gone = r.ExitCode == 0 && r.Output.Trim().Length == 0; return (gone, gone ? "Windows no longer lists the app" : "Windows still lists the app");
        }
        if (cat.Find(hive, id) is not null) return (false, "Windows still lists the program");
        if (c.RollbackState.TryGetValue("originalFolder", out var o) && o is string p && Directory.Exists(p)) return (false, "the program's folder is still there");
        return (true, c.RollbackState.ContainsKey("regFile") ? "the program is no longer listed and its files were moved aside (this can be undone)" : "Windows no longer lists the program");
    }

    public async Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        string? G(string n) => saved.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        if (G("movedFolder") is { } moved && G("originalFolder") is { } orig && Directory.Exists(moved)) MoveDir(moved, orig);
        if (G("regFile") is { } reg && File.Exists(reg))
        {
            var r = await c.Proc.RunAsync("reg.exe", $"import \"{reg}\"", TimeSpan.FromSeconds(30), ct);
            if (r.ExitCode != 0) throw new InvalidOperationException("could not restore the program's registration");
        }
    }
}

/// <summary>Splits a registered uninstall command into program and arguments and adds the quiet switch for the common installer kinds.</summary>
public static class Command
{
    public static (string exe, string args) Split(string cmd)
    {
        cmd = Environment.ExpandEnvironmentVariables(cmd.Trim());
        if (cmd.StartsWith('"')) { var end = cmd.IndexOf('"', 1); return end < 0 ? (cmd.Trim('"'), "") : (cmd[1..end], cmd[(end + 1)..].Trim()); }
        var m = Regex.Match(cmd, @"^(.*?\.exe)(\s+(.*))?$", RegexOptions.IgnoreCase);
        return m.Success ? (m.Groups[1].Value, m.Groups[3].Value.Trim()) : (cmd, "");
    }

    public static string Silence(string exe, string args)
    {
        var name = Path.GetFileName(exe).ToLowerInvariant();
        if (name == "msiexec.exe") { var m = Regex.Match(args, @"\{[0-9A-Fa-f-]{36}\}"); return m.Success ? $"/x {m.Value} /qn /norestart" : args; }
        if (name.StartsWith("unins") && !Regex.IsMatch(args, @"/(very)?silent", RegexOptions.IgnoreCase)) return (args + " /VERYSILENT /NORESTART /SUPPRESSMSGBOXES").Trim();   // Inno Setup
        if (Regex.IsMatch(args, @"(^|\s)/S(\s|$)")) return args;                                                                                                       // NSIS already quiet
        return args;                                                                                                                                                    // unknown installer: run as registered (it may show its own window)
    }
}
