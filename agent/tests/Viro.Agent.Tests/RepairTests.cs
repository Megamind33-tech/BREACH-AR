using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Win32;
using Viro.Agent;
using Viro.Agent.Repair;
using Xunit;

// ------------------------------------------------------------------------------------------------ test doubles
sealed class Sandbox : RepairEnv, IDisposable
{
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "viro-sbx-" + Guid.NewGuid().ToString("N"));
    public bool Link = true, Resolves = true;
    public string RegBase { get; } = @"Software\ViroTest-" + Guid.NewGuid().ToString("N");
    public Sandbox() { Directory.CreateDirectory(Root); }
    public override string WindowsDir => Path.Combine(Root, "Windows");
    public override string SystemDrive => Root + Path.DirectorySeparatorChar;
    public override string ProgramDataDir => Path.Combine(Root, "ProgramData");
    public override string StateDir => Path.Combine(Root, "state");
    public override bool NetworkLinkUp() => Link;
    public override Task<bool> CanResolveAsync(CancellationToken ct) => Task.FromResult(Resolves);
    public override IReadOnlyList<StartupSlot> StartupSlots() =>
    [
        new(@"HKU\S-1-5-21-TEST\SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
            () => Registry.CurrentUser.CreateSubKey(RegBase + @"\Run"),
            w => w ? Registry.CurrentUser.CreateSubKey(RegBase + @"\Approved", true) : Registry.CurrentUser.OpenSubKey(RegBase + @"\Approved")),
    ];
    public string Mk(string rel, int ageDays = 0, string content = "data")
    {
        var p = Path.Combine(Root, rel); Directory.CreateDirectory(Path.GetDirectoryName(p)!);
        File.WriteAllText(p, content); File.SetLastWriteTimeUtc(p, DateTime.UtcNow.AddDays(-ageDays)); return p;
    }
    public void Dispose()
    {
        try { Registry.CurrentUser.DeleteSubKeyTree(RegBase, false); } catch { }
        try { foreach (var f in Directory.EnumerateFiles(Root, "*", SearchOption.AllDirectories)) File.SetAttributes(f, FileAttributes.Normal); Directory.Delete(Root, true); } catch { }
    }
}

sealed class FakeProc(Func<string, string, ProcResult>? script = null) : IProcessRunner
{
    public readonly List<string> Calls = [];
    public Task<ProcResult> RunAsync(string exe, string args, TimeSpan t, CancellationToken ct, Encoding? enc = null)
    { Calls.Add(Path.GetFileName(exe) + " " + args); return Task.FromResult((script ?? ((_, _) => new ProcResult(0, "", false)))(Path.GetFileName(exe), args)); }
}

sealed class FakeServices : IServices
{
    public Dictionary<string, string> State = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, string> Mode = new(StringComparer.OrdinalIgnoreCase);
    public List<FailedService> Failed = [];
    public HashSet<string> WontStart = new(StringComparer.OrdinalIgnoreCase);
    public List<string> Log = [];
    public string? Status(string n) => State.TryGetValue(n, out var s) ? s : null;
    public string? StartMode(string n) => Mode.GetValueOrDefault(n);
    public Task StopAsync(string n, TimeSpan t) { Log.Add("stop " + n); State[n] = "Stopped"; return Task.CompletedTask; }
    public Task StartAsync(string n, TimeSpan t) { Log.Add("start " + n); if (WontStart.Contains(n)) throw new InvalidOperationException("cannot start " + n); State[n] = "Running"; return Task.CompletedTask; }
    public IReadOnlyList<FailedService> FailedAutoServices() => Failed.Where(f => State.GetValueOrDefault(f.Name) != "Running").ToList();
}

