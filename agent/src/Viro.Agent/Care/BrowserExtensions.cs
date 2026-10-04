using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Viro.Agent;

/// <summary>Reads installed Chrome and Edge extensions from every user profile, and manages the browser policy blocklist. Read-only except Block/Unblock.</summary>
public static class BrowserExtensions
{
    static readonly (string browser, string dataDir, string policyKey)[] Browsers =
    [("chrome", @"Google\Chrome\User Data", @"SOFTWARE\Policies\Google\Chrome\ExtensionInstallBlocklist"), ("edge", @"Microsoft\Edge\User Data", @"SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallBlocklist")];

    public static List<ExtensionInfo> Read(string? usersRoot = null)
    {
        var o = new List<ExtensionInfo>(); var users = usersRoot ?? Path.Combine(Path.GetPathRoot(Environment.SystemDirectory)!, "Users");
        if (!Directory.Exists(users)) return o;
        foreach (var user in Directory.EnumerateDirectories(users))
            foreach (var (browser, dataDir, policyKey) in Browsers)
            {
                var data = Path.Combine(user, "AppData", "Local", dataDir); if (!Directory.Exists(data)) continue;
                var blocked = BlockedIds(policyKey);
                foreach (var profile in Directory.EnumerateDirectories(data).Where(p => Path.GetFileName(p) is "Default" || Path.GetFileName(p).StartsWith("Profile ")))
                {
                    var ext = Path.Combine(profile, "Extensions"); if (!Directory.Exists(ext)) continue;
                    foreach (var dir in Directory.EnumerateDirectories(ext).Where(d => Regex.IsMatch(Path.GetFileName(d), "^[a-p]{32}$")))
                    {
                        var ver = Directory.EnumerateDirectories(dir).OrderByDescending(x => x, StringComparer.OrdinalIgnoreCase).FirstOrDefault(); if (ver is null) continue;
                        var info = Parse(Path.Combine(ver, "manifest.json"), browser, Path.GetFileName(dir), blocked.Contains(Path.GetFileName(dir)));
                        if (info is not null && !o.Any(x => x.Browser == info.Browser && x.Id == info.Id)) o.Add(info);
                    }
                }
            }
        return o;
    }

    public static ExtensionInfo? Parse(string manifestPath, string browser, string id, bool blocked)
    {
        try
        {
            using var d = JsonDocument.Parse(File.ReadAllText(manifestPath), new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip }); var r = d.RootElement;
            var name = r.TryGetProperty("name", out var n) ? n.GetString() ?? id : id;
            var m = Regex.Match(name, @"^__MSG_(.+)__$");
            if (m.Success) name = Localized(Path.GetDirectoryName(manifestPath)!, m.Groups[1].Value, r.TryGetProperty("default_locale", out var dl) ? dl.GetString() : null) ?? id;
            string? sp = null, hp = null;
            if (r.TryGetProperty("chrome_settings_overrides", out var o) && o.ValueKind == JsonValueKind.Object)
            {
                if (o.TryGetProperty("search_provider", out var s) && s.ValueKind == JsonValueKind.Object) sp = (s.TryGetProperty("name", out var sn) ? sn.GetString() : null) ?? (s.TryGetProperty("search_url", out var su) ? su.GetString() : null);
                if (o.TryGetProperty("homepage", out var h) && h.ValueKind == JsonValueKind.String) hp = h.GetString();
            }
            return new(browser, id, name.Length > 80 ? name[..80] : name, sp is { Length: > 120 } ? sp[..120] : sp, hp is { Length: > 120 } ? hp[..120] : hp, blocked);
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException) { return null; }
    }

    static string? Localized(string dir, string key, string? locale)
    {
        foreach (var loc in new[] { locale, "en", "en_US" }.Where(x => x is not null).Distinct())
        {
            var p = Path.Combine(dir, "_locales", loc!, "messages.json"); if (!File.Exists(p)) continue;
            try { using var d = JsonDocument.Parse(File.ReadAllText(p)); foreach (var prop in d.RootElement.EnumerateObject()) if (prop.Name.Equals(key, StringComparison.OrdinalIgnoreCase) && prop.Value.TryGetProperty("message", out var msg)) return msg.GetString(); } catch { }
        }
        return null;
    }

    static string PolicyKey(string browser) => Browsers.First(b => b.browser == browser).policyKey;
    static HashSet<string> BlockedIds(string policyKey) { using var k = Registry.LocalMachine.OpenSubKey(policyKey); return k is null ? [] : [.. k.GetValueNames().Select(n => k.GetValue(n) as string ?? "")]; }

    public static string Block(string browser, string id)
    {
        if (!Regex.IsMatch(id, "^[a-p]{32}$")) throw new ArgumentException("not an extension id");
        using var k = Registry.LocalMachine.CreateSubKey(PolicyKey(browser), true);
        foreach (var n in k.GetValueNames()) if (k.GetValue(n) as string == id) return n;       // already blocked
        var next = (k.GetValueNames().Select(n => int.TryParse(n, out var i) ? i : 0).DefaultIfEmpty(0).Max() + 1).ToString();
        k.SetValue(next, id); return next;
    }
    public static void Unblock(string browser, string valueName) { using var k = Registry.LocalMachine.OpenSubKey(PolicyKey(browser), true); if (Regex.IsMatch(valueName, @"^\d{1,5}$")) k?.DeleteValue(valueName, false); }
}
