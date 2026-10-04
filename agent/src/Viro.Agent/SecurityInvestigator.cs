using System.Management;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.Win32;
using Viro.Agent.Repair;

namespace Viro.Agent;

// ---------------------------------------------------------------------------------------------------------------------
// Evidence about what a threat may have changed on this PC. Everything here is read-only, and every conclusion carries its evidence and a
// confidence. Nothing is called malicious because it is merely unfamiliar: the only HIGH-confidence link to a threat is a Defender detection.
// ---------------------------------------------------------------------------------------------------------------------
public sealed record RunEntry(string Location, string Name, string Command);
public sealed record TaskEntry(string Name, string Command, string? Author);
public sealed record ServiceEntry(string Name, string Path, string StartMode);
public sealed record ProxyState(string Scope, bool Enabled, string? Server, string? AutoConfigUrl);
public sealed record DnsState(string Adapter, bool Dhcp, string[] Servers);
public sealed record DefenderPolicy(bool? DisableAntiSpyware, bool? DisableRealtimeMonitoring, int? Exclusions);
/// <param name="SearchProvider">the search engine the extension forces, when it declares one</param>
public sealed record ExtensionInfo(string Browser, string Id, string Name, string? SearchProvider, string? Homepage, bool Blocked);
public sealed record SystemFacts(IReadOnlyList<RunEntry> Run, IReadOnlyList<TaskEntry> Tasks, IReadOnlyList<ServiceEntry> Services, IReadOnlyList<ProxyState> Proxies,
    IReadOnlyList<DnsState> Dns, IReadOnlyList<string> Hosts, DefenderPolicy Defender, IReadOnlyList<ExtensionInfo>? Extensions = null);

/// <param name="Suspicious">true only when there is concrete evidence; LOW/MEDIUM findings are for a person to review</param>
/// <param name="Recipe">the approved recipe that can undo it, or null when only a person can decide</param>
public sealed record SecFinding(string Kind, string Severity, bool Suspicious, string Confidence, string Evidence, string Location, string Name, string? Recipe);

public interface ISecurityState
{
    SystemFacts Read();
    void ClearProxy(string scope); void SetDnsAutomatic(string adapter); void WriteHosts(IEnumerable<string> lines);
    void RemoveRunEntry(string location, string name); void RemoveTask(string name); void DeletePolicyValue(string name);
    string? TaskXml(string name); void RestoreTask(string name, string xml); void SetRunEntry(string location, string name, string command);
    ProxyState? RawProxy(string scope); void SetProxy(ProxyState p); void SetDns(string adapter, string[] servers);
    void SetPolicyValue(string name, int value);
    string BlockExtension(string browser, string id); void UnblockExtension(string browser, string valueName);
}

public static partial class SecurityAnalysis
{
    static readonly string[] Vendors = ["microsoft", "windowsupdate", "defender", "avast", "avg.", "kaspersky", "mcafee", "norton", "symantec", "bitdefender", "eset", "malwarebytes", "sophos", "trendmicro", "virustotal", "crowdstrike", "sentinelone"];
    static readonly string[] KnownSearch = ["google", "bing", "duckduckgo", "yahoo", "ecosia", "brave", "startpage", "qwant", "microsoft", "newtab", "about:"];
    static readonly string[] KnownResolvers = ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9", "149.112.112.112", "208.67.222.222", "208.67.220.220"];

    public static bool UserWritable(string command) => UserPath().IsMatch(command);
    public static bool Obfuscated(string command) => Encoded().IsMatch(command);

    /// <summary>Extracts file paths from a Defender resource string such as "file:_C:\Users\a\x.exe".</summary>
    public static IEnumerable<string> ThreatPaths(IEnumerable<string> resources) =>
        resources.Select(r => Regex.Replace(r ?? "", @"^(file|folder|regkey|process|webfile):_?", "", RegexOptions.IgnoreCase).Trim()).Where(p => p.Length > 3).Distinct(StringComparer.OrdinalIgnoreCase);

    static bool Links(string command, IReadOnlyList<string> threat) => threat.Any(t => command.Contains(t, StringComparison.OrdinalIgnoreCase));
    static bool Private(string ip) => ip.StartsWith("10.") || ip.StartsWith("192.168.") || ip.StartsWith("127.") || Regex.IsMatch(ip, @"^172\.(1[6-9]|2\d|3[01])\.") || ip.StartsWith("169.254.") || ip.Contains(':') && (ip.StartsWith("fe80", StringComparison.OrdinalIgnoreCase) || ip.StartsWith("fd", StringComparison.OrdinalIgnoreCase) || ip == "::1");