static class T
{
    public static JsonElement J(string json = "{}") => JsonDocument.Parse(json).RootElement.Clone();
    public static RepairContext Ctx(Sandbox sb, IProcessRunner? p = null, IServices? s = null, string opts = "{}") => new(sb, p ?? new FakeProc(), s ?? new FakeServices(), NullLogger.Instance, J(opts));
    public static JobContext Job(string type, string paramsJson) => new(new VerifiedJob("id", type, J(paramsJson), 60), new ControlClient("http://localhost:1"), new UpdateStateCache(), NullLogger.Instance);
}

// ------------------------------------------------------------------------------------------------ cleanup
public class CleanupTests
{
    static Sandbox Populated()
    {
        var sb = new Sandbox();
        sb.Mk(@"Windows\Temp\old.tmp", 5, new string('x', 1000)); sb.Mk(@"Windows\Temp\new.tmp", 0, new string('x', 1000));
        sb.Mk(@"Users\alice\AppData\Local\Temp\old.log", 9, new string('x', 2000));
        sb.Mk(@"Users\alice\AppData\Local\Google\Chrome\User Data\Default\Cache\Cache_Data\f_000001", 0, new string('x', 4000));
        sb.Mk(@"Users\alice\AppData\Local\Google\Chrome\User Data\Default\Cookies", 30, "SESSION-COOKIES");
        sb.Mk(@"Users\alice\Documents\thesis.docx", 400, "IRREPLACEABLE"); sb.Mk(@"Users\alice\Downloads\installer.exe", 400, "keep");
        sb.Mk(@"Users\alice\Desktop\notes.txt", 400, "keep"); sb.Mk(@"Users\alice\Pictures\photo.jpg", 400, "keep");
        sb.Mk(@"Users\Public\Documents\shared.txt", 400, "keep");
        sb.Mk(@"$Recycle.Bin\S-1-5-21-1\$R123.txt", 3, new string('x', 500));
        sb.Mk(@"Windows\SoftwareDistribution\Download\pkg.cab", 1, new string('x', 3000));
        return sb;
    }

    [Fact]
    public void Preview_counts_only_eligible_safe_files_and_never_looks_at_personal_folders()
    {
        using var sb = Populated();
        var r = Cleanup.Preview(sb, null).ToDictionary(x => x.Id);
        Assert.Equal(1000, r["windows-temp"].BytesFound);        // new.tmp is too recent
        Assert.Equal(2000, r["user-temp"].BytesFound);
        Assert.Equal(4000, r["browser-cache"].BytesFound);       // cache only, not Cookies
        Assert.Equal(3000, r["update-leftovers"].BytesFound);
        Assert.Equal("SAFE", r["browser-cache"].Class);
        Assert.Equal("REVIEW", r["recycle-bin"].Class);
        Assert.Equal(500, r["recycle-bin"].BytesFound);
        Assert.DoesNotContain(Cleanup.Catalog, c => c.Id.Contains("download", StringComparison.OrdinalIgnoreCase) && c.Id != "update-leftovers");
    }

    [Fact]
    public async Task Safe_run_frees_space_and_leaves_personal_data_cookies_and_recent_files_alone()
    {
        using var sb = Populated();
        var res = await Cleanup.RunAsync(sb, new FakeProc(), Cleanup.SafeIds, approveReview: false);
        Assert.Equal(1000 + 2000 + 4000 + 3000, res.Sum(x => x.BytesFreed));
        Assert.False(File.Exists(Path.Combine(sb.Root, @"Windows\Temp\old.tmp")));
        Assert.True(File.Exists(Path.Combine(sb.Root, @"Windows\Temp\new.tmp")), "recent file kept");
        Assert.True(File.Exists(Path.Combine(sb.Root, @"Users\alice\AppData\Local\Google\Chrome\User Data\Default\Cookies")), "cookies kept");
        foreach (var keep in new[] { @"Users\alice\Documents\thesis.docx", @"Users\alice\Downloads\installer.exe", @"Users\alice\Desktop\notes.txt", @"Users\alice\Pictures\photo.jpg", @"Users\Public\Documents\shared.txt" })
            Assert.True(File.Exists(Path.Combine(sb.Root, keep)), keep);
        Assert.True(File.Exists(Path.Combine(sb.Root, @"$Recycle.Bin\S-1-5-21-1\$R123.txt")), "REVIEW category untouched without approval");
    }

