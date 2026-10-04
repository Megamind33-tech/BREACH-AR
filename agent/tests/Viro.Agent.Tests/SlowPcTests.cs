using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Viro.Agent.Care;
using Viro.Agent.Repair;
using Xunit;

/// <summary>An environment whose shutdown settings and services live in memory, so the recipes can be proven without touching this PC's registry.</summary>
sealed class SlowEnv : RepairEnv
{
    public readonly Dictionary<string, int?> Values = new() { ["HKLM|WaitToKillServiceTimeout"] = 20000, ["HKU|WaitToKillAppTimeout"] = 30000, ["HKU|HungAppTimeout"] = 5000 };
    public bool Wipe;
    public readonly Dictionary<string, int> Delayed = new() { ["VendorSync"] = 0, ["SlowThing"] = 0, ["AVGsvc"] = 0, ["WinInternal"] = 0 };
    public override string WindowsDir => @"C:\Windows";
    public override IReadOnlyList<ShutdownSetting> ReadShutdownSettings() =>
    [
        new(@"HKLM\Control", "WaitToKillServiceTimeout", Values["HKLM|WaitToKillServiceTimeout"], 5000, "services"),
        new(@"HKU\S\Desktop", "WaitToKillAppTimeout", Values["HKU|WaitToKillAppTimeout"], 20000, "apps"),
        new(@"HKU\S\Desktop", "HungAppTimeout", Values["HKU|HungAppTimeout"], 5000, "hung"),
    ];
    public override bool ClearsPageFileAtShutdown() => Wipe;
    public override void WriteShutdownSetting(string where, string name, int? value) => Values[where.Split('\\')[0] + "|" + name] = value;
    public override IReadOnlyList<AutoServiceEntry> ServiceEntries() =>
    [
        new("VendorSync", "Vendor Sync", @"C:\Program Files\Vendor\sync.exe", 2, Delayed["VendorSync"], 0x10),
        new("SlowThing", "Slow Thing", @"C:\Program Files\Slow\slow.exe", 2, Delayed["SlowThing"], 0x10),
        new("AVGsvc", "AVG Service", @"C:\Program Files\AVG\avg.exe", 2, Delayed["AVGsvc"], 0x10),
        new("WinInternal", "Windows Internal", @"C:\Windows\System32\svchost.exe -k x", 2, Delayed["WinInternal"], 0x20),
    ];
    public override void SetDelayedStart(string service, int value) => Delayed[service] = value;
}

public class SlowPcTests
{
    static RepairContext Ctx(RepairEnv env, IProcessRunner? p = null, string opts = "{}") => new(env, p ?? new FakeProc(), new FakeServices(), NullLogger.Instance, JsonDocument.Parse(opts).RootElement);
    static IReadOnlyDictionary<string, IRepairRecipe> With(IRepairRecipe r) => Recipes.All.ToDictionary(x => x.Key, x => x.Key == r.Id ? r : x.Value);

    [Fact]
    public async Task Shutdown_speed_restores_only_the_waiting_times_that_were_raised_then_verifies_and_undoes()
    {
        var env = new SlowEnv { Wipe = true }; var r = new ShutdownSpeedRecipe();
        var rep = await RepairEngine.RunAsync(r, Ctx(env), default);
        Assert.True(rep.Applied && rep.Verified == true, rep.Summary);
        Assert.Equal(5000, env.Values["HKLM|WaitToKillServiceTimeout"]); Assert.Equal(20000, env.Values["HKU|WaitToKillAppTimeout"]);
        Assert.Equal(5000, env.Values["HKU|HungAppTimeout"]);                                         // was already at the default: untouched
        Assert.Contains("wipe the paging file", rep.Steps.First().Detail);                           // the security setting is reported but left alone
        Assert.Contains("No action needed", (await RepairEngine.RunAsync(r, Ctx(env), default)).Summary);
        await RepairEngine.RollbackAsync(With(r), rep.RepairId, Ctx(env), default);
        Assert.Equal(20000, env.Values["HKLM|WaitToKillServiceTimeout"]); Assert.Equal(30000, env.Values["HKU|WaitToKillAppTimeout"]);
    }

