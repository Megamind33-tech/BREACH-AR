using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;

namespace WorkCare.QuickCheck;

/// <summary>
/// The phone-facing side of one inspection session: a tiny HTTP carrier (no admin rights needed) and a UDP answer to the phone's "is anyone there" broadcast.
/// HTTP only moves bytes: after the hello, every body is a WCP1 AES-GCM frame, so the carrier could be any transport. The listener exists only while this session is open;
/// closing the session (or the window) stops it, and nothing survives the process.
/// </summary>
public sealed class SessionServer : IDisposable
{
    public const int DiscoveryPort = 47820, HttpPort = 47821;
    readonly Wcp1.PcSession _pc; readonly Func<string, bool, CancellationToken, Task<JsonObject>> _onStartScan;
    TcpListener? _tcp; UdpClient? _udp; CancellationTokenSource _cts = new();
    Wcp1.Channel? _channel; Wcp1.Keys? _keys;
    readonly object _lock = new(); readonly List<(long seq, string kind, JsonObject payload)> _events = [];
    TaskCompletionSource _signal = new(TaskCreationOptions.RunContinuationsAsynchronously);
    string? _scanId;
    public string Code { get; }
    public string? Sas => _keys?.Sas;
    public bool PhoneConnected => _keys is not null;
    public event Action? StateChanged;
    public event Action<JsonObject>? ScanProgress;
    public event Action<JsonObject>? ScanResult;
    public event Action<string>? Failed;

    public SessionServer(string code, Func<string, bool, CancellationToken, Task<JsonObject>> onStartScan, long? now = null)
    {
        Code = code; _onStartScan = onStartScan;
        _pc = Wcp1.PcSession.Create(now ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds(), Wcp1.SecretFromCode(code));
    }
    public long ExpiresAt => _pc.Offer.ExpiresAt;

    public void Start()
    {
        _tcp = new TcpListener(IPAddress.Any, HttpPort); _tcp.Start();
        _ = Task.Run(() => AcceptLoop(_cts.Token));
        try { _udp = new UdpClient(new IPEndPoint(IPAddress.Any, DiscoveryPort)) { EnableBroadcast = true }; _ = Task.Run(() => DiscoveryLoop(_cts.Token)); } catch { /* port busy: manual address still works */ }
    }

