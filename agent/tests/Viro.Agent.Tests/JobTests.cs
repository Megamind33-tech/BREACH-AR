using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Viro.Agent;
using Xunit;

public class JobVerifierTests
{
    const string Dev = "33333333-3333-4333-8333-333333333333", Org = "22222222-2222-4222-8222-222222222222", JobId = "11111111-1111-4111-8111-111111111111";
    static readonly DateTimeOffset Now = new(2026, 6, 1, 0, 0, 0, TimeSpan.Zero);
    static string TmpReplay() => Path.Combine(Path.GetTempPath(), "viro-replay-" + Guid.NewGuid().ToString("N") + ".txt");
    static JsonElement Fixture() => JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "signed-job.json"))).RootElement;

    static JobVerifier Make(string pub, string dev = Dev, string org = Org, string[]? types = null, DateTimeOffset? now = null, ReplayStore? replay = null)
        => new(pub, dev, org, types ?? ["health.check", "service.restart"], replay ?? new ReplayStore(TmpReplay()), () => now ?? Now);

    // A signer local to the tests so each rejection path can be exercised with a *validly signed* but wrong job.
    sealed class TestSigner
    {
        readonly ECDsa _k = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        public string PublicKey => Convert.ToBase64String(_k.ExportSubjectPublicKeyInfo());
        public JobEnvelope Job(object? over = null, string? id = null)
        {
            var d = new Dictionary<string, object?> { ["v"] = 1, ["jobId"] = id ?? JobId, ["orgId"] = Org, ["deviceId"] = Dev, ["type"] = "health.check", ["params"] = new { }, ["issuedAt"] = "2026-05-31T23:00:00.000Z", ["expiresAt"] = "2026-06-01T01:00:00.000Z", ["timeoutSeconds"] = 300 };
            if (over is not null) foreach (var p in over.GetType().GetProperties()) d[p.Name] = p.GetValue(over);
            var payload = JsonSerializer.Serialize(d);
            return new(id ?? (string)d["jobId"]!, payload, Convert.ToBase64String(_k.SignData(Encoding.UTF8.GetBytes(payload), HashAlgorithmName.SHA256)));
        }
    }

    [Fact]
    public void Accepts_a_job_signed_by_the_Node_control_server()
    {
        var f = Fixture();
        var v = Make(f.GetProperty("publicKey").GetString()!);
        var (job, why) = v.Verify(new(JobId, f.GetProperty("valid").GetProperty("payload").GetString()!, f.GetProperty("valid").GetProperty("signature").GetString()!));
        Assert.Null(why);
        Assert.Equal("health.check", job!.Type);
        Assert.Equal(300, job.TimeoutSeconds);
    }

    [Fact]
    public void Rejects_tampered_payload_and_foreign_signatures_from_the_Node_server()
    {
        var f = Fixture(); var pub = f.GetProperty("publicKey").GetString()!;
        var valid = f.GetProperty("valid");
        var tampered = valid.GetProperty("payload").GetString()!.Replace("health.check", "service.restart");
        Assert.Equal("signature verification failed", Make(pub).Verify(new(JobId, tampered, valid.GetProperty("signature").GetString()!)).rejection);
        var other = f.GetProperty("otherKeySig");
        Assert.Equal("signature verification failed", Make(pub).Verify(new(JobId, other.GetProperty("payload").GetString()!, other.GetProperty("signature").GetString()!)).rejection);
        Assert.Equal("signature verification failed", Make(pub).Verify(new(JobId, tampered, "not-base64!!")).rejection);
    }

    [Fact] public void Rejects_a_job_addressed_to_another_device() { var s = new TestSigner(); Assert.Contains("different device", Make(s.PublicKey, dev: "99999999-9999-4999-8999-999999999999").Verify(s.Job()).rejection); }
    [Fact] public void Rejects_a_job_from_another_organization() { var s = new TestSigner(); Assert.Contains("different organization", Make(s.PublicKey, org: "99999999-9999-4999-8999-999999999999").Verify(s.Job()).rejection); }
    [Fact] public void Rejects_expired_jobs() { var s = new TestSigner(); Assert.Equal("job has expired", Make(s.PublicKey, now: Now.AddHours(3)).Verify(s.Job()).rejection); }
    [Fact] public void Rejects_jobs_issued_in_the_future() { var s = new TestSigner(); Assert.Equal("job is issued in the future", Make(s.PublicKey, now: Now.AddDays(-3)).Verify(s.Job()).rejection); }
    [Fact] public void Rejects_unknown_job_types_even_when_validly_signed() { var s = new TestSigner(); Assert.Contains("unsupported job type", Make(s.PublicKey).Verify(s.Job(new { type = "run.arbitrary.command" })).rejection); }
    [Fact] public void Rejects_a_job_whose_envelope_id_differs_from_the_signed_id() { var s = new TestSigner(); var j = s.Job(); Assert.Contains("does not match", Make(s.PublicKey).Verify(j with { Id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }).rejection); }

    [Fact]
    public void Rejects_a_replayed_job_even_after_the_agent_restarts()
    {
        var s = new TestSigner(); var path = TmpReplay(); var j = s.Job();
        Assert.Null(Make(s.PublicKey, replay: new ReplayStore(path)).Verify(j).rejection);
        // A job that was accepted but never began (the agent was restarted or updated first) is offered again by Control and must run; one that already began is never accepted again.
        var restarted = Make(s.PublicKey, replay: new ReplayStore(path)); Assert.Null(restarted.Verify(j).rejection);
        Assert.Contains("replay", restarted.Verify(j).rejection);                                                          // not twice in the same run
        restarted.MarkStarted(j.Id);
        Assert.Contains("replay", Make(s.PublicKey, replay: new ReplayStore(path)).Verify(j).rejection);                    // started: never again, even after another restart
    }

    [Fact] public void A_key_pinned_from_a_different_server_accepts_nothing() { var mine = new TestSigner(); var attacker = new TestSigner(); Assert.Equal("signature verification failed", Make(mine.PublicKey).Verify(attacker.Job()).rejection); }
}

