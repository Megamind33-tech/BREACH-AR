using System.Net;
using System.Text;
using System.Text.Json;
using Viro.Agent.Care;
using Viro.Agent.Repair;
using Xunit;

sealed class MemStore : IAccountStore { public string? Text; public string? Load() => Text; public void Save(string t) => Text = t; public void Clear() => Text = null; }

sealed class FakeViro(Func<HttpRequestMessage, (HttpStatusCode, string)> reply) : HttpMessageHandler
{
    public readonly List<string> Calls = [];
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
    {
        Calls.Add(r.Method + " " + r.RequestUri!.AbsolutePath); var (code, body) = reply(r);
        return Task.FromResult(new HttpResponseMessage(code) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
    }
}

public class AccountTests
{
    static string Plus(string until = "2099-01-01T00:00:00Z") => JsonSerializer.Serialize(new { kind = "personal", plan = "care-year", planName = "Viro Care", active = true, validUntil = until, features = new[] { "fix.verified", "diagnose.cause", "repair.programs", "uninstall.forced" } });
    static FakeViro Server(Func<string>? entitlements = null, HttpStatusCode login = HttpStatusCode.OK) => new(r => r.RequestUri!.AbsolutePath switch
    {
        "/api/v1/auth/login" => login == HttpStatusCode.OK ? (HttpStatusCode.OK, "{\"token\":\"tok123\"}") : (login, "{\"error\":\"invalid credentials\"}"),
        "/api/v1/entitlements" => (HttpStatusCode.OK, (entitlements ?? (() => Plus()))()),
        _ => (HttpStatusCode.NotFound, "{}"),
    });
    static JsonElement J(string s = "{}") => JsonDocument.Parse(s).RootElement.Clone();

    [Fact]
    public async Task SigningInStoresThePlanAndUnlocksItsFeatures()
    {
        var store = new MemStore(); var svc = new AccountService(store, Server(), "https://example.test");
        Assert.False(svc.State().SignedIn); Assert.False(svc.Has("diagnose.cause")); Assert.True(svc.Has("clean.space"));
        var r = await svc.SignInAsync("A@Example.com", "pw", null, default);
        Assert.True(r.Ok); var s = svc.State(); Assert.True(s.SignedIn); Assert.Equal("a@example.com", s.Email); Assert.Equal("Viro Care", s.PlanName);
        Assert.True(svc.Has("diagnose.cause")); Assert.True(svc.Has("clean.space")); Assert.False(svc.Has("move.cloud"));
        Assert.DoesNotContain("pw", store.Text);                              // the password itself is never kept
    }

    [Fact]
    public async Task WrongPasswordAndUnreachableServerAreSaidPlainly()
    {
        var svc = new AccountService(new MemStore(), Server(login: HttpStatusCode.Unauthorized), "https://example.test");
        var bad = await svc.SignInAsync("a@b.c", "x", null, default); Assert.False(bad.Ok); Assert.Contains("do not match", bad.Message);
        var down = new AccountService(new MemStore(), new FakeViro(_ => throw new HttpRequestException("down")), "https://example.test");
        var r = await down.SignInAsync("a@b.c", "x", null, default); Assert.False(r.Ok); Assert.Contains("internet", r.Message);
    }

    [Fact]
    public async Task PaidFeaturesSurviveAWeekOfflineThenWaitForAConnection()
    {
        var store = new MemStore(); var t = new DateTime(2026, 10, 4, 0, 0, 0, DateTimeKind.Utc);
        var svc = new AccountService(store, Server(), "https://example.test", () => t); await svc.SignInAsync("a@b.c", "pw", null, default);
        t = t.AddDays(6); Assert.True(svc.Has("diagnose.cause")); Assert.False(svc.State().Stale);
        t = t.AddDays(2); Assert.False(svc.Has("diagnose.cause")); Assert.True(svc.State().Stale); Assert.True(svc.Has("clean.space"));      // free keeps working
    }

