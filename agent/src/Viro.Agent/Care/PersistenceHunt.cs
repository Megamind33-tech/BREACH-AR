using System.Management;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Viro.Agent.Care;

/// <summary>
/// A read-only sweep of the places malware uses to come back after a restart that the ordinary security check does not cover: the Startup folders, the Windows sign-in hooks
/// (Winlogon, image debuggers, AppInit), RunOnce keys, WMI event subscriptions, and script or program files dropped in user folders that are padded, oversized or randomly named.
/// It reports findings with their evidence and a severity, never a verdict, and changes nothing.
/// </summary>
public static class PersistenceHunt
{
    public sealed record Finding(string Category, string Severity, string Name, string Location, string Evidence);

    static readonly Regex Encoded = new(@"-(e|ec|enc|encodedcommand)\b|frombase64string", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex Hidden = new(@"-w(indowstyle)?\s+hidden|vbhide", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex ScriptHost = new(@"\b(mshta|wscript|cscript|regsvr32[^\r\n]*scrobj|rundll32[^\r\n]*javascript)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex UserFolder = new(@"\\(AppData|Temp|Users\\Public|Downloads|ProgramData)\\", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex ShellScript = new(@"\.(bat|cmd|vbs|vbe|js|jse|wsf|hta|ps1)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly HashSet<string> ScriptExt = new(StringComparer.OrdinalIgnoreCase) { ".bat", ".cmd", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".hta", ".ps1", ".scr", ".pif" };

    /// <summary>Reasons a start-up command deserves a look. Pure, so it can be tested without a computer.</summary>
    public static List<string> Reasons(string command)
    {
        var r = new List<string>();
        if (Encoded.IsMatch(command)) r.Add("runs an encoded command");
        if (Hidden.IsMatch(command)) r.Add("runs in a hidden window");
        if (ScriptHost.IsMatch(command)) r.Add("starts a script host often used to run downloaded code");
        if (UserFolder.IsMatch(command) && ShellScript.IsMatch(command)) r.Add("runs a script stored in a user-writable folder");
        var exe = Regex.Match(command, @"""?([^""]+?\.(exe|scr|com|bat|cmd))""?", RegexOptions.IgnoreCase); if (exe.Success && StartupInspector.LooksRandom(Path.GetFileNameWithoutExtension(exe.Groups[1].Value))) r.Add("the program name looks randomly generated");
        return r;
    }
    static string Severity(List<string> reasons) => reasons.Count >= 2 || reasons.Contains("runs an encoded command") ? "high" : reasons.Count == 1 ? "medium" : "low";

    public static List<Finding> CheckWinlogon(string? shell, string? userinit, string? taskman)
    {
        var f = new List<Finding>(); const string loc = @"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon";
        if (!string.IsNullOrWhiteSpace(shell) && !shell.Trim().Equals("explorer.exe", StringComparison.OrdinalIgnoreCase)) f.Add(new("winlogon", "high", "Shell", loc, $"The Windows shell is \"{shell}\" instead of explorer.exe. Whatever it names runs at every sign-in in place of the desktop."));
        if (!string.IsNullOrWhiteSpace(userinit) && !Regex.IsMatch(userinit.Trim(), @"^(C:\\Windows\\system32\\userinit\.exe,?)$", RegexOptions.IgnoreCase)) f.Add(new("winlogon", "high", "Userinit", loc, $"Userinit is \"{userinit}\" instead of the standard value. Extra programs listed here run at every sign-in."));
        if (!string.IsNullOrWhiteSpace(taskman)) f.Add(new("winlogon", "high", "Taskman", loc, $"A Taskman program is set (\"{taskman}\"). It replaces Task Manager's launcher and is not used by normal Windows."));
        return f;
    }

    public static List<Finding> Run(IEnumerable<(string Scope, string Dir)>? startupFolders = null, IEnumerable<string>? dropFolders = null, int maxFiles = 60)
    {
        var f = new List<Finding>();
        // 1. the Startup folders themselves
        foreach (var (scope, dir) in startupFolders ?? StartupInspector.DefaultFolders())
        {
            if (!Directory.Exists(dir)) continue; IEnumerable<string> files; try { files = Directory.EnumerateFiles(dir).ToList(); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { continue; }
            foreach (var p in files)
            {
                var fi = new FileInfo(p); if (fi.Name.Equals("desktop.ini", StringComparison.OrdinalIgnoreCase)) continue; var why = new List<string>();
                if (ScriptExt.Contains(fi.Extension)) why.Add("a script (not a shortcut) is set to run at sign-in");
                if (StartupInspector.LooksRandom(Path.GetFileNameWithoutExtension(fi.Name))) why.Add("the name looks randomly generated");
                if (fi.Length > 200 * 1024 && ScriptExt.Contains(fi.Extension)) why.Add($"the script is {fi.Length / 1024} KB, far larger than a real start-up script");
                if (why.Count > 0) f.Add(new("startup-folder", why.Count >= 2 ? "high" : "medium", fi.Name, p, $"{scope}: {string.Join("; ", why)}."));
            }
        }
        // 2. RunOnce and the sign-in hooks
        try
        {
            foreach (var hive in new[] { RegistryHive.LocalMachine }.SelectMany(h => new[] { RegistryView.Registry64, RegistryView.Registry32 }.Select(v => (h, v))))
                using (var b = RegistryKey.OpenBaseKey(hive.h, hive.v)) foreach (var sub in new[] { @"SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce", @"SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnceEx" })
                    using (var k = b.OpenSubKey(sub)) if (k is not null) foreach (var n in k.GetValueNames()) { var v = k.GetValue(n)?.ToString() ?? ""; var r = Reasons(v); if (r.Count > 0) f.Add(new("runonce", Severity(r), n, @"HKLM\" + sub, $"{string.Join("; ", r)}: {Cut(v)}")); }
            foreach (var sid in Registry.Users.GetSubKeyNames().Where(n => n.StartsWith("S-1-5-21-") && !n.EndsWith("_Classes")))
                using (var k = Registry.Users.OpenSubKey(sid + @"\Software\Microsoft\Windows\CurrentVersion\RunOnce")) if (k is not null) foreach (var n in k.GetValueNames()) { var v = k.GetValue(n)?.ToString() ?? ""; var r = Reasons(v); if (r.Count > 0) f.Add(new("runonce", Severity(r), n, $@"HKU\{sid}\...\RunOnce", $"{string.Join("; ", r)}: {Cut(v)}")); }
            using (var w = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon")) if (w is not null) f.AddRange(CheckWinlogon(w.GetValue("Shell")?.ToString(), w.GetValue("Userinit")?.ToString(), w.GetValue("Taskman")?.ToString()));
            using (var ifeo = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options")) if (ifeo is not null) foreach (var app in ifeo.GetSubKeyNames()) using (var k = ifeo.OpenSubKey(app)) { var dbg = k?.GetValue("Debugger")?.ToString(); if (!string.IsNullOrWhiteSpace(dbg) && !dbg.Contains("vsjitdebugger", StringComparison.OrdinalIgnoreCase)) f.Add(new("image-debugger", "high", app, $@"HKLM\...\Image File Execution Options\{app}", $"Starting {app} actually starts \"{Cut(dbg)}\". Malware uses this to hijack programs such as security tools; legitimate use is rare.")); }
            using (var win = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows")) { var dlls = win?.GetValue("AppInit_DLLs")?.ToString(); if (!string.IsNullOrWhiteSpace(dlls) && Convert.ToInt32(win!.GetValue("LoadAppInit_DLLs") ?? 0) == 1) f.Add(new("appinit", "high", "AppInit_DLLs", @"HKLM\...\Windows", $"These libraries are loaded into every program that starts: {Cut(dlls)}.")); }
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException) { f.Add(new("limit", "info", "registry", "", "Some registry locations could not be read: " + e.Message)); }
        // 3. WMI permanent event subscriptions (a way to run commands with no file in any start-up location)
        try { using var s = new ManagementObjectSearcher(@"root\subscription", "SELECT * FROM CommandLineEventConsumer"); foreach (ManagementObject m in s.Get()) f.Add(new("wmi-subscription", "high", m["Name"]?.ToString() ?? "(unnamed)", "WMI root\\subscription", $"A WMI event consumer runs a command: {Cut(m["CommandLineTemplate"]?.ToString() ?? "")}. Used by software that wants to survive without any visible start-up entry.")); } catch (ManagementException) { }
        try { using var s = new ManagementObjectSearcher(@"root\subscription", "SELECT * FROM ActiveScriptEventConsumer"); foreach (ManagementObject m in s.Get()) f.Add(new("wmi-subscription", "high", m["Name"]?.ToString() ?? "(unnamed)", "WMI root\\subscription", "A WMI event consumer runs a script.")); } catch (ManagementException) { }
        // 4. scripts and programs dropped in places people never look
        var seen = 0;
        foreach (var dir in dropFolders ?? DefaultDropFolders())
        {
            if (!Directory.Exists(dir)) continue; IEnumerable<string> files; try { files = Directory.EnumerateFiles(dir).ToList(); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { continue; }
            foreach (var p in files)
            {
                var fi = new FileInfo(p); if (!ScriptExt.Contains(fi.Extension) || seen >= maxFiles) continue; var why = new List<string>();
                if (StartupInspector.LooksRandom(Path.GetFileNameWithoutExtension(fi.Name))) why.Add("random-looking name");
                if (fi.Length > 500 * 1024) why.Add($"{fi.Length / 1024} KB script");
                if (why.Count == 0) continue;
                if (fi.Length <= 20 * 1024 * 1024 && PaddedWithJunk(p)) why.Add("padded with long junk comment lines");
                seen++; f.Add(new("dropped-script", why.Count >= 2 ? "high" : "medium", fi.Name, p, $"{string.Join("; ", why)}; created {fi.CreationTimeUtc:yyyy-MM-dd}."));
            }
        }
        return f;
    }

    static string Cut(string s) => s.Length > 200 ? s[..200] + "…" : s;
    static bool PaddedWithJunk(string path)
    {
        try { int junk = 0, total = 0; foreach (var line in File.ReadLines(path)) { total++; var t = line.Trim(); if ((t.StartsWith("::") || t.StartsWith("rem ", StringComparison.OrdinalIgnoreCase)) && t.Length > 100) junk++; if (total >= 400) break; } return junk >= 20 && junk * 2 > total; }
        catch (IOException) { return false; } catch (UnauthorizedAccessException) { return false; }
    }
    static IEnumerable<string> DefaultDropFolders()
    {
        var win = Environment.GetFolderPath(Environment.SpecialFolder.Windows); yield return Path.Combine(win, "Temp"); yield return Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData); yield return @"C:\Users\Public";
        var users = Path.Combine(Path.GetPathRoot(Environment.SystemDirectory) ?? "C:\\", "Users"); if (!Directory.Exists(users)) yield break;
        foreach (var u in Directory.EnumerateDirectories(users)) { yield return u; yield return Path.Combine(u, "AppData", "Roaming"); yield return Path.Combine(u, "AppData", "Local"); yield return Path.Combine(u, "AppData", "Local", "Temp"); yield return Path.Combine(u, "Downloads"); }
    }
}

public sealed class PersistenceHuntHandler : IJobHandler
{
    public string Type => "persistence.hunt";
    public Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct) => Task.Run(() =>
    {
        var f = PersistenceHunt.Run();
        return new JobOutcome(true, new
        {
            findings = f, counts = new { high = f.Count(x => x.Severity == "high"), medium = f.Count(x => x.Severity == "medium"), low = f.Count(x => x.Severity == "low") },
            checkedPlaces = new[] { "Startup folders (all users and each profile)", "RunOnce keys", "Winlogon Shell, Userinit and Taskman", "Image File Execution Options debuggers", "AppInit_DLLs", "WMI permanent event subscriptions", "scripts in user folders, Temp, ProgramData and Public" },
            limits = new[] { "Profiles that are not signed in are not loaded, so their per-user registry keys are not read.", "Only script files are examined in the drop folders, not every program.", "This reports indicators for review. It does not scan files for known malware: use the antivirus for that, and compare file hashes with a reputation service." },
            note = "Findings are evidence to review, not verdicts. Nothing was changed.",
        });
    }, ct);
}
