using System.Text;
using System.Text.Json;
using Viro.Agent;
using Viro.Agent.Repair;
using Xunit;

sealed class FakeWu(params PendingUpdate[] pending) : IUpdateAgent
{
    public List<string> Installed = [];
    public int ResultCode = 2;
    public Task<IReadOnlyList<PendingUpdate>> SearchAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<PendingUpdate>>(pending.Where(p => !Installed.Contains(p.Id)).ToList());
    public Task<InstallResult> InstallAsync(IReadOnlyList<PendingUpdate> u, CancellationToken ct)
    {
        Installed.AddRange(u.Select(x => x.Id));
        return Task.FromResult(new InstallResult([.. u.Select(x => new UpdateOutcome(x.Id, x.Title, ResultCode, ResultCode == 2 ? 0 : unchecked((int)0x80240022), false))], true));
    }
}

static class PU
{
    public static PendingUpdate Sw(string id, string title, string cat = "Updates", string? sev = null) => new(id, 1, title, "KB1", false, sev, 1000, true, [cat], null);
    public static PendingUpdate Drv(string id, string title = "Intel - Net - 23.110.0.5") => new(id, 1, title, null, true, null, 1000, false, ["Drivers"], new("Intel", "Wi-Fi 6", "Net", "23.110.0.5", "PCI\\VEN_8086&DEV_1", "2026-01-01"));
}

public class WingetParserTests
{
    public const string Real = @"Name                                                               Id                                     Version        Available     Source
---------------------------------------------------------------------------------------------------------------------------------------------
Antigravity 2.1.4                                                  Google.Antigravity                     2.1.4          2.18.1        winget
AnyDesk                                                            AnyDesk.AnyDesk                        ad 9.0.14      9.8.0         winget
App Installer                                                      Microsoft.AppInstaller                 1.29.290.0     1.29.380      winget
Docker Desktop                                                     Docker.DockerDesktop                   4.90.0         4.93.0        winget
3 upgrades available.
";
    [Fact]
    public void Parses_real_winget_output_into_id_current_and_available_versions()
    {
        var l = Winget.ParseUpgrades(Real);
        Assert.Equal(4, l.Count);
        Assert.Equal(new("AnyDesk", "AnyDesk.AnyDesk", "ad 9.0.14", "9.8.0"), l[1]);
        Assert.Equal("Docker.DockerDesktop", l[3].Id);
        Assert.DoesNotContain(l, x => x.Name.Contains("upgrades available"));
    }
    [Fact]
    public void Winget_is_run_from_its_own_folder_so_SYSTEM_can_start_it()
    {
        var (exe, args) = Winget.Command(@"C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe\winget.exe", "upgrade --accept-source-agreements");
        Assert.Equal("cmd.exe", exe); Assert.Equal("/d /c cd /d \"C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe\" && \"winget.exe\" upgrade --accept-source-agreements", args);
        Assert.Equal(("winget.exe", "list"), Winget.Command("winget.exe", "list"));
    }
    [Fact] public void Unrecognised_or_empty_output_gives_an_empty_list_not_garbage() { Assert.Empty(Winget.ParseUpgrades("")); Assert.Empty(Winget.ParseUpgrades("No installed package found matching input criteria.")); }
    [Fact]
    public void Finds_winget_in_the_newest_App_Installer_folder_for_SYSTEM_or_falls_back_to_the_user_alias()
    {
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WindowsApps");
        var a = Path.Combine(root, "Microsoft.DesktopAppInstaller_1.20.0.0_x64__8wekyb3d8bbwe"); var b = Path.Combine(root, "Microsoft.DesktopAppInstaller_1.29.0.0_x64__8wekyb3d8bbwe");
        Assert.Equal(Path.Combine(b, "winget.exe"), Winget.Find(p => p.StartsWith(root), _ => [a, b]));
        Assert.EndsWith(@"WindowsApps\winget.exe", Winget.Find(p => p.Contains(@"Microsoft\WindowsApps"), _ => []));
        Assert.Null(Winget.Find(_ => false, _ => []));
    }
}

