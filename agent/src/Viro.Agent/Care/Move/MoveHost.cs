using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using Viro.Agent.Repair;

namespace Viro.Agent.Care.Move;

public sealed record MoveFile(string Root, string Path, long Size, long Mtime, long Offset);
public sealed record MoveSetting(string Key, string Name, string Kind, string Value);
public sealed record MoveApp(string Name, string? Version, string? Publisher, string? WingetId);
public sealed record MoveWifi(string Name, string Xml);
public sealed record MoveManifest(int V, string CreatedAt, string Machine, string Os, IReadOnlyList<MoveSetting> Settings, IReadOnlyList<MoveApp> Apps, IReadOnlyList<MoveWifi> Wifi, IReadOnlyList<MoveFile> Files, long StreamLength);

/// <summary>What the Windows PC can offer to back up and take back: folders, settings, networks, bookmarks and the program list. Tests stand in for it.</summary>
public interface IMoveHost
{
    string MachineName { get; }
    string OsName { get; }
    /// <summary>Folder aliases (Documents, Desktop, Pictures, Music, Videos) and where they are on this PC.</summary>
    IReadOnlyDictionary<string, string> Roots { get; }
    IReadOnlyList<MoveSetting> ReadSettings();
    void WriteSetting(MoveSetting s);
    string? WallpaperPath();
    void ApplyWallpaper(string path);
    Task<IReadOnlyList<MoveWifi>> ExportWifiAsync(CancellationToken ct);
    Task ImportWifiAsync(MoveWifi w, CancellationToken ct);
    /// <summary>Chrome and Edge bookmarks as an HTML file any browser can import; null when there are none.</summary>
    string? BookmarksHtml();
    Task<IReadOnlyList<MoveApp>> InstalledAppsAsync(CancellationToken ct);
    Task<(bool Ok, string Detail)> InstallAppAsync(string wingetId, CancellationToken ct);
    string RestoredSettingsFolder { get; }
    string RestoredBookmarksFolder { get; }
}