public class JobRunnerTests
{
    const string Dev = "33333333-3333-4333-8333-333333333333", Org = "22222222-2222-4222-8222-222222222222";

    sealed class FakeControl : HttpMessageHandler
    {
        public readonly List<(string path, string body)> Calls = [];
        public HttpStatusCode StartStatus = HttpStatusCode.OK;
        public int ResultFailures;   // fail this many result posts with 503 before accepting
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
        {
            lock (Calls) Calls.Add((r.RequestUri!.AbsolutePath, r.Content is null ? "" : r.Content.ReadAsStringAsync(ct).Result));
            var status = r.RequestUri.AbsolutePath.EndsWith("/start") ? StartStatus : r.RequestUri.AbsolutePath.EndsWith("/result") && ResultFailures-- > 0 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK;
            return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent("{\"ok\":true}") });
        }
        public string[] Results() { lock (Calls) return [.. Calls.Where(c => c.path.EndsWith("/result")).Select(c => c.body)]; }
    }
    sealed class Handler(string type, Func<CancellationToken, Task<JobOutcome>> f) : IJobHandler
    {
        public string Type => type;
        public Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct) => f(ct);
    }

    static (JobRunner runner, FakeControl fake, MakeJob job, CancellationTokenSource stop) Setup(params IJobHandler[] handlers)
    {
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var fake = new FakeControl();
        var client = new ControlClient("http://localhost:1", fake);
        var verifier = new JobVerifier(Convert.ToBase64String(key.ExportSubjectPublicKeyInfo()), Dev, Org, handlers.Select(h => h.Type), new ReplayStore(Path.Combine(Path.GetTempPath(), "viro-rr-" + Guid.NewGuid().ToString("N") + ".txt")));
        var runner = new JobRunner(client, verifier, handlers, new UpdateStateCache(), NullLogger.Instance);
        var stop = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        _ = runner.RunAsync(stop.Token);
        JobEnvelope Job(string type, int timeout = 300)
        {
            var id = Guid.NewGuid().ToString();
            var p = JsonSerializer.Serialize(new { v = 1, jobId = id, orgId = Org, deviceId = Dev, type, @params = new { }, issuedAt = DateTimeOffset.UtcNow.AddMinutes(-1).ToString("O"), expiresAt = DateTimeOffset.UtcNow.AddHours(1).ToString("O"), timeoutSeconds = timeout });
            return new(id, p, Convert.ToBase64String(key.SignData(Encoding.UTF8.GetBytes(p), HashAlgorithmName.SHA256)));
        }
        return (runner, fake, Job, stop);
    }
    delegate JobEnvelope MakeJob(string type, int timeout = 300);
    static async Task Until(Func<bool> cond, int ms = 8000) { var sw = System.Diagnostics.Stopwatch.StartNew(); while (!cond()) { if (sw.ElapsedMilliseconds > ms) throw new TimeoutException("condition not met"); await Task.Delay(20); } }

    [Fact]
    public async Task Successful_job_reports_start_then_completed_with_its_result()
    {
        var (runner, fake, job, stop) = Setup(new Handler("t.ok", _ => Task.FromResult(new JobOutcome(true, new { answer = 42 }))));
        await runner.OfferAsync([job("t.ok")], stop.Token);
        await Until(() => fake.Results().Length == 1);
        Assert.Contains("\"status\":\"completed\"", fake.Results()[0]);
        Assert.Contains("\"answer\":42", fake.Results()[0]);
        Assert.True(fake.Calls.FindIndex(c => c.path.EndsWith("/start")) < fake.Calls.FindIndex(c => c.path.EndsWith("/result")));
    }

    [Fact]
    public async Task A_result_is_retried_when_the_network_or_server_blips()
    {
        JobRunner.RetryDelays = [TimeSpan.FromMilliseconds(20), TimeSpan.FromMilliseconds(20), TimeSpan.FromMilliseconds(20)];
        var (runner, fake, job, stop) = Setup(new Handler("t.ok", _ => Task.FromResult(new JobOutcome(true))));
        fake.ResultFailures = 2;
        await runner.OfferAsync([job("t.ok")], stop.Token);
        await Until(() => fake.Results().Length == 3);   // 2 failures + 1 success
        Assert.Contains("completed", fake.Results()[2]);
    }

    [Fact]
    public async Task Failing_and_throwing_handlers_are_reported_as_failed_without_crashing_the_runner()
    {
        var (runner, fake, job, stop) = Setup(
            new Handler("t.fail", _ => Task.FromResult(new JobOutcome(false, null, "nope"))),
            new Handler("t.throw", _ => throw new InvalidOperationException("boom")),
            new Handler("t.ok", _ => Task.FromResult(new JobOutcome(true))));
        await runner.OfferAsync([job("t.fail"), job("t.throw"), job("t.ok")], stop.Token);
        await Until(() => fake.Results().Length == 3);
        var r = fake.Results();
        Assert.Contains("nope", r[0]); Assert.Contains("failed", r[0]);
        Assert.Contains("boom", r[1]); Assert.Contains("failed", r[1]);
        Assert.Contains("completed", r[2]);
    }

    [Fact]
    public async Task Invalid_jobs_never_reach_a_handler_and_are_reported_failed()
    {
        var ran = false;
        var (runner, fake, _, stop) = Setup(new Handler("t.ok", _ => { ran = true; return Task.FromResult(new JobOutcome(true)); }));
        var forged = new JobEnvelope(Guid.NewGuid().ToString(), "{\"v\":1,\"type\":\"t.ok\"}", Convert.ToBase64String(new byte[64]));
        await runner.OfferAsync([forged], stop.Token);
        await Until(() => fake.Results().Length == 1);
        Assert.False(ran);
        Assert.Contains("rejected by agent", fake.Results()[0]);
        Assert.Contains("signature verification failed", fake.Results()[0]);
    }

    [Fact]
    public async Task A_job_that_overruns_its_timeout_is_stopped_and_reported_failed()
    {
        var (runner, fake, job, stop) = Setup(new Handler("t.slow", async ct => { await Task.Delay(TimeSpan.FromMinutes(5), ct); return new JobOutcome(true); }));
        await runner.OfferAsync([job("t.slow", timeout: 5)], stop.Token);
        await Until(() => fake.Results().Length == 1, 15000);
        Assert.Contains("timed out after 5s", fake.Results()[0]);
    }

    [Fact]
    public async Task Cancelling_a_running_job_stops_it_and_reports_cancelled()
    {
        var started = new TaskCompletionSource();
        var (runner, fake, job, stop) = Setup(new Handler("t.slow", async ct => { started.SetResult(); await Task.Delay(TimeSpan.FromMinutes(5), ct); return new JobOutcome(true); }));
        var j = job("t.slow");
        await runner.OfferAsync([j], stop.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        runner.Cancel([j.Id]);
        await Until(() => fake.Results().Length == 1);
        Assert.Contains("\"status\":\"cancelled\"", fake.Results()[0]);
    }

    [Fact]
    public async Task A_job_the_server_no_longer_allows_is_skipped_without_running()
    {
        var ran = false;
        var (runner, fake, job, stop) = Setup(new Handler("t.ok", _ => { ran = true; return Task.FromResult(new JobOutcome(true)); }));
        fake.StartStatus = HttpStatusCode.Conflict; // e.g. cancelled while queued
        await runner.OfferAsync([job("t.ok")], stop.Token);
        await Until(() => fake.Calls.Any(c => c.path.EndsWith("/start")));
        await Task.Delay(300);
        Assert.False(ran);
        Assert.Empty(fake.Results());
    }

    [Fact]
    public async Task The_same_job_offered_twice_by_heartbeat_runs_once()
    {
        var count = 0;
        var (runner, fake, job, stop) = Setup(new Handler("t.ok", async _ => { Interlocked.Increment(ref count); await Task.Delay(200); return new JobOutcome(true); }));
        var j = job("t.ok");
        await runner.OfferAsync([j], stop.Token);
        await runner.OfferAsync([j], stop.Token);
        await Until(() => fake.Results().Length >= 1);
        await Task.Delay(400);
        Assert.Equal(1, count);
        Assert.Single(fake.Results());
    }
}