public class SoftwareHandlerTests
{
    // winget "list --id X" exits 0 when installed, non-zero when not.
    sealed class W(bool installedAtStart, bool installWorks = true, string output = "Successfully installed")
    {
        public bool Installed = installedAtStart; public readonly List<string> Calls = [];
        public ProcResult Run(string exe, string a)
        {
            Calls.Add(a);
            if (a.StartsWith("list")) return new(Installed ? 0 : 1, "", false);
            if (a.StartsWith("install") || a.StartsWith("upgrade")) { if (installWorks) Installed = true; return new(installWorks ? 0 : 1, output, false); }
            if (a.StartsWith("uninstall")) { if (installWorks) Installed = false; return new(installWorks ? 0 : 1, "Successfully uninstalled", false); }
            return new(0, "", false);
        }
    }
    static Task<JobOutcome> Go(string type, string id, W w, bool haveWinget = true) =>
        new SoftwareActionHandler(type, new FakeProc(w.Run), () => haveWinget ? "winget.exe" : null).RunAsync(T.Job(type, JsonSerializer.Serialize(new { wingetId = id })), CancellationToken.None);

    [Fact] public async Task Install_is_verified_by_checking_the_package_is_really_there_afterwards()
    {
        var w = new W(false); var o = await Go("software.install", "Mozilla.Firefox", w);
        Assert.True(o.Success); Assert.Contains(w.Calls, c => c == "install --id Mozilla.Firefox --exact --silent --accept-source-agreements --disable-interactivity --accept-package-agreements");
    }
    [Fact] public async Task An_install_that_claims_success_but_leaves_nothing_is_a_failure()
    {
        var w = new W(false); w.Installed = false;
        var p = new FakeProc((_, a) => a.StartsWith("list") ? new ProcResult(1, "", false) : new ProcResult(0, "ok", false));
        var o = await new SoftwareActionHandler("software.install", p, () => "w").RunAsync(T.Job("software.install", "{\"wingetId\":\"X.Y\"}"), default);
        Assert.False(o.Success); Assert.Contains("not installed", o.Error);
    }
    [Fact] public async Task Uninstall_is_verified_the_same_way() { var w = new W(true); Assert.True((await Go("software.uninstall", "Adobe.Flash", w)).Success); Assert.False(w.Installed); }
    [Fact] public async Task Update_with_nothing_newer_is_success_not_failure()
    {
        var p = new FakeProc((_, a) => a.StartsWith("list") ? new ProcResult(0, "", false) : new ProcResult(unchecked((int)0x8A15002B), "No available upgrade found.", false));
        Assert.True((await new SoftwareActionHandler("software.update", p, () => "w").RunAsync(T.Job("software.update", "{\"wingetId\":\"A.B\"}"), default)).Success);
    }
    [Fact] public async Task Failures_are_reported_with_the_exit_code() { var o = await Go("software.install", "A.B", new W(false, installWorks: false)); Assert.False(o.Success); Assert.Contains("exit 1", o.Error); }
    [Theory] [InlineData("x; calc")] [InlineData("a b")] [InlineData("..\\evil")] [InlineData("-source")] [InlineData("")]
    public async Task Package_ids_that_could_smuggle_arguments_never_reach_winget(string id)
    {
        var w = new W(false); var o = await Go("software.install", id, w);
        Assert.False(o.Success); Assert.Empty(w.Calls);
    }
    [Fact] public async Task Missing_winget_is_reported_clearly() { var o = await Go("software.install", "A.B", new W(false), haveWinget: false); Assert.False(o.Success); Assert.Contains("not available", o.Error); }
    [Fact] public async Task Check_updates_returns_parsed_upgrades()
    {
        var o = await new SoftwareCheckUpdatesHandler(new FakeProc((_, _) => new ProcResult(0, WingetParserTests.Real, false)), () => "w").RunAsync(T.Job("software.check-updates", "{}"), default);
        Assert.True(o.Success); Assert.Contains("\"count\":4", JsonSerializer.Serialize(o.Result));
    }
}

public class UpdateHandlerTests
{
    static Task<JobOutcome> Install(FakeWu wu, string json) => new UpdatesInstallHandler(wu).RunAsync(T.Job("updates.install", json), default);
    static readonly PendingUpdate[] Mix = [PU.Sw("s1", "Security update KB1", "Security Updates"), PU.Sw("c1", "Critical", "Critical Updates"), PU.Sw("o1", "Optional preview", "Updates"), PU.Drv("d1")];