    [Fact]
    public async Task Boot_delay_only_touches_slow_third_party_services_never_security_or_windows_ones()
    {
        var env = new SlowEnv();
        var slow = new List<SlowItem> { new("VendorSync", "service", 9.5, 3), new("Slow Thing", "service", 4.1, 2), new("AVGsvc", "service", 20, 5), new("WinInternal", "service", 12, 1), new("VendorSync2", "service", 1.0, 1), new("Missing", "service", 8, 1) };
        var r = new BootDelayServicesRecipe(() => slow);
        var rep = await RepairEngine.RunAsync(r, Ctx(env), default);
        Assert.True(rep.Applied && rep.Verified == true, rep.Summary);
        Assert.Equal(1, env.Delayed["VendorSync"]); Assert.Equal(1, env.Delayed["SlowThing"]);
        Assert.Equal(0, env.Delayed["AVGsvc"]); Assert.Equal(0, env.Delayed["WinInternal"]);          // security product and a Windows service are left alone
        Assert.Contains("No action needed", (await RepairEngine.RunAsync(r, Ctx(env), default)).Summary);
        await RepairEngine.RollbackAsync(With(r), rep.RepairId, Ctx(env), default);
        Assert.Equal(0, env.Delayed["VendorSync"]);
    }

    [Fact]
    public async Task Boot_delay_does_nothing_without_measured_evidence()
        => Assert.Contains("No action needed", (await RepairEngine.RunAsync(new BootDelayServicesRecipe(() => null), Ctx(new SlowEnv()), default)).Summary);

    // ---- app repair ----
    const string Code = "{AC76BA86-7AD7-1033-7B44-AC0F074E4100}";
    static string Opts(string kind, string id) => JsonSerializer.Serialize(new { kind, id });

    [Fact]
    public async Task App_repair_runs_windows_installer_repair_and_is_verified_by_windows()
    {
        var proc = new FakeProc((exe, args) => new ProcResult(0, "", false)); var states = new Queue<int>([5, 5]);
        var rep = await RepairEngine.RunAsync(new AppRepairRecipe(_ => states.Dequeue()), Ctx(new SlowEnv(), proc, Opts("msi", Code)), default);
        Assert.True(rep.Applied && rep.Verified == true, rep.Summary);
        Assert.Contains(proc.Calls, c => c == $"msiexec.exe /fa {Code} /qn /norestart");
    }

    [Fact]
    public async Task App_repair_explains_what_went_wrong_and_does_not_claim_success()
    {
        var needsAdmin = await RepairEngine.RunAsync(new AppRepairRecipe(_ => 5), Ctx(new SlowEnv(), new FakeProc((_, _) => new ProcResult(1730, "", false)), Opts("msi", Code)), default);
        Assert.False(needsAdmin.Applied); Assert.Contains("administrator", needsAdmin.Summary);
        var noSource = await RepairEngine.RunAsync(new AppRepairRecipe(_ => -4), Ctx(new SlowEnv(), new FakeProc((_, _) => new ProcResult(1612, "", false)), Opts("msi", Code)), default);
        Assert.Contains("original installer", noSource.Summary);
        var gone = await RepairEngine.RunAsync(new AppRepairRecipe(_ => -1), Ctx(new SlowEnv(), null, Opts("msi", Code)), default);
        Assert.Contains("nothing to repair", gone.Summary);
        var stillBroken = await RepairEngine.RunAsync(new AppRepairRecipe(_ => -6), Ctx(new SlowEnv(), null, Opts("msi", Code)), default);
        Assert.NotEqual(true, stillBroken.Verified);                                                  // exit 0 from the installer is not proof; Windows' own state is
    }