/// <summary>The only settings a snapshot may carry or put back. A restore ignores anything else, so a damaged or tampered snapshot cannot write arbitrary registry values.</summary>
public static class MoveSettingsCatalog
{
    public static readonly IReadOnlyList<(string Key, string Name)> Allowed =
    [
        (@"Control Panel\Desktop", "WallpaperStyle"), (@"Control Panel\Desktop", "TileWallpaper"),
        (@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme"), (@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "SystemUsesLightTheme"),
        (@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "EnableTransparency"), (@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "ColorPrevalence"),
        (@"Software\Microsoft\Windows\DWM", "AccentColor"),
        (@"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "HideFileExt"), (@"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "Hidden"),
        (@"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "TaskbarAl"), (@"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "ShowTaskViewButton"),
        (@"Control Panel\Mouse", "SwapMouseButtons"),
    ];
    public static bool IsAllowed(MoveSetting s) => Allowed.Any(a => a.Key.Equals(s.Key, StringComparison.OrdinalIgnoreCase) && a.Name.Equals(s.Name, StringComparison.OrdinalIgnoreCase)) && s.Kind is "DWord" or "String" && s.Value.Length <= 40;
}

public sealed partial class WindowsMoveHost(IProcessRunner? proc = null) : IMoveHost
{
    readonly IProcessRunner run = proc ?? new SystemProcessRunner();
    public string MachineName => Environment.MachineName;
    public string OsName => Environment.OSVersion.VersionString;
    public IReadOnlyDictionary<string, string> Roots { get; } = new Dictionary<string, string>
    {
        ["Documents"] = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), ["Desktop"] = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
        ["Pictures"] = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), ["Music"] = Environment.GetFolderPath(Environment.SpecialFolder.MyMusic), ["Videos"] = Environment.GetFolderPath(Environment.SpecialFolder.MyVideos),
    };
    public string RestoredSettingsFolder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "Viro Move");
    public string RestoredBookmarksFolder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Viro Move");

    public IReadOnlyList<MoveSetting> ReadSettings()
    {
        var o = new List<MoveSetting>();
        foreach (var (key, name) in MoveSettingsCatalog.Allowed)
        {
            try
            {
                using var k = Registry.CurrentUser.OpenSubKey(key); var v = k?.GetValue(name); if (v is null) continue;
                var kind = k!.GetValueKind(name); if (kind == RegistryValueKind.DWord) o.Add(new(key, name, "DWord", Convert.ToInt32(v).ToString())); else if (kind == RegistryValueKind.String) o.Add(new(key, name, "String", v.ToString() ?? ""));
            }
            catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException) { }
        }
        return o;
    }

    public void WriteSetting(MoveSetting s)
    {
        if (!MoveSettingsCatalog.IsAllowed(s)) return;
        using var k = Registry.CurrentUser.CreateSubKey(s.Key, true);
        if (s.Kind == "DWord" && int.TryParse(s.Value, out var n)) k.SetValue(s.Name, n, RegistryValueKind.DWord); else if (s.Kind == "String") k.SetValue(s.Name, s.Value, RegistryValueKind.String);
    }

    public string? WallpaperPath()
    {
        try { using var k = Registry.CurrentUser.OpenSubKey(@"Control Panel\Desktop"); var p = k?.GetValue("WallPaper") as string; if (!string.IsNullOrWhiteSpace(p) && File.Exists(p)) return p;
              var t = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Windows\Themes\TranscodedWallpaper"); return File.Exists(t) ? t : null; }
        catch (Exception e) when (e is System.Security.SecurityException or IOException) { return null; }
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SystemParametersInfo(uint action, uint param, string value, uint flags);
    public void ApplyWallpaper(string path) { if (File.Exists(path)) SystemParametersInfo(0x0014, 0, path, 0x01 | 0x02); }       // SPI_SETDESKWALLPAPER, update the profile and tell Windows

    public async Task<IReadOnlyList<MoveWifi>> ExportWifiAsync(CancellationToken ct)
    {
        var dir = Path.Combine(Path.GetTempPath(), "viro-wifi-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir); var o = new List<MoveWifi>();
        try
        {
            var r = await run.RunAsync("netsh.exe", $"wlan export profile key=clear folder=\"{dir}\"", TimeSpan.FromSeconds(30), ct);
            if (r.ExitCode == 0) foreach (var f in Directory.GetFiles(dir, "*.xml")) { var xml = await File.ReadAllTextAsync(f, ct); var n = Regex.Match(xml, "<name>([^<]+)</name>").Groups[1].Value; if (n.Length > 0) o.Add(new(n, xml)); }
        }
        finally { try { foreach (var f in Directory.GetFiles(dir)) File.Delete(f); Directory.Delete(dir); } catch (IOException) { } }       // the clear-text copies never stay on disk
        return o;
    }

    public async Task ImportWifiAsync(MoveWifi w, CancellationToken ct)
    {
        var f = Path.Combine(Path.GetTempPath(), "viro-wifi-" + Guid.NewGuid().ToString("N") + ".xml");
        try { await File.WriteAllTextAsync(f, w.Xml, ct); await run.RunAsync("netsh.exe", $"wlan add profile filename=\"{f}\" user=current", TimeSpan.FromSeconds(30), ct); }
        finally { try { File.Delete(f); } catch (IOException) { } }
    }

    public string? BookmarksHtml()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); var sb = new StringBuilder(); var any = false;
        sb.AppendLine("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks from Viro Move</H1>\n<DL><p>");
        foreach (var (name, path) in new[] { ("Chrome", @"Google\Chrome\User Data\Default\Bookmarks"), ("Edge", @"Microsoft\Edge\User Data\Default\Bookmarks") })
        {
            var f = Path.Combine(local, path); if (!File.Exists(f)) continue;
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(f)); sb.AppendLine($"<DT><H3>{System.Net.WebUtility.HtmlEncode(name)}</H3>\n<DL><p>");
                if (doc.RootElement.TryGetProperty("roots", out var roots)) foreach (var r in roots.EnumerateObject()) if (r.Value.ValueKind == JsonValueKind.Object) Walk(r.Value, sb, ref any);
                sb.AppendLine("</DL><p>");
            }
            catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException) { }
        }
        sb.AppendLine("</DL><p>");
        return any ? sb.ToString() : null;
    }
    static void Walk(JsonElement n, StringBuilder sb, ref bool any)
    {
        var type = n.TryGetProperty("type", out var t) ? t.GetString() : null; var name = n.TryGetProperty("name", out var nm) ? nm.GetString() ?? "" : "";
        if (type == "url" && n.TryGetProperty("url", out var u) && u.GetString() is { } url && Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https") { any = true; sb.AppendLine($"<DT><A HREF=\"{System.Net.WebUtility.HtmlEncode(url)}\">{System.Net.WebUtility.HtmlEncode(name)}</A>"); }
        else if (type == "folder" && n.TryGetProperty("children", out var ch)) { sb.AppendLine($"<DT><H3>{System.Net.WebUtility.HtmlEncode(name)}</H3>\n<DL><p>"); foreach (var c in ch.EnumerateArray()) Walk(c, sb, ref any); sb.AppendLine("</DL><p>"); }
        else if (n.TryGetProperty("children", out var ch2)) foreach (var c in ch2.EnumerateArray()) Walk(c, sb, ref any);
    }

    public async Task<IReadOnlyList<MoveApp>> InstalledAppsAsync(CancellationToken ct)
    {
        var apps = AppInventory.Registered().Select(a => new MoveApp(a.Name, a.Version, a.Publisher, null)).ToList();
        var wg = Winget.Find(); if (wg is null) return apps;
        var (exe, args) = Winget.Command(wg, "list --accept-source-agreements --disable-interactivity");
        var r = await run.RunAsync(exe, args, TimeSpan.FromMinutes(3), ct);
        if (r.ExitCode != 0) return apps;
        var byName = Winget.ParseInstalled(r.Output);
        return [.. apps.Select(a => byName.TryGetValue(a.Name, out var id) ? a with { WingetId = id } : a)];
    }

    public async Task<(bool Ok, string Detail)> InstallAppAsync(string wingetId, CancellationToken ct)
    {
        if (!Regex.IsMatch(wingetId, @"^[A-Za-z0-9][A-Za-z0-9.+_-]{1,100}$")) return (false, "not a valid package id");
        var wg = Winget.Find(); if (wg is null) return (false, "Windows Package Manager (winget) is not installed on this PC");
        var (exe, args) = Winget.Command(wg, $"install --id {wingetId} --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity");
        var r = await run.RunAsync(exe, args, TimeSpan.FromMinutes(25), ct);
        return r.TimedOut ? (false, "took too long") : r.ExitCode == 0 ? (true, "installed") : (false, $"winget returned {r.ExitCode}");
    }
}
