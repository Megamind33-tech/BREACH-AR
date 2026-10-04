using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.RegularExpressions;
using Viro.Agent.Repair;

namespace Viro.Agent;

/// <summary>One physical network adapter that is connected, as Control needs it to wake this PC later: its hardware address and which network it is on.</summary>
public sealed record NetAdapterFact(string Name, string Mac, string Ip, int Prefix, string? Gateway, bool Wired, bool? WakeOnMagicPacket);

public static partial class WakeOnLan
{
    [GeneratedRegex(@"^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")] public static partial Regex MacFormat();
    static readonly Regex Virtual = new(@"virtual|vmware|vbox|virtualbox|hyper-v|vethernet|tap-|tunnel|loopback|bluetooth|wan miniport|vpn|npcap|docker|wsl", RegexOptions.IgnoreCase);

    /// <summary>The connected physical adapters with an IPv4 address. Virtual, VPN and Bluetooth adapters are never listed: they cannot be woken.</summary>
    public static List<NetAdapterFact> Adapters(IReadOnlyDictionary<string, bool>? wakeByName = null)
    {
        var o = new List<NetAdapterFact>();
        foreach (var n in NetworkInterface.GetAllNetworkInterfaces())
        {
            try
            {
                if (n.OperationalStatus != OperationalStatus.Up || n.NetworkInterfaceType is not (NetworkInterfaceType.Ethernet or NetworkInterfaceType.Wireless80211 or NetworkInterfaceType.GigabitEthernet)) continue;
                if (Virtual.IsMatch(n.Description) || Virtual.IsMatch(n.Name)) continue;
                var mac = n.GetPhysicalAddress().GetAddressBytes(); if (mac.Length != 6) continue;
                var props = n.GetIPProperties();
                var ip = props.UnicastAddresses.FirstOrDefault(a => a.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a.Address) && !a.Address.ToString().StartsWith("169.254"));
                if (ip is null) continue;
                var gw = props.GatewayAddresses.FirstOrDefault(g => g.Address.AddressFamily == AddressFamily.InterNetwork)?.Address.ToString();
                bool? wol = wakeByName is not null && wakeByName.TryGetValue(n.Name, out var w) ? w : null;
                o.Add(new(n.Name, string.Join(":", mac.Select(b => b.ToString("X2"))), ip.Address.ToString(), ip.PrefixLength, gw, n.NetworkInterfaceType != NetworkInterfaceType.Wireless80211, wol));
            }
            catch (Exception e) when (e is NetworkInformationException or InvalidOperationException) { /* adapter changed while reading */ }
        }
        return o;
    }

    public static byte[] MagicPacket(string mac)
    {
        if (!MacFormat().IsMatch(mac)) throw new ArgumentException("not a MAC address");
        var m = mac.Split(':', '-').Select(x => Convert.ToByte(x, 16)).ToArray();
        var p = new byte[6 + 16 * 6]; Array.Fill(p, (byte)0xFF, 0, 6);
        for (var i = 0; i < 16; i++) Buffer.BlockCopy(m, 0, p, 6 + i * 6, 6);
        return p;
    }

    /// <summary>The directed broadcast address of a network (for example 192.168.1.255 for 192.168.1.9/24).</summary>
    public static IPAddress Broadcast(IPAddress ip, int prefix)
    {
        var b = ip.GetAddressBytes(); var mask = prefix <= 0 ? 0u : uint.MaxValue << (32 - Math.Min(prefix, 32));
        var v = (uint)(b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]); var bc = v | ~mask;
        return new IPAddress([(byte)(bc >> 24), (byte)(bc >> 16), (byte)(bc >> 8), (byte)bc]);
    }
}