    [Fact]
    public async Task App_repair_refuses_ids_that_could_carry_extra_commands()
    {
        foreach (var bad in new[] { ("msi", "{x}"), ("appx", "A'; calc; '"), ("appx", "ab"), ("exe", "whatever"), ("msi", "") })
        {
            var rep = await RepairEngine.RunAsync(new AppRepairRecipe(), Ctx(new SlowEnv(), new FakeProc(), Opts(bad.Item1, bad.Item2)), default);
            Assert.False(rep.Applied); Assert.Contains("Diagnosis failed", rep.Summary);
        }
    }

    [Fact]
    public void The_new_repairs_are_registered_and_the_risky_one_asks_first()
    {
        foreach (var id in new[] { "shutdown.speed", "boot.delay-services", "app.repair" }) Assert.True(Recipes.All.ContainsKey(id), id);
        Assert.Equal(RepairRisk.Review, Recipes.All["app.repair"].Risk);                             // reinstalling a program's files needs the person's say-so
        Assert.False(Recipes.All["app.repair"].AutoSafe);
    }

    [Fact]
    public void Crashes_are_matched_to_installed_programs_by_name()
    {
        var apps = new List<InstalledApp> { new("Google Chrome", "1", "Google", "msi", Code), new("Zoom", "5", "Zoom", "other", null) };
        Assert.Equal("Google Chrome", AppInventory.Match("chrome.exe", apps)); Assert.Null(AppInventory.Match("unknownthing.exe", apps)); Assert.Null(AppInventory.Match("a.exe", apps));
    }
}

/// <summary>A sandbox that also has a real Startup folder (a temp directory), to prove folder items are listed, classified and switched like Run-key ones.</summary>
sealed class FolderEnv(Sandbox sb, string folder) : RepairEnv
{
    public override string WindowsDir => sb.WindowsDir; public override string SystemDrive => sb.SystemDrive; public override string ProgramDataDir => sb.ProgramDataDir; public override string StateDir => sb.StateDir;
    public override IReadOnlyList<StartupSlot> StartupSlots() => [.. sb.StartupSlots(), new(@"HKU\S-1-5-21-TEST\Startup folder", () => null, sb.StartupSlots()[0].OpenApproved, folder)];
}

public class StartupFolderTests
{
    [Fact]
    public async Task Startup_folder_programs_are_listed_and_can_be_turned_off_and_on_again()
    {
        using var sb = new Sandbox(); var dir = Path.Combine(Path.GetTempPath(), "viro-startup-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "SpotifyHelper.exe"), "x"); File.WriteAllText(Path.Combine(dir, "desktop.ini"), "x"); File.WriteAllText(Path.Combine(dir, "notes.txt"), "x");
            var env = new FolderEnv(sb, dir);
            var items = Viro.Agent.Care.StartupOptimizeRecipe.Items(env).Where(i => i.Location.EndsWith("Startup folder")).ToList();
            Assert.Equal(["SpotifyHelper.exe"], items.Select(i => i.Name));                          // only things Windows would actually launch
            Assert.True(items[0].Enabled);
            var opts = JsonSerializer.Serialize(new { entries = new[] { new { location = items[0].Location, name = items[0].Name } } });
            var ctx = () => new RepairContext(env, new FakeProc(), new FakeServices(), NullLogger.Instance, JsonDocument.Parse(opts).RootElement);
            var off = await RepairEngine.RunAsync(Recipes.All["startup.disable"], ctx(), default);
            Assert.True(off.Applied && off.Verified == true, off.Summary);
            Assert.False(Viro.Agent.Care.StartupOptimizeRecipe.Items(env).Single(i => i.Location.EndsWith("Startup folder")).Enabled);
            Assert.True(File.Exists(Path.Combine(dir, "SpotifyHelper.exe")));                       // nothing is deleted
            var on = await RepairEngine.RunAsync(Recipes.All["startup.enable"], ctx(), default);
            Assert.True(on.Verified == true, on.Summary);
            Assert.True(Viro.Agent.Care.StartupOptimizeRecipe.Items(env).Single(i => i.Location.EndsWith("Startup folder")).Enabled);
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }
}
