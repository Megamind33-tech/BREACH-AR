using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Viro.Agent;
using Viro.Agent.Repair;
using Xunit;

sealed class FakeSecurityState : ISecurityState
{
    public List<RunEntry> Run = []; public List<TaskEntry> Tasks = []; public List<ServiceEntry> Services = []; public List<ProxyState> Proxies = []; public List<DnsState> Dns = []; public List<string> Hosts = [];
    public bool DisableAv, DisableRt; public int? Exclusions; public Dictionary<string, string> TaskXmls = [];
    public bool ProxyChangeIgnored;
    public SystemFacts Read() => new(Run.ToList(), Tasks.ToList(), Services.ToList(), Proxies.ToList(), Dns.ToList(), Hosts.ToList(), new(DisableAv ? true : null, DisableRt ? true : null, Exclusions), Extensions.ToList());
    public void ClearProxy(string scope) { if (!ProxyChangeIgnored) Proxies = Proxies.Select(p => p.Scope == scope ? p with { Enabled = false, Server = null, AutoConfigUrl = null } : p).ToList(); }
    public ProxyState? RawProxy(string scope) => Proxies.FirstOrDefault(p => p.Scope == scope);
    public void SetProxy(ProxyState p) => Proxies = Proxies.Select(x => x.Scope == p.Scope ? p : x).ToList();
    public void SetDnsAutomatic(string adapter) => Dns = Dns.Select(d => d.Adapter == adapter ? d with { Dhcp = true, Servers = [] } : d).ToList();
    public void SetDns(string adapter, string[] servers) => Dns = Dns.Select(d => d.Adapter == adapter ? d with { Dhcp = false, Servers = servers } : d).ToList();
    public void WriteHosts(IEnumerable<string> lines) => Hosts = lines.ToList();
    public void RemoveRunEntry(string location, string name) => Run.RemoveAll(r => r.Location == location && r.Name == name);
    public void SetRunEntry(string location, string name, string command) => Run.Add(new(location, name, command));
    public void RemoveTask(string name) => Tasks.RemoveAll(t => t.Name == name);
    public string? TaskXml(string name) => TaskXmls.GetValueOrDefault(name);
    public void RestoreTask(string name, string xml) => Tasks.Add(new(name, "restored", null));
    public void DeletePolicyValue(string name) { if (name == "DisableAntiSpyware") DisableAv = false; if (name == "DisableRealtimeMonitoring") DisableRt = false; }
    public void SetPolicyValue(string name, int value) { if (name == "DisableAntiSpyware") DisableAv = true; if (name == "DisableRealtimeMonitoring") DisableRt = true; }
    public List<ExtensionInfo> Extensions = []; public string BlockExtension(string browser, string id) { Extensions = Extensions.Select(e => e.Browser == browser && e.Id == id ? e with { Blocked = true } : e).ToList(); return "1"; } public void UnblockExtension(string browser, string valueName) => Extensions = Extensions.Select(e => e with { Blocked = false }).ToList();
}

public class SecurityInvestigationTests
{
    const string Trojan = @"C:\Users\bob\AppData\Roaming\svch0st\svch0st.exe";
    static Task<RepairReport> Run(IRepairRecipe r, string options = "{}") { using var sb = new Sandbox(); return RepairEngine.RunAsync(r, new RepairContext(sb, new FakeProc(), new FakeServices(), NullLogger.Instance, T.J(options)), default); }
    static string Opts(params string[] entries) => "{\"threatPaths\":[" + string.Join(",", new[] { JsonSerializer.Serialize(Trojan) }) + "]" + (entries.Length > 0 ? ",\"entries\":[" + string.Join(",", entries) + "]" : "") + "}";

    [Fact]
    public void Nothing_is_called_malicious_merely_for_being_unfamiliar_only_a_detection_links_persistence_with_high_confidence()
    {
        var f = new SystemFacts([new(@"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "Updater", @"C:\Users\bob\AppData\Local\Teams\update.exe"), new(@"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "svch0st", Trojan)],
            [new("Backup", @"powershell -w hidden -enc AAAA", "x")], [new("Odd", @"C:\Users\Public\x.exe", "auto")], [], [], [], new(null, null, null));
        var none = SecurityAnalysis.Analyze(f, []);
        Assert.All(none, x => { Assert.False(x.Suspicious); Assert.Equal("LOW", x.Confidence); Assert.Null(x.Recipe); });   // review only, never auto-removed
        Assert.Equal(4, none.Count);
        var linked = SecurityAnalysis.Analyze(f, [Trojan]);
        var hit = linked.Single(x => x.Suspicious); Assert.Equal("HIGH", hit.Confidence); Assert.Equal("svch0st", hit.Name); Assert.Equal("security.remove-persistence", hit.Recipe); Assert.Contains("Defender reported", hit.Evidence);
    }