public class HandlerTests
{
    static JobContext Ctx(string type, string paramsJson) => new(new VerifiedJob("id", type, JsonDocument.Parse(paramsJson).RootElement.Clone(), 60), new ControlClient("http://localhost:1"), new UpdateStateCache(), NullLogger.Instance);

    [Fact]
    public async Task Service_restart_refuses_protected_services_and_reports_missing_ones()
    {
        var h = new ServiceRestartHandler();
        var prot = await h.RunAsync(Ctx("service.restart", "{\"name\":\"RpcSs\"}"), CancellationToken.None);
        Assert.False(prot.Success); Assert.Contains("protected", prot.Error);
        Assert.False((await h.RunAsync(Ctx("service.restart", "{\"name\":\"ViroAgent\"}"), CancellationToken.None)).Success);
        var missing = await h.RunAsync(Ctx("service.restart", "{\"name\":\"ThisServiceDoesNotExist123\"}"), CancellationToken.None);
        Assert.False(missing.Success); Assert.Contains("not found", missing.Error);
    }

    [Fact]
    public async Task Hardware_diagnose_returns_only_measured_data_and_explains_what_it_could_not_read()
    {
        var o = await new HardwareDiagnoseHandler().RunAsync(Ctx("hardware.diagnose", "{}"), CancellationToken.None);
        Assert.True(o.Success);
        var json = JsonSerializer.Serialize(o.Result, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        Assert.True(root.GetProperty("storage").GetProperty("disks").GetArrayLength() > 0);
        Assert.True(root.GetProperty("memory").GetProperty("modules").GetArrayLength() > 0);
        foreach (var u in root.GetProperty("unavailable").EnumerateArray()) Assert.False(string.IsNullOrWhiteSpace(u.GetProperty("reason").GetString()));
    }
}
