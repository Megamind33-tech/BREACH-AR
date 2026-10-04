using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Viro.Agent;
using Viro.Agent.Repair;
using Xunit;

sealed class FakePolicyStore : IPolicyStore
{
    public readonly Dictionary<string, int> Values = new(StringComparer.OrdinalIgnoreCase);
    public bool Ignore;   // simulates a policy that overrides the change
    public int? GetInt(string key, string name) => Values.TryGetValue(key + "|" + name, out var v) ? v : null;
    public void SetInt(string key, string name, int value) { if (!Ignore) Values[key + "|" + name] = value; }
    public void Delete(string key, string name) => Values.Remove(key + "|" + name);
}

public class ProtectionTests
{
    const string Smb = @"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters";
    static readonly string Pol = @"SOFTWARE\Policies\Microsoft\Windows\";
    static IRepairRecipe Recipe(string id, IPolicyStore s) => Protection.Create(s).Single(r => r.Id == id);
    static Task<RepairReport> Run(IRepairRecipe r, IProcessRunner? p = null) { using var sb = new Sandbox(); return RepairEngine.RunAsync(r, new RepairContext(sb, p ?? new FakeProc(), new FakeServices(), NullLogger.Instance, T.J()), default); }

    [Fact]
    public async Task A_registry_control_is_diagnosed_applied_verified_and_reports_what_it_changed()
    {
        var s = new FakePolicyStore(); var r = Recipe("privacy.activity-history", s);
        var rep = await Run(r);
        Assert.True(rep.Applied); Assert.True(rep.Verified); Assert.True(rep.RollbackAvailable);
        Assert.Equal(0, s.GetInt(Pol + "System", "EnableActivityFeed")); Assert.Equal(0, s.GetInt(Pol + "System", "UploadUserActivities")); Assert.Equal(0, s.GetInt(Pol + "System", "PublishUserActivities"));
        var again = await Run(r);
        Assert.False(again.Applied); Assert.Contains("No action needed", again.Summary);   // already in place: nothing is touched
    }

    [Fact]
    public async Task A_change_that_does_not_take_effect_is_reported_as_unverified_and_put_back()
    {
        var s = new FakePolicyStore { Ignore = true }; s.Values[Pol + "AdvertisingInfo|DisabledByGroupPolicy"] = 0;
        var rep = await Run(Recipe("privacy.advertising-id", s));
        Assert.True(rep.Applied); Assert.False(rep.Verified); Assert.True(rep.RolledBack); Assert.Equal(0, s.GetInt(Pol + "AdvertisingInfo", "DisabledByGroupPolicy"));
        Assert.Contains("did not take effect", rep.Summary);
    }

    [Fact]
    public async Task Rollback_restores_the_previous_value_or_removes_a_value_that_did_not_exist()
    {
        using var sb = new Sandbox(); var s = new FakePolicyStore(); s.Values[Pol + "DataCollection|AllowTelemetry"] = 3;   // changed, then absent for the other setting
        var r = Recipe("privacy.telemetry-minimum", s);
        var rep = await RepairEngine.RunAsync(r, new RepairContext(sb, new FakeProc(), new FakeServices(), NullLogger.Instance, T.J()), default);
        Assert.True(rep.Verified); Assert.Equal(1, s.GetInt(Pol + "DataCollection", "AllowTelemetry")); Assert.Equal(1, s.GetInt(Pol + "DataCollection", "DoNotShowFeedbackNotifications"));
        var back = await RepairEngine.RollbackAsync(Recipes.All.ToDictionary(x => x.Key, x => x.Key == r.Id ? r : x.Value), rep.RepairId, new RepairContext(sb, new FakeProc(), new FakeServices(), NullLogger.Instance, T.J()), default);
        Assert.True(back.RolledBack); Assert.Equal(3, s.GetInt(Pol + "DataCollection", "AllowTelemetry")); Assert.Null(s.GetInt(Pol + "DataCollection", "DoNotShowFeedbackNotifications"));
    }