    [Fact] public async Task Security_scope_installs_only_security_and_critical_and_never_drivers()
    {
        var wu = new FakeWu(Mix); var o = await Install(wu, "{\"scope\":\"security\"}");
        Assert.True(o.Success); Assert.Equal(["s1", "c1"], wu.Installed);
    }
    [Fact] public async Task All_scope_installs_every_non_driver_update_but_still_no_drivers()
    {
        var wu = new FakeWu(Mix); await Install(wu, "{\"scope\":\"all\"}");
        Assert.Equal(["s1", "c1", "o1"], wu.Installed); Assert.DoesNotContain("d1", wu.Installed);
    }
    [Fact] public async Task Explicit_ids_must_all_be_pending_non_driver_updates()
    {
        var wu = new FakeWu(Mix);
        var bad = await Install(wu, "{\"scope\":\"all\",\"updateIds\":[\"s1\",\"d1\"]}");
        Assert.False(bad.Success); Assert.Empty(wu.Installed);
        Assert.True((await Install(wu, "{\"scope\":\"all\",\"updateIds\":[\"o1\"]}")).Success);
    }
    [Fact] public async Task Nothing_pending_is_a_successful_no_op() { var o = await Install(new FakeWu(), "{\"scope\":\"security\"}"); Assert.True(o.Success); Assert.Contains("nothing to install", JsonSerializer.Serialize(o.Result)); }
    [Fact] public async Task Failed_updates_fail_the_job_and_say_which()
    {
        var wu = new FakeWu(Mix) { ResultCode = 4 }; var o = await Install(wu, "{\"scope\":\"security\"}");
        Assert.False(o.Success); Assert.Contains("Security update KB1", o.Error); Assert.Contains("0x80240022", o.Error);
    }
    [Fact] public async Task Scan_reports_drivers_separately_from_security_and_other_updates()
    {
        var o = await new UpdatesScanHandler(new FakeWu(Mix)).RunAsync(T.Job("updates.scan", "{}"), default);
        var j = JsonSerializer.SerializeToElement(o.Result, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(3, j.GetProperty("pendingCount").GetInt32()); Assert.Equal(2, j.GetProperty("securityCount").GetInt32()); Assert.Equal(1, j.GetProperty("driverCount").GetInt32());
        Assert.Equal("Intel", j.GetProperty("drivers")[0].GetProperty("driver").GetProperty("manufacturer").GetString());
    }
    [Fact] public async Task Driver_install_touches_only_driver_packages_and_records_what_it_replaced()
    {
        var wu = new FakeWu(Mix); var n = 0;
        var h = new DriverInstallHandler(wu, _ => [new { infName = n++ == 0 ? "oem5.inf" : "oem9.inf", version = "1" }], new FakeProc());
        var o = await h.RunAsync(T.Job("driver.install", "{\"updateIds\":[\"d1\"]}"), default);
        Assert.True(o.Success); Assert.Equal(["d1"], wu.Installed);
        var s = JsonSerializer.Serialize(o.Result); Assert.Contains("oem5.inf", s); Assert.Contains("oem9.inf", s);   // before and after
        Assert.False((await new DriverInstallHandler(new FakeWu(Mix), null, new FakeProc()).RunAsync(T.Job("driver.install", "{\"updateIds\":[\"s1\"]}"), default)).Success);
    }
    static string Store(params string[] infs) => "Microsoft PnP Utility\r\n<?xml version=\"1.0\" encoding=\"utf-8\"?><PnpUtil>" + string.Concat(infs.Select(i => $"<Driver DriverName=\"{i}\"><OriginalName>x.inf</OriginalName></Driver>")) + "</PnpUtil>";
    [Fact] public async Task Driver_install_records_the_packages_it_added_to_the_driver_store_even_for_hardware_that_is_not_attached()
    {
        var calls = 0; var proc = new FakeProc((_, _) => new ProcResult(0, calls++ == 0 ? Store("oem1.inf", "oem2.inf") : Store("oem1.inf", "oem2.inf", "oem77.inf"), false));
        var o = await new DriverInstallHandler(new FakeWu(Mix), _ => [], proc).RunAsync(T.Job("driver.install", "{\"updateIds\":[\"d1\"]}"), default);
        var j = JsonSerializer.SerializeToElement(o.Result, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.True(o.Success); Assert.Equal(1, j.GetProperty("packagesAdded").GetArrayLength()); Assert.Equal("oem77.inf", j.GetProperty("packagesAdded")[0].GetString()); Assert.True(j.GetProperty("storeKnown").GetBoolean());
        Assert.Equal(["/enum-drivers /format xml"], proc.Calls.Select(c => c.Replace("pnputil.exe ", "")).Distinct().ToArray());
        Assert.Empty(PatchFacts.ParseDriverStore("garbage")); Assert.Empty(PatchFacts.ParseDriverStore("<?xml version=\"1.0\"?><PnpUtil><Driver"));
        Assert.Equal(["oem5.inf"], PatchFacts.ParseDriverStore(Store("OEM5.inf", "accelerometer.inf")));   // only third-party oemNN.inf names, lower-cased
    }
    [Theory] [InlineData("oem12.inf", true)] [InlineData("OEM3.INF", true)] [InlineData("..\\..\\x.inf", false)] [InlineData("oem1.inf & calc", false)] [InlineData("C:\\a.inf", false)] [InlineData("nvidia.inf", false)]
    public async Task Driver_rollback_only_accepts_third_party_driver_package_names(string inf, bool allowed)
    {
        var p = new FakeProc(); var o = await new DriverRollbackHandler(p).RunAsync(T.Job("driver.rollback", JsonSerializer.Serialize(new { infName = inf })), default);
        Assert.Equal(allowed, o.Success); Assert.Equal(allowed ? 1 : 0, p.Calls.Count);
        if (allowed) Assert.Equal($"pnputil.exe /delete-driver {inf} /uninstall /force", p.Calls[0]);
    }
    [Fact] public async Task Driver_rollback_reports_reboot_needed_and_failures()
    {
        Assert.Contains("\"rebootRequired\":true", JsonSerializer.Serialize((await new DriverRollbackHandler(new FakeProc((_, _) => new ProcResult(3010, "ok", false))).RunAsync(T.Job("driver.rollback", "{\"infName\":\"oem1.inf\"}"), default)).Result));
        Assert.False((await new DriverRollbackHandler(new FakeProc((_, _) => new ProcResult(5, "denied", false))).RunAsync(T.Job("driver.rollback", "{\"infName\":\"oem1.inf\"}"), default)).Success);
    }
}

public class SystemActionTests
{
    sealed class Notifier(int sessions) : IUserNotifier { public string? Text; public int Secs; public int Notify(string t, string x, int s) { Text = x; Secs = s; return sessions; } }

    [Fact] public async Task Messages_are_delivered_visibly_and_allowlisted()
    {
        var n = new Notifier(2); var o = await new MessageSendHandler(n).RunAsync(T.Job("message.send", "{\"text\":\"Please save your work: restart at 18:00.\",\"seconds\":90}"), default);
        Assert.True(o.Success); Assert.Equal(90, n.Secs); Assert.StartsWith("Please save", n.Text);
        foreach (var bad in new[] { "x\\\" & calc", "<script>", "a`b", "" })
            Assert.False((await new MessageSendHandler(new Notifier(1)).RunAsync(T.Job("message.send", JsonSerializer.Serialize(new { text = bad })), default)).Success, bad);
        Assert.Contains("no user", (await new MessageSendHandler(new Notifier(0)).RunAsync(T.Job("message.send", "{\"text\":\"hello\"}"), default)).Error);
    }
    [Fact] public async Task Reboot_always_has_a_visible_countdown_and_a_safe_message()
    {
        var p = new FakeProc(); await new RebootHandler(p).RunAsync(T.Job("system.reboot", "{\"delaySeconds\":1}"), default);
        Assert.StartsWith("shutdown.exe /r /t 30 /c \"", p.Calls[0]);                  // clamped to a minimum of 30 s
        var p2 = new FakeProc(); await new RebootHandler(p2).RunAsync(T.Job("system.reboot", "{\"delaySeconds\":999999}"), default);
        Assert.Contains("/t 3600", p2.Calls[0]);
        var p3 = new FakeProc(); Assert.False((await new RebootHandler(p3).RunAsync(T.Job("system.reboot", "{\"message\":\"x\\\" /f /t 0 \\\"\"}"), default)).Success); Assert.Empty(p3.Calls);
        Assert.DoesNotContain("/f", p.Calls[0]);                                        // never force-closes users' apps
        Assert.Contains("already scheduled", (await new RebootHandler(new FakeProc((_, _) => new ProcResult(1190, "", false))).RunAsync(T.Job("system.reboot", "{}"), default)).Error);
    }
    [Fact] public async Task Reboot_can_be_cancelled()
    {
        var p = new FakeProc(); Assert.True((await new RebootCancelHandler(p).RunAsync(T.Job("system.reboot-cancel", "{}"), default)).Success); Assert.Equal("shutdown.exe /a", p.Calls[0]);
        Assert.Contains("no restart", (await new RebootCancelHandler(new FakeProc((_, _) => new ProcResult(1116, "", false))).RunAsync(T.Job("system.reboot-cancel", "{}"), default)).Error);
    }
}
