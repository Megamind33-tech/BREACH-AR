using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Viro.Agent.Care;
using Viro.Agent.Repair;
using Xunit;

sealed class PowerEnv : RepairEnv
{
    public bool? Fast = true;
    public override bool? FastStartupEnabled() => Fast;
    public override void SetFastStartup(bool on) => Fast = on;
}

public class StabilityTests
{
    static StabilityEvidence Ev(int blue = 0, (string, int)[]? codes = null, int restarts = 0, int disk = 0, int whea = 0, int tdr = 0, int oom = 0, int shell = 0, int freezes = 0)
        => new(blue, codes ?? [], restarts, disk, whea, tdr, oom, shell, freezes, null);
    static RepairContext Ctx(RepairEnv env, string opts = "{}") => new(env, new FakeProc(), new FakeServices(), NullLogger.Instance, JsonDocument.Parse(opts).RootElement);

    [Fact]
    public void Causes_are_drawn_only_from_what_windows_recorded_and_ranked_with_a_fix_where_one_exists()
    {
        var calm = StabilityReader.Analyse(Ev());
        Assert.Equal("none", Assert.Single(calm).Code); Assert.Contains("no blue screens", calm[0].Detail);       // silence is not a diagnosis

        var c = StabilityReader.Analyse(Ev(blue: 3, codes: [("0x0000001a", 2), ("0x000000d1", 1)], disk: 4, shell: 5, oom: 2, restarts: 4));
        Assert.Equal(["disk", "memory", "driver", "shell", "ram-full"], c.Select(x => x.Code));
        Assert.Equal("disk.check", c.Single(x => x.Code == "disk").Recipe); Assert.Equal("high", c.Single(x => x.Code == "disk").Confidence);
        Assert.Equal("windows.memory-test", c.Single(x => x.Code == "memory").Recipe);
        Assert.Equal("shell.repair", c.Single(x => x.Code == "shell").Recipe);
        Assert.DoesNotContain(c, x => x.Code == "power");                                                           // a crash was recorded, so it is not "just power"

        var power = StabilityReader.Analyse(Ev(restarts: 3));
        Assert.Equal("power.fast-startup-off", power.Single(x => x.Code == "power").Recipe);
        Assert.Contains(StabilityReader.Analyse(Ev(whea: 2)), x => x.Code == "hardware" && x.Recipe is null);        // hardware faults are not something software can fix
        Assert.Contains("MEMORY_MANAGEMENT", StabilityReader.Describe("0x0000001a"));
    }

    [Fact]
    public async Task Frozen_programs_are_rechecked_before_they_are_closed_and_the_result_is_verified()
    {
        var started = DateTime.UtcNow.AddHours(-1);
        var hung = new List<HungApp> { new(101, "Reports", "Reports - not responding", started, @"C:\Apps\reports.exe"), new(102, "Other", "x", started, null) };
        var killed = new List<int>();
        var r = new EndHungAppsRecipe(() => hung.ToList(), pid => { killed.Add(pid); hung.RemoveAll(h => h.Pid == pid); return true; });
        var rep = await RepairEngine.RunAsync(r, Ctx(new SlowEnv(), "{\"pids\":[101,999]}"), default);                // 999 is not frozen: ignored
        Assert.True(rep.Applied && rep.Verified == true, rep.Summary);
        Assert.Equal([101], killed); Assert.Contains(hung, h => h.Pid == 102);                                      // the other frozen program was not asked about, so it is left alone
        Assert.Contains("none of the chosen programs is frozen", (await RepairEngine.RunAsync(r, Ctx(new SlowEnv(), "{\"pids\":[101]}"), default)).Summary);
        var stuck = await RepairEngine.RunAsync(new EndHungAppsRecipe(() => [new(7, "Stubborn", "", started, null)], _ => false), Ctx(new SlowEnv(), "{\"pids\":[7]}"), default);
        Assert.False(stuck.Applied); Assert.Contains("would not close", stuck.Summary);
        var bad = await RepairEngine.RunAsync(r, Ctx(new SlowEnv(), "{}"), default); Assert.Contains("Diagnosis failed", bad.Summary);
    }

    [Fact]
    public async Task Fast_startup_can_be_turned_off_verified_and_turned_back_on()
    {
        var env = new PowerEnv(); var rec = new FastStartupOffRecipe();
        var rep = await RepairEngine.RunAsync(rec, Ctx(env), default);
        Assert.True(rep.Applied && rep.Verified == true, rep.Summary); Assert.False(env.Fast);
        Assert.Contains("No action needed", (await RepairEngine.RunAsync(rec, Ctx(env), default)).Summary);
        await RepairEngine.RollbackAsync(Recipes.All.ToDictionary(x => x.Key, x => x.Key == rec.Id ? (IRepairRecipe)rec : x.Value), rep.RepairId, Ctx(env), default);
        Assert.True(env.Fast);
    }

    [Fact]
    public async Task Memory_test_is_scheduled_for_the_next_restart_and_only_counts_when_windows_shows_it_scheduled()
    {
        var sched = false;
        var proc = new FakeProc((exe, args) => exe == "bcdedit.exe" && args.StartsWith("/bootsequence") ? Do(() => sched = true) : exe == "bcdedit.exe" && args.StartsWith("/enum") ? new(0, sched ? "bootsequence  {memdiag}" : "identifier {bootmgr}", false) : new(0, "", false));
        static ProcResult Do(Action a) { a(); return new(0, "", false); }
        var rep = await RepairEngine.RunAsync(new MemoryTestRecipe(), new RepairContext(new SlowEnv(), proc, new FakeServices(), NullLogger.Instance, JsonDocument.Parse("{}").RootElement), default);
        Assert.True(rep.Applied && rep.Verified == true && rep.RebootRequired, rep.Summary);
        var refused = await RepairEngine.RunAsync(new MemoryTestRecipe(), new RepairContext(new SlowEnv(), new FakeProc((_, _) => new ProcResult(1, "access denied", false)), new FakeServices(), NullLogger.Instance, JsonDocument.Parse("{}").RootElement), default);
        Assert.False(refused.Applied);
    }

    [Fact]
    public void The_desktop_repair_is_registered_and_asks_first()
    {
        foreach (var id in new[] { "apps.end-hung", "shell.repair", "windows.memory-test", "power.fast-startup-off" }) Assert.True(Recipes.All.ContainsKey(id), id);
        Assert.All(new[] { "apps.end-hung", "shell.repair", "windows.memory-test", "power.fast-startup-off" }, id => Assert.Equal(RepairRisk.Review, Recipes.All[id].Risk));
    }
}