    [Fact]
    public async Task A_saved_rollback_file_can_only_touch_the_settings_of_its_own_recipe()
    {
        var s = new FakePolicyStore(); s.Values[Smb + "|SMB1"] = 1; var r = Recipe("protect.smb1-off", s);
        await r.RollbackAsync(new RepairContext(new Sandbox(), new FakeProc(), new FakeServices(), NullLogger.Instance, T.J()),
            JsonDocument.Parse("{\"previous\":[{\"key\":\"SYSTEM\\\\Anything\",\"name\":\"Else\",\"value\":7},{\"key\":\"SYSTEM\\\\CurrentControlSet\\\\Services\\\\LanmanServer\\\\Parameters\",\"name\":\"SMB1\",\"value\":1}]}").RootElement, default);
        Assert.Null(s.GetInt(@"SYSTEM\Anything", "Else"));
    }

    [Fact]
    public async Task SMB1_is_only_changed_when_it_is_actually_on()
    {
        var s = new FakePolicyStore(); var r = Recipe("protect.smb1-off", s);
        Assert.False((await Run(r)).Applied);   // no value: the protocol is not installed on modern Windows
        s.Values[Smb + "|SMB1"] = 1; var rep = await Run(r);
        Assert.True(rep.Verified); Assert.Equal(0, s.GetInt(Smb, "SMB1"));
    }

    [Fact]
    public async Task Remote_Desktop_hardening_is_skipped_when_Remote_Desktop_is_off()
    {
        var s = new FakePolicyStore(); var r = Recipe("protect.rdp-nla", s);
        Assert.Contains("not enabled", (await Run(r)).Summary); Assert.Null(s.GetInt(@"SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp", "UserAuthentication"));
        s.Values[@"SYSTEM\CurrentControlSet\Control\Terminal Server|fDenyTSConnections"] = 0; Assert.True((await Run(r)).Verified);
    }

    [Fact]
    public void Every_control_is_a_registered_recipe_with_a_risk_that_matches_how_disruptive_it_is()
    {
        foreach (var r in Protection.Create()) { Assert.True(Recipes.All.ContainsKey(r.Id), r.Id); Assert.True(r.Reversible, r.Id); Assert.False(r.AutoSafe, r.Id + " is never part of the one-click pass"); }
        foreach (var id in new[] { "protect.ransomware-block", "protect.network-protection", "protect.rdp-nla", "privacy.location-off" }) Assert.Equal(RepairRisk.Review, Recipes.All[id].Risk);
        foreach (var id in new[] { "protect.ransomware-audit", "protect.firewall", "protect.pua", "protect.smb1-off", "privacy.telemetry-minimum" }) Assert.Equal(RepairRisk.Safe, Recipes.All[id].Risk);
    }

    // ---- Defender and firewall, with a scripted PowerShell ----
    static FakeProc Defender(Func<int> current, Action<int>? onSet = null, bool active = true, int exit = 0) => new((_, args) =>
    {
        if (args.Contains("Set-MpPreference")) { var n = int.Parse(System.Text.RegularExpressions.Regex.Match(args, @"-\w+ (-?\d+)").Groups[1].Value); if (exit == 0) onSet?.Invoke(n); return new ProcResult(exit, exit == 0 ? "" : "Set-MpPreference : Access is denied 0x80070005", false); }
        return new ProcResult(0, $"VIRO|{(active ? "True" : "False")}|{current()}", false);
    });

    [Fact]
    public async Task Defender_settings_are_changed_verified_and_restorable()
    {
        var value = 0; var sets = new List<int>(); var p = Defender(() => value, v => { value = v; sets.Add(v); });
        var rep = await Run(Recipe("protect.ransomware-audit", new FakePolicyStore()), p);
        Assert.True(rep.Verified); Assert.Equal(2, value); Assert.Contains(p.Calls, c => c.Contains("Set-MpPreference -EnableControlledFolderAccess 2"));
        Assert.True((await Run(Recipe("protect.ransomware-audit", new FakePolicyStore()), p)).Summary.Contains("No action needed"));   // already watching
        await Recipe("protect.ransomware-audit", new FakePolicyStore()).RollbackAsync(new RepairContext(new Sandbox(), p, new FakeServices(), NullLogger.Instance, T.J()), JsonDocument.Parse("{\"previous\":0}").RootElement, default);
        Assert.Equal(0, value);
    }