    [Fact]
    public async Task Review_categories_need_explicit_approval()
    {
        using var sb = Populated();
        await Assert.ThrowsAsync<InvalidOperationException>(() => Cleanup.RunAsync(sb, new FakeProc(), ["recycle-bin"], approveReview: false));
        var res = await Cleanup.RunAsync(sb, new FakeProc(), ["recycle-bin"], approveReview: true);
        Assert.Equal(500, res[0].BytesFreed);
        Assert.False(File.Exists(Path.Combine(sb.Root, @"$Recycle.Bin\S-1-5-21-1\$R123.txt")));
    }

    [Fact]
    public async Task Unknown_categories_and_personal_folder_names_are_rejected()
    {
        using var sb = Populated();
        foreach (var bad in new[] { "documents", "downloads", "../../Users", "everything" })
            await Assert.ThrowsAsync<InvalidOperationException>(() => Cleanup.RunAsync(sb, new FakeProc(), [bad], approveReview: true));
        Assert.True(File.Exists(Path.Combine(sb.Root, @"Users\alice\Documents\thesis.docx")));
    }

    [Fact]
    public async Task Junctions_are_never_followed_out_of_a_cleanup_root()
    {
        using var sb = Populated();
        var victim = sb.Mk(@"outside\victim.txt", 100, "MUST SURVIVE");
        var link = Path.Combine(sb.Root, @"Windows\Temp\evil-link");
        var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd.exe", $"/c mklink /J \"{link}\" \"{Path.GetDirectoryName(victim)}\"") { CreateNoWindow = true, UseShellExecute = false })!;
        p.WaitForExit(); Assert.True(Directory.Exists(link), "junction created");
        await Cleanup.RunAsync(sb, new FakeProc(), ["windows-temp"], false);
        Assert.True(File.Exists(victim), "file behind the junction was deleted!");
        Directory.Delete(link); // removes the junction only
    }

    [Fact]
    public async Task Locked_files_are_skipped_not_forced()
    {
        using var sb = Populated();
        var locked = sb.Mk(@"Windows\Temp\locked.tmp", 10, "in use");
        using (new FileStream(locked, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            var res = await Cleanup.RunAsync(sb, new FakeProc(), ["windows-temp"], false);
            Assert.True(File.Exists(locked));
            Assert.Equal(1, res[0].Skipped);
            Assert.Equal(1000, res[0].BytesFreed);
        }
    }

    [Fact]
    public async Task Cleanup_handlers_report_real_numbers_and_protect_personal_data()
    {
        using var sb = Populated();
        var prev = await new CleanupPreviewHandler(sb).RunAsync(T.Job("cleanup.preview", "{}"), CancellationToken.None);
        var pj = JsonSerializer.SerializeToElement(prev.Result, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(10000, pj.GetProperty("safeBytes").GetInt64());
        Assert.Contains("Downloads", pj.GetProperty("personalDataNeverTouched").EnumerateArray().Select(x => x.GetString()));
        var run = await new CleanupRunHandler(sb, new FakeProc()).RunAsync(T.Job("cleanup.run", "{\"categories\":[\"windows-temp\",\"user-temp\"]}"), CancellationToken.None);
        Assert.True(run.Success);
        var refuse = await new CleanupRunHandler(sb, new FakeProc()).RunAsync(T.Job("cleanup.run", "{\"categories\":[\"recycle-bin\"]}"), CancellationToken.None);
        Assert.False(refuse.Success); Assert.Contains("REVIEW", refuse.Error);
    }
}

// ------------------------------------------------------------------------------------------------ engine + recipes
public class RepairEngineTests
{
    sealed class Fake(bool needed, bool applyThrows, bool verifies, bool reversible = true) : IRepairRecipe
    {
        public string Id => "fake"; public string Title => "Fake"; public RepairRisk Risk => RepairRisk.Safe; public bool AutoSafe => true; public bool Reversible => reversible;
        public bool Applied, RolledBack;
        public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct) => Task.FromResult(new Finding(needed, "diag", new { before = 1 }));
        public Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct) { c.RollbackState["k"] = "v"; Applied = true; if (applyThrows) throw new InvalidOperationException("boom"); return Task.CompletedTask; }
        public Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct) => Task.FromResult((verifies, verifies ? "fine" : "still broken"));
        public Task RollbackAsync(RepairContext c, JsonElement s, CancellationToken ct) { RolledBack = true; return Task.CompletedTask; }
    }

    [Fact] public async Task No_change_is_made_when_diagnosis_finds_nothing_wrong()
    {
        using var sb = new Sandbox(); var r = new Fake(false, false, true);
        var rep = await RepairEngine.RunAsync(r, T.Ctx(sb), default);
        Assert.False(r.Applied); Assert.False(rep.Applied); Assert.StartsWith("No action needed", rep.Summary);
    }
    [Fact] public async Task Successful_repair_is_verified_and_rollback_state_is_persisted()
    {
        using var sb = new Sandbox(); var r = new Fake(true, false, true);
        var rep = await RepairEngine.RunAsync(r, T.Ctx(sb), default);
        Assert.True(rep.Applied); Assert.True(rep.Verified); Assert.True(rep.RollbackAvailable);
        Assert.Equal(new[] { "diagnose", "apply", "verify" }, rep.Steps.Select(s => s.Name));
        Assert.True(File.Exists(Path.Combine(sb.StateDir, rep.RepairId + ".json")));
        var undo = await RepairEngine.RollbackAsync(new Dictionary<string, IRepairRecipe> { ["fake"] = r }, rep.RepairId, T.Ctx(sb), default);
        Assert.True(r.RolledBack); Assert.True(undo.RolledBack);
        Assert.False(File.Exists(Path.Combine(sb.StateDir, rep.RepairId + ".json")), "state consumed");
        await Assert.ThrowsAsync<InvalidOperationException>(() => RepairEngine.RollbackAsync(new Dictionary<string, IRepairRecipe> { ["fake"] = r }, rep.RepairId, T.Ctx(sb), default));
    }
    [Fact] public async Task A_change_that_does_not_verify_is_rolled_back_automatically()
    {
        using var sb = new Sandbox(); var r = new Fake(true, false, false);
        var rep = await RepairEngine.RunAsync(r, T.Ctx(sb), default);
        Assert.False(rep.Verified); Assert.True(rep.RolledBack); Assert.True(r.RolledBack);
    }
    [Fact] public async Task A_failure_while_applying_is_undone_and_reported()
    {
        using var sb = new Sandbox(); var r = new Fake(true, true, true);
        var rep = await RepairEngine.RunAsync(r, T.Ctx(sb), default);
        Assert.False(rep.Verified ?? false); Assert.True(rep.RolledBack); Assert.Contains("boom", rep.Summary);
    }
    [Fact] public async Task Irreversible_repairs_that_fail_verification_say_rollback_is_unavailable()
    {
        using var sb = new Sandbox(); var r = new Fake(true, false, false, reversible: false);
        var rep = await RepairEngine.RunAsync(r, T.Ctx(sb), default);
        Assert.False(rep.RolledBack); Assert.Contains(rep.Steps, s => s.Name == "rollback" && !s.Ok);
    }
    [Fact] public async Task Rollback_ids_must_be_guids_so_paths_cannot_be_injected()
    {
        using var sb = new Sandbox();
        await Assert.ThrowsAsync<ArgumentException>(() => RepairEngine.RollbackAsync(Recipes.All, @"..\..\Windows\System32\config", T.Ctx(sb), default));
    }
}