    public static List<SecFinding> Analyze(SystemFacts f, IReadOnlyList<string> threatPaths)
    {
        var o = new List<SecFinding>();
        foreach (var r in f.Run) Persist(o, "startup-entry", r.Location, r.Name, r.Command, threatPaths, removable: true);
        foreach (var t in f.Tasks) Persist(o, "scheduled-task", "Task Scheduler", t.Name, t.Command, threatPaths, removable: true);
        foreach (var s in f.Services) Persist(o, "service", "Services", s.Name, s.Path, threatPaths, removable: false);

        foreach (var p in f.Proxies.Where(p => p.Enabled && !string.IsNullOrWhiteSpace(p.Server) || !string.IsNullOrWhiteSpace(p.AutoConfigUrl)))
        {
            var loop = p.Server is { } sv && Regex.IsMatch(sv, @"(^|=|//)(127\.|localhost)", RegexOptions.IgnoreCase);
            o.Add(new("proxy", loop ? "high" : "medium", true, "MEDIUM", $"Web traffic is routed through {(p.AutoConfigUrl is { Length: > 0 } ? "an automatic proxy script " + p.AutoConfigUrl : p.Server)} ({p.Scope}){(loop ? "; a proxy on this same PC can read or alter web traffic" : "")}. Organizations that use a proxy on purpose should approve this.", p.Scope, "proxy", "security.restore-proxy"));
        }
        foreach (var d in f.Dns.Where(d => !d.Dhcp && d.Servers.Length > 0 && d.Servers.Any(s => !Private(s) && !KnownResolvers.Contains(s))))
            o.Add(new("dns", "medium", true, "MEDIUM", $"Adapter \"{d.Adapter}\" uses fixed DNS servers {string.Join(", ", d.Servers)} that are neither on this network nor a well-known public resolver.", d.Adapter, "dns", "security.restore-dns"));

        foreach (var line in f.Hosts)
        {
            var m = HostsLine().Match(line); if (!m.Success) continue;
            var ip = m.Groups[1].Value; var names = m.Groups[2].Value.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries);
            var vendor = names.FirstOrDefault(n => Vendors.Any(v => n.Contains(v, StringComparison.OrdinalIgnoreCase)));
            if (vendor is not null) o.Add(new("hosts", "high", true, "HIGH", $"The hosts file redirects or blocks \"{vendor}\", a Windows update or security vendor address ({ip}). That stops protection from updating.", "hosts", line.Trim(), "security.restore-hosts"));
            else if (!Private(ip) && ip != "0.0.0.0" && !names.All(n => n is "localhost" or "broadcasthost" or "ip6-localhost")) o.Add(new("hosts", "medium", true, "MEDIUM", $"The hosts file points {string.Join(", ", names.Take(3))} at {ip}.", "hosts", line.Trim(), "security.restore-hosts"));
        }