    [Fact]
    public void Proxy_dns_hosts_and_Defender_policy_changes_are_reported_with_the_evidence_and_the_recipe_that_can_undo_them()
    {
        var f = new SystemFacts([], [], [], [new("machine", true, "127.0.0.1:8888", null), new("S-1-5-21-1", false, null, null), new("S-1-5-21-2", true, "proxy.corp:3128", null)],
            [new("Ethernet", false, ["203.0.113.9"]), new("Wi-Fi", false, ["192.168.1.1", "1.1.1.1"]), new("Lan", true, [])],
            ["# comment", "127.0.0.1 localhost", "::1 localhost", "203.0.113.5 update.microsoft.com", "0.0.0.0 definitions.avast.com", "198.51.100.4 shop.example.com", "  "], new(true, true, 3));
        var r = SecurityAnalysis.Analyze(f, []);
        Assert.Equal(2, r.Count(x => x.Kind == "proxy")); Assert.Equal("high", r.First(x => x.Kind == "proxy").Severity);
        Assert.Single(r, x => x.Kind == "dns"); Assert.Equal("Ethernet", r.Single(x => x.Kind == "dns").Location);
        Assert.Equal(3, r.Count(x => x.Kind == "hosts")); Assert.Equal(2, r.Count(x => x.Kind == "hosts" && x.Confidence == "HIGH"));
        Assert.Equal(2, r.Count(x => x.Kind == "security-setting" && x.Recipe == "security.restore-defender-policy"));
        Assert.Contains(r, x => x.Name == "exclusions" && !x.Suspicious && x.Recipe is null);
        Assert.Empty(SecurityAnalysis.Analyze(new SystemFacts([], [], [], [new("machine", false, null, null)], [new("Lan", true, [])], ["127.0.0.1 localhost"], new(null, null, null)), []));
    }

    [Fact]
    public void Threat_resources_are_reduced_to_plain_file_paths()
    {
        Assert.Equal([Trojan], SecurityAnalysis.ThreatPaths([$"file:_{Trojan}", "  ", "x"]).ToArray());
        Assert.Equal(2, SecurityAnalysis.ThreatPaths([@"file:_C:\a\b.exe", @"regkey:_HKLM\x\y"]).Count());
    }

    [Fact]
    public async Task Persistence_is_removed_only_when_linked_to_a_detection_and_named_then_verified_and_restorable()
    {
        var s = new FakeSecurityState(); const string loc = @"HKU\S-1-5-21-1\Software\Microsoft\Windows\CurrentVersion\Run";
        s.Run.Add(new(loc, "svch0st", Trojan)); s.Run.Add(new(loc, "Teams", @"C:\Users\bob\AppData\Local\Teams\update.exe")); s.Tasks.Add(new("Updater1", Trojan + " /quiet", null)); s.TaskXmls["Updater1"] = "<Task/>";
        var r = new RemovePersistenceRecipe(s);
        Assert.Contains("nothing qualifies", (await Run(r)).Summary);   // no detection path, no removal
        var rep = await Run(r, Opts("{\"location\":\"" + loc.Replace("\\", "\\\\") + "\",\"name\":\"svch0st\"}"));
        Assert.True(rep.Verified); Assert.DoesNotContain(s.Run, x => x.Name == "svch0st"); Assert.Contains(s.Run, x => x.Name == "Teams"); Assert.Contains(s.Tasks, t => t.Name == "Updater1");   // only the named entry went
        var all = await Run(r, Opts()); Assert.True(all.Verified); Assert.Empty(s.Tasks);
        Assert.True(rep.RollbackAvailable);
        await r.RollbackAsync(new RepairContext(new Sandbox(), new FakeProc(), new FakeServices(), NullLogger.Instance, T.J()), JsonDocument.Parse("{\"removed\":[{\"kind\":\"startup-entry\",\"location\":\"" + loc.Replace("\\", "\\\\") + "\",\"name\":\"svch0st\",\"data\":\"back\"}]}").RootElement, default);
        Assert.Contains(s.Run, x => x.Name == "svch0st" && x.Command == "back");
    }

