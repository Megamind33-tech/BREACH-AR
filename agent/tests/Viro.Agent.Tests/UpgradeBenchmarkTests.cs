using Viro.Agent.Care;
using Xunit;

public class UpgradeBenchmarkTests
{
    static UpgradeBenchmark.Options Quick(string dir, Func<double?>? temp = null, double abortAt = 95) => new(SingleSeconds: 0.4, SustainedSeconds: 2, MemoryMB: 64, StorageMB: 16, StorageSeconds: 0.4, AbortTempC: abortAt, QuietWaitSeconds: 0, TempReader: temp ?? (() => 61.0), FrequencyReader: () => 3000.0, StorageDir: dir, IgnoreBatteryCheck: true);
    static string TempDir() => Path.Combine(Path.GetTempPath(), "viro-bench-test-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public void A_measurement_reports_every_metric_the_before_and_after_comparison_needs_and_leaves_nothing_behind()
    {
        var dir = TempDir();
        try
        {
            var r = UpgradeBenchmark.Run(Quick(dir), CancellationToken.None);
            var m = (Dictionary<string, object?>)r["metrics"]!; var safety = (Dictionary<string, object?>)r["safety"]!;
            foreach (var k in new[] { "cpuSingleScore", "cpuMultiScore", "cpuSustainedScore", "cpuSustainedRatio", "memBandwidthMBs", "memLatencyNs", "seqReadMBs", "rndRead4kIops", "peakTempC", "idleTempC" })
                Assert.True(m.ContainsKey(k) && Convert.ToDouble(m[k]) > 0, $"{k} was not measured");
            Assert.True(Convert.ToDouble(m["cpuMultiScore"]) >= Convert.ToDouble(m["cpuSingleScore"]) * 0.9, "all threads are not slower than one");
            Assert.InRange(Convert.ToDouble(m["cpuSustainedRatio"]), 0.3, 1.0001);
            Assert.False((bool)safety["aborted"]!);
            Assert.Equal(61.0, Convert.ToDouble(m["peakTempC"]), 1);
            Assert.Empty(Directory.EnumerateFiles(dir, "viro-bench-*.tmp"));            // the one temporary file was removed
        }
        finally { try { Directory.Delete(dir, true); } catch (IOException) { } }
    }

    [Fact]
    public void It_stops_at_once_when_the_processor_gets_too_hot_and_does_not_go_on_to_stress_anything_else()
    {
        var dir = TempDir();
        try
        {
            var calls = 0; var r = UpgradeBenchmark.Run(Quick(dir, () => ++calls <= 2 ? 60.0 : 97.0), CancellationToken.None);
            var safety = (Dictionary<string, object?>)r["safety"]!; var m = (Dictionary<string, object?>)r["metrics"]!;
            Assert.True((bool)safety["aborted"]!); Assert.Contains("95", (string)safety["reason"]!); Assert.False(m.ContainsKey("seqReadMBs")); Assert.False(m.ContainsKey("memBandwidthMBs"));
            Assert.True(Convert.ToDouble(safety["durationSeconds"]) < 20, "a full run takes over a minute; an aborted one stops far sooner");
        }
        finally { try { Directory.Delete(dir, true); } catch (IOException) { } }
    }

    [Fact]
    public void A_busy_computer_is_reported_as_noisy_so_its_figures_are_not_judged()
    {
        var dir = TempDir();
        try
        {
            var r = UpgradeBenchmark.Run(Quick(dir) with { QuietBelowPercent = -1 }, CancellationToken.None);   // any load at all counts as busy
            Assert.True((bool)((Dictionary<string, object?>)r["safety"]!)["noisy"]!);
        }
        finally { try { Directory.Delete(dir, true); } catch (IOException) { } }
    }

    [Fact]
    public void Without_a_temperature_sensor_it_says_so_instead_of_inventing_a_reading()
    {
        var dir = TempDir();
        try
        {
            var r = UpgradeBenchmark.Run(Quick(dir, () => null), CancellationToken.None); var m = (Dictionary<string, object?>)r["metrics"]!;
            Assert.False(m.ContainsKey("peakTempC")); Assert.False(m.ContainsKey("idleTempC"));
            Assert.Contains(((List<object>)r["unavailable"]!), x => x.ToString()!.Contains("Temperature"));
        }
        finally { try { Directory.Delete(dir, true); } catch (IOException) { } }
    }
}
