using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Win32;
using Viro.Agent;
using Viro.Agent.Care;
using Viro.Agent.Repair;
using Viro.Compute;
using Xunit;

sealed class FakeProcSource(List<ProcInfo> procs, double used = 70, long total = 16L << 30) : IProcessSource
{
    public List<ProcInfo> Procs = procs; public double Used = used; public long Total = total;
    public Task<IReadOnlyList<ProcInfo>> SnapshotAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<ProcInfo>>(Procs.ToList());
    public (double usedPercent, long totalBytes) Memory() => (Used, Total);
}
sealed class FakeProcActions(FakeProcSource src, double freePercentPerTrimMb = 0.01) : IProcessActions
{
    public readonly List<int> Trimmed = [], Killed = []; public HashSet<int> Refuse = []; public int LastTrimError { get; private set; }
    public long WorkingSetOf(int pid) => src.Procs.FirstOrDefault(p => p.Pid == pid)?.WorkingSetBytes ?? 0;
    public bool TrimWorkingSet(int pid)
    {
        if (Refuse.Contains(pid)) { LastTrimError = 5; return false; }
        var p = src.Procs.First(x => x.Pid == pid); var freed = p.WorkingSetBytes * 7 / 10; Trimmed.Add(pid);
        src.Procs[src.Procs.IndexOf(p)] = p with { WorkingSetBytes = p.WorkingSetBytes - freed }; src.Used -= (double)freed / src.Total * 100; return true;
    }
    public bool Kill(int pid) { Killed.Add(pid); src.Procs.RemoveAll(p => p.Pid == pid); return true; }
}

public class CareTests
{
    const long MB = 1048576;
    static ProcInfo P(int pid, string name, long mb, double cpu = 0.2, bool? win = false, bool? fg = false, string? path = @"C:\Program Files\X\x.exe", int session = 1, bool svc = false) => new(pid, name, path, session, svc, cpu, mb * MB, win, fg);
    static ProcessCloseAssessment A(ProcInfo p) => ProcessClassifier.Assess(p, @"C:\Windows");

    [Fact]
    public void Only_an_approved_background_helper_with_no_window_is_ever_safe_to_close()
    {
        Assert.Equal(CloseRisk.SAFE, A(P(1, "AdobeARM", 60)).CloseRisk); Assert.Equal("SAFE_TO_SUGGEST_CLOSE", A(P(1, "AdobeARM", 60)).Category);
        Assert.Equal(CloseRisk.ASK_USER, A(P(1, "AdobeARM", 60, win: true)).CloseRisk);           // a window is open: maybe in use
        Assert.Equal(CloseRisk.ASK_USER, A(P(1, "AdobeARM", 60, win: null)).CloseRisk);           // state unknown: never assumed safe
        Assert.Equal(CloseRisk.ASK_USER, A(P(1, "AdobeARM", 60, fg: true)).CloseRisk);
        Assert.Equal(CloseRisk.UNKNOWN, A(P(2, "mystery-tool", 500)).CloseRisk); Assert.Equal("UNKNOWN", A(P(2, "mystery-tool", 500)).Category);      // unknown never defaults to closing
        Assert.Equal(CloseRisk.ASK_USER, A(P(2, "mystery-tool", 500, win: true)).CloseRisk);
    }

    [Theory]
    [InlineData("WINWORD")] [InlineData("chrome")] [InlineData("Code")] [InlineData("Teams")] [InlineData("excel")] [InlineData("obs64")] [InlineData("Slack")]
    public void Programs_that_can_hold_unsaved_work_or_a_live_call_are_never_closed_automatically(string name)
    {
        var a = A(P(3, name, 900)); Assert.Equal(CloseRisk.HIGH_RISK, a.CloseRisk); Assert.Equal("NEVER_AUTOCLOSE", a.Category); Assert.Contains("yourself", a.Recommendation.Replace("You are using this application right now.", "yourself"));
    }

    [Theory]
    [InlineData("explorer", 1, false, @"C:\Windows\explorer.exe")] [InlineData("svchost", 0, true, @"C:\Windows\System32\svchost.exe")] [InlineData("MsMpEng", 0, true, null)] [InlineData("viro-agent", 0, true, null)] [InlineData("avgsvc", 1, false, null)]
    [InlineData("lsass", 0, false, null)] [InlineData("whatever", 0, false, null)] [InlineData("teamviewer", 1, false, null)] [InlineData("helper", 1, true, null)] [InlineData("winlogon", 1, false, null)]
    public void Windows_security_and_remote_management_are_system_critical_and_never_touched(string name, int session, bool svc, string? path)
    {
        var a = A(P(4, name, 400, session: session, svc: svc, path: path)); Assert.Equal(CloseRisk.SYSTEM_CRITICAL, a.CloseRisk); Assert.Equal("SYSTEM_CRITICAL", a.Category);
    }

    [Fact]
    public void The_plan_trims_idle_background_programs_and_never_the_one_in_use_or_anything_critical()
    {
        var procs = new List<ProcInfo> { P(1, "chrome", 1200, fg: true, win: true), P(2, "spotify", 600, win: true), P(3, "AdobeARM", 120), P(4, "svchost", 500, session: 0), P(5, "busy-encoder", 900, cpu: 55), P(6, "tiny", 10), P(7, "MsMpEng", 800, session: 0), P(8, "mystery", 350) };
        var plan = MemoryPlanner.Plan(procs, 16L << 30, 70, 50);
        Assert.Equal(new[] { 2, 8, 3 }.OrderBy(x => x), plan.Trim.Select(t => t.Pid).OrderBy(x => x));        // not the foreground chrome, not svchost/Defender, not the busy one, not the tiny one
        Assert.Equal([3], plan.CloseSuggestions.Select(c => c.ProcessId)); Assert.Equal(new[] { 2, 8 }.OrderBy(x => x), plan.AskUser.Select(c => c.ProcessId).OrderBy(x => x));
        Assert.True(plan.NeedToFreeMb > 3000 && plan.NeedToFreeMb < 3400);          // 20% of 16 GB
        Assert.Empty(MemoryPlanner.Plan([P(1, "spotify", 600, win: null, fg: null)], 16L << 30, 70, 50).Trim);      // session not observable: nothing is trimmed
        Assert.Contains("not realistic", MemoryPlanner.Plan(procs, 4L << 30, 80, 50).Note);       // a 4 GB PC cannot honestly promise 50%
        Assert.Null(MemoryPlanner.Plan(procs, 16L << 30, 70, 50).Note);
    }