public class RecipeTests
{
    static Task<RepairReport> Run(string id, Sandbox sb, IProcessRunner? p = null, IServices? s = null, string opts = "{}") => RepairEngine.RunAsync(Recipes.All[id], T.Ctx(sb, p, s, opts), default);

    [Fact] public async Task Failed_services_are_restarted_and_verified()
    {
        using var sb = new Sandbox();
        var svc = new FakeServices { State = { ["Foo"] = "Stopped", ["Bar"] = "Stopped" }, Failed = [new("Foo", "Foo Service", 1), new("Bar", null, 2), new("ViroAgent", null, 1)] };
        var rep = await Run("services.restart-failed", sb, s: svc);
        Assert.True(rep.Verified); Assert.Equal("Running", svc.State["Foo"]);
        Assert.DoesNotContain("start ViroAgent", svc.Log);
    }
    [Fact] public async Task A_service_that_will_not_start_is_reported_as_failed()
    {
        using var sb = new Sandbox();
        var svc = new FakeServices { State = { ["Foo"] = "Stopped" }, Failed = [new("Foo", null, 1)], WontStart = { "Foo" } };
        var rep = await Run("services.restart-failed", sb, s: svc);
        Assert.False(rep.Verified); Assert.Contains("Foo", rep.Summary);
    }
    [Fact] public async Task Spooler_repair_clears_only_stuck_jobs_and_restarts_the_service()
    {
        using var sb = new Sandbox(); var q = sb.Mk(@"Windows\System32\spool\PRINTERS\00001.SPL", 1); sb.Mk(@"Windows\System32\spool\PRINTERS\00001.SHD", 1);
        var svc = new FakeServices { State = { ["Spooler"] = "Running" } };
        var rep = await Run("printer.spooler", sb, s: svc);
        Assert.True(rep.Verified); Assert.False(File.Exists(q)); Assert.Equal(["stop Spooler", "start Spooler"], svc.Log);
        Assert.Contains("No action needed", (await Run("printer.spooler", sb, s: svc)).Summary);
    }
    [Fact] public async Task Dns_flush_only_runs_when_resolution_is_actually_broken()
    {
        using var sb = new Sandbox(); var p = new FakeProc();
        Assert.Contains("No action needed", (await Run("dns.flush", sb, p)).Summary); Assert.Empty(p.Calls);
        sb.Resolves = false; sb.Link = true;
        var broken = await RepairEngine.RunAsync(Recipes.All["dns.flush"], T.Ctx(sb, p), default);
        Assert.Contains("ipconfig.exe /flushdns", p.Calls); Assert.False(broken.Verified); Assert.Contains("still fails", broken.Summary);
        sb.Link = false; Assert.Contains("No action needed", (await Run("dns.flush", sb, new FakeProc())).Summary);
    }
    [Fact] public async Task Network_reset_runs_both_commands_and_flags_a_reboot()
    {
        using var sb = new Sandbox { Resolves = false }; var p = new FakeProc();
        var rep = await Run("network.reset", sb, p);
        Assert.Equal(["netsh.exe winsock reset", "netsh.exe int ip reset"], p.Calls); Assert.True(rep.RebootRequired);
        var failing = await Run("network.reset", sb, new FakeProc((_, a) => new ProcResult(1, "access denied", false)));
        Assert.False(failing.Verified ?? false); Assert.Contains("access denied", failing.Summary);
    }
    [Fact] public async Task Windows_update_reset_swaps_caches_and_rollback_restores_them_exactly()
    {
        using var sb = new Sandbox(); var orig = sb.Mk(@"Windows\SoftwareDistribution\Download\keep.cab", 0, "ORIGINAL"); sb.Mk(@"Windows\System32\catroot2\db.edb", 0, "CAT");
        var svc = new FakeServices { State = { ["wuauserv"] = "Running", ["bits"] = "Running", ["cryptsvc"] = "Running" }, Mode = { ["wuauserv"] = "Disabled" } };
        var rep = await Run("windows.update-reset", sb, s: svc);
        Assert.True(rep.Verified); Assert.False(File.Exists(orig));
        Assert.Contains(Directory.GetDirectories(Path.Combine(sb.Root, "Windows")), d => d.Contains("SoftwareDistribution.viro-bak-"));
        var undo = await RepairEngine.RollbackAsync(Recipes.All, rep.RepairId, T.Ctx(sb, s: svc), default);
        Assert.True(undo.RolledBack); Assert.Equal("ORIGINAL", File.ReadAllText(orig));
        Assert.Equal("CAT", File.ReadAllText(Path.Combine(sb.Root, @"Windows\System32\catroot2\db.edb")));
        Assert.DoesNotContain(Directory.GetDirectories(Path.Combine(sb.Root, "Windows")), d => d.Contains("viro-bak"));
    }
    [Fact] public async Task Windows_update_reset_needs_a_fault_or_force()
    {
        using var sb = new Sandbox(); var svc = new FakeServices { State = { ["wuauserv"] = "Running" }, Mode = { ["wuauserv"] = "Auto" } };
        Assert.Contains("No action needed", (await Run("windows.update-reset", sb, s: svc)).Summary);
        sb.Mk(@"Windows\SoftwareDistribution\x.txt");
        Assert.True((await Run("windows.update-reset", sb, s: svc, opts: "{\"force\":true}")).Applied);
    }
    [Theory]
    [InlineData("Windows Resource Protection did not find any integrity violations.", true)]
    [InlineData("Windows Resource Protection found corrupt files and successfully repaired them.", true)]
    [InlineData("Windows Resource Protection found corrupt files but was unable to fix some of them.", false)]
    [InlineData("Windows Resource Protection could not perform the requested operation.", false)]
    [InlineData("You must be an administrator running a console session in order to use the sfc utility.", false)]
    [InlineData("ein ganz anderer Text", false)]
    public async Task Sfc_outcome_is_parsed_not_assumed(string output, bool ok)
    {
        using var sb = new Sandbox();
        var rep = await Run("windows.sfc", sb, new FakeProc((_, _) => new ProcResult(0, output, false)));
        Assert.Equal(ok, rep.Verified);
    }
    [Fact] public async Task Sfc_that_times_out_is_a_failure()
    {
        using var sb = new Sandbox();
        Assert.False((await Run("windows.sfc", sb, new FakeProc((_, _) => new ProcResult(-1, "", true)))).Verified);
    }
    [Fact] public async Task Dism_diagnoses_with_CheckHealth_and_only_repairs_when_corruption_is_found()
    {
        using var sb = new Sandbox();
        var healthy = new FakeProc((_, a) => new ProcResult(0, "No component store corruption detected.", false));
        Assert.Contains("No action needed", (await Run("windows.dism", sb, healthy)).Summary);
        Assert.DoesNotContain(healthy.Calls, c => c.Contains("RestoreHealth"));
        var state = "repairable"; var p = new FakeProc((_, a) => a.Contains("RestoreHealth") ? (state = "clean") is not null ? new ProcResult(0, "done", false) : null! : new ProcResult(0, state == "clean" ? "No component store corruption detected." : "The component store is repairable.", false));
        var rep = await Run("windows.dism", sb, p);
        Assert.True(rep.Verified); Assert.Contains(p.Calls, c => c.Contains("/RestoreHealth"));
        var stillBad = await Run("windows.dism", sb, new FakeProc((_, a) => new ProcResult(0, "The component store is repairable.", false)));
        Assert.False(stillBad.Verified);
    }
    [Fact] public async Task Cleanup_safe_recipe_verifies_freed_bytes()
    {
        using var sb = new Sandbox(); sb.Mk(@"Windows\Temp\big.tmp", 5, new string('x', 60 * 1024 * 1024));
        var rep = await Run("cleanup.safe", sb);
        Assert.True(rep.Verified); Assert.False(File.Exists(Path.Combine(sb.Root, @"Windows\Temp\big.tmp")));
        Assert.Contains("No action needed", (await Run("cleanup.safe", sb)).Summary);
    }
    [Fact] public async Task Startup_disable_flips_the_approved_flag_and_rollback_restores_the_previous_state()
    {
        using var sb = new Sandbox();
        using (var run = sb.StartupSlots()[0].OpenRun()!) { run.SetValue("Teams", "C:\\teams.exe"); run.SetValue("Slack", "C:\\slack.exe"); }
        var loc = sb.StartupSlots()[0].Location;
        var opts = JsonSerializer.Serialize(new { entries = new[] { new { location = loc, name = "Teams" } } });
        var rep = await Run("startup.disable", sb, opts: opts);
        Assert.True(rep.Verified); Assert.True(rep.RollbackAvailable);
        using (var ap = sb.StartupSlots()[0].OpenApproved(false)!) { Assert.Equal(1, ((byte[])ap.GetValue("Teams")!)[0] & 1); Assert.Null(ap.GetValue("Slack")); }
        using (var run = sb.StartupSlots()[0].OpenRun()!) Assert.NotNull(run.GetValue("Teams")); // nothing was deleted
        await RepairEngine.RollbackAsync(Recipes.All, rep.RepairId, T.Ctx(sb), default);
        using (var ap = sb.StartupSlots()[0].OpenApproved(false)!) Assert.Null(ap.GetValue("Teams"));
    }
    [Fact] public async Task Startup_disable_reports_entries_that_do_not_exist_and_changes_nothing()
    {
        using var sb = new Sandbox();
        var rep = await Run("startup.disable", sb, opts: JsonSerializer.Serialize(new { entries = new[] { new { location = "HKLM\\nowhere", name = "Ghost" } } }));
        Assert.False(rep.Applied); Assert.Contains("not found", rep.Summary);
    }
}