        // Privacy: an extension that takes over the search engine or home page is behaving like a browser hijacker. Only that concrete behaviour is reported.
        foreach (var x in (f.Extensions ?? []).Where(x => !x.Blocked))
        {
            var why = x.SearchProvider is { Length: > 0 } sp && !KnownSearch.Any(k => sp.Contains(k, StringComparison.OrdinalIgnoreCase)) ? $"forces the search engine to \"{x.SearchProvider}\""
                    : x.Homepage is { Length: > 0 } hp && !KnownSearch.Any(k => hp.Contains(k, StringComparison.OrdinalIgnoreCase)) ? $"forces the home page to {x.Homepage}" : null;
            if (why is not null) o.Add(new("browser-extension", "medium", true, "MEDIUM", $"The {x.Browser} extension \"{x.Name}\" {why}. Extensions that take over search or the home page are how browser hijackers earn money from your searches.", x.Browser, x.Id, "privacy.block-extension"));
        }
        if (f.Defender.DisableAntiSpyware == true) o.Add(new("security-setting", "high", true, "HIGH", "A policy turns Microsoft Defender off (DisableAntiSpyware=1). Malware commonly sets this.", "Defender policy", "DisableAntiSpyware", "security.restore-defender-policy"));
        if (f.Defender.DisableRealtimeMonitoring == true) o.Add(new("security-setting", "high", true, "HIGH", "A policy turns Defender real-time protection off (DisableRealtimeMonitoring=1).", "Defender policy", "DisableRealtimeMonitoring", "security.restore-defender-policy"));
        if (f.Defender.Exclusions is > 0) o.Add(new("security-setting", "low", false, "LOW", $"Defender has {f.Defender.Exclusions} scan exclusion(s). Malware sometimes adds them; most are legitimate. Review who added them.", "Defender exclusions", "exclusions", null));
        return o;
    }

    static void Persist(List<SecFinding> o, string kind, string location, string name, string command, IReadOnlyList<string> threat, bool removable)
    {
        if (Links(command, threat))
        { o.Add(new(kind, "high", true, "HIGH", $"\"{name}\" starts {Trim(command)}, which Microsoft Defender reported as a threat. This is how it would run again after a restart.", location, name, removable ? "security.remove-persistence" : null)); return; }
        var why = Obfuscated(command) ? "runs an encoded or hidden script" : UserWritable(command) ? "starts a program from a user-writable folder" : null;
        if (why is not null) o.Add(new(kind, "low", false, "LOW", $"\"{name}\" {why}: {Trim(command)}. Many legitimate apps do this; it is listed for review, and Viro will not remove it without a detection.", location, name, null));
    }
    static string Trim(string s) => s.Length > 160 ? s[..160] + "…" : s;

    [GeneratedRegex(@"\\(AppData|Temp|Users\\Public|Downloads)\\", RegexOptions.IgnoreCase)] private static partial Regex UserPath();
    [GeneratedRegex(@"(-enc\b|-encodedcommand|frombase64string|-w(indowstyle)?\s+hidden|mshta|wscript|cscript.*\.(js|vbs))", RegexOptions.IgnoreCase)] private static partial Regex Encoded();
    [GeneratedRegex(@"^\s*([0-9a-fA-F:.]+)\s+([^#\r\n]+?)\s*(#.*)?$")] private static partial Regex HostsLine();
}