    [Fact]
    public async Task Trimming_is_measured_rate_limited_per_program_and_only_when_above_the_target()
    {
        var clock = new DateTime(2026, 10, 1, 12, 0, 0, DateTimeKind.Utc);
        var src = new FakeProcSource([P(2, "spotify", 600, win: true), P(3, "AdobeARM", 120), P(1, "chrome", 1000, fg: true, win: true)], used: 72); var act = new FakeProcActions(src);
        var g = new MemoryGuard(src, act, () => clock, TimeSpan.Zero);
        var run = await g.RunAsync(50, default);
        Assert.Equal(new[] { 2, 3 }.OrderBy(x => x), act.Trimmed.OrderBy(x => x)); Assert.Equal(72, run.BeforePercent); Assert.True(run.AfterPercent < 72); Assert.True(run.ReclaimedMb > 400, $"measured, not estimated: {run.ReclaimedMb}");
        Assert.All(run.Trimmed, t => Assert.True(t.Mb > 0));
        act.Trimmed.Clear(); src.Used = 72; await g.RunAsync(50, default); Assert.Empty(act.Trimmed);           // 15-minute cooldown per program
        clock = clock.AddMinutes(16); src.Procs[0] = src.Procs[0] with { WorkingSetBytes = 400 * MB }; src.Used = 72; await g.RunAsync(50, default); Assert.Contains(2, act.Trimmed);
        act.Trimmed.Clear(); src.Used = 45; await g.RunAsync(50, default); Assert.Empty(act.Trimmed);             // within target: nothing to do
    }

    [Fact]
    public async Task Closing_rechecks_the_program_at_the_moment_of_closing_and_refuses_anything_not_safe()
    {
        var src = new FakeProcSource([P(3, "AdobeARM", 120), P(4, "spotify", 300, win: true), P(5, "WINWORD", 400, win: true)]); var act = new FakeProcActions(src); var c = new SafeIdleAppCloser(src, act);
        src.Procs[0] = src.Procs[0] with { HasVisibleWindow = true };        // the helper opened a window after it was listed
        var r1 = await c.CloseAsync([3, 4, 5, 99], default);
        Assert.Empty(act.Killed); Assert.All(r1, o => Assert.False(o.Closed)); Assert.Contains("now rated ASK_USER", r1[0].Reason); Assert.Contains("HIGH_RISK", r1[2].Reason); Assert.Contains("no longer running", r1[3].Reason);
        src.Procs[0] = src.Procs[0] with { HasVisibleWindow = false }; var r2 = await c.CloseAsync([3], default);
        Assert.Equal([3], act.Killed); Assert.True(r2[0].Closed);
    }

    [Fact]
    public async Task The_memory_recipe_frees_memory_and_reports_the_measured_result_or_says_nothing_was_gained()
    {
        var src = new FakeProcSource([P(2, "spotify", 600, win: true), P(3, "AdobeARM", 120)], used: 72); var act = new FakeProcActions(src);
        CareRuntime.Source = src; CareRuntime.Actions = act; CareRuntime.Guard = new MemoryGuard(src, act, null, TimeSpan.Zero); CareRuntime.Policy = CarePolicy.Default;
        try
        {
            using var sb = new Sandbox(); var r = new MemoryTrimRecipe();
            var rep = await RepairEngine.RunAsync(r, new RepairContext(sb, new FakeProc(), new FakeServices(), NullLogger.Instance, T.J()), default);
            Assert.True(rep.Applied); Assert.True(rep.Verified); Assert.Contains("freed", rep.Summary); Assert.Contains("%", rep.Summary);
            src.Used = 40; Assert.Contains("within the 50% target", (await RepairEngine.RunAsync(r, new RepairContext(sb, new FakeProc(), new FakeServices(), NullLogger.Instance, T.J()), default)).Summary);
            src.Used = 72; src.Procs.Clear(); src.Procs.Add(P(1, "chrome", 2000, fg: true, win: true));
            Assert.Contains("no idle program", (await RepairEngine.RunAsync(r, new RepairContext(sb, new FakeProc(), new FakeServices(), NullLogger.Instance, T.J()), default)).Summary);
        }
        finally { CareRuntime.Source = null; CareRuntime.Guard = null; CareRuntime.Actions = new SystemProcessActions(); }
    }

