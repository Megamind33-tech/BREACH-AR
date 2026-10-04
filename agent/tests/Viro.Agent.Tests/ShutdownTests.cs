using Viro.Agent;
using Viro.Agent.Repair;
using Xunit;

public class ShutdownTests
{
    [Fact]
    public async Task Shutdown_always_has_a_visible_countdown_a_safe_message_and_never_force_closes_apps()
    {
        var p = new FakeProc(); var ok = await new ShutdownHandler(p).RunAsync(T.Job("system.shutdown", "{\"delaySeconds\":1}"), default);
        Assert.True(ok.Success); Assert.StartsWith("shutdown.exe /s /t 30 /c \"", p.Calls[0]);                       // switch off (not restart), at least 30 s so people can save
        var p2 = new FakeProc(); await new ShutdownHandler(p2).RunAsync(T.Job("system.shutdown", "{\"delaySeconds\":999999}"), default);
        Assert.Contains("/t 3600", p2.Calls[0]);
        var p3 = new FakeProc(); await new ShutdownHandler(p3).RunAsync(T.Job("system.shutdown", "{}"), default);
        Assert.Contains("/t 60", p3.Calls[0]); Assert.Contains("save your work", p3.Calls[0]);
        Assert.DoesNotContain(" /f", p.Calls[0]); Assert.DoesNotContain("/r", p.Calls[0]);
        var evil = new FakeProc(); Assert.False((await new ShutdownHandler(evil).RunAsync(T.Job("system.shutdown", "{\"message\":\"x\\\" /f /t 0 \\\"\"}"), default)).Success);
        Assert.Empty(evil.Calls);                                                                                     // an unsafe message never reaches the command line
        Assert.Contains("already scheduled", (await new ShutdownHandler(new FakeProc((_, _) => new ProcResult(1190, "", false))).RunAsync(T.Job("system.shutdown", "{}"), default)).Error);
    }

    [Fact]
    public void The_agent_knows_the_shutdown_job()
        => Assert.Contains(JobHandlers.All().ToList(), h => h.Type == "system.shutdown");
}