/// <summary>wol.send { mac, broadcasts[] }: sends the "magic packet" that wakes a sleeping or switched-off PC on this same network. Runs on a PC that is awake; Control picks one on the target's network.</summary>
public sealed class WakeOnLanHandler(Func<IReadOnlyList<(IPAddress local, IPAddress broadcast)>>? interfaces = null, Func<IPAddress, IPAddress, int, byte[], Task>? send = null) : IJobHandler
{
    public string Type => "wol.send";
    static readonly int[] Ports = [9, 7];

    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var p = ctx.Job.Params;
        var mac = p.TryGetProperty("mac", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString()! : "";
        if (!WakeOnLan.MacFormat().IsMatch(mac)) return new(false, null, "that is not a valid hardware address");
        var asked = new List<IPAddress>();
        if (p.TryGetProperty("broadcasts", out var b) && b.ValueKind == JsonValueKind.Array)
            foreach (var x in b.EnumerateArray()) if (x.ValueKind == JsonValueKind.String && IPAddress.TryParse(x.GetString(), out var a) && a.AddressFamily == AddressFamily.InterNetwork) asked.Add(a);
        var packet = WakeOnLan.MagicPacket(mac);
        var ifs = (interfaces ?? Local)();
        if (ifs.Count == 0) return new(false, null, "this PC has no connected network adapter to send from");
        var sent = new List<string>();
        foreach (var (local, bc) in ifs)
            foreach (var target in asked.Count == 0 ? [bc] : asked.Append(bc).Distinct().ToList())
                foreach (var port in Ports)
                {
                    try { await (send ?? Send)(local, target, port, packet); sent.Add($"{local} -> {target}:{port}"); }
                    catch (Exception e) when (e is SocketException or InvalidOperationException) { /* this route is not usable; the others may be */ }
                }
        return sent.Count > 0 ? new(true, new { sent = sent.Count, routes = sent.Take(8) }) : new(false, null, "the wake-up signal could not be sent from this PC");
    }

    static IReadOnlyList<(IPAddress, IPAddress)> Local() => [.. WakeOnLan.Adapters().Select(a => { var ip = IPAddress.Parse(a.Ip); return (ip, WakeOnLan.Broadcast(ip, a.Prefix)); })];

    static async Task Send(IPAddress local, IPAddress target, int port, byte[] packet)
    {
        using var u = new UdpClient(new IPEndPoint(local, 0)) { EnableBroadcast = true };      // leave through the right adapter on a PC with more than one
        await u.SendAsync(packet, new IPEndPoint(target, port));
    }
}

/// <summary>power.wol-enable: turns on "Wake on Magic Packet" for the physical adapters that support it, so this PC can be woken from the console. Reversible. Windows is only half of it: the PC's BIOS or UEFI setting must allow it too, and Viro cannot read that.</summary>
public sealed class WakeOnLanEnableRecipe : IRepairRecipe
{
    public string Id => "power.wol-enable"; public string Title => "Allow this PC to be woken from the console (Wake-on-LAN)";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => true;
    sealed record Nic(string Name, string Wake);

    static async Task<List<Nic>> ReadAsync(RepairContext c, CancellationToken ct)
    {
        var r = await c.Proc.RunAsync("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object { $p = Get-NetAdapterPowerManagement -Name $_.Name -ErrorAction SilentlyContinue; [pscustomobject]@{ Name = $_.Name; Wake = [string]$p.WakeOnMagicPacket } } | ConvertTo-Json -Compress\"", TimeSpan.FromSeconds(60), ct);
        if (r.ExitCode != 0 || string.IsNullOrWhiteSpace(r.Output)) return [];
        try
        {
            using var d = JsonDocument.Parse(r.Output.Trim()); var items = d.RootElement.ValueKind == JsonValueKind.Array ? d.RootElement.EnumerateArray().ToList() : [d.RootElement];
            return [.. items.Select(x => new Nic(x.GetProperty("Name").GetString() ?? "", x.GetProperty("Wake").GetString() ?? "")).Where(n => n.Name.Length > 0)];
        }
        catch (JsonException) { return []; }
    }
    static bool Safe(string name) => Regex.IsMatch(name, @"^[\p{L}\p{N} ._\-()#]{1,80}$");

