using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Viro.Agent.Care;

/// <summary>What the person at this PC may use. Mirrors the server's list (server/src/entitlements.ts); the server is the source of truth and the app caches its answer.</summary>
public sealed record AccountState(bool SignedIn, string? Email, string? Plan, string? PlanName, bool Active, DateTime? ValidUntil, IReadOnlyList<string> Features, bool Managed, bool Stale, DateTime? CheckedAt);

public interface IAccountStore { string? Load(); void Save(string text); void Clear(); }

/// <summary>Keeps the sign-in token and the last answer on this PC, protected for this Windows user only.</summary>
public sealed class DpapiAccountStore(string? path = null) : IAccountStore
{
    readonly string file = path ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Viro", "account.bin");
    public string? Load() { try { return File.Exists(file) ? Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(file), null, DataProtectionScope.CurrentUser)) : null; } catch (Exception e) when (e is CryptographicException or IOException) { return null; } }
    public void Save(string text) { Directory.CreateDirectory(Path.GetDirectoryName(file)!); File.WriteAllBytes(file, ProtectedData.Protect(Encoding.UTF8.GetBytes(text), null, DataProtectionScope.CurrentUser)); }
    public void Clear() { try { File.Delete(file); } catch (IOException) { } }
}

public sealed class AccountService(IAccountStore store, HttpMessageHandler? handler = null, string? baseUrl = null, Func<DateTime>? clock = null)
{
    /// <summary>How long a cached answer keeps paid features working with no connection to Viro. After this the free features stay, the paid ones wait for a connection.</summary>
    public static readonly TimeSpan OfflineGrace = TimeSpan.FromDays(7);
    public static readonly string[] FreeFeatures = ["scan.full", "clean.space", "startup.manage", "memory.trim", "apps.list", "updates.view"];
    public static string DefaultServer => Environment.GetEnvironmentVariable("VIRO_SERVER") is { Length: > 0 } s ? s.TrimEnd('/') : "https://control.viro3.online";

    readonly string server = (baseUrl ?? DefaultServer).TrimEnd('/');
    readonly Func<DateTime> now = clock ?? (() => DateTime.UtcNow);
    readonly HttpClient http = new(handler ?? new HttpClientHandler()) { Timeout = TimeSpan.FromMinutes(5) };
    static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    sealed record Saved(string Email, string Token, string? Plan, string? PlanName, bool Active, DateTime? ValidUntil, string[] Features, DateTime? CheckedAt, string Kind);
    Saved? Read() { try { return store.Load() is { } t ? JsonSerializer.Deserialize<Saved>(t, Web) : null; } catch (JsonException) { return null; } }

    /// <summary>The answer without any network: signed out and free, signed in with what was last confirmed, or everything when an organization manages this PC.</summary>
    public AccountState State(bool managedByOrganization = false)
    {
        if (managedByOrganization) return new(Read() is not null, Read()?.Email, null, "Managed by your organization", true, null, ["*"], true, false, null);
        var s = Read(); if (s is null) return new(false, null, null, null, false, null, FreeFeatures, false, false, null);
        var stale = s.CheckedAt is null || now() - s.CheckedAt > OfflineGrace;
        var features = stale || !s.Active ? FreeFeatures : s.Features.Concat(FreeFeatures).Distinct().ToArray();
        return new(true, s.Email, s.Plan, s.PlanName, s.Active, s.ValidUntil, features, false, stale, s.CheckedAt);
    }

    public bool Has(string feature, bool managed = false) { var f = State(managed).Features; return f.Contains("*") || f.Contains(feature); }