// ---------------------------------------------------------------------------------------------------------------------
public sealed class WindowsSecurityState : ISecurityState
{
    const string Inet = @"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    const string DefPol = @"SOFTWARE\Policies\Microsoft\Windows Defender";
    static string HostsPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"System32\drivers\etc\hosts");
    static string TasksDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"System32\Tasks");
    static T? Try<T>(Func<T> f) { try { return f(); } catch { return default; } }
    static IEnumerable<string> UserSids() => Try(() => Registry.Users.GetSubKeyNames().Where(n => n.StartsWith("S-1-5-21-") && !n.EndsWith("_Classes")).ToArray()) ?? [];

    public SystemFacts Read() => new(Run(), Tasks(), Services(), Proxies(), Dns(), Try(() => File.ReadAllLines(HostsPath)) ?? [], DefenderFacts(), Try(() => BrowserExtensions.Read()) ?? []);
    public string BlockExtension(string browser, string id) => BrowserExtensions.Block(browser, id);
    public void UnblockExtension(string browser, string valueName) => BrowserExtensions.Unblock(browser, valueName);

    List<RunEntry> Run()
    {
        var o = new List<RunEntry>();
        void From(RegistryKey? root, string hive, string sub) { using var k = root?.OpenSubKey(sub); if (k is null) return; foreach (var n in k.GetValueNames()) if (k.GetValue(n) is string s) o.Add(new($@"{hive}\{sub}", n, s)); }
        foreach (var sub in new[] { @"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run" }) From(Registry.LocalMachine, "HKLM", sub);
        foreach (var sid in UserSids()) From(Registry.Users, $@"HKU\{sid}", $@"{sid}\Software\Microsoft\Windows\CurrentVersion\Run");
        return o;
    }

    List<TaskEntry> Tasks()
    {
        var o = new List<TaskEntry>();
        if (!Directory.Exists(TasksDir)) return o;
        foreach (var f in Try(() => Directory.EnumerateFiles(TasksDir, "*", SearchOption.AllDirectories).ToList()) ?? [])
        {
            var rel = Path.GetRelativePath(TasksDir, f); if (rel.StartsWith(@"Microsoft\", StringComparison.OrdinalIgnoreCase)) continue;
            try
            {
                var x = XDocument.Load(f); XNamespace ns = x.Root!.Name.Namespace;
                var cmds = x.Descendants(ns + "Exec").Select(e => ((string?)e.Element(ns + "Command") + " " + (string?)e.Element(ns + "Arguments")).Trim());
                foreach (var c in cmds) o.Add(new(rel, Environment.ExpandEnvironmentVariables(c), (string?)x.Descendants(ns + "Author").FirstOrDefault()));
            }
            catch { }
        }
        return o;
    }

    static List<ServiceEntry> Services()
    {
        try
        {
            using var s = new ManagementObjectSearcher("SELECT Name,PathName,StartMode FROM Win32_Service");
            return [.. s.Get().Cast<ManagementBaseObject>().Select(m => new ServiceEntry(m["Name"]?.ToString() ?? "", m["PathName"]?.ToString() ?? "", m["StartMode"]?.ToString() ?? "")).Where(x => SecurityAnalysis.UserWritable(x.Path))];
        }
        catch { return []; }
    }

    public ProxyState? RawProxy(string scope)
    {
        RegistryKey? Open(bool w) => scope == "machine" ? Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings", w) : Registry.Users.OpenSubKey($@"{scope}\{Inet}", w);
        using var k = Open(false); if (k is null) return null;
        return new(scope, (k.GetValue("ProxyEnable") as int? ?? 0) == 1, k.GetValue("ProxyServer") as string, k.GetValue("AutoConfigURL") as string);
    }
    List<ProxyState> Proxies()
    {
        var o = new List<ProxyState>(); if (RawProxy("machine") is { } m) o.Add(m);
        foreach (var sid in UserSids()) if (RawProxy(sid) is { } u) o.Add(u with { Scope = sid });
        return o;
    }
    public void ClearProxy(string scope) => SetProxy(new(scope, false, null, null));
    public void SetProxy(ProxyState p)
    {
        using var k = p.Scope == "machine" ? Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings", true) : Registry.Users.OpenSubKey($@"{p.Scope}\{Inet}", true);
        if (k is null) return;
        k.SetValue("ProxyEnable", p.Enabled ? 1 : 0, RegistryValueKind.DWord);
        if (p.Server is null) k.DeleteValue("ProxyServer", false); else k.SetValue("ProxyServer", p.Server);
        if (p.AutoConfigUrl is null) k.DeleteValue("AutoConfigURL", false); else k.SetValue("AutoConfigURL", p.AutoConfigUrl);
    }

    static List<DnsState> Dns()
    {
        try
        {
            using var s = new ManagementObjectSearcher("SELECT Description,DHCPEnabled,DNSServerSearchOrder FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled=TRUE");
            return [.. s.Get().Cast<ManagementBaseObject>().Select(m => new DnsState(m["Description"]?.ToString() ?? "", m["DHCPEnabled"] as bool? ?? true, m["DNSServerSearchOrder"] as string[] ?? []))];
        }
        catch { return []; }
    }
    public void SetDnsAutomatic(string adapter) => Netsh($"interface ip set dnsservers name=\"{Interface(adapter)}\" source=dhcp");
    public void SetDns(string adapter, string[] servers) { var n = Interface(adapter); Netsh($"interface ip set dnsservers name=\"{n}\" static {servers[0]} primary"); for (var i = 1; i < servers.Length; i++) Netsh($"interface ip add dnsservers name=\"{n}\" {servers[i]} index={i + 1}"); }
    static string Interface(string description)
    {
        using var s = new ManagementObjectSearcher($"SELECT NetConnectionID FROM Win32_NetworkAdapter WHERE Description='{description.Replace("'", "''")}'");
        var id = s.Get().Cast<ManagementBaseObject>().Select(m => m["NetConnectionID"]?.ToString()).FirstOrDefault(x => !string.IsNullOrEmpty(x));
        return id is not null && Regex.IsMatch(id, @"^[\w .()#-]{1,80}$") ? id : throw new InvalidOperationException("the network interface name could not be determined safely");
    }
    static void Netsh(string args) { using var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("netsh.exe", args) { CreateNoWindow = true, UseShellExecute = false })!; p.WaitForExit(30000); if (p.ExitCode != 0) throw new InvalidOperationException("netsh failed (" + p.ExitCode + ")"); }

    public void WriteHosts(IEnumerable<string> lines) { var tmp = HostsPath + ".viro-tmp"; File.WriteAllLines(tmp, lines); File.Move(tmp, HostsPath, true); }

    public void RemoveRunEntry(string location, string name) { using var k = OpenRun(location, true); k?.DeleteValue(name, false); }
    public void SetRunEntry(string location, string name, string command) { using var k = OpenRun(location, true); k?.SetValue(name, command); }
    static RegistryKey? OpenRun(string location, bool w)
    {
        if (location.StartsWith(@"HKLM\")) return Registry.LocalMachine.OpenSubKey(location[5..], w);
        var m = Regex.Match(location, @"^HKU\\(S-1-5-21-[\d-]+)\\(.+)$"); return m.Success ? Registry.Users.OpenSubKey(m.Groups[1].Value + "\\" + m.Groups[2].Value, w) : null;
    }

    public string? TaskXml(string name) { var p = TaskPath(name); return File.Exists(p) ? File.ReadAllText(p) : null; }
    public void RemoveTask(string name) { Schtasks($"/Delete /TN \"{name}\" /F"); }
    public void RestoreTask(string name, string xml) { var tmp = Path.GetTempFileName(); try { File.WriteAllText(tmp, xml); Schtasks($"/Create /TN \"{name}\" /XML \"{tmp}\" /F"); } finally { File.Delete(tmp); } }
    static string TaskPath(string name) { var p = Path.GetFullPath(Path.Combine(TasksDir, name)); return p.StartsWith(TasksDir, StringComparison.OrdinalIgnoreCase) ? p : throw new ArgumentException("invalid task name"); }
    static void Schtasks(string args) { using var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("schtasks.exe", args) { CreateNoWindow = true, UseShellExecute = false })!; p.WaitForExit(30000); if (p.ExitCode != 0) throw new InvalidOperationException("schtasks failed (" + p.ExitCode + ")"); }

    static DefenderPolicy DefenderFacts()
    {
        int? Pol(string sub, string n) => Try(() => Registry.GetValue(@"HKEY_LOCAL_MACHINE\" + DefPol + sub, n, null) as int?);
        int? ex = Try(() => { using var s = new ManagementObjectSearcher(new ManagementScope(@"\\.\root\Microsoft\Windows\Defender"), new ObjectQuery("SELECT ExclusionPath,ExclusionProcess,ExclusionExtension FROM MSFT_MpPreference")); var m = s.Get().Cast<ManagementBaseObject>().FirstOrDefault(); return m is null ? (int?)null : new[] { "ExclusionPath", "ExclusionProcess", "ExclusionExtension" }.Sum(n => (m[n] as string[])?.Length ?? 0); });
        return new(Pol("", "DisableAntiSpyware") is { } a ? a == 1 : null, Pol(@"\Real-Time Protection", "DisableRealtimeMonitoring") is { } r ? r == 1 : null, ex);
    }
    public void DeletePolicyValue(string name) { foreach (var sub in new[] { "", @"\Real-Time Protection" }) { using var k = Registry.LocalMachine.OpenSubKey(DefPol + sub, true); k?.DeleteValue(name, false); } }
    public void SetPolicyValue(string name, int value) { var sub = name == "DisableRealtimeMonitoring" ? @"\Real-Time Protection" : ""; Registry.SetValue(@"HKEY_LOCAL_MACHINE\" + DefPol + sub, name, value, RegistryValueKind.DWord); }
}

// ---------------------------------------------------------------------------------------------------------------------
/// <summary>security.investigate { threatPaths? }: read-only. What startup entries, tasks, proxy, DNS, hosts and Defender settings look like, with evidence.</summary>
public sealed class SecurityInvestigateHandler(ISecurityState? state = null) : IJobHandler
{
    public string Type => "security.investigate";
    public Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var threat = ctx.Job.Params.ValueKind == JsonValueKind.Object && ctx.Job.Params.TryGetProperty("threatPaths", out var t) && t.ValueKind == JsonValueKind.Array ? t.EnumerateArray().Select(x => x.GetString() ?? "").ToList() : [];
        var facts = (state ?? new WindowsSecurityState()).Read();
        var findings = SecurityAnalysis.Analyze(facts, threat);
        return Task.FromResult(new JobOutcome(true, new
        {
            investigatedAt = DateTime.UtcNow.ToString("O"), findings,
            counts = new { startupEntries = facts.Run.Count, scheduledTasks = facts.Tasks.Count, servicesInUserFolders = facts.Services.Count, proxies = facts.Proxies.Count(p => p.Enabled), hostsLines = facts.Hosts.Count },
            suspiciousCount = findings.Count(f => f.Suspicious), limits = "Offline user profiles are not inspected, and browser extensions are not yet examined.",
        }));
    }
}