    [Fact]
    public async Task ALapsedPlanOrARevokedSignInGoesBackToFree()
    {
        var plan = Plus(); var store = new MemStore(); var handler = new FakeViro(r => r.RequestUri!.AbsolutePath == "/api/v1/auth/login" ? (HttpStatusCode.OK, "{\"token\":\"t\"}") : (HttpStatusCode.OK, plan));
        var svc = new AccountService(store, handler, "https://example.test"); await svc.SignInAsync("a@b.c", "pw", null, default); Assert.True(svc.Has("fix.verified"));
        plan = JsonSerializer.Serialize(new { kind = "personal", plan = "care-year", planName = "Viro Care", active = false, validUntil = "2020-01-01T00:00:00Z", features = new[] { "fix.verified" } });
        await svc.RefreshAsync(default); Assert.False(svc.Has("fix.verified")); Assert.True(svc.Has("clean.space"));
        var gone = new AccountService(store, new FakeViro(_ => (HttpStatusCode.Unauthorized, "{}")), "https://example.test"); await gone.RefreshAsync(default);
        Assert.False(gone.State().SignedIn); Assert.Null(store.Text);          // an invalid token signs the person out
    }

    static async Task<JsonElement> Call(LocalBridge b, string cmd, string args = "{}") => JsonSerializer.SerializeToElement(await b.HandleAsync(cmd, J(args), default), new JsonSerializerOptions(JsonSerializerDefaults.Web));

    [Fact]
    public async Task TheWindowLocksPaidCommandsAndUnlocksThemForPaidAccountsAndManagedPcs()
    {
        using var sb = new Sandbox(); var act = new LocalActions(new SandboxUserEnv(sb, Path.Combine(sb.Root, "undo")));
        var store = new MemStore(); var svc = new AccountService(store, Server(), "https://example.test");
        var managed = false; var bridge = new LocalBridge(act, () => false, null, null, svc, null, () => Task.FromResult(managed));
        var locked = await Call(bridge, "apps.repair", "{\"kind\":\"msi\",\"id\":\"x\"}");
        Assert.True(locked.GetProperty("locked").GetBoolean()); Assert.Equal("repair.programs", locked.GetProperty("feature").GetString());
        Assert.True((await Call(bridge, "slow.analyze")).GetProperty("locked").GetBoolean());
        Assert.True((await Call(bridge, "apps.uninstall", "{\"kind\":\"other\",\"id\":\"x\",\"forced\":true}")).GetProperty("locked").GetBoolean());
        Assert.Null(FeatureGate.Required("apps.uninstall", J("{\"kind\":\"other\",\"id\":\"x\"}")));        // a normal uninstall stays free
        Assert.Null(FeatureGate.Required("space.clean", J())); Assert.Equal("fix.verified", FeatureGate.Required("fix.all", J()));
        Assert.Equal("repair.programs", FeatureGate.Required("recipe.run", J("{\"recipe\":\"printer.repair\"}")));
        Assert.Null(FeatureGate.Required("recipe.run", J("{\"recipe\":\"memory.trim-idle\"}")));

        managed = true; Assert.False((await Call(bridge, "slow.analyze")).TryGetProperty("locked", out _)); managed = false;     // an organization-managed PC is never locked
        await svc.SignInAsync("a@b.c", "pw", null, default);
        var status = await Call(bridge, "account.status"); Assert.True(status.GetProperty("signedIn").GetBoolean()); Assert.Equal("Viro Care", status.GetProperty("planName").GetString());
        Assert.False((await Call(bridge, "account.signout")).GetProperty("signedIn").GetBoolean());
    }

    [Fact]
    public void FeatureNamesInTheWindowMatchTheServersList()
    {
        // the server is the source of truth: every feature the window gates on must exist in server/src/entitlements.ts
        var file = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "server", "src", "entitlements.ts"));
        if (!File.Exists(file)) return;                                  // running outside the repository
        var text = File.ReadAllText(file);
        foreach (var f in FeatureGate.Titles.Keys.Concat(AccountService.FreeFeatures)) Assert.Contains($"'{f}'", text);
    }
}
