using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;

namespace Viro.Agent.Care;

/// <summary>
/// Read-only look at what sits in the Windows Startup folders (the all-users one and each person's own): size, dates, hash, the opening lines of a script, who signed
/// a program, and objective indicators (encoded commands, hidden windows, downloads, tampering with security tools). It reports facts and indicators, never a verdict,
/// and it can only read inside those folders: there is no way to point it at another path.
/// </summary>
public static class StartupInspector
{
    public sealed record Indicator(string Code, string Text);
    static readonly (string Code, string Text, Regex Pattern)[] Rules =
    [
        ("encoded-powershell", "Runs an encoded PowerShell command (hides what it does).", new Regex(@"powershell(\.exe)?\b[^\r\n]*\s-(e|ec|enc|encodedcommand)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled)),
        ("hidden-window", "Starts something in a hidden window.", new Regex(@"-w(indowstyle)?\s+hidden|\bstart\s+/min\b|vbhide|WindowStyle\s*=\s*Hidden", RegexOptions.IgnoreCase | RegexOptions.Compiled)),
        ("downloads", "Downloads something from the internet.", new Regex(@"\b(curl|wget|bitsadmin|Invoke-WebRequest|iwr|DownloadString|DownloadFile|Start-BitsTransfer)\b|certutil[^\r\n]*-urlcache", RegexOptions.IgnoreCase | RegexOptions.Compiled)),
        ("decodes-payload", "Decodes a hidden payload (certutil -decode or a base64 conversion).", new Regex(@"certutil[^\r\n]*-decode|FromBase64String", RegexOptions.IgnoreCase | RegexOptions.Compiled)),
        ("persistence", "Adds itself to start-up elsewhere (registry Run key or a scheduled task).", new Regex(@"reg(\.exe)?\s+add[^\r\n]*\\Run\b|schtasks(\.exe)?\s+/create", RegexOptions.IgnoreCase | RegexOptions.Compiled)),
        ("tampers-with-security", "Tries to stop or change security software.", new Regex(@"Set-MpPreference|Add-MpPreference|DisableRealtimeMonitoring|sc(\.exe)?\s+(stop|config)\s+(WinDefend|avp|wscsvc)|taskkill[^\r\n]*(MsMpEng|avp|kaspersky|defender)", RegexOptions.IgnoreCase | RegexOptions.Compiled)),
        ("long-blob", "Contains a very long unreadable block (often an obfuscated payload).", new Regex(@"[A-Za-z0-9+/]{300,}={0,2}", RegexOptions.Compiled)),
    ];
    static readonly Regex Url = new(@"https?://[^\s""'<>)]+", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly HashSet<string> Text = new(StringComparer.OrdinalIgnoreCase) { ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".txt", ".ini", ".url" };
    static readonly HashSet<string> Programs = new(StringComparer.OrdinalIgnoreCase) { ".exe", ".dll", ".scr", ".com", ".msi" };

    /// <summary>Folders searched: the all-users Startup folder and each profile's. Overridable for tests only.</summary>
    public static IEnumerable<(string Scope, string Dir)> DefaultFolders()
    {
        var common = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
        yield return ("All users", common);
        var users = Path.Combine(Path.GetPathRoot(Environment.SystemDirectory) ?? "C:\\", "Users");
        if (!Directory.Exists(users)) yield break;
        foreach (var u in Directory.EnumerateDirectories(users))
            yield return (Path.GetFileName(u), Path.Combine(u, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"));
    }

    public static object Inspect(string? only = null, IEnumerable<(string Scope, string Dir)>? folders = null, int maxPreviewBytes = 2048)
    {
        var files = new List<object>(); var scanned = new List<object>(); var unreadable = new List<object>();
        foreach (var (scope, dir) in folders ?? DefaultFolders())
        {
            if (!Directory.Exists(dir)) continue; scanned.Add(new { scope, folder = dir });
            IEnumerable<string> entries; try { entries = Directory.EnumerateFiles(dir).ToList(); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { unreadable.Add(new { scope, folder = dir, reason = e.Message }); continue; }
            foreach (var path in entries)
            {
                var name = Path.GetFileName(path); if (name.Equals("desktop.ini", StringComparison.OrdinalIgnoreCase)) continue;
                if (only is not null && !name.Equals(only, StringComparison.OrdinalIgnoreCase)) continue;
                try { files.Add(Describe(scope, path, maxPreviewBytes)); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { unreadable.Add(new { scope, file = name, reason = e.Message }); }
            }
        }
        return new { files, scanned, unreadable, note = "Facts and indicators only. An indicator means \"worth a look\", not \"malicious\": legitimate scripts can use any of these. Nothing was changed." };
    }

    static object Describe(string scope, string path, int maxPreviewBytes)
    {
        var fi = new FileInfo(path); var ext = fi.Extension; var indicators = new List<Indicator>();
        string? sha = null; if (fi.Length <= 64L * 1024 * 1024) { using var s = File.OpenRead(path); sha = Convert.ToHexString(SHA256.HashData(s)).ToLowerInvariant(); }
        if (LooksRandom(Path.GetFileNameWithoutExtension(fi.Name))) indicators.Add(new("random-name", "The file name looks randomly generated, which is common for unwanted software and rare for real programs."));
        string? preview = null; var truncated = false; var binary = false; List<string> urls = []; List<string> commands = []; int junk = 0, lineCount = 0, commandCount = 0;
        if (Text.Contains(ext) || ext == "")
        {
            var buf = new byte[Math.Min(fi.Length, maxPreviewBytes)]; using (var s = File.OpenRead(path)) _ = s.Read(buf, 0, buf.Length); truncated = fi.Length > buf.Length;
            if (buf.Contains((byte)0) && !(buf.Length > 2 && ((buf[0] == 0xFF && buf[1] == 0xFE) || (buf[0] == 0xFE && buf[1] == 0xFF)))) binary = true;
            else
            {
                preview = (buf.Length > 2 && buf[0] == 0xFF && buf[1] == 0xFE ? Encoding.Unicode : Encoding.UTF8).GetString(buf);
                // Read the whole script (up to 20 MB), setting aside junk comment lines, so the first REAL commands are visible even when the file opens with a wall of padding.
                if (fi.Length <= 20L * 1024 * 1024)
                {
                    using var sr = new StreamReader(path, true); string? line;
                    while ((line = sr.ReadLine()) is not null)
                    {
                        lineCount++; var t = line.Trim(); if (t.Length == 0) continue;
                        if (IsComment(t)) { if (JunkComment(t)) junk++; continue; }
                        commandCount++; if (commands.Count < 40) commands.Add(t.Length > 300 ? t[..300] + "…" : t);
                    }
                }
                var text = preview + "\n" + string.Join("\n", commands);
                foreach (var (code, why, rx) in Rules) if (rx.IsMatch(text)) indicators.Add(new(code, why));
                if (preview.Split('\n').Any(l => l.Length > 1000)) indicators.Add(new("very-long-line", "A single line of over 1,000 characters (often hides something)."));
                if (junk >= 20 && junk * 2 > lineCount) indicators.Add(new("junk-padding", $"{junk} of {lineCount} lines are long meaningless comments. Padding a script with junk is a way to bury the real commands and slip past scanners."));
                urls = Url.Matches(text).Select(m => m.Value).Distinct().Take(10).ToList();
            }
        }
        object? signature = null; string? target = null;
        if (Programs.Contains(ext)) signature = Signer(path);
        if (ext.Equals(".lnk", StringComparison.OrdinalIgnoreCase)) target = ShortcutTarget(path);
        return new { scope, name = fi.Name, path, sizeBytes = fi.Length, created = fi.CreationTimeUtc.ToString("O"), modified = fi.LastWriteTimeUtc.ToString("O"), sha256 = sha, kind = ext.Length > 0 ? ext.ToLowerInvariant() : "(none)", binary, preview, previewTruncated = truncated, lines = lineCount, junkCommentLines = junk, commandLines = commandCount, commands, urls, signature, shortcutTarget = target, indicators };
    }

    static bool IsComment(string t) => t.StartsWith("::") || t.StartsWith("rem ", StringComparison.OrdinalIgnoreCase) || t.StartsWith("@rem", StringComparison.OrdinalIgnoreCase) || t.StartsWith("//") || t.StartsWith("'") || t.StartsWith("#");
    static readonly Regex JunkBody = new(@"^[A-Za-z0-9+/=_-]{100,}$", RegexOptions.Compiled);
    static bool JunkComment(string t) => JunkBody.IsMatch(t.TrimStart(':', '/', '\'', '#', ' ').Replace("rem ", "", StringComparison.OrdinalIgnoreCase));

    /// <summary>A long run of letters with no structure: random-looking names have a mix of cases and almost no word-like vowel pattern.</summary>
    public static bool LooksRandom(string name)
    {
        if (name.Length < 16 || name.Contains(' ') || name.Contains('-') || name.Contains('_') || name.Contains('.')) return false;
        var letters = name.Count(char.IsLetter); if (letters < name.Length * 0.9) return false;
        var upper = name.Count(char.IsUpper); var lower = name.Count(char.IsLower); var vowels = name.Count(c => "aeiouAEIOU".Contains(c));
        var switches = 0; for (var i = 1; i < name.Length; i++) if (char.IsUpper(name[i]) != char.IsUpper(name[i - 1])) switches++;
        return upper >= 4 && lower >= 4 && switches >= name.Length / 4 && vowels < name.Length * 0.3;
    }

    static object Signer(string path)
    {
        try { using var c = new X509Certificate2(X509Certificate.CreateFromSignedFile(path)); return new { signed = true, signer = c.Subject, note = "A signature is present; it was not validated here." }; }
        catch (Exception e) when (e is CryptographicException or IOException) { return new { signed = false, signer = (string?)null, note = "No signature." }; }
    }
    static string? ShortcutTarget(string path)
    {
        try { var t = Type.GetTypeFromProgID("WScript.Shell"); if (t is null) return null; dynamic shell = Activator.CreateInstance(t)!; dynamic lnk = shell.CreateShortcut(path); return (string?)lnk.TargetPath + (string.IsNullOrWhiteSpace((string?)lnk.Arguments) ? "" : " " + (string?)lnk.Arguments); }
        catch (Exception) { return null; }
    }
}

public sealed class StartupInspectHandler : IJobHandler
{
    public string Type => "startup.inspect";
    public Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct) => Task.Run(() =>
    {
        var only = ctx.Job.Params.TryGetProperty("name", out var n) && n.ValueKind == System.Text.Json.JsonValueKind.String ? n.GetString() : null;
        return new JobOutcome(true, StartupInspector.Inspect(only));
    }, ct);
}