    [Fact]
    public async Task Proxy_is_cleared_verified_and_restorable_and_an_ignored_change_is_reported_honestly()
    {
        var s = new FakeSecurityState(); s.Proxies.Add(new("machine", true, "127.0.0.1:8888", null));
        var r = new RestoreProxyRecipe(s); var rep = await Run(r);
        Assert.True(rep.Verified); Assert.False(s.Proxies[0].Enabled); Assert.True(rep.RollbackAvailable);
        await r.RollbackAsync(new RepairContext(new Sandbox(), new FakeProc(), new FakeServices(), NullLogger.Instance, T.J()), JsonDocument.Parse("{\"proxies\":[{\"scope\":\"machine\",\"enabled\":true,\"server\":\"127.0.0.1:8888\",\"autoConfigUrl\":null}]}").RootElement, default);
        Assert.True(s.Proxies[0].Enabled);
        var stuck = new FakeSecurityState { ProxyChangeIgnored = true }; stuck.Proxies.Add(new("machine", true, "127.0.0.1:8888", null));
        var bad = await Run(new RestoreProxyRecipe(stuck)); Assert.False(bad.Verified); Assert.True(bad.RolledBack); Assert.Contains("remain", bad.Summary);
        Assert.Contains("no proxy problem", (await Run(new RestoreProxyRecipe(new FakeSecurityState()))).Summary);
    }

    [Fact]
    public async Task Hosts_repair_drops_only_the_flagged_lines_and_keeps_everything_else()
    {
        var s = new FakeSecurityState { Hosts = ["# my notes", "127.0.0.1 localhost", "203.0.113.5 update.microsoft.com", "10.0.0.5 intranet.local"] };
        var rep = await Run(new RestoreHostsRecipe(s));
        Assert.True(rep.Verified); Assert.Equal(["# my notes", "127.0.0.1 localhost", "10.0.0.5 intranet.local"], s.Hosts);
    }

    [Fact]
    public async Task Defender_policy_is_restored_and_DNS_goes_back_to_automatic()
    {
        var s = new FakeSecurityState { DisableAv = true, DisableRt = true }; var rep = await Run(new RestoreDefenderPolicyRecipe(s));
        Assert.True(rep.Verified); Assert.False(s.DisableAv); Assert.False(s.DisableRt);
        var d = new FakeSecurityState(); d.Dns.Add(new("Ethernet", false, ["203.0.113.9"])); var dr = await Run(new RestoreDnsRecipe(d));
        Assert.True(dr.Verified); Assert.True(d.Dns[0].Dhcp); Assert.True(dr.RollbackAvailable);
    }

    [Fact]
    public async Task The_investigation_job_is_read_only_and_reports_counts_limits_and_suspicious_findings()
    {
        var s = new FakeSecurityState { Hosts = ["203.0.113.5 definitions.avast.com"] };
        var o = await new SecurityInvestigateHandler(s).RunAsync(T.Job("security.investigate", "{\"threatPaths\":[]}"), default);
        var j = JsonSerializer.SerializeToElement(o.Result, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.True(o.Success); Assert.Equal(1, j.GetProperty("suspiciousCount").GetInt32()); Assert.Contains("browser extensions", j.GetProperty("limits").GetString());
        Assert.Equal(["203.0.113.5 definitions.avast.com"], s.Hosts);   // nothing was changed
    }

    [Fact]
    public void The_security_recipes_are_registered_reversible_and_always_need_approval()
    {
        foreach (var id in new[] { "security.restore-proxy", "security.restore-dns", "security.restore-hosts", "security.restore-defender-policy", "security.remove-persistence" })
        { Assert.True(Recipes.All.ContainsKey(id), id); Assert.Equal(RepairRisk.Review, Recipes.All[id].Risk); Assert.True(Recipes.All[id].Reversible); Assert.False(Recipes.All[id].AutoSafe); }
        Assert.Contains(JobHandlers.All().Select(h => h.Type), t => t == "security.investigate");
        Assert.Contains(JobHandlers.All().Select(h => h.Type), t => t == "security.remediate");
    }
}

public class BrowserExtensionTests
{
    const string Hijack = "abcdefghijklmnopabcdefghijklmnop", Benign = "ponmlkjihgfedcbaponmlkjihgfedcba";
    static string MakeExt(string users, string browserDir, string profile, string id, string manifest, string? messages = null)
    {
        var dir = Path.Combine(users, "bob", "AppData", "Local", browserDir, "User Data", profile, "Extensions", id, "2.1_0"); Directory.CreateDirectory(dir); File.WriteAllText(Path.Combine(dir, "manifest.json"), manifest);
        if (messages is not null) { var loc = Path.Combine(dir, "_locales", "en"); Directory.CreateDirectory(loc); File.WriteAllText(Path.Combine(loc, "messages.json"), messages); }
        return dir;
    }

