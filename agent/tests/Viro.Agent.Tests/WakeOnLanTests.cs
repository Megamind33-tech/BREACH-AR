using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Viro.Agent;
using Viro.Agent.Repair;
using Xunit;

public class WakeOnLanTests
{
    [Fact]
    public void The_magic_packet_has_the_exact_wire_format()
    {
        var p = WakeOnLan.MagicPacket("aa-bb-cc-00-11-22");
        Assert.Equal(102, p.Length);
        Assert.All(p.Take(6), b => Assert.Equal(0xFF, b));
        for (var i = 0; i < 16; i++) Assert.Equal(new byte[] { 0xAA, 0xBB, 0xCC, 0x00, 0x11, 0x22 }, p.Skip(6 + i * 6).Take(6).ToArray());
        foreach (var bad in new[] { "", "AA:BB:CC:00:11", "AA:BB:CC:00:11:2G", "AA:BB:CC:00:11:22:33", "../../etc" }) Assert.Throws<ArgumentException>(() => WakeOnLan.MagicPacket(bad));
    }

    [Fact]
    public void Directed_broadcast_addresses_are_computed_per_network()
    {
        Assert.Equal("192.168.1.255", WakeOnLan.Broadcast(IPAddress.Parse("192.168.1.9"), 24).ToString());
        Assert.Equal("10.4.255.255", WakeOnLan.Broadcast(IPAddress.Parse("10.4.7.200"), 16).ToString());
        Assert.Equal("172.16.5.255", WakeOnLan.Broadcast(IPAddress.Parse("172.16.5.130"), 25).ToString());
    }

    static VerifiedJobHolder Job(string json) => new(json);
    sealed class VerifiedJobHolder(string json) { public JobContext Ctx => T.Job("wol.send", json); }

    [Fact]
    public async Task The_signal_leaves_through_each_adapter_to_the_targets_network_on_both_wake_ports()
    {
        var sent = new List<(string local, string to, int port, int len)>();
        var h = new WakeOnLanHandler(() => [(IPAddress.Parse("192.168.1.20"), IPAddress.Parse("192.168.1.255"))], (l, t, p, b) => { sent.Add((l.ToString(), t.ToString(), p, b.Length)); return Task.CompletedTask; });
        var r = await h.RunAsync(Job("{\"mac\":\"AA:BB:CC:00:11:22\",\"broadcasts\":[\"192.168.1.255\",\"192.168.1.255\"]}").Ctx, default);
        Assert.True(r.Success);
        Assert.Equal(new[] { 9, 7 }, sent.Select(s => s.port).ToArray());                                           // asked address and the adapter's own broadcast are the same: sent once per port
        Assert.All(sent, s => { Assert.Equal("192.168.1.20", s.local); Assert.Equal("192.168.1.255", s.to); Assert.Equal(102, s.len); });
    }

    [Fact]
    public async Task A_bad_address_sends_nothing_and_a_failing_route_does_not_stop_the_others()
    {
        var sent = 0; var h0 = new WakeOnLanHandler(() => [(IPAddress.Loopback, IPAddress.Broadcast)], (_, _, _, _) => { sent++; return Task.CompletedTask; });
        Assert.False((await h0.RunAsync(Job("{\"mac\":\"nonsense\"}").Ctx, default)).Success); Assert.Equal(0, sent);
        Assert.False((await new WakeOnLanHandler(() => [], (_, _, _, _) => Task.CompletedTask).RunAsync(Job("{\"mac\":\"AA:BB:CC:00:11:22\"}").Ctx, default)).Success);
        var n = 0; var flaky = new WakeOnLanHandler(() => [(IPAddress.Parse("10.0.0.5"), IPAddress.Parse("10.0.0.255")), (IPAddress.Parse("192.168.1.5"), IPAddress.Parse("192.168.1.255"))],
            (l, _, _, _) => { if (l.ToString().StartsWith("10.")) throw new System.Net.Sockets.SocketException(); n++; return Task.CompletedTask; });
        var r = await flaky.RunAsync(Job("{\"mac\":\"AA:BB:CC:00:11:22\"}").Ctx, default);
        Assert.True(r.Success); Assert.Equal(2, n);
    }

    [Fact]
    public async Task Allowing_wake_is_diagnosed_applied_verified_and_reversible()
    {
        var wake = "Disabled";
        var proc = new FakeProc((exe, args) =>
        {
            if (args.Contains("Set-NetAdapterPowerManagement") && args.Contains("Enabled")) { wake = "Enabled"; return new(0, "", false); }
            if (args.Contains("Set-NetAdapterPowerManagement") && args.Contains("Disabled")) { wake = "Disabled"; return new(0, "", false); }
            return new(0, $"{{\"Name\":\"Ethernet\",\"Wake\":\"{wake}\"}}", false);
        });
        var r = new WakeOnLanEnableRecipe(); var env = new SlowEnv();
        RepairContext Ctx() => new(env, proc, new FakeServices(), NullLogger.Instance, JsonDocument.Parse("{}").RootElement);
        var rep = await RepairEngine.RunAsync(r, Ctx(), default);
        Assert.True(rep.Applied && rep.Verified == true, rep.Summary); Assert.Contains("BIOS", rep.Steps.Last().Detail);   // Windows is only half of it, and the answer says so
        Assert.Contains("No action needed", (await RepairEngine.RunAsync(r, Ctx(), default)).Summary);
        await RepairEngine.RollbackAsync(Recipes.All.ToDictionary(x => x.Key, x => x.Key == r.Id ? (IRepairRecipe)r : x.Value), rep.RepairId, Ctx(), default);
        Assert.Equal("Disabled", wake);
        // an adapter that does not offer wake at all (typical for Wi-Fi) is reported honestly and never "fixed"
        var wifi = new FakeProc((_, _) => new(0, "{\"Name\":\"Wi-Fi\",\"Wake\":\"Unsupported\"}", false));
        var none = await RepairEngine.RunAsync(r, new RepairContext(env, wifi, new FakeServices(), NullLogger.Instance, JsonDocument.Parse("{}").RootElement), default);
        Assert.False(none.Applied); Assert.Contains("do not offer Wake-on-LAN", none.Steps.First().Detail);
        Assert.Equal(RepairRisk.Review, Recipes.All["power.wol-enable"].Risk);
    }

    [Fact]
    public void This_pcs_adapters_are_read_without_virtual_ones()
        => Assert.All(WakeOnLan.Adapters(), a => { Assert.Matches("^([0-9A-F]{2}:){5}[0-9A-F]{2}$", a.Mac); Assert.DoesNotMatch("(?i)virtual|vmware|hyper-v|loopback", a.Name); });
}