    public async Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var all = await ReadAsync(c, ct);
        var off = all.Where(n => n.Wake.Equals("Disabled", StringComparison.OrdinalIgnoreCase) && Safe(n.Name)).ToList();
        var unsupported = all.Count(n => n.Wake is "" or "Unsupported");
        return new(off.Count > 0, off.Count > 0 ? $"Wake on Magic Packet is off on {string.Join(", ", off.Select(n => n.Name))} and will be turned on" : all.Count == 0 ? "no connected physical network adapter was found" : unsupported == all.Count ? "the network adapter(s) do not offer Wake-on-LAN in Windows (common for Wi-Fi); use a cable and a network card that supports it" : "Wake on Magic Packet is already on", off);
    }

    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var prior = new List<object>(); c.RollbackState["adapters"] = prior;
        foreach (var n in (List<Nic>)f.Before!)
        {
            prior.Add(new { n.Name, previous = "Disabled" });
            var r = await c.Proc.RunAsync("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"Set-NetAdapterPowerManagement -Name '{n.Name}' -WakeOnMagicPacket Enabled -ErrorAction Stop\"", TimeSpan.FromSeconds(60), ct);
            if (r.ExitCode != 0) throw new InvalidOperationException($"Windows would not change {n.Name}: {r.Output.Trim().Split('\n').FirstOrDefault()?.Trim()}");
        }
    }

    public async Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var names = ((List<Nic>)f.Before!).Select(n => n.Name).ToHashSet(); var now = await ReadAsync(c, ct);
        var still = now.Where(n => names.Contains(n.Name) && !n.Wake.Equals("Enabled", StringComparison.OrdinalIgnoreCase)).Select(n => n.Name).ToList();
        return (still.Count == 0, still.Count == 0 ? "Wake on Magic Packet is on in Windows. Make sure Wake-on-LAN is also allowed in the PC's BIOS or UEFI settings." : "still off: " + string.Join(", ", still));
    }

    public async Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        foreach (var e in saved.GetProperty("adapters").EnumerateArray())
        {
            var name = e.GetProperty("name").GetString()!; if (!Safe(name)) continue;
            await c.Proc.RunAsync("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"Set-NetAdapterPowerManagement -Name '{name}' -WakeOnMagicPacket Disabled\"", TimeSpan.FromSeconds(60), ct);
        }
    }
}

/// <summary>The network facts sent with each heartbeat. Adapter addresses are read every time (cheap); whether Windows allows waking each adapter is read by PowerShell in the background about every half hour.</summary>
public static class NetworkFacts
{
    static IReadOnlyDictionary<string, bool> wake = new Dictionary<string, bool>();
    static DateTime readAt = DateTime.MinValue; static int busy;

    public static List<NetAdapterFact> Current()
    {
        if (DateTime.UtcNow - readAt > TimeSpan.FromMinutes(30) && Interlocked.Exchange(ref busy, 1) == 0)
            _ = Task.Run(async () =>
            {
                try
                {
                    var r = await new SystemProcessRunner().RunAsync("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"Get-NetAdapter -Physical | ForEach-Object { $p = Get-NetAdapterPowerManagement -Name $_.Name -ErrorAction SilentlyContinue; [pscustomobject]@{ Name = $_.Name; Wake = [string]$p.WakeOnMagicPacket } } | ConvertTo-Json -Compress\"", TimeSpan.FromSeconds(60), CancellationToken.None);
                    if (r.ExitCode == 0 && !string.IsNullOrWhiteSpace(r.Output))
                    {
                        using var d = JsonDocument.Parse(r.Output.Trim()); var items = d.RootElement.ValueKind == JsonValueKind.Array ? d.RootElement.EnumerateArray().ToList() : [d.RootElement];
                        wake = items.ToDictionary(x => x.GetProperty("Name").GetString() ?? "", x => string.Equals(x.GetProperty("Wake").GetString(), "Enabled", StringComparison.OrdinalIgnoreCase));
                    }
                }
                catch (Exception e) when (e is JsonException or InvalidOperationException or System.ComponentModel.Win32Exception or ArgumentException) { /* unknown stays unknown */ }
                finally { readAt = DateTime.UtcNow; Interlocked.Exchange(ref busy, 0); }
            });
        return WakeOnLan.Adapters(wake);
    }
}
