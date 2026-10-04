using System.Net;
using System.Text;
using Viro.Agent;
using Viro.Agent.Care;
using Xunit;

/// <summary>Answers the enroll-check and enroll calls like the server does, for a workspace whose id and name the test chooses.</summary>
sealed class WorkspaceHandler(string orgId, string orgName) : HttpMessageHandler
{
    public readonly List<string> Paths = [];
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
    {
        Paths.Add(r.RequestUri!.AbsolutePath);
        var body = r.RequestUri.AbsolutePath.EndsWith("/check")
            ? $"{{\"organizationId\":\"{orgId}\",\"organizationName\":\"{orgName}\",\"siteName\":\"HQ\",\"departmentName\":null}}"
            : $"{{\"deviceId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"deviceSecret\":\"vds_{orgName}\",\"heartbeatIntervalSeconds\":30,\"jobSigningPublicKey\":\"KEY\",\"organizationId\":\"{orgId}\"}}";
        return Task.FromResult(new HttpResponseMessage(r.RequestUri.AbsolutePath.EndsWith("/check") ? HttpStatusCode.OK : HttpStatusCode.Created) { Content = new StringContent(body) });
    }
}

[Collection("uses-agent-data-dir")]
public class WorkspaceTests : IDisposable
{
    readonly List<string> _said = [];
    public WorkspaceTests() { if (Directory.Exists(TestEnv.Data)) Directory.Delete(TestEnv.Data, true); }
    public void Dispose() { try { Directory.Delete(TestEnv.Data, true); } catch { } }
    Installer Make(FakeSc sc, WorkspaceHandler h) => new(sc, () => true, _said.Add, u => new ControlClient("http://localhost:1", h));
    static InstallOptions Opts(bool move = false) => new("http://localhost:1", "vet_token_value", null, Force: move, ProtectDataDir: false);
    const string A = "aaaaaaaa-0000-4000-8000-000000000001", B = "bbbbbbbb-0000-4000-8000-000000000002";

    [Fact]
    public async Task A_pc_that_already_belongs_to_a_workspace_is_not_moved_by_another_organizations_code()
    {
        var sc = new FakeSc(); var acme = new WorkspaceHandler(A, "Acme");
        Assert.Equal(0, await Make(sc, acme).SetupAsync(Opts(), @"C:iro-agent.exe", default));
        Assert.Equal(A, AgentConfig.Load().OrganizationId);

        var bravo = new WorkspaceHandler(B, "Bravo");
        Assert.Equal(3, await Make(sc, bravo).SetupAsync(Opts(), @"C:iro-agent.exe", default));
        Assert.Equal(A, AgentConfig.Load().OrganizationId);                    // identity untouched
        Assert.Equal("vds_Acme", AgentConfig.Load().DeviceSecret);
        Assert.Equal(["/agent/v1/enroll/check"], bravo.Paths);                 // looked up only: the other workspace's code was never used up
        Assert.Contains(_said, m => m.Contains("Bravo") && m.Contains("not changed"));
    }

    [Fact]
    public async Task A_move_happens_only_when_asked_for_explicitly()
    {
        var sc = new FakeSc();
        await Make(sc, new WorkspaceHandler(A, "Acme")).SetupAsync(Opts(), @"C:iro-agent.exe", default);
        var bravo = new WorkspaceHandler(B, "Bravo");
        Assert.Equal(0, await Make(sc, bravo).SetupAsync(Opts(move: true), @"C:iro-agent.exe", default));
        Assert.Equal(B, AgentConfig.Load().OrganizationId);
        Assert.Equal(["/agent/v1/enroll/check", "/agent/v1/enroll"], bravo.Paths);
    }

    [Fact]
    public async Task A_running_service_is_restarted_after_a_move_so_it_reports_to_the_new_workspace()
    {
        var sc = new FakeSc();
        await Make(sc, new WorkspaceHandler(A, "Acme")).SetupAsync(Opts(), @"C:airo-agent.exe", default);
        Assert.True(sc.Running); sc.Calls.Clear();
        Assert.Equal(0, await Make(sc, new WorkspaceHandler(B, "Bravo")).SetupAsync(Opts(move: true), @"C:airo-agent.exe", default));
        var stop = sc.Calls.FindIndex(c => c.StartsWith("sc.exe stop ViroAgent")); var start = sc.Calls.FindIndex(c => c.StartsWith("sc.exe start ViroAgent"));
        Assert.True(stop >= 0 && start > stop, string.Join(" | ", sc.Calls));
        Assert.True(sc.Running);
    }

    [Fact]
    public async Task A_code_for_the_same_workspace_reconnects_without_a_move()
    {
        var sc = new FakeSc();
        await Make(sc, new WorkspaceHandler(A, "Acme")).SetupAsync(Opts(), @"C:iro-agent.exe", default);
        Assert.Equal(0, await Make(sc, new WorkspaceHandler(A, "Acme")).SetupAsync(Opts(), @"C:iro-agent.exe", default));
    }

    [Fact]
    public async Task A_fresh_pc_joins_without_any_look_up_getting_in_the_way()
    {
        var h = new WorkspaceHandler(A, "Acme");
        Assert.Equal(0, await Make(new FakeSc(), h).SetupAsync(Opts(), @"C:iro-agent.exe", default));
        Assert.Equal(["/agent/v1/enroll"], h.Paths);
    }

    static string Code(string server, string token) => "VIRO1-" + Convert.ToBase64String(Encoding.UTF8.GetBytes($"{{\"u\":\"{server}\",\"t\":\"{token}\"}}")).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    [Fact]
    public void Connection_codes_are_parsed_strictly()
    {
        var ok = ConnectionCode.Parse("  " + Code("https://control.example.com", "vet_abcdefghij") + "\r\n");
        Assert.Equal(("https://control.example.com", "vet_abcdefghij"), (ok.Server, ok.Token));
        Assert.Equal("http://localhost:8080", ConnectionCode.Parse(Code("http://localhost:8080", "vet_abcdefghij")).Server);
        Assert.Equal("http://192.168.1.9:8080", ConnectionCode.Parse(Code("http://192.168.1.9:8080", "vet_abcdefghij")).Server);   // private LAN address: allowed for testing
        foreach (var bad in new[] { "", "hello", "VIRO1-", "VIRO1-@@@@", Code("http://evil.example.com", "vet_abcdefghij"), Code("http://8.8.8.8:8080", "vet_abcdefghij"), Code("http://172.32.0.1:8080", "vet_abcdefghij"), Code("https://x.com/path", "vet_abcdefghij"), Code("https://u:p@x.com", "vet_abcdefghij"), Code("https://x.com", "short") })
            Assert.Throws<ArgumentException>(() => ConnectionCode.Parse(bad));
    }

    [Fact]
    public async Task Checking_a_code_shows_the_workspace_name_and_a_dead_code_gets_a_plain_message()
    {
        var w = new WorkspaceActions(_ => new ControlClient("http://localhost:1", new WorkspaceHandler(A, "Acme")));
        var c = await w.CheckAsync(Code("http://localhost:1", "vet_abcdefghij"), default);
        Assert.Equal(("Acme", "HQ"), (c.OrganizationName, c.SiteName));
        var dead = new WorkspaceActions(_ => new ControlClient("http://localhost:1", new EnrollHandler(HttpStatusCode.Unauthorized)));
        var e = await Assert.ThrowsAsync<ArgumentException>(() => dead.CheckAsync(Code("http://localhost:1", "vet_abcdefghij"), default));
        Assert.Contains("expired or already been used", e.Message);
    }
}
