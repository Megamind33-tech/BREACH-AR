using Viro.Agent;
using Xunit;

public class BenchmarkTests
{
    [Fact]
    public async Task The_benchmark_measures_this_machine_and_reports_unavailable_values_as_null_not_guesses()
    {
        var r = await Benchmark.RunAsync(CancellationToken.None, cpuSamples: 3, cpuInterval: TimeSpan.FromMilliseconds(300));
        var m = r.Metrics;
        Assert.InRange((double)m["ramPercent"]!, 1, 100);
        Assert.True((long)m["ramUsedBytes"]! > 100_000_000);
        Assert.InRange((int)m["processCount"]!, 10, 5000);
        Assert.True((int)m["runningServices"]! > 5);
        Assert.True((long)m["systemFreeBytes"]! > 0);
        Assert.InRange((double)m["diskSyncWriteMs"]!, 0.001, 5000);
        Assert.True(m["cpuAvgPercent"] is null || (double)m["cpuAvgPercent"]! is >= 0 and <= 100);
        Assert.True(m["bootSeconds"] is null || (double)m["bootSeconds"]! > 0);
        Assert.Equal(3, (int)m["cpuSamples"]!);
        Assert.NotNull(m["measuredAt"]); Assert.Equal("benchmark.run", new BenchmarkHandler().Type);
    }

    [Fact]
    public void Boot_time_is_read_from_the_Windows_diagnostics_event_and_ignores_junk()
    {
        const string xml = "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><EventID>100</EventID></System><EventData><Data Name='BootStartTime'>2026-09-30T00:50:22Z</Data><Data Name='BootTime'>74213</Data></EventData></Event>";
        Assert.Equal(74.2, Benchmark.ParseBootSeconds(xml));
        Assert.Null(Benchmark.ParseBootSeconds("<Event><EventData><Data Name='BootTime'>0</Data></EventData></Event>"));
        Assert.Null(Benchmark.ParseBootSeconds("<Event><EventData/></Event>"));
    }
}