    /// <summary>Signs in. A second step code is only asked for when the account has one (the server says so).</summary>
    public async Task<(bool Ok, string Message, bool NeedsCode)> SignInAsync(string email, string password, string? code, CancellationToken ct)
    {
        var body = new Dictionary<string, object?> { ["email"] = email.Trim(), ["password"] = password, ["code"] = string.IsNullOrWhiteSpace(code) ? null : code.Trim() };
        HttpResponseMessage r;
        try { r = await http.PostAsync(server + "/api/v1/auth/login", new StringContent(JsonSerializer.Serialize(body, Web), Encoding.UTF8, "application/json"), ct); }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { return (false, "Could not reach Viro. Check your internet connection and try again.", false); }
        var text = await r.Content.ReadAsStringAsync(ct); using var doc = JsonDocument.Parse(text.Length == 0 ? "{}" : text);
        if (!r.IsSuccessStatusCode)
        {
            var err = doc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : null;
            if (err == "mfa_required") return (false, "Enter the 6-digit code from your authenticator app.", true);
            return (false, err switch { "invalid credentials" => "That email and password do not match.", null => "Sign-in failed.", _ => err }, doc.RootElement.TryGetProperty("mfa", out var m) && m.ValueKind == JsonValueKind.True);
        }
        var token = doc.RootElement.GetProperty("token").GetString()!;
        store.Save(JsonSerializer.Serialize(new Saved(email.Trim().ToLowerInvariant(), token, null, null, false, null, [], null, "personal"), Web));
        var ok = await RefreshAsync(ct);
        return ok ? (true, "Signed in.", false) : (true, "Signed in, but your plan could not be checked yet.", false);
    }

    /// <summary>Asks Viro what this account may use and remembers the answer. A rejected token signs the person out; a network failure keeps the last answer.</summary>
    public async Task<bool> RefreshAsync(CancellationToken ct)
    {
        var s = Read(); if (s is null) return false;
        using var req = new HttpRequestMessage(HttpMethod.Get, server + "/api/v1/entitlements"); req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", s.Token);
        HttpResponseMessage r;
        try { r = await http.SendAsync(req, ct); }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { return false; }
        if (r.StatusCode is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden) { store.Clear(); return false; }
        if (!r.IsSuccessStatusCode) return false;
        using var doc = JsonDocument.Parse(await r.Content.ReadAsStringAsync(ct)); var d = doc.RootElement;
        string? Str(string n) => d.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var features = d.TryGetProperty("features", out var f) && f.ValueKind == JsonValueKind.Array ? f.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToArray() : [];
        DateTime? until = DateTime.TryParse(Str("validUntil"), null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var u) ? u : null;
        store.Save(JsonSerializer.Serialize(new Saved(s.Email, s.Token, Str("plan"), Str("planName"), d.TryGetProperty("active", out var a) && a.ValueKind == JsonValueKind.True, until, features, now(), Str("kind") ?? "personal"), Web));
        return true;
    }