    [Fact]
    public async Task Defender_controls_refuse_to_touch_a_PC_protected_by_another_antivirus_and_report_tamper_protection_honestly()
    {
        var other = await Run(Recipe("protect.pua", new FakePolicyStore()), Defender(() => 0, active: false));
        Assert.False(other.Applied); Assert.Contains("not the active antivirus", other.Summary);
        var probe = new FakeProc((_, _) => new ProcResult(0, "VIRO|False|0", false)); await Run(Recipe("protect.pua", new FakePolicyStore()), probe); Assert.Contains("-notmatch 'Passive", probe.Calls[0]);   // SxS Passive Mode counts as passive
        var denied = await Run(Recipe("protect.pua", new FakePolicyStore()), Defender(() => 0, exit: 1));
        Assert.False(denied.Verified ?? false); Assert.Contains("access denied", denied.Summary);
        var ignored = await Run(Recipe("protect.pua", new FakePolicyStore()), Defender(() => 0));   // the command "works" but Defender keeps the old value
        Assert.True(ignored.Applied); Assert.False(ignored.Verified); Assert.Contains("did not keep the change", ignored.Summary);
    }

    [Fact]
    public void The_advanced_ransomware_rule_reads_and_writes_only_its_own_rule_id()
    {
        var p = new FakeProc(); var r = Recipe("protect.asr-ransomware", new FakePolicyStore());
        RepairEngine.RunAsync(r, new RepairContext(new Sandbox(), p, new FakeServices(), NullLogger.Instance, T.J()), default).GetAwaiter().GetResult();
        Assert.All(p.Calls, c => Assert.Contains("c1db55ab-c21a-4637-bb3f-a12568109d35", c.Replace("VIRO", "")));   // every command names the ransomware rule and nothing else
        Assert.DoesNotContain(p.Calls, c => c.Contains("Set-MpPreference") || c.Contains("Remove-MpPreference") && !c.Contains("c1db55ab"));
    }

    [Fact]
    public async Task The_firewall_is_turned_on_per_profile_and_only_profiles_that_were_on_are_left_alone_on_rollback()
    {
        var state = new Dictionary<string, bool> { ["Domain"] = true, ["Private"] = false, ["Public"] = false };
        var p = new FakeProc((_, args) =>
        {
            if (args.Contains("Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True")) { foreach (var k in state.Keys.ToList()) state[k] = true; return new ProcResult(0, "", false); }
            return new ProcResult(0, string.Concat(state.Select(kv => $"{kv.Key}={(kv.Value ? "True" : "False")}\r\n")), false);
        });
        var r = new FirewallRecipe(); using var sb = new Sandbox();
        var rep = await RepairEngine.RunAsync(r, new RepairContext(sb, p, new FakeServices(), NullLogger.Instance, T.J()), default);
        Assert.True(rep.Verified); Assert.All(state.Values, v => Assert.True(v));
        await r.RollbackAsync(new RepairContext(sb, p, new FakeServices(), NullLogger.Instance, T.J()), JsonDocument.Parse("{\"previous\":{\"Domain\":true,\"Private\":false,\"Public\":false}}").RootElement, default);
        Assert.Contains(p.Calls, c => c.Contains("-Profile Private -Enabled False")); Assert.Contains(p.Calls, c => c.Contains("-Profile Public -Enabled False")); Assert.DoesNotContain(p.Calls, c => c.Contains("-Profile Domain -Enabled False"));
        Assert.Equal(new Dictionary<string, bool> { ["Domain"] = true, ["Public"] = false }, FirewallRecipe.Parse("Domain=True\r\nPublic=False\r\nnoise\r\nOther=True"));
        Assert.Contains("could not be read", (await RepairEngine.RunAsync(r, new RepairContext(sb, new FakeProc((_, _) => new ProcResult(1, "Get-NetFirewallProfile : boom", false)), new FakeServices(), NullLogger.Instance, T.J()), default)).Summary);
    }
}