    [Fact]
    public async Task Only_an_extension_that_takes_over_search_or_the_home_page_is_reported_and_blocking_it_is_verified_and_reversible()
    {
        var users = Path.Combine(Path.GetTempPath(), "viro-ext-" + Guid.NewGuid().ToString("N"));
        try
        {
            MakeExt(users, @"Google\Chrome", "Default", Hijack, "{\"name\":\"__MSG_appName__\",\"default_locale\":\"en\",\"chrome_settings_overrides\":{\"search_provider\":{\"name\":\"FastSearch Pro\",\"search_url\":\"https://fastsearch.example/?q={searchTerms}\"},\"homepage\":\"https://fastsearch.example\"}}", "{\"appName\":{\"message\":\"PDF Helper Plus\"}}");
            MakeExt(users, @"Microsoft\Edge", "Profile 1", Benign, "{\"name\":\"Dark Reader\",\"permissions\":[\"<all_urls>\",\"webRequest\"]}");                                  // broad permissions are common and legitimate: not reported
            MakeExt(users, @"Google\Chrome", "Default", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "{\"name\":\"Bing Search\",\"chrome_settings_overrides\":{\"search_provider\":{\"name\":\"Bing\"}}}");   // a normal search engine
            MakeExt(users, @"Google\Chrome", "Default", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "not json");                                                                                                   // unreadable: skipped
            var found = BrowserExtensions.Read(users);
            Assert.Equal(3, found.Count); Assert.Equal("PDF Helper Plus", found.Single(x => x.Id == Hijack).Name); Assert.Equal("FastSearch Pro", found.Single(x => x.Id == Hijack).SearchProvider);

            var s = new FakeSecurityState { Extensions = found };
            var r = SecurityAnalysis.Analyze(s.Read(), []).Where(x => x.Kind == "browser-extension").ToList();
            Assert.Single(r); Assert.Equal(Hijack, r[0].Name); Assert.Equal("chrome", r[0].Location); Assert.Equal("privacy.block-extension", r[0].Recipe); Assert.Contains("PDF Helper Plus", r[0].Evidence); Assert.Contains("FastSearch Pro", r[0].Evidence);

            using var sb = new Sandbox(); RepairContext Ctx(string opts = "{}") => new(sb, new FakeProc(), new FakeServices(), Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, T.J(opts));
            var rec = new BlockExtensionRecipe(s);
            Assert.False((await RepairEngine.RunAsync(rec, Ctx("{\"entries\":[{\"location\":\"chrome\",\"name\":\"" + Benign + "\"}]}"), default)).Applied);     // only what is named AND flagged
            var rep = await RepairEngine.RunAsync(rec, Ctx(), default);
            Assert.True(rep.Verified); Assert.True(s.Extensions.Single(x => x.Id == Hijack).Blocked); Assert.True(rep.RollbackAvailable); Assert.Contains("next time the browser starts", rep.Summary);
            Assert.Contains("no extension", (await RepairEngine.RunAsync(rec, Ctx(), default)).Summary);
            await rec.RollbackAsync(Ctx(), System.Text.Json.JsonDocument.Parse("{\"blocked\":[{\"browser\":\"chrome\",\"valueName\":\"1\",\"id\":\"" + Hijack + "\"}]}").RootElement, default);
            Assert.False(s.Extensions.Single(x => x.Id == Hijack).Blocked);
            Assert.Throws<ArgumentException>(() => BrowserExtensions.Block("chrome", "../evil"));
        }
        finally { try { Directory.Delete(users, true); } catch { } }
    }
}