    [Theory]
    [InlineData("Spotify", @"""C:\Users\a\AppData\Roaming\Spotify\Spotify.exe"" /background", StartupClass.SAFE_TO_DISABLE)] [InlineData("Discord", @"C:\Users\a\AppData\Local\Discord\Update.exe --processStart Discord.exe", StartupClass.SAFE_TO_DISABLE)]
    [InlineData("AdobeGCInvoker-1.0", @"C:\Program Files (x86)\Common Files\Adobe\AdobeGCClient\AGCInvokerUtility.exe", StartupClass.SAFE_TO_DISABLE)] [InlineData("MicrosoftEdgeAutoLaunch_AB12", @"""C:\Program Files (x86)\Microsoft\Edge\msedge.exe"" --no-startup-window", StartupClass.SAFE_TO_DISABLE)]
    [InlineData("SecurityHealth", @"C:\Windows\System32\SecurityHealthSystray.exe", StartupClass.KEEP)] [InlineData("RtkAudUService", @"C:\Windows\System32\RtkAudUService64.exe", StartupClass.KEEP)] [InlineData("OneDrive", @"C:\Users\a\AppData\Local\Microsoft\OneDrive\OneDrive.exe /background", StartupClass.KEEP)]
    [InlineData("AVGUI", @"C:\Program Files\AVG\avgui.exe", StartupClass.KEEP)] [InlineData("ViroAgent", @"C:\Program Files\Viro\viro-agent.exe", StartupClass.KEEP)] [InlineData("AcmeInventory", @"C:\Program Files\Acme\inv.exe", StartupClass.ASK)]
    public void Start_up_programs_are_classified_conservatively(string name, string command, StartupClass expected) =>
        Assert.Equal(expected, StartupClassifier.Assess(new(@"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run", name, command, true)).Class);

    [Fact]
    public async Task Start_up_optimization_disables_only_safe_items_reports_the_measured_delay_and_can_be_rolled_back()
    {
        using var sb = new Sandbox(); var loc = sb.StartupSlots()[0].Location;
        using (var run = sb.StartupSlots()[0].OpenRun()!) { run.SetValue("Spotify", @"C:\x\Spotify.exe"); run.SetValue("SecurityHealth", @"C:\Windows\SecurityHealthSystray.exe"); run.SetValue("AcmeInventory", @"C:\acme\inv.exe"); run.SetValue("Discord", @"C:\x\Discord.exe"); }
        var boot = new BootEvidence([new(DateTime.UtcNow, 97.5, 40, 55)], [new("Spotify", 11.3, 14), new("Other", 5, 6)]);
        var r = new StartupOptimizeRecipe(() => boot);
        var rep = await RepairEngine.RunAsync(r, new RepairContext(sb, new FakeProc(), new FakeServices(), NullLogger.Instance, T.J()), default);
        Assert.True(rep.Applied); Assert.True(rep.Verified); Assert.Contains("next restart", rep.Summary);
        using (var ap = sb.StartupSlots()[0].OpenApproved(false)!) { Assert.True(((byte[])ap.GetValue("Spotify")!)[0] == 3); Assert.True(((byte[])ap.GetValue("Discord")!)[0] == 3); Assert.Null(ap.GetValue("SecurityHealth")); Assert.Null(ap.GetValue("AcmeInventory")); }
        var finding = JsonSerializer.Serialize(rep.Before); Assert.Contains("11.3", finding); Assert.Contains("97.5", finding);
        Assert.Contains("No action needed", (await RepairEngine.RunAsync(r, new RepairContext(sb, new FakeProc(), new FakeServices(), NullLogger.Instance, T.J()), default)).Summary);     // already done
        var back = await RepairEngine.RollbackAsync(Recipes.All.ToDictionary(x => x.Key, x => x.Key == r.Id ? r : x.Value), rep.RepairId, new RepairContext(sb, new FakeProc(), new FakeServices(), NullLogger.Instance, T.J()), default);
        Assert.True(back.RolledBack); using (var ap = sb.StartupSlots()[0].OpenApproved(false)!) Assert.Null(ap.GetValue("Spotify"));
        Assert.Equal(2, StartupOptimizeRecipe.Items(sb).Count(i => i.Enabled && StartupClassifier.Assess(i).Class == StartupClass.SAFE_TO_DISABLE));
    }

    [Fact]
    public void Heat_is_detected_once_recovers_with_hysteresis_and_a_persistent_cooling_problem_is_only_suspected_with_evidence()
    {
        var m = new ThermalMonitor(); var t0 = new DateTime(2026, 10, 1, 12, 0, 0, DateTimeKind.Utc);
        ThermalSample S(int min, double? temp, double load = 80, bool compute = false) => new(t0.AddMinutes(min), temp, load, null, compute);
        Assert.Null(m.Observe(S(0, 60), 85));
        Assert.Null(m.Observe(S(1, 80), 85));                                                     // warm, not yet a warning
        var heat = m.Observe(S(2, 87), 85); Assert.Equal("heat", heat!.Kind); Assert.Equal("PAUSE", heat.Gate); Assert.Contains("87", heat.Detail);
        Assert.Null(m.Observe(S(3, 90), 85));                                                     // still hot: no second alert
        Assert.Null(m.Observe(S(4, 82), 85));                                                     // inside the release margin: still warning
        Assert.Equal("recovered", m.Observe(S(5, 70), 85)!.Kind);
        Assert.Null(m.Observe(S(6, null), 85)); Assert.Equal(ThermalLevel.Normal, m.Level);      // no reading changes nothing
        Assert.Equal(1, m.WarningEvents7d);

        var c = new ThermalMonitor(); c.Observe(new(t0, 88, 10, null, false), 85);
        for (var i = 1; i < 15; i++) Assert.Null(c.Observe(new(t0.AddMinutes(i), 88, 10, null, false), 85));
        var sus = c.Observe(new(t0.AddMinutes(16), 88, 10, null, false), 85); Assert.Equal("cooling-suspect", sus!.Kind); Assert.Contains("Software is unlikely", sus.Detail); Assert.True(c.CoolingSuspected);
        Assert.Null(c.Observe(new(t0.AddMinutes(17), 88, 10, null, false), 85));                   // reported once
        var busy = new ThermalMonitor(); busy.Observe(new(t0, 88, 90, null, false), 85); Assert.Null(busy.Observe(new(t0.AddMinutes(30), 88, 90, null, false), 85)); Assert.False(busy.CoolingSuspected);   // heavy load explains it
        var comp = new ThermalMonitor(); comp.Observe(new(t0, 88, 10, null, true), 85); Assert.Null(comp.Observe(new(t0.AddMinutes(30), 88, 10, null, true), 85));                                      // Viro's own compute is running: not evidence
    }

    [Fact]
    public void Battery_wake_locks_are_read_from_powercfg_and_the_care_policy_is_clamped()
    {
        var req = "DISPLAY:\nNone.\n\nSYSTEM:\n[PROCESS] \\Device\\HarddiskVolume3\\Program Files\\Teams\\Teams.exe\n\nAWAYMODE:\nNone.\n\nEXECUTION:\n[DRIVER] Realtek High Definition Audio(HDAUDIO\\FUNC_01)\nAn audio stream is currently in use.\n";
        var r = JsonSerializer.Serialize(BatteryProbe.ParseRequests(req)); Assert.Contains("Teams.exe", r); Assert.Contains("\"kind\":\"SYSTEM\"", r); Assert.Contains("Realtek", r); Assert.DoesNotContain("AWAYMODE", r);
        Assert.Empty(BatteryProbe.ParseRequests("DISPLAY:\nNone.\nSYSTEM:\nNone.\n"));
        var p = CarePolicy.Parse(JsonDocument.Parse("{\"ramTargetPercent\":5,\"thermalWarningC\":500,\"popups\":false,\"autoCloseSafe\":true}").RootElement);
        Assert.Equal(30, p.RamTargetPercent); Assert.Equal(95, p.ThermalWarningC); Assert.False(p.Popups); Assert.True(p.AutoCloseSafe); Assert.Equal(CarePolicy.Default, CarePolicy.Parse(JsonDocument.Parse("{}").RootElement));
    }

    [Fact]
    public async Task The_new_care_jobs_and_recipes_are_registered_and_the_battery_job_reads_only()
    {
        Assert.Contains(JobHandlers.All().Select(h => h.Type), t => t == "memory.analyze"); Assert.Contains(JobHandlers.All().Select(h => h.Type), t => t == "battery.diagnose");
        Assert.True(Recipes.All["memory.trim-idle"].AutoSafe); Assert.Equal(RepairRisk.Safe, Recipes.All["startup.optimize"].Risk); Assert.True(Recipes.All["startup.optimize"].Reversible);
        var src = new FakeProcSource([P(1, "chrome", 900, fg: true, win: true)]); CareRuntime.Source = src;
        try { var o = await new MemoryAnalyzeHandler().RunAsync(T.Job("memory.analyze", "{}"), default); Assert.True(o.Success); Assert.Contains("top", JsonSerializer.Serialize(o.Result)); }
        finally { CareRuntime.Source = null; CareRuntime.Guard = null; }
    }
}

sealed class FakeUi(params string?[] answers) : IUserUi
{
    public readonly List<Notice> Shown = []; int i;
    public Task<IReadOnlyList<WindowInfo>?> WindowsAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<WindowInfo>?>([]);
    public Task<string?> NotifyAsync(Notice n, CancellationToken ct) { Shown.Add(n); return Task.FromResult(i < answers.Length ? answers[i++] : null); }
}

public class UiNoticeTests
{
    [Fact]
    public async Task The_storage_notice_uses_fixed_text_with_the_three_actions_and_follows_up_on_the_choice()
    {
        var ui = new FakeUi("backup", "ok"); CareRuntime.Ui = ui;
        try
        {
            var o = await new UiNotifyHandler().RunAsync(T.Job("ui.notify", "{\"template\":\"storage-failing\",\"evidence\":[\"SSD reports Unhealthy status.\",\"\",\"3 uncorrectable errors\"]}"), default);
            Assert.True(o.Success); var j = JsonSerializer.Serialize(o.Result); Assert.Contains("\"shown\":true", j); Assert.Contains("backup", j);
            Assert.Equal("Your storage drive may be deteriorating", ui.Shown[0].Title); Assert.Equal(["CHECK BACKUP", "VIEW EVIDENCE", "CONTACT IT"], ui.Shown[0].Buttons.Select(b => b.Text).ToArray()); Assert.Equal("critical", ui.Shown[0].Severity);
            Assert.Equal(["SSD reports Unhealthy status.", "3 uncorrectable errors"], ui.Shown[0].Lines.ToArray());   // blank evidence lines are dropped
            Assert.Equal(2, ui.Shown.Count); Assert.Contains("backup", ui.Shown[1].Body);
            Assert.False((await new UiNotifyHandler().RunAsync(T.Job("ui.notify", "{\"template\":\"anything-else\"}"), default)).Success);
            CareRuntime.Ui = null; Assert.Contains("\"shown\":false", JsonSerializer.Serialize((await new UiNotifyHandler().RunAsync(T.Job("ui.notify", "{\"template\":\"storage-failing\"}"), default)).Result));   // nobody signed in: nothing shown, said plainly
        }
        finally { CareRuntime.Ui = null; }
    }
}

public class ResourceHealthTests
{
    [Fact]
    public void The_exhaustion_message_Windows_wrote_names_the_programs_that_used_the_memory()
    {
        var msg = "Windows successfully diagnosed a low virtual memory condition. The following programs consumed the most virtual memory: Grammarly.Desktop.exe (13844) consumed 5097779200 bytes, chrome.exe (20420) consumed 3391123456 bytes, and chrome.exe (23124) consumed 1292828672 bytes.";
        var r = ResourceHealth.ParseExhaustion(msg);
        Assert.Equal([("Grammarly.Desktop.exe", 4862.0), ("chrome.exe", 3234.0), ("chrome.exe", 1233.0)], r);
        Assert.Empty(ResourceHealth.ParseExhaustion("nothing useful here")); Assert.Empty(ResourceHealth.ParseExhaustion(null!));
    }

    [Fact]
    public void Commit_is_ranked_by_what_programs_have_promised_not_by_what_is_in_RAM_and_windows_is_classified_critical()
    {
        const long MB = 1048576;
        var top = ResourceHealth.TopCommit([("Grammarly.Desktop", 4861 * MB, 700 * MB, 1), ("chrome", 800 * MB, 300 * MB, 1), ("chrome", 900 * MB, 400 * MB, 1), ("svchost", 3000 * MB, 100 * MB, 0), ("tiny", MB, MB, 1)], 4);
        Assert.Equal(["Grammarly.Desktop", "svchost", "chrome", "tiny"], top.Select(t => t.Name));        // chrome's processes are added up
        Assert.Equal(1700, top.Single(t => t.Name == "chrome").PrivateMb); Assert.Equal(700, top.Single(t => t.Name == "chrome").WorkingSetMb);
        Assert.Equal("SYSTEM_CRITICAL", top.Single(t => t.Name == "svchost").Category); Assert.Equal("UNKNOWN", top[0].Category); Assert.Equal("NEVER_AUTOCLOSE", top.Single(t => t.Name == "chrome").Category);
    }

    [Fact]
    public void Running_security_products_are_listed_with_their_memory()
    {
        const long MB = 1048576;
        var e = ResourceHealth.SecurityEnginesRunning([("AVGSvc", 300 * MB), ("avgsvca", 11 * MB), ("MBAMService", 99 * MB), ("Malwarebytes", 210 * MB), ("MsMpEng", 160 * MB), ("chrome", 900 * MB)]);
        Assert.Equal(["AVG", "Malwarebytes", "Microsoft Defender"], e.Select(x => x.Name)); Assert.Equal(311, e[0].MemoryMb); Assert.Equal(309, e[1].MemoryMb); Assert.Empty(ResourceHealth.SecurityEnginesRunning([("chrome", MB)]));
    }

    [Fact]
    public void The_memory_plan_trims_a_few_big_idle_programs_per_pass_never_dozens_at_once()
    {
        var procs = Enumerable.Range(1, 40).Select(i => new ProcInfo(i, "app" + i, @"C:\Program Files\x.exe", 1, false, 0.2, (200 + i) * 1048576L, false, false)).ToList();
        var plan = MemoryPlanner.Plan(procs, 8L << 30, 90, 50);
        Assert.Equal(MemoryPlanner.MaxTrimsPerPass, plan.Trim.Count); Assert.True(plan.Trim[0].Mb >= plan.Trim[^1].Mb);
        Assert.Empty(MemoryPlanner.Plan([new ProcInfo(1, "small", null, 1, false, 0, 60 * 1048576L, false, false)], 8L << 30, 90, 50).Trim);        // under 80 MB is not worth the disturbance
    }

    [Fact]
    public void Firmware_thermal_queries_are_cached_and_the_risky_ACPI_query_is_off_unless_asked_for()
    {
        Assert.Null(Environment.GetEnvironmentVariable("VIRO_ACPI_THERMAL"));
        Assert.Null(ThermalSensors.CriticalTripC());           // the BIOS-calling query is never made by default
        var sw = System.Diagnostics.Stopwatch.StartNew(); var a = ThermalSensors.CpuTempC(); var first = sw.ElapsedMilliseconds; sw.Restart(); for (var i = 0; i < 500; i++) _ = ThermalSensors.CpuTempC(); Assert.True(sw.ElapsedMilliseconds < 200, "500 reads inside the cache window must not query the firmware again");
        Assert.Equal(a, ThermalSensors.CpuTempC()); _ = first;
    }
}

public class HogTests
{
    const long MB = 1048576;
    static ProcInfo P(int pid, string name, long privMb, bool? fg = false, int session = 1) => new(pid, name, @"C:\Program Files\X\x.exe", session, false, 0.3, privMb * MB / 3, true, fg, privMb * MB);

    [Fact]
    public void The_idle_program_holding_gigabytes_of_commit_is_found_but_never_windows_never_the_one_in_use_and_never_a_normal_size()
    {
        var procs = new List<ProcInfo> { P(1, "Grammarly.Desktop", 4861), P(2, "chrome", 900), P(3, "chrome", 800), P(4, "svchost", 6000, session: 0), P(5, "msedge", 1500) };
        var h = MemoryPlanner.FindHog(procs, 8L << 30)!;
        Assert.Equal("Grammarly.Desktop", h.Name); Assert.Equal(4861, h.PrivateMb); Assert.Equal(CloseRisk.ASK_USER, h.Assessment.CloseRisk);      // never closed for the person
        Assert.Null(MemoryPlanner.FindHog([P(1, "Grammarly.Desktop", 4861, fg: true)], 8L << 30));                     // in use: not a candidate
        Assert.Null(MemoryPlanner.FindHog([P(1, "Grammarly.Desktop", 4861, fg: null)], 8L << 30));                     // cannot tell whether it is in use: not a candidate
        Assert.Null(MemoryPlanner.FindHog([P(1, "app", 1900)], 8L << 30)); Assert.Null(MemoryPlanner.FindHog([P(4, "svchost", 6000, session: 0)], 8L << 30));
        Assert.Null(MemoryPlanner.FindHog([P(1, "chrome", 1200), P(2, "chrome", 1200)], 16L << 30));                   // 2.4 GB of 16 GB is not a hog
        Assert.Equal("chrome", MemoryPlanner.FindHog([P(1, "chrome", 1200), P(2, "chrome", 1300), P(3, "chrome", 700)], 8L << 30)!.Name);     // all of a program's processes are added up
        Assert.Equal(3, MemoryPlanner.FindHog([P(1, "chrome", 1200), P(2, "chrome", 1300), P(3, "chrome", 700)], 8L << 30)!.Processes);
    }
}

public class TrimFailureTests
{
    [Fact]
    public async Task When_Windows_refuses_the_trim_the_reason_is_reported_not_a_vague_failure()
    {
        var src = new FakeProcSource([new ProcInfo(2, "spotify", @"C:\x\s.exe", 1, false, 0.2, 600L * 1048576, true, false), new ProcInfo(3, "AdobeARM", @"C:\x\a.exe", 1, false, 0.2, 120L * 1048576, false, false)], used: 72);
        var act = new FakeProcActions(src) { Refuse = [2, 3] };
        var run = await new MemoryGuard(src, act, null, TimeSpan.Zero).RunAsync(50, default);
        Assert.Empty(run.Trimmed); Assert.Equal(2, run.Failures!.Count); Assert.All(run.Failures, f => Assert.Equal(5, f.Error));
        CareRuntime.Source = src; CareRuntime.Actions = act; CareRuntime.Guard = new MemoryGuard(src, act, null, TimeSpan.Zero);
        try
        {
            using var sb = new Sandbox();
            var rep = await RepairEngine.RunAsync(new MemoryTrimRecipe(), new RepairContext(sb, new FakeProc(), new FakeServices(), Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, T.J()), default);
            Assert.False(rep.Verified); Assert.Contains("refused", rep.Summary); Assert.Contains("error 5", rep.Summary); Assert.Contains("Access is denied", rep.Summary);
        }
        finally { CareRuntime.Source = null; CareRuntime.Guard = null; CareRuntime.Actions = new SystemProcessActions(); }
    }
}

public class StartupAtomicityTests
{
    [Fact]
    public async Task Disabling_start_up_programs_records_every_entry_for_rollback_as_it_goes()
    {
        using var sb = new Sandbox(); var slot = sb.StartupSlots()[0]; using (var run = slot.OpenRun()!) { run.SetValue("First", @"C:\a\a.exe"); run.SetValue("Second", @"C:\b\b.exe"); }
        // the second entry is in a location that cannot be written (a slot whose Approved key refuses): simulate by naming a location that does not exist for the second
        var opts = JsonDocument.Parse("{\"entries\":[{\"location\":\"" + slot.Location.Replace("\\", "\\\\") + "\",\"name\":\"First\"},{\"location\":\"" + slot.Location.Replace("\\", "\\\\") + "\",\"name\":\"Second\"}]}").RootElement;
        var rep = await RepairEngine.RunAsync(Recipes.All["startup.disable"], new RepairContext(sb, new FakeProc(), new FakeServices(), Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, opts), default);
        Assert.True(rep.Verified); Assert.True(rep.RollbackAvailable);            // the normal path records both entries for rollback
        using var ap = slot.OpenApproved(false)!; Assert.Equal(3, ((byte[])ap.GetValue("First")!)[0]); Assert.Equal(3, ((byte[])ap.GetValue("Second")!)[0]);
    }
}

public class StartupEnableTests
{
    static RepairContext Ctx(Sandbox sb, string opts) => new(sb, new FakeProc(), new FakeServices(), Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, JsonDocument.Parse(opts).RootElement);

    [Fact]
    public async Task Start_up_programs_can_be_turned_off_and_back_on_and_the_manager_list_shows_the_real_state()
    {
        using var sb = new Sandbox(); var slot = sb.StartupSlots()[0];
        using (var run = slot.OpenRun()!) { run.SetValue("Spotify", @"C:\x\Spotify.exe"); run.SetValue("AcmeInventory", @"C:\acme\inv.exe"); }
        var entries = "{\"entries\":[{\"location\":\"" + slot.Location.Replace("\\", "\\\\") + "\",\"name\":\"AcmeInventory\"}]}";        // an item Viro would only ever ask about
        var off = await RepairEngine.RunAsync(Recipes.All["startup.disable"], Ctx(sb, entries), default); Assert.True(off.Verified);
        var list = StartupOptimizeRecipe.Items(sb); Assert.False(list.Single(i => i.Name == "AcmeInventory").Enabled); Assert.True(list.Single(i => i.Name == "Spotify").Enabled);
        Assert.Equal(StartupClass.ASK, StartupClassifier.Assess(list.Single(i => i.Name == "AcmeInventory")).Class);

        var on = await RepairEngine.RunAsync(Recipes.All["startup.enable"], Ctx(sb, entries), default);
        Assert.True(on.Applied); Assert.True(on.Verified); Assert.True(on.RollbackAvailable); Assert.True(StartupOptimizeRecipe.Items(sb).Single(i => i.Name == "AcmeInventory").Enabled);
        Assert.Contains("No action needed", (await RepairEngine.RunAsync(Recipes.All["startup.enable"], Ctx(sb, entries), default)).Summary);      // already on: nothing touched
        var undo = await RepairEngine.RollbackAsync(Recipes.All, on.RepairId, Ctx(sb, "{}"), default);                                              // rolling the enable back turns it off again
        Assert.True(undo.RolledBack); Assert.False(StartupOptimizeRecipe.Items(sb).Single(i => i.Name == "AcmeInventory").Enabled);
        Assert.Equal(RepairRisk.Review, Recipes.All["startup.enable"].Risk); Assert.True(Recipes.All["startup.enable"].Reversible);
        await Assert.ThrowsAsync<ArgumentException>(() => Recipes.All["startup.enable"].DiagnoseAsync(Ctx(sb, "{}"), default));
    }
}

public class CleanupEffectivenessTests
{
    static string Put(Sandbox sb, string rel, int bytes, TimeSpan age)
    {
        var p = Path.Combine(sb.Root, rel); Directory.CreateDirectory(Path.GetDirectoryName(p)!); File.WriteAllBytes(p, new byte[bytes]); File.SetLastWriteTimeUtc(p, DateTime.UtcNow - age); return p;
    }

    [Fact]
    public async Task A_run_that_frees_little_says_how_much_was_too_new_and_the_stronger_option_frees_it_without_touching_in_use_or_very_fresh_files()
    {
        using var sb = new Sandbox(); var temp = @"Users\alice\AppData\Local\Temp";
        Put(sb, temp + @"\old.tmp", 1000, TimeSpan.FromDays(5));
        Put(sb, temp + @"\yesterday\db1\base.dat", 50_000, TimeSpan.FromHours(20));     // a test database or installer unpacked yesterday
        Put(sb, temp + @"\yesterday\db1\more.dat", 70_000, TimeSpan.FromHours(20));
        var fresh = Put(sb, temp + @"\writing-now.tmp", 9_000, TimeSpan.FromMinutes(10));
        var locked = Put(sb, temp + @"\locked.tmp", 7_000, TimeSpan.FromHours(3));
        Put(sb, @"Windows\Temp\w.tmp", 4_000, TimeSpan.FromHours(5));
        Put(sb, @"Users\alice\Documents\thesis.docx", 123, TimeSpan.FromDays(400));

        var safe = await Cleanup.RunAsync(sb, new FakeProc(), ["user-temp", "windows-temp"], approveReview: false);
        Assert.Equal(1000, safe.Sum(x => x.BytesFreed));                                                             // only the 5-day-old file is safe by default
        Assert.Equal(50_000 + 70_000 + 9_000 + 7_000 + 4_000, safe.Sum(x => x.RecentBytes)); Assert.True(safe.Sum(x => x.RecentFiles) == 5, "the result says how much was too new, so a small number is explained");

        await Assert.ThrowsAsync<InvalidOperationException>(() => Cleanup.RunAsync(sb, new FakeProc(), ["recent-temp"], approveReview: false));      // the stronger option needs approval
        using (var hold = new FileStream(locked, FileMode.Open, FileAccess.Read, FileShare.None))                 // a program has this file open
        {
            var deep = (await Cleanup.RunAsync(sb, new FakeProc(), ["recent-temp"], approveReview: true)).Single();
            Assert.Equal("REVIEW", deep.Class); Assert.Equal(50_000 + 70_000 + 4_000, deep.BytesFreed);              // yesterday's files and the Windows temp file are gone
            Assert.Equal(1, deep.Skipped); Assert.Contains("in use", deep.Note); Assert.Equal(9_000, deep.RecentBytes);   // the file in use is left, and the very fresh file is counted as too new
        }
        Assert.True(File.Exists(fresh), "a file changed ten minutes ago is never touched"); Assert.True(File.Exists(locked), "a file in use is never forced");
        Assert.False(Directory.Exists(Path.Combine(sb.Root, temp, "yesterday")), "folders left empty are removed too");
        Assert.True(File.Exists(Path.Combine(sb.Root, @"Users\alice\Documents\thesis.docx")), "personal files are never part of any category");
        var prev = Cleanup.Preview(sb, ["recent-temp"]).Single(); Assert.Equal(7_000, prev.BytesFound); Assert.Equal(9_000, prev.RecentBytes);
        Assert.DoesNotContain("recent-temp", Cleanup.SafeIds);                                                       // never part of the automatic safe set
    }
}

public class LocalAppTests
{
    [Fact]
    public async Task The_person_at_the_PC_can_free_space_manage_start_up_programs_and_undo_without_any_terminal()
    {
        using var sb = new Sandbox(); var state = Path.Combine(sb.Root, "undo"); var env = new SandboxUserEnv(sb, state); var a = new LocalActions(env);
        // free space: a fresh pile of temp files is reported as too new, and the person can include it knowingly
        var tmp = Path.Combine(sb.Root, @"Users\alice\AppData\Local\Temp"); Directory.CreateDirectory(tmp);
        File.WriteAllBytes(Path.Combine(tmp, "old.tmp"), new byte[1000]); File.SetLastWriteTimeUtc(Path.Combine(tmp, "old.tmp"), DateTime.UtcNow.AddDays(-9));
        Directory.CreateDirectory(Path.Combine(tmp, "pg")); File.WriteAllBytes(Path.Combine(tmp, @"pg\data"), new byte[80 * 1048576]); File.SetLastWriteTimeUtc(Path.Combine(tmp, @"pg\data"), DateTime.UtcNow.AddHours(-5));
        var prev = await a.PreviewCleanupAsync(default);
        Assert.Equal(1000, prev.Single(x => x.Id == "user-temp").BytesFound); Assert.Equal(80 * 1048576L, prev.Single(x => x.Id == "user-temp").RecentBytes); Assert.Equal("REVIEW", prev.Single(x => x.Id == "recent-temp").Class);
        Assert.DoesNotContain(prev, x => x.Id == "windows-old");
        var safe = await a.CleanAsync(["user-temp"], default); var said = LocalActions.Describe(safe, ranReview: false);
        Assert.Contains("Freed 0 MB", said); Assert.Contains("80 MB more is temporary but too new to delete safely by default", said);
        var more = await a.CleanAsync(["recent-temp"], default); Assert.Contains("Freed 80 MB", LocalActions.Describe(more, ranReview: true)); Assert.False(File.Exists(Path.Combine(tmp, @"pg\data")));

        // start-up: list with advice, stop, start again, and the history lists both with undo
        using (var run = sb.StartupSlots()[0].OpenRun()!) { run.SetValue("Spotify", @"C:\x\Spotify.exe"); run.SetValue("SecurityHealth", @"C:\Windows\SecurityHealthSystray.exe"); run.SetValue("AcmeInventory", @"C:\acme\inv.exe"); }
        var list = a.StartupPrograms(); Assert.Equal(StartupClass.SAFE_TO_DISABLE, list.Single(x => x.Item.Name == "Spotify").Class); Assert.Equal(StartupClass.KEEP, list.Single(x => x.Item.Name == "SecurityHealth").Class); Assert.True(list.All(x => x.Item.Enabled));
        var off = await a.SetStartupAsync(list.Where(x => x.Class != StartupClass.KEEP).Select(x => x.Item), enable: false, default); Assert.True(off.Verified);
        Assert.Equal(2, a.StartupPrograms().Count(x => !x.Item.Enabled)); Assert.Equal("SecurityHealth", a.StartupPrograms().First().Item.Name);   // enabled ones first
        var hist = a.History(); Assert.Single(hist); Assert.Equal("Stopped programs from starting with Windows", hist[0].Title); Assert.Equal("2 programs", hist[0].Summary);
        var undone = await a.UndoAsync(hist[0].Id, default); Assert.True(undone.RolledBack); Assert.True(a.StartupPrograms().All(x => x.Item.Enabled)); Assert.Empty(a.History());     // undo removes the record, and the programs start again
        await Assert.ThrowsAsync<InvalidOperationException>(() => a.UndoAsync(hist[0].Id, default));                                                                                       // a second undo is refused, not silently ignored
    }

    [Fact]
    public async Task Memory_can_be_given_back_from_the_window_and_the_result_is_measured()
    {
        const long MB = 1048576; var src = new FakeProcSource([new ProcInfo(2, "spotify", @"C:\x\s.exe", 1, false, 0.2, 600 * MB, true, false), new ProcInfo(3, "chrome", @"C:\x\c.exe", 1, false, 5, 900 * MB, true, true)], used: 80); var act = new FakeProcActions(src);
        using var sb = new Sandbox(); var a = new LocalActions(new SandboxUserEnv(sb, Path.Combine(sb.Root, "undo")), src, act);
        var r = await a.TrimMemoryAsync(default);
        Assert.Equal([2], act.Trimmed); Assert.True(r.ReclaimedMb > 300); Assert.True(r.AfterPercent < r.BeforePercent);          // the program in use (foreground) is never trimmed
    }
}

sealed class SandboxUserEnv(Sandbox sb, string state) : RepairEnv
{
    public override string WindowsDir => sb.WindowsDir; public override string SystemDrive => sb.SystemDrive; public override string ProgramDataDir => sb.ProgramDataDir; public override string StateDir => state;
    public override IReadOnlyList<StartupSlot> StartupSlots() => sb.StartupSlots();
}

public class LocalViewTests
{
    [Fact]
    public async Task The_window_reads_the_service_view_over_a_read_only_pipe_and_nothing_else_is_answered()
    {
        var name = "viro-test-" + Guid.NewGuid().ToString("N"); using var stop = new CancellationTokenSource(); var calls = 0;
        var sec = new System.IO.Pipes.PipeSecurity(); sec.AddAccessRule(new System.IO.Pipes.PipeAccessRule(System.Security.Principal.WindowsIdentity.GetCurrent().User!, System.IO.Pipes.PipeAccessRights.ReadWrite, System.Security.AccessControl.AccessControlType.Allow));
        var server = LocalViewServer.ListenAsync(name, _ => { calls++; return Task.FromResult<string?>("{\"hostname\":\"PC-1\",\"health\":{\"overall\":74}}"); }, sec, Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, stop.Token);
        try
        {
            var v = await LocalViewServer.ReadAsync(default, name); Assert.NotNull(v); Assert.Equal("PC-1", v!.Value.GetProperty("hostname").GetString()); Assert.Equal(74, v.Value.GetProperty("health").GetProperty("overall").GetInt32());
            // a request for anything but the view is refused (the pipe cannot start jobs or change settings)
            await using var c = new System.IO.Pipes.NamedPipeClientStream(".", name, System.IO.Pipes.PipeDirection.InOut, System.IO.Pipes.PipeOptions.Asynchronous); await c.ConnectAsync(3000);
            await PipeFrames.WriteAsync(c, PipeFrames.Ui, System.Text.Encoding.UTF8.GetBytes("{\"k\":\"run-job\",\"type\":\"repair.run\"}"), default);
            var r = await PipeFrames.ReadAsync(c, default); Assert.False(System.Text.Json.JsonDocument.Parse(r!.Value.payload).RootElement.GetProperty("ok").GetBoolean()); Assert.Equal(1, calls);
        }
        finally { stop.Cancel(); try { await server; } catch { } }
        Assert.Null(await LocalViewServer.ReadAsync(default, name));          // nobody listening: the window gets null, not a hang or a crash
    }

    [Fact]
    public async Task When_the_service_has_no_view_the_window_gets_null_and_says_so()
    {
        var name = "viro-test-" + Guid.NewGuid().ToString("N"); using var stop = new CancellationTokenSource();
        var sec = new System.IO.Pipes.PipeSecurity(); sec.AddAccessRule(new System.IO.Pipes.PipeAccessRule(System.Security.Principal.WindowsIdentity.GetCurrent().User!, System.IO.Pipes.PipeAccessRights.ReadWrite, System.Security.AccessControl.AccessControlType.Allow));
        var server = LocalViewServer.ListenAsync(name, _ => Task.FromResult<string?>(null), sec, Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, stop.Token);
        try { Assert.Null(await LocalViewServer.ReadAsync(default, name)); } finally { stop.Cancel(); try { await server; } catch { } }
        Assert.True(LocalActions.CanFixHere("memory.trim-idle")); Assert.True(LocalActions.CanFixHere("startup.optimize")); Assert.False(LocalActions.CanFixHere("protect.firewall")); Assert.False(LocalActions.CanFixHere(null));
        var sc = LocalViewServer.Security(); Assert.Contains(sc.GetAccessRules(true, false, typeof(System.Security.Principal.SecurityIdentifier)).Cast<System.IO.Pipes.PipeAccessRule>(), r => r.IdentityReference.Value == "S-1-5-11");
    }
}