    async Task DiscoveryLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var r = await _udp!.ReceiveAsync(ct);
                if (Encoding.UTF8.GetString(r.Buffer).Trim() != "WCP1?" || _pc.Used || _pc.Revoked) continue;      // answer only while a session is waiting
                var reply = Encoding.UTF8.GetBytes(new JsonObject { ["protocol"] = "WCP1", ["port"] = HttpPort, ["session"] = Wcp1.Hex(_pc.Offer.SessionId) }.ToJsonString());
                await _udp.SendAsync(reply, reply.Length, r.RemoteEndPoint);
            }
            catch (OperationCanceledException) { return; } catch (ObjectDisposedException) { return; } catch { }
        }
    }
    async Task AcceptLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { var c = await _tcp!.AcceptTcpClientAsync(ct); _ = Task.Run(() => Handle(c, ct)); }
            catch (OperationCanceledException) { return; } catch (ObjectDisposedException) { return; } catch { }
        }
    }

    async Task Handle(TcpClient client, CancellationToken ct)
    {
        using var _ = client; client.ReceiveTimeout = client.SendTimeout = 20000;
        try
        {
            var remote = (client.Client.RemoteEndPoint as IPEndPoint)?.Address;
            if (remote is null || !IsPrivate(remote)) return;                                   // inspection is local-network only
            var ns = client.GetStream(); var (method, path, body) = await ReadRequest(ns, ct);
            (int code, JsonObject json) res;
            try { res = (method, path) switch { ("GET", "/wcp1/info") => Info(), ("POST", "/wcp1/hello") => Hello(JsonNode.Parse(body)!.AsObject()), ("POST", "/wcp1/msg") => await Message(JsonNode.Parse(body)!.AsObject(), ct), _ => (404, new JsonObject { ["error"] = "not found" }) }; }
            catch (Exception) { res = (400, new JsonObject { ["error"] = "bad request" }); }
            var payload = Encoding.UTF8.GetBytes(res.json.ToJsonString());
            var head = Encoding.ASCII.GetBytes($"HTTP/1.1 {res.code} {(res.code == 200 ? "OK" : "Error")}\r\nContent-Type: application/json\r\nContent-Length: {payload.Length}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n");
            await ns.WriteAsync(head, ct); await ns.WriteAsync(payload, ct);
        }
        catch { /* a dropped connection is not an error worth surfacing */ }
    }
    static bool IsPrivate(IPAddress a)
    {
        if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
        if (IPAddress.IsLoopback(a)) return true; if (a.AddressFamily == AddressFamily.InterNetworkV6) return a.IsIPv6LinkLocal || a.IsIPv6SiteLocal;
        var b = a.GetAddressBytes(); return b[0] == 10 || (b[0] == 172 && b[1] is >= 16 and <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254);
    }
    static async Task<(string method, string path, string body)> ReadRequest(NetworkStream ns, CancellationToken ct)
    {
        var buf = new List<byte>(); var one = new byte[1]; int headEnd = -1;
        while (headEnd < 0 && buf.Count < 16384) { var n = await ns.ReadAsync(one, ct); if (n == 0) break; buf.Add(one[0]); var c = buf.Count; if (c >= 4 && buf[c - 4] == '\r' && buf[c - 3] == '\n' && buf[c - 2] == '\r' && buf[c - 1] == '\n') headEnd = c; }
        var head = Encoding.ASCII.GetString([.. buf]); var lines = head.Split("\r\n"); var first = lines[0].Split(' ');
        var len = lines.Select(l => l.Split(':', 2)).Where(p => p.Length == 2 && p[0].Trim().Equals("content-length", StringComparison.OrdinalIgnoreCase)).Select(p => int.Parse(p[1].Trim())).FirstOrDefault();
        if (len > 1_000_000) throw new InvalidOperationException("too large");
        var body = new byte[len]; var got = 0; while (got < len) { var n = await ns.ReadAsync(body.AsMemory(got, len - got), ct); if (n == 0) break; got += n; }
        return (first[0], first[1], Encoding.UTF8.GetString(body, 0, got));
    }

    (int, JsonObject) Info() => (200, new JsonObject { ["protocol"] = "WCP1", ["session"] = Wcp1.B64u(_pc.Offer.SessionId), ["pcPub"] = Wcp1.B64u(_pc.Offer.PcPub), ["expiresAt"] = _pc.Offer.ExpiresAt });
    (int, JsonObject) Hello(JsonObject b)
    {
        var h = new Wcp1.Hello(Wcp1.UnB64u(b["phonePub"]!.GetValue<string>()), Wcp1.UnB64u(b["nonceP"]!.GetValue<string>()), Wcp1.UnB64u(b["proof"]!.GetValue<string>()));
        var (accept, keys, refusal) = _pc.HandleHello(h, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        if (refusal is not null) return (403, new JsonObject { ["error"] = refusal switch { Wcp1.Refusal.Expired => "expired", Wcp1.Refusal.Locked => "locked", Wcp1.Refusal.Used => "used", Wcp1.Refusal.BadProof => "bad_proof", _ => "malformed" } });
        _keys = keys; _channel = new Wcp1.Channel(keys!, _pc.Offer.SessionId, server: true); StateChanged?.Invoke();
        return (200, new JsonObject { ["nonceC"] = Wcp1.B64u(accept!.NonceC), ["proof"] = Wcp1.B64u(accept.Proof) });
    }
    async Task<(int, JsonObject)> Message(JsonObject b, CancellationToken ct)
    {
        if (_channel is null) return (403, new JsonObject { ["error"] = "no session" });
        JsonObject req; try { req = JsonNode.Parse(Encoding.UTF8.GetString(_channel.Receive(Wcp1.UnB64u(b["frame"]!.GetValue<string>()))))!.AsObject(); } catch { return (403, new JsonObject { ["error"] = "bad frame" }); }
        JsonObject resp;
        switch (req["type"]?.GetValue<string>())
        {
            case "start_scan":
                var deepScan = req["depth"]?.GetValue<string>() == "deep";
                lock (_lock) { if (_scanId is null) { _scanId = Guid.NewGuid().ToString("N")[..12]; var id = _scanId; _ = Task.Run(() => RunScan(id, deepScan)); } }
                resp = new JsonObject { ["scanId"] = _scanId }; break;
            case "poll":
                var since = req["since"]?.GetValue<long>() ?? 0; var wait = Math.Clamp(req["waitMs"]?.GetValue<int>() ?? 0, 0, 8000);
                var deadline = DateTime.UtcNow.AddMilliseconds(wait);
                while (true)
                {
                    Task sig; lock (_lock) { if (_events.Any(e => e.seq > since) || DateTime.UtcNow >= deadline) break; sig = _signal.Task; }
                    await Task.WhenAny(sig, Task.Delay(Math.Max(1, (int)(deadline - DateTime.UtcNow).TotalMilliseconds), ct));
                }
                lock (_lock) { var ev = _events.Where(e => e.seq > since).ToList(); var arr = new JsonArray(); foreach (var e in ev) arr.Add(new JsonObject { ["seq"] = e.seq, ["kind"] = e.kind, ["payload"] = e.payload.DeepClone() }); resp = new JsonObject { ["events"] = arr, ["next"] = ev.Count > 0 ? ev.Max(e => e.seq) : since }; }
                break;
            case "close": resp = new JsonObject { ["ok"] = true }; _ = Task.Run(async () => { await Task.Delay(300); Close(); }); break;
            default: resp = new JsonObject { ["error"] = "unknown request" }; break;
        }
        return (200, new JsonObject { ["frame"] = Wcp1.B64u(_channel.Send(Encoding.UTF8.GetBytes(resp.ToJsonString()))) });
    }

    void Push(string kind, JsonObject payload) { lock (_lock) { _events.Add((_events.Count + 1, kind, payload)); var s = _signal; _signal = new(TaskCreationOptions.RunContinuationsAsynchronously); s.TrySetResult(); } }
    async Task RunScan(string id, bool deep)
    {
        try { var result = await _onStartScan(id, deep, _cts.Token); Push("result", result); ScanResult?.Invoke(result); }
        catch (OperationCanceledException) { }
        catch (Exception e) { Push("error", new JsonObject { ["message"] = "The inspection could not finish: " + e.Message }); Failed?.Invoke(e.Message); }
    }
    /// <summary>Called by the inspection as stages complete.</summary>
    public void Report(JsonObject progress) { Push("progress", progress); ScanProgress?.Invoke(progress); }

    public void Close() { _pc.Revoke(); try { _cts.Cancel(); } catch { } try { _tcp?.Stop(); } catch { } try { _udp?.Dispose(); } catch { } StateChanged?.Invoke(); }
    public void Dispose() => Close();
}
