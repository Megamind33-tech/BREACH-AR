using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Viro.Agent;

public sealed record EnrollResult(string DeviceId, string DeviceSecret, int HeartbeatIntervalSeconds, string JobSigningPublicKey, string OrganizationId);

/// <summary>Which workspace an enrollment token belongs to, as the server reports it. Looking it up uses nothing up.</summary>
public sealed record EnrollCheck(string OrganizationId, string OrganizationName, string? SiteName, string? DepartmentName);

public sealed class AuthRejectedException(string message) : Exception(message);

/// <summary>Thin client for the Viro Control agent channel. TLS is enforced for any non-loopback server.</summary>
public sealed class ControlClient
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    readonly HttpClient _http;

    public ControlClient(string serverUrl, HttpMessageHandler? handler = null)
    {
        var uri = new Uri(serverUrl.TrimEnd('/') + "/");
        if (!AllowsPlainHttp(uri))
            throw new ArgumentException("Viro Control must be reached over https (plain http is only allowed for this computer and private local-network addresses, for testing).");
        _http = handler is null ? new HttpClient() : new HttpClient(handler);
        _http.BaseAddress = uri;
        _http.Timeout = TimeSpan.FromSeconds(30);
    }

    /// <summary>https is always fine. Plain http is accepted only when the server is this computer or a literal private local-network address (10.x, 172.16-31.x, 192.168.x), which never leaves the building.</summary>
    public static bool AllowsPlainHttp(Uri u)
    {
        if (u.Scheme == Uri.UriSchemeHttps || u.IsLoopback) return true;
        if (u.Scheme != Uri.UriSchemeHttp || !System.Net.IPAddress.TryParse(u.Host, out var ip) || ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) return false;
        var b = ip.GetAddressBytes();
        return b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168);
    }

    string? _bearer;
    public void UseDevice(string deviceId, string secret)
    {
        _bearer = $"{deviceId}.{secret}";
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _bearer);
    }

    /// <summary>Opens the WebSocket for one support session (wss for https servers, ws for loopback development).</summary>
    public async Task<IMessageChannel> ConnectSessionAsync(string sessionId, CancellationToken ct)
    {
        var b = _http.BaseAddress!;
        var uri = new UriBuilder(b) { Scheme = b.Scheme == Uri.UriSchemeHttps ? "wss" : "ws", Path = $"{b.AbsolutePath.TrimEnd('/')}/agent/v1/sessions/{sessionId}/ws" }.Uri;
        var ws = new System.Net.WebSockets.ClientWebSocket();
        ws.Options.SetRequestHeader("Authorization", "Bearer " + _bearer);
        await ws.ConnectAsync(uri, ct);
        return new WebSocketChannel(ws);
    }

    public async Task<EnrollCheck> CheckEnrollmentAsync(string token, CancellationToken ct)
    {
        using var r = await _http.PostAsJsonAsync("agent/v1/enroll/check", new { enrollmentToken = token }, Json, ct);
        if (r.StatusCode == HttpStatusCode.Unauthorized) throw new AuthRejectedException("this code is not valid, or it has expired or already been used");
        r.EnsureSuccessStatusCode();
        var b = await r.Content.ReadFromJsonAsync<JsonElement>(Json, ct);
        string? S(string n) => b.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        return new(S("organizationId") ?? "", S("organizationName") ?? "another workspace", S("siteName"), S("departmentName"));
    }

    public async Task<EnrollResult> EnrollAsync(string token, string machineGuid, string hostname, string agentVersion, CancellationToken ct)
    {
        using var r = await _http.PostAsJsonAsync("agent/v1/enroll", new { enrollmentToken = token, machineGuid, hostname, agentVersion }, Json, ct);
        if (r.StatusCode == HttpStatusCode.Unauthorized) throw new AuthRejectedException("enrollment token rejected");
        r.EnsureSuccessStatusCode();
        var b = await r.Content.ReadFromJsonAsync<JsonElement>(Json, ct);
        return new(b.GetProperty("deviceId").GetString()!, b.GetProperty("deviceSecret").GetString()!,
                   b.TryGetProperty("heartbeatIntervalSeconds", out var i) ? i.GetInt32() : 30,
                   b.GetProperty("jobSigningPublicKey").GetString()!, b.GetProperty("organizationId").GetString()!);
    }

    public async Task<HeartbeatReply> SendHeartbeatAsync(object body, CancellationToken ct)
    {
        using var doc = await SendAsync(HttpMethod.Post, "agent/v1/heartbeat", body, ct);
        var root = doc!.RootElement;
        var jobs = root.TryGetProperty("jobs", out var j) ? j.EnumerateArray().Select(x => new JobEnvelope(x.GetProperty("id").GetString()!, x.GetProperty("payload").GetString()!, x.GetProperty("signature").GetString()!)).ToList() : [];
        var cancel = root.TryGetProperty("cancel", out var c) ? c.EnumerateArray().Select(x => x.GetString()!).ToList() : [];
        UpdateOffer? offer = null;
        if (root.TryGetProperty("update", out var u) && u.ValueKind == JsonValueKind.Object)
            offer = new(u.GetProperty("version").GetString()!, u.GetProperty("url").GetString()!, u.GetProperty("manifest").GetString()!, u.GetProperty("signature").GetString()!, u.GetProperty("sha256").GetString()!, u.GetProperty("size").GetInt64());
        var sessions = root.TryGetProperty("sessions", out var ss) && ss.ValueKind == JsonValueKind.Array ? ss.EnumerateArray().Select(x => new SessionOffer(x.GetProperty("id").GetString()!, x.GetProperty("kind").GetString()!, x.GetProperty("admin").GetString()!, x.TryGetProperty("reason", out var rs) ? rs.GetString() : null)).ToList() : [];
        var poll = root.TryGetProperty("pollSeconds", out var ps) && ps.ValueKind == JsonValueKind.Number ? ps.GetInt32() : 0;
        return new(jobs, cancel, offer, sessions, poll);
    }
    public Task StartJobAsync(string id, CancellationToken ct) => SendAsync(HttpMethod.Post, $"agent/v1/jobs/{id}/start", new { }, ct);
    public Task ReportJobAsync(string id, string status, object? result, string? error, CancellationToken ct) => SendAsync(HttpMethod.Post, $"agent/v1/jobs/{id}/result", new { status, result, error }, ct);
    public Task SendInventoryAsync(object body, CancellationToken ct) => SendAsync(HttpMethod.Put, "agent/v1/inventory", body, ct);

    /// <summary>Streams an authenticated download (relative URL from Control) into <paramref name="dest"/>.</summary>
    public async Task DownloadAsync(string relativeUrl, Stream dest, CancellationToken ct)
    {
        using var r = await _http.GetAsync(relativeUrl.TrimStart('/'), HttpCompletionOption.ResponseHeadersRead, ct);
        if (r.StatusCode == HttpStatusCode.Unauthorized) throw new AuthRejectedException("device credentials rejected");
        r.EnsureSuccessStatusCode();
        await r.Content.CopyToAsync(dest, ct);
    }
    /// <summary>Best effort: tells Control this device was uninstalled on purpose.</summary>
    public async Task GoodbyeAsync(CancellationToken ct) { try { await SendAsync(HttpMethod.Post, "agent/v1/goodbye", new { }, ct); } catch { /* offline or already revoked */ } }

    /// <summary>Generic authenticated call for other Viro services (the compute worker). The caller disposes the returned document.</summary>
    public Task<JsonDocument?> CallAsync(HttpMethod method, string path, object? body, CancellationToken ct) => SendAsync(method, path, body ?? new { }, ct);

    public Task SendAnatomyAsync(object body, CancellationToken ct) => SendAsync(HttpMethod.Post, "agent/v1/anatomy", body, ct);
    public Task SendHealthAsync(object body, CancellationToken ct) => SendAsync(HttpMethod.Put, "agent/v1/health", body, ct);

    async Task<JsonDocument?> SendAsync(HttpMethod m, string path, object body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(m, path) { Content = JsonContent.Create(body, options: Json) };
        using var r = await _http.SendAsync(req, ct);
        if (r.StatusCode == HttpStatusCode.Unauthorized) throw new AuthRejectedException("device credentials rejected");
        r.EnsureSuccessStatusCode();
        var text = await r.Content.ReadAsStringAsync(ct);
        return text.Length > 0 ? JsonDocument.Parse(text) : null;
    }
}

public sealed record HeartbeatReply(List<JobEnvelope> Jobs, List<string> Cancel, UpdateOffer? Update = null, List<SessionOffer>? Sessions = null, int PollSeconds = 0, ComputeWanted? Compute = null);
public sealed record ComputeWanted(bool Install);
