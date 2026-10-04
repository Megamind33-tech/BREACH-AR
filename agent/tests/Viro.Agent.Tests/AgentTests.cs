using System.Text.Json;
using Viro.Agent;
using Xunit;

public class OfflineQueueTests
{
    static string Tmp() => Path.Combine(Path.GetTempPath(), "viro-q-" + Guid.NewGuid().ToString("N") + ".jsonl");
    static JsonElement J(int n) => JsonDocument.Parse($"{{\"n\":{n}}}").RootElement.Clone();

    [Fact]
    public async Task Drains_in_order_and_survives_a_new_instance()
    {
        var p = Tmp();
        var q = new OfflineQueue(p);
        for (var i = 1; i <= 3; i++) q.Enqueue(J(i));
        var seen = new List<int>();
        var restarted = new OfflineQueue(p); // simulates reboot
        Assert.Equal(3, await restarted.DrainAsync(e => { seen.Add(e.GetProperty("n").GetInt32()); return Task.CompletedTask; }));
        Assert.Equal([1, 2, 3], seen);
        Assert.Equal(0, restarted.Count);
    }

    [Fact]
    public async Task Failure_keeps_unsent_items()
    {
        var q = new OfflineQueue(Tmp());
        q.Enqueue(J(1)); q.Enqueue(J(2));
        var calls = 0;
        await Assert.ThrowsAsync<HttpRequestException>(() => q.DrainAsync(_ => ++calls == 2 ? throw new HttpRequestException() : Task.CompletedTask));
        Assert.Equal(1, q.Count);
    }

    [Fact]
    public void Capacity_drops_oldest()
    {
        var q = new OfflineQueue(Tmp(), capacity: 2);
        for (var i = 1; i <= 4; i++) q.Enqueue(J(i));
        Assert.Equal(2, q.Count);
    }
}

public class ClientTests
{
    [Fact] public void Refuses_plain_http_to_remote_hosts() => Assert.Throws<ArgumentException>(() => new ControlClient("http://control.example.com"));
    [Fact] public void Allows_http_on_loopback_for_development() => _ = new ControlClient("http://localhost:8080");
}

public class CollectorTests
{
    [Fact]
    public void Real_hardware_and_metrics_are_collected()
    {
        var hw = Collectors.Hardware();
        Assert.False(string.IsNullOrEmpty(hw["cpu"] as string));
        Assert.True((hw["ramBytes"] as long?) > 0);
        Collectors.CpuPercent();
        Thread.Sleep(300);
        var m = Collectors.Metrics();
        Assert.InRange((double)m["ramPercent"]!, 1, 100);
        Assert.True((long)m["systemDiskTotalBytes"]! > 0);
        Assert.NotEmpty(Collectors.Software());
        Assert.NotEmpty(Collectors.MachineGuid());
    }
}

public class HealthCollectorTests
{
    [Fact]
    public async Task Snapshot_contains_real_measurements_and_serializes()
    {
        var snap = await HealthCollector.CollectAsync(new UpdateStateCache());
        var json = System.Text.Json.JsonSerializer.Serialize(snap, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
        using var doc = System.Text.Json.JsonDocument.Parse(json);
        var root = doc.RootElement;
        Assert.True(root.GetProperty("memory").GetProperty("totalBytes").GetInt64() > 0);
        Assert.Contains(root.GetProperty("volumes").EnumerateArray(), v => v.GetProperty("isSystem").GetBoolean());
        Assert.InRange(root.GetProperty("perf").GetProperty("ramPercent").GetDouble(), 1, 100);
        Assert.True(root.GetProperty("processes").GetArrayLength() > 0);
        // Application crash entries must be real Application Error / Hang records, never arbitrary event-1000 log noise.
        foreach (var c in root.GetProperty("crashes").EnumerateArray())
            Assert.DoesNotContain("Category:", c.GetProperty("app").GetString());
    }
}

public class TransientTests
{
    static HttpRequestException Ex(System.Net.HttpStatusCode? c) => new("x", null, c);
    [Theory] [InlineData(400)] [InlineData(404)] [InlineData(409)] [InlineData(422)]
    public void Permanent_client_errors_are_never_retried(int code) => Assert.True(Transient.IsPermanentRejection(Ex((System.Net.HttpStatusCode)code)));
    [Theory] [InlineData(401)] [InlineData(408)] [InlineData(429)] [InlineData(500)] [InlineData(502)] [InlineData(503)]
    public void Auth_timeouts_throttling_and_server_errors_are_retried(int code) => Assert.False(Transient.IsPermanentRejection(Ex((System.Net.HttpStatusCode)code)));
    [Fact] public void Network_failures_without_a_status_are_retried() => Assert.False(Transient.IsPermanentRejection(Ex(null)));
}