    public async Task<(bool Ok, string Message)> SignUpAsync(string name, string email, string password, CancellationToken ct)
    {
        try
        {
            var r = await http.PostAsync(server + "/api/v1/signup", new StringContent(JsonSerializer.Serialize(new { name, email, password, acceptTerms = true }, Web), Encoding.UTF8, "application/json"), ct);
            using var doc = JsonDocument.Parse(await r.Content.ReadAsStringAsync(ct));
            var msg = doc.RootElement.TryGetProperty(r.IsSuccessStatusCode ? "message" : "error", out var m) ? m.GetString() ?? "" : "";
            return (r.IsSuccessStatusCode, r.IsSuccessStatusCode ? msg : msg.Length > 0 ? msg : "Could not create the account. Check the details and try again.");
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { return (false, "Could not reach Viro. Check your internet connection and try again."); }
    }

    /// <summary>One call to Viro as the signed-in person. Returns the status code and the JSON body; a rejected token signs the person out.</summary>
    public async Task<(int Status, JsonElement Body)> SendAsync(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        var s = Read(); if (s is null) return (401, JsonDocument.Parse("{\"error\":\"Sign in to your Viro account first.\"}").RootElement.Clone());
        using var req = new HttpRequestMessage(method, server + path); req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", s.Token);
        if (body is not null) req.Content = new StringContent(JsonSerializer.Serialize(body, Web), Encoding.UTF8, "application/json");
        try
        {
            var r = await http.SendAsync(req, ct); var text = await r.Content.ReadAsStringAsync(ct);
            if (r.StatusCode == System.Net.HttpStatusCode.Unauthorized) store.Clear();
            return ((int)r.StatusCode, JsonDocument.Parse(text.Length == 0 ? "{}" : text).RootElement.Clone());
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { return (0, JsonDocument.Parse("{\"error\":\"Could not reach Viro. Check your internet connection and try again.\"}").RootElement.Clone()); }
    }

    /// <summary>A binary call to Viro as the signed-in person (Viro Move chunks). Returns the status, the body bytes and the chunk checksum header.</summary>
    public async Task<(int Status, byte[] Data, string? Sha)> SendBytesAsync(HttpMethod method, string path, byte[]? body, string? sha, CancellationToken ct)
    {
        var s = Read(); if (s is null) return (401, [], null);
        using var req = new HttpRequestMessage(method, server + path); req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", s.Token);
        if (body is not null) { req.Content = new ByteArrayContent(body); req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream"); if (sha is not null) req.Headers.Add("x-chunk-sha256", sha); }
        try
        {
            using var r = await http.SendAsync(req, ct);
            if (r.StatusCode == System.Net.HttpStatusCode.Unauthorized) store.Clear();
            return ((int)r.StatusCode, await r.Content.ReadAsByteArrayAsync(ct), r.Headers.TryGetValues("x-chunk-sha256", out var v) ? v.FirstOrDefault() : null);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { if (ct.IsCancellationRequested) throw; return (0, [], null); }
    }

    public void SignOut() => store.Clear();
    public string ManageUrl => server + "/#/billing";
}

/// <summary>Which paid feature each command in the window needs. Anything not listed is free.</summary>
public static class FeatureGate
{
    public static string? Required(string cmd, JsonElement args)
    {
        switch (cmd)
        {
            case "slow.analyze": case "stability.analyze": return "diagnose.cause";
            case "apps.repair": return "repair.programs";
            case "fix.all": return "fix.verified";
            case "backup.check": return "backup.check";
            case "apps.leftovers": case "apps.leftovers.clean": return "uninstall.forced";
            case "schedule.enable": case "schedule.run": return "maintenance.scheduled";
            case "help.request": return "help.technician";
            case "move.list": case "move.backup": case "move.open": case "move.restore": case "move.delete": case "move.preview": return "move.cloud";
            case "apps.uninstall": return args.ValueKind == JsonValueKind.Object && args.TryGetProperty("forced", out var f) && f.ValueKind == JsonValueKind.True ? "uninstall.forced" : null;
            case "recipe.run":
                var r = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("recipe", out var x) ? x.GetString() : null;
                return r is "printer.repair" or "shell.repair" or "app.repair" ? "repair.programs" : null;
            default: return null;
        }
    }
    public static readonly IReadOnlyDictionary<string, string> Titles = new Dictionary<string, string>
    {
        ["diagnose.cause"] = "Why it is slow or crashing: the actual cause", ["repair.programs"] = "Repair broken programs, printers and Windows pieces", ["uninstall.forced"] = "Remove stubborn and hidden programs, with undo",
        ["fix.verified"] = "Fixes that are re-checked, with before and after and undo", ["health.warnings"] = "Early warning for failing drives and batteries", ["advice.replace"] = "Repair, upgrade or replace advice with a price",
        ["backup.check"] = "Backup check", ["maintenance.scheduled"] = "Scheduled fixes and a weekly report", ["history.machine"] = "Machine history", ["move.cloud"] = "Viro Move: your apps, files and settings on your next PC", ["help.technician"] = "Ask a technician",
    };
}