public class RemainingRecipeTests
{
    const string Pol = @"SOFTWARE\Policies\Microsoft\Windows\";
    static Task<RepairReport> Run(IRepairRecipe r, IProcessRunner? p = null) { using var sb = new Sandbox(); return RepairEngine.RunAsync(r, new RepairContext(sb, p ?? new FakeProc(), new FakeServices(), NullLogger.Instance, T.J()), default); }

    [Fact]
    public async Task LLMNR_PowerShell_logging_and_consumer_content_controls_apply_verify_and_are_idempotent()
    {
        var s = new FakePolicyStore();
        foreach (var (id, key, name, val) in new[] { ("protect.llmnr-off", @"SOFTWARE\Policies\Microsoft\Windows NT\DNSClient", "EnableMulticast", 0), ("protect.ps-logging", Pol + @"PowerShell\ScriptBlockLogging", "EnableScriptBlockLogging", 1),
                                                     ("privacy.consumer-features", Pol + "CloudContent", "DisableWindowsConsumerFeatures", 1) })
        {
            var r = Protection.Create(s).Single(x => x.Id == id);
            var rep = await Run(r); Assert.True(rep.Verified, id); Assert.Equal(val, s.GetInt(key, name)); Assert.True(rep.RollbackAvailable, id);
            Assert.False((await Run(r)).Applied, id + " is idempotent");
        }
        Assert.Equal(1, s.GetInt(Pol + "CloudContent", "DisableTailoredExperiencesWithDiagnosticData"));
    }

    [Fact]
    public async Task Disk_check_reports_healthy_problems_or_a_timeout_honestly()
    {
        var r = Recipes.All["disk.check"];
        Assert.Contains("healthy", (await Run(r, new FakeProc((_, _) => new ProcResult(0, "Windows has scanned the file system and found no problems.", false)))).Summary);
        Assert.Equal(RepairRisk.Safe, r.Risk);
        var bad = await Run(r, new FakeProc((_, _) => new ProcResult(3, "Errors found.", false))); Assert.False(bad.Verified); Assert.Contains("reported problems", bad.Summary);
        var slow = await Run(r, new FakeProc((_, _) => new ProcResult(-1, "", true))); Assert.False(slow.Verified); Assert.Contains("did not finish", slow.Summary);
        var calls = new FakeProc(); await Run(r, calls); Assert.Contains("/scan", calls.Calls.Single());      // online scan only: it never schedules a repair at restart by itself
        Assert.DoesNotContain("/f", calls.Calls.Single()); Assert.DoesNotContain("/r", calls.Calls.Single());
    }

    [Fact]
    public void Every_catalog_recipe_the_server_knows_is_implemented_by_the_agent_and_no_more()
    {
        var root = Directory.GetParent(AppContext.BaseDirectory)!; while (root is not null && !File.Exists(Path.Combine(root.FullName, "server", "src", "catalog.ts"))) root = root.Parent;
        Assert.NotNull(root);
        var ids = System.Text.RegularExpressions.Regex.Matches(File.ReadAllText(Path.Combine(root!.FullName, "server", "src", "catalog.ts")).Split("export const REPAIR_RECIPES")[1].Split("as const")[0], @"^\s+'([a-z]+\.[a-z0-9-]+)':", System.Text.RegularExpressions.RegexOptions.Multiline).Select(m => m.Groups[1].Value).ToHashSet();
        Assert.Equal(ids.OrderBy(x => x), Recipes.All.Keys.OrderBy(x => x));
    }
}
