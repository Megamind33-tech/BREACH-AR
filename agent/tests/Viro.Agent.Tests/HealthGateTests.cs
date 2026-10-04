using Microsoft.Extensions.Logging.Abstractions;
using Viro.Agent;
using Viro.Agent.Repair;
using Viro.Compute;
using Xunit;

sealed class BusyEnv : RepairEnv
{
    public (bool onBattery, int percent)? Power; public double? Cpu; public int Sampled;
    public OfficeInstall? Install = new(@"C:\CTR\OfficeClickToRun.exe", "x64", "en-us", "16.0.1");
    public override (bool onBattery, int percent)? Battery() => Power;
    public override Task<double?> CpuBusyPercentAsync(CancellationToken ct) { Sampled++; return Task.FromResult(Cpu); }
    public override OfficeInstall? OfficeClickToRun() => Install;
    public override bool IsProcessRunning(string name) => false;
    public override string StateDir => Path.Combine(Path.GetTempPath(), "viro-guard-" + Guid.NewGuid().ToString("N"));
}

public class HealthGateTests
{
    static ComputePolicy P() => new(true, 1, 30, 10, null, false, 70, 15, true, 0, "selftest", "w", null);
    static Signals Idle() => new(1200, false, 55, 40, null, false, false, true);
    static readonly DateTime Now = new(2026, 9, 30, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Machine_health_wins_over_compute_ALLOW_THROTTLE_PAUSE_BLOCK()
    {
        Assert.True(PolicyEngine.Decide(P(), Idle(), false, Now, null, new HealthGate("ALLOW", "The computer is healthy.")).Run);
        Assert.True(PolicyEngine.Decide(P(), Idle(), false, Now).Run, "no instruction from Control changes nothing");
        var t = PolicyEngine.Decide(P(), Idle(), false, Now, null, new HealthGate("THROTTLE", "The processor is slowing itself down because of heat."));
        Assert.True(t.Run); Assert.Equal(15, t.CpuCapPercent); Assert.Contains("reduced because", t.Reason);
        var pause = PolicyEngine.Decide(P(), Idle(), true, Now, null, new HealthGate("PAUSE", "A repair is being carried out."));
        Assert.False(pause.Run); Assert.Equal("health-paused", pause.State); Assert.Contains("repair", pause.Reason);
        var block = PolicyEngine.Decide(P(), Idle(), true, Now, null, new HealthGate("BLOCK", "A hardware fault was detected on this computer."));
        Assert.False(block.Run); Assert.Equal("health-blocked", block.State);
        Assert.Equal(5, PolicyEngine.Decide(P() with { MaxCpuPercent = 8 }, Idle(), false, Now, null, new HealthGate("THROTTLE", "hot")).CpuCapPercent);   // never below the hard minimum
        Assert.Equal("disabled", PolicyEngine.Decide(P() with { Enabled = false }, Idle(), false, Now, null, new HealthGate("ALLOW", "")).State);
    }

    [Fact]
    public async Task Disruptive_repairs_wait_while_the_PC_is_on_a_low_battery_or_busy_and_run_when_it_is_quiet()
    {
        Assert.Null(await DisruptionGuard.CheckAsync("services.restart-failed", new BusyEnv { Power = (true, 10), Cpu = 99 }, default));      // not disruptive: never postponed
        var env = new BusyEnv { Power = (true, 35), Cpu = 10 };
        Assert.Contains("on battery (35%)", await DisruptionGuard.CheckAsync("office.quick-repair", env, default));
        env.Power = (true, 55);
        Assert.Null(await DisruptionGuard.CheckAsync("office.quick-repair", env, default));
        Assert.Contains("on battery (55%)", await DisruptionGuard.CheckAsync("windows.sfc", env, default));   // heavy disk work needs more charge
        env.Power = (false, 20); Assert.Null(await DisruptionGuard.CheckAsync("windows.sfc", env, default));  // plugged in: charge is irrelevant
        env.Cpu = 92; Assert.Contains("the computer is busy", await DisruptionGuard.CheckAsync("windows.dism", env, default));
        env.Cpu = null; env.Power = null; Assert.Null(await DisruptionGuard.CheckAsync("windows.dism", env, default));   // cannot be measured: do not block forever
    }

    [Fact]
    public async Task A_postponed_repair_is_reported_as_deferred_and_nothing_runs()
    {
        var env = new BusyEnv { Cpu = 97 }; var proc = new FakeProc();
        var outcome = await new RepairRunHandler(env, proc, new FakeServices()).RunAsync(T.Job("repair.run", "{\"recipe\":\"office.quick-repair\"}"), default);
        Assert.True(outcome.Success); Assert.Empty(proc.Calls);
        var json = System.Text.Json.JsonSerializer.Serialize(outcome.Result);
        Assert.Contains("\"deferred\":true", json); Assert.Contains("Deferred: the computer is busy", json);
        env.Cpu = 5;
        var ran = await new RepairRunHandler(env, proc, new FakeServices()).RunAsync(T.Job("repair.run", "{\"recipe\":\"office.quick-repair\"}"), default);
        Assert.True(ran.Success); Assert.Single(proc.Calls);
    }
}