public class RepairHandlerTests
{
    [Fact] public async Task Review_recipes_are_refused_without_explicit_approval()
    {
        using var sb = new Sandbox(); var svc = new FakeServices { State = { ["wuauserv"] = "Running" } };
        var h = new RepairRunHandler(sb, new FakeProc(), svc);
        var refused = await h.RunAsync(T.Job("repair.run", "{\"recipe\":\"windows.update-reset\",\"options\":{\"force\":true}}"), CancellationToken.None);
        Assert.False(refused.Success); Assert.Contains("approval", refused.Error); Assert.Empty(svc.Log);
        var ok = await h.RunAsync(T.Job("repair.run", "{\"recipe\":\"windows.update-reset\",\"approved\":true,\"options\":{\"force\":true}}"), CancellationToken.None);
        Assert.True(ok.Success);
        Assert.False((await h.RunAsync(T.Job("repair.run", "{\"recipe\":\"format.c\"}"), CancellationToken.None)).Success);
    }
    [Fact] public async Task Fix_my_pc_only_touches_things_that_are_actually_broken()
    {
        using var sb = new Sandbox(); sb.Mk(@"Windows\Temp\big.tmp", 5, new string('x', 60 * 1024 * 1024));
        var svc = new FakeServices { State = { ["Foo"] = "Stopped" }, Failed = [new("Foo", null, 1)] };
        var p = new FakeProc();
        var o = await new RepairFixSafeHandler(sb, p, svc).RunAsync(T.Job("repair.fix-safe", "{}"), CancellationToken.None);
        Assert.True(o.Success);
        var j = JsonSerializer.SerializeToElement(o.Result, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(2, j.GetProperty("fixedCount").GetInt32());         // services + cleanup
        Assert.DoesNotContain(p.Calls, c => c.Contains("sfc") || c.Contains("winsock") || c.Contains("RestoreHealth"));
        Assert.Equal("Running", svc.State["Foo"]);
        var again = await new RepairFixSafeHandler(sb, p, svc).RunAsync(T.Job("repair.fix-safe", "{}"), CancellationToken.None);
        Assert.Equal(0, JsonSerializer.SerializeToElement(again.Result, new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("fixedCount").GetInt32());
    }
    [Fact] public async Task Rollback_handler_reports_missing_state_clearly()
    {
        using var sb = new Sandbox();
        var o = await new RepairRollbackHandler(sb, new FakeProc(), new FakeServices()).RunAsync(T.Job("repair.rollback", "{\"repairId\":\"" + Guid.NewGuid() + "\"}"), CancellationToken.None);
        Assert.False(o.Success); Assert.Contains("no rollback information", o.Error);
    }
}

public class SecurityHandlerTests
{
    static Dictionary<string, object?> Posture(bool defender, string engine = "Microsoft Defender") => new() { ["engine"] = engine, ["engineIsDefender"] = defender, ["signatureVersion"] = "1.2.3" };

    [Fact]
    public async Task Scan_is_refused_when_a_third_party_antivirus_is_the_active_engine()
    {
        var p = new FakeProc();
        var o = await DefenderActionHandler.Scan(p, () => Posture(false, "AVG Antivirus")).RunAsync(T.Job("security.scan", "{\"scanType\":\"quick\"}"), CancellationToken.None);
        Assert.False(o.Success); Assert.Contains("AVG Antivirus", o.Error); Assert.Empty(p.Calls);
    }

    [Theory]
    [InlineData("{\"scanType\":\"quick\"}", "Start-MpScan -ScanType QuickScan")]
    [InlineData("{\"scanType\":\"full\"}", "Start-MpScan -ScanType FullScan")]
    [InlineData("{}", "Start-MpScan -ScanType QuickScan")]
    [InlineData("{\"scanType\":\"\\\"; calc; \\\"\"}", "Start-MpScan -ScanType QuickScan")]   // hostile input can only ever select one of the two fixed commands
    public async Task Scan_runs_only_fixed_PowerShell_text(string paramsJson, string expected)
    {
        var p = new FakeProc();
        var o = await DefenderActionHandler.Scan(p, () => Posture(true)).RunAsync(T.Job("security.scan", paramsJson), CancellationToken.None);
        Assert.True(o.Success); Assert.Single(p.Calls); Assert.Contains(expected, p.Calls[0]); Assert.DoesNotContain("calc", p.Calls[0]);
    }

    [Fact]
    public async Task Access_denied_and_timeouts_are_reported_precisely()
    {
        var denied = await DefenderActionHandler.UpdateSignatures(new FakeProc((_, _) => new ProcResult(1, "Update-MpSignature : Access is denied. 0x80070005", false)), () => Posture(true)).RunAsync(T.Job("security.update-signatures", "{}"), CancellationToken.None);
        Assert.False(denied.Success); Assert.Contains("SYSTEM/administrator", denied.Error);
        var slow = await DefenderActionHandler.Scan(new FakeProc((_, _) => new ProcResult(-1, "", true)), () => Posture(true)).RunAsync(T.Job("security.scan", "{}"), CancellationToken.None);
        Assert.False(slow.Success); Assert.Contains("timed out", slow.Error);
    }

    [Fact]
    public void Real_security_posture_is_read_from_this_machine_and_unreadable_items_are_null_not_guessed()
    {
        var s = SecurityCollector.Collect();
        Assert.True(s.ContainsKey("engine")); Assert.True(s.ContainsKey("bitLocker")); Assert.True(s.ContainsKey("threats"));
        Assert.IsAssignableFrom<System.Collections.IEnumerable>(s["threats"]);
        var json = System.Text.Json.JsonSerializer.Serialize(s);   // must always serialise, whatever this machine allows
        Assert.Contains("uacEnabled", json);
    }
}
