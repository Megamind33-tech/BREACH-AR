using System.Text.Json;
using Viro.Compute;
using Xunit;

public class SessionReportingTests
{
    static readonly DateTime T0 = new(2026, 10, 2, 12, 0, 0, DateTimeKind.Utc);
    static JsonElement Json(object o) => JsonSerializer.SerializeToElement(o, new JsonSerializerOptions(JsonSerializerDefaults.Web));

    [Fact]
    public void Summary_reads_hashrate_shares_and_pool_uptime()
    {
        var s = MinerSummary.Parse("""{"hashrate":{"total":[512.34,500,0]},"connection":{"uptime":120,"accepted":7,"rejected":1,"pool":"x"}}""");
        Assert.Equal(512.3, s.Hashrate); Assert.Equal(7, s.Accepted); Assert.Equal(1, s.Rejected); Assert.Equal(120, s.PoolUptimeSeconds); Assert.True(s.PoolConnected);
        Assert.False(MinerSummary.Parse("""{"connection":{"uptime":0}}""").PoolConnected);
    }

    [Theory]
    [InlineData("")] [InlineData("not json")] [InlineData("[]")] [InlineData("{}")]
    [InlineData("""{"hashrate":{"total":[-5]},"connection":{"uptime":-1,"accepted":-3,"rejected":"x"}}""")]
    [InlineData("""{"hashrate":{"total":[null]},"connection":null}""")]
    public void Malformed_or_negative_summaries_read_as_not_reported_never_as_guesses(string json)
    {
        var s = MinerSummary.Parse(json);
        Assert.Null(s.Hashrate); Assert.Null(s.Accepted); Assert.Null(s.Rejected); Assert.Null(s.PoolUptimeSeconds); Assert.Null(s.PoolConnected);
    }

    [Fact]
    public void Tracker_follows_one_run_with_average_peak_and_cumulative_shares()
    {
        var t = new SessionTracker(); Assert.False(t.Active);
        t.Start(T0, "6.21.0", "0.1.0"); Assert.True(t.Active);
        t.Observe(T0.AddSeconds(20), new(100, 1, 0, 20)); t.Observe(T0.AddSeconds(40), new(300, 3, 1, 40)); t.Observe(T0.AddSeconds(60), new(200, 4, 1, 60));
        Assert.Equal(200, t.AverageHashrate); Assert.Equal(300, t.PeakHashrate); Assert.Equal(4, t.Accepted); Assert.Equal(1, t.Rejected);
    }

    [Fact]
    public void Share_counters_that_restart_at_zero_after_a_reconnect_keep_counting_up()
    {
        var t = new SessionTracker(); t.Start(T0, null, null);
        t.Observe(T0.AddSeconds(20), new(null, 5, 2, 20));
        t.Observe(T0.AddSeconds(40), new(null, 1, 0, 5));       // the engine reconnected: its own counters began again
        t.Observe(T0.AddSeconds(60), new(null, 3, 1, 25));
        Assert.Equal(5 + 1 + 2, t.Accepted); Assert.Equal(2 + 0 + 1, t.Rejected);
    }

    [Fact]
    public void Missing_readings_are_null_in_the_report_not_zero()
    {
        var t = new SessionTracker(); t.Start(T0, null, null);
        var r = Json(t.Report(T0.AddSeconds(30), new SessionSample(null, null, null)));
        Assert.Equal(JsonValueKind.Null, r.GetProperty("averageHashrate").ValueKind); Assert.Equal(JsonValueKind.Null, r.GetProperty("peakHashrate").ValueKind);
        Assert.Equal(JsonValueKind.Null, r.GetProperty("stoppedAt").ValueKind); Assert.Equal(JsonValueKind.Null, r.GetProperty("stopReason").ValueKind);
        var s = r.GetProperty("sample");
        foreach (var f in new[] { "hashrate", "cpuUsagePercent", "cpuTempC", "memoryPercent", "poolConnected", "lastShareAt" }) Assert.Equal(JsonValueKind.Null, s.GetProperty(f).ValueKind);
        Assert.Equal(30, r.GetProperty("runtimeSeconds").GetDouble());
    }

    [Fact]
    public void A_sample_carries_the_latest_rate_pool_state_and_the_time_a_share_was_last_seen()
    {
        var t = new SessionTracker(); t.Start(T0, "e", "w");
        t.Observe(T0.AddSeconds(20), new(111, 1, 0, 20)); t.Observe(T0.AddSeconds(40), new(222, 1, 0, 40));
        var s = Json(t.Report(T0.AddSeconds(45), new SessionSample(25, 61, 40))).GetProperty("sample");
        Assert.Equal(222, s.GetProperty("hashrate").GetDouble()); Assert.True(s.GetProperty("poolConnected").GetBoolean()); Assert.Equal(61, s.GetProperty("cpuTempC").GetDouble());
        Assert.Equal(T0.AddSeconds(20), s.GetProperty("lastShareAt").GetDateTime().ToUniversalTime());
    }

    [Fact]
    public void Stop_closes_the_run_with_its_reason_and_a_new_run_gets_a_new_id()
    {
        var t = new SessionTracker(); t.Start(T0, "e", "w"); var first = t.SessionId;
        var r = Json(t.Stop(T0.AddMinutes(5), "user came back"));
        Assert.False(t.Active); Assert.Equal("user came back", r.GetProperty("stopReason").GetString()); Assert.Equal(300, r.GetProperty("runtimeSeconds").GetDouble());
        Assert.Equal(first, r.GetProperty("sessionId").GetGuid()); Assert.Equal(T0.AddMinutes(5), r.GetProperty("stoppedAt").GetDateTime().ToUniversalTime());
        Assert.Equal("stopped", Json(Start(T0, "  ")).GetProperty("stopReason").GetString());
        t.Start(T0.AddMinutes(10), "e", "w"); Assert.NotEqual(first, t.SessionId);
        Assert.Equal(300, Json(Start(T0, new string('x', 900))).GetProperty("stopReason").GetString()!.Length);
        static object Start(DateTime at, string reason) { var x = new SessionTracker(); x.Start(at, null, null); return x.Stop(at.AddSeconds(1), reason); }
    }

    [Fact]
    public void An_undelivered_stop_report_survives_on_disk_until_cleared()
    {
        var dir = Path.Combine(Path.GetTempPath(), "viro-outbox-" + Guid.NewGuid().ToString("N"));
        try
        {
            var box = new SessionOutbox(dir); Assert.Null(box.Load());
            var t = new SessionTracker(); t.Start(T0, "e", "w"); var rep = t.Stop(T0.AddSeconds(90), "engine exited");
            box.Save(rep);
            var back = JsonDocument.Parse(new SessionOutbox(dir).Load()!).RootElement;     // a fresh instance: it is the file that remembers
            Assert.Equal("engine exited", back.GetProperty("stopReason").GetString()); Assert.Equal(t.SessionId, back.GetProperty("sessionId").GetGuid());
            box.Clear(); Assert.Null(box.Load());
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }
}
