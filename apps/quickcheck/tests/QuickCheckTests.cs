using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using WorkCare.QuickCheck;
using Xunit;

namespace WorkCare.QuickCheck.Tests;

static class Shared
{
    public static string Read(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "shared", name));
    public static JsonObject Vectors(string name) => JsonNode.Parse(Read(name))!.AsObject();
}

public class RulesConformanceTests
{
    [Fact]
    public void EverySharedVectorProducesExactlyTheExpectedFindings()
    {
        var eval = new RulesEvaluator(Shared.Read("rules.json")); Assert.Equal(1, eval.Version);
        foreach (var c in Shared.Vectors("rules-vectors.json")["cases"]!.AsArray())
        {
            var name = c!["name"]!.GetValue<string>(); var res = eval.Evaluate(c["input"]!); var expect = c["expect"]!.AsArray();
            Assert.Equal(expect.Select(e => e!["id"]!.GetValue<string>()), res.Findings.Select(f => f["id"]!.GetValue<string>()));
            for (var i = 0; i < expect.Count; i++)
            {
                var e = expect[i]!.AsObject(); var f = res.Findings[i];
                Assert.Equal(e["severity"]!.GetValue<string>(), f["severity"]!.GetValue<string>());
                Assert.Equal(e["evidenceType"]!.GetValue<string>(), f["evidenceType"]!.GetValue<string>());
                foreach (var (k, want) in e["evidence"]!.AsObject())
                {
                    var got = f["evidence"]!.AsArray().FirstOrDefault(x => x!["name"]!.GetValue<string>() == k)?["value"];
                    Assert.True(got is not null, $"{name}: {f["id"]} evidence {k} missing");
                    if (want!.GetValueKind() == JsonValueKind.Number) Assert.Equal(want.GetValue<double>(), got!.GetValue<double>(), 9);
                    else Assert.Equal(want.ToJsonString(), got!.ToJsonString());
                }
            }
        }
    }

    [Fact]
    public void BatteryAt71PercentIsAttentionAndMissingInputsAreSkippedNotGuessed()
    {
        var eval = new RulesEvaluator(Shared.Read("rules.json"));
        var r = eval.Evaluate(JsonNode.Parse("{\"schemaVersion\":1,\"battery\":{\"designWh\":54.1,\"fullChargeWh\":38.4}}")!);
        var b = r.Findings.Single(f => f["id"]!.GetValue<string>() == "battery.capacity");
        Assert.Equal("attention", b["severity"]!.GetValue<string>());
        Assert.Contains("71%", b["summary"]!.GetValue<string>());
        Assert.DoesNotContain(r.Findings, f => f["id"]!.GetValue<string>().StartsWith("storage"));
        Assert.Contains("storage.health", r.Skipped);
    }
}

public class Wcp1ConformanceTests
{
    static JsonObject V => Shared.Vectors("wcp1-vectors.json");
    static byte[] H(JsonNode n, string k) => Wcp1.FromHex(n[k]!.GetValue<string>());

    [Fact]
    public void ComputerSideReproducesEveryReferenceValue()
    {
        var inp = V["inputs"]!; var exp = V["expected"]!;
        var pcPub = H(exp, "pcPublicKey");
        var key = Wcp1.KeyFrom(H(inp, "pcPrivateKey"), pcPub);
        Assert.Equal(exp["pcPublicKey"]!.GetValue<string>(), Wcp1.Hex(Wcp1.PublicBytes(key)));
        var session = Wcp1.PcSession.Create(inp["expiresAt"]!.GetValue<long>() - 300, H(inp, "secret"), 300, key, H(inp, "sessionId"));
        var hello = new Wcp1.Hello(H(exp, "phonePublicKey"), H(inp, "nonceP"), H(exp, "helloProof"));
        var (accept, keys, refusal) = session.HandleHello(hello, inp["expiresAt"]!.GetValue<long>() - 100, H(inp, "nonceC"));
        Assert.Null(refusal);
        Assert.Equal(exp["acceptProof"]!.GetValue<string>(), Wcp1.Hex(accept!.Proof));
        Assert.Equal(exp["clientKey"]!.GetValue<string>(), Wcp1.Hex(keys!.ClientKey));
        Assert.Equal(exp["serverKey"]!.GetValue<string>(), Wcp1.Hex(keys.ServerKey));
        Assert.Equal(exp["sas"]!.GetValue<string>(), keys.Sas);
        var sid = H(inp, "sessionId");
        var f0 = exp["frameClientToServerCounter0"]!;
        Assert.Equal(f0["frame"]!.GetValue<string>(), Wcp1.Hex(Wcp1.Seal(keys.ClientKey, sid, Wcp1.C2S, 0, Encoding.UTF8.GetBytes(f0["plaintextUtf8"]!.GetValue<string>()))));
        var f5 = exp["frameServerToClientCounter5"]!;
        var (counter, plain) = Wcp1.Open(keys.ServerKey, sid, Wcp1.S2C, H(f5, "frame"));
        Assert.Equal(5UL, counter); Assert.Equal(f5["plaintextUtf8"]!.GetValue<string>(), Encoding.UTF8.GetString(plain));
        Assert.Equal(exp["secretFromCode"]!["secret"]!.GetValue<string>(), Wcp1.Hex(Wcp1.SecretFromCode(exp["secretFromCode"]!["code"]!.GetValue<string>())));
    }

    [Fact]
    public void ExpiredRevokedLockedAndUsedSessionsRefuse()
    {
        var now = 1_790_000_000L; var secret = Wcp1.SecretFromCode("111-222-333");
        var s = Wcp1.PcSession.Create(now, secret, 60);
        Assert.Equal(Wcp1.Refusal.Expired, s.HandleHello(new Wcp1.PhoneHandshake(s.Offer).Hello, now + 60).refusal);
        var s2 = Wcp1.PcSession.Create(now, secret); s2.Revoke();
        Assert.Equal(Wcp1.Refusal.Expired, s2.HandleHello(new Wcp1.PhoneHandshake(s2.Offer).Hello, now).refusal);
        var s3 = Wcp1.PcSession.Create(now, secret); var wrong = s3.Offer with { Secret = Wcp1.SecretFromCode("999-999-999") };
        for (var i = 0; i < Wcp1.MaxFailedAttempts; i++) Assert.Equal(Wcp1.Refusal.BadProof, s3.HandleHello(new Wcp1.PhoneHandshake(wrong).Hello, now).refusal);
        Assert.Equal(Wcp1.Refusal.Locked, s3.HandleHello(new Wcp1.PhoneHandshake(s3.Offer).Hello, now).refusal);
        var s4 = Wcp1.PcSession.Create(now, secret);
        Assert.Null(s4.HandleHello(new Wcp1.PhoneHandshake(s4.Offer).Hello, now).refusal);
        Assert.Equal(Wcp1.Refusal.Used, s4.HandleHello(new Wcp1.PhoneHandshake(s4.Offer).Hello, now).refusal);
    }

    [Fact]
    public void PhoneAndComputerAgreeAndReplayedOrTamperedFramesAreRefused()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds(); var s = Wcp1.PcSession.Create(now, Wcp1.SecretFromCode("123-456-789"));
        var phone = new Wcp1.PhoneHandshake(s.Offer); var (accept, keys, _) = s.HandleHello(phone.Hello, now); var pk = phone.Finish(accept!);
        Assert.Equal(keys!.Sas, pk.Sas);
        var a = new Wcp1.Channel(pk, s.Offer.SessionId, server: false); var b = new Wcp1.Channel(keys, s.Offer.SessionId, server: true);
        var f1 = a.Send(Encoding.UTF8.GetBytes("one")); var f2 = a.Send(Encoding.UTF8.GetBytes("two"));
        Assert.Equal("two", Encoding.UTF8.GetString(b.Receive(f2)));
        Assert.Throws<CryptographicException>(() => b.Receive(f1));
        Assert.Throws<CryptographicException>(() => b.Receive(f2));
        var bad = a.Send(Encoding.UTF8.GetBytes("three")); bad[10] ^= 1;
        Assert.ThrowsAny<CryptographicException>(() => b.Receive(bad));
        Assert.Throws<CryptographicException>(() => new Wcp1.PhoneHandshake(s.Offer).Finish(new Wcp1.Accept(new byte[16], new byte[32])));
    }
}

public class SessionServerTests
{
    static async Task<JsonObject> Post(HttpClient c, string path, JsonObject body)
    {
        var r = await c.PostAsync("http://127.0.0.1:47821" + path, new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"));
        var j = JsonNode.Parse(await r.Content.ReadAsStringAsync())!.AsObject(); j["_status"] = (int)r.StatusCode; return j;
    }
    static JsonObject HelloBody(Wcp1.Hello h) => new() { ["phonePub"] = Wcp1.B64u(h.PhonePub), ["nonceP"] = Wcp1.B64u(h.NonceP), ["proof"] = Wcp1.B64u(h.Proof) };

    [Fact]
    public async Task ASessionPairsEncryptsRunsAScanWithRealStageEventsAndRefusesAWrongCode()
    {
        var code = "482-193-755"; SessionServer? server = null;
        server = new SessionServer(code, async (id, deep, ct) =>
        {
            foreach (var n in new[] { 0, 1, 2 })
            {
                await Task.Delay(30, ct);
                server!.Report(new JsonObject { ["scanId"] = id, ["stages"] = new JsonArray(new JsonObject { ["id"] = "a", ["label"] = "A", ["state"] = n == 2 ? "done" : "running" }), ["completedStages"] = n == 2 ? 1 : 0, ["totalStages"] = 1, ["finished"] = n == 2 });
            }
            return InspectionRunner.Envelope("quickcheck", new JsonObject { ["scanId"] = id, ["device"] = new JsonObject { ["name"] = "TEST-PC", ["model"] = null }, ["passed"] = 1, ["attention"] = 0, ["critical"] = 0, ["findings"] = new JsonArray(), ["notMeasured"] = new JsonArray(), ["disclaimer"] = InspectionRunner.Disclaimer });
        });
        using var _ = server; server.Start();
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        var info = JsonNode.Parse(await http.GetStringAsync("http://127.0.0.1:47821/wcp1/info"))!.AsObject();
        Assert.Equal("WCP1", info["protocol"]!.GetValue<string>());
        var offer = new Wcp1.Offer(Wcp1.UnB64u(info["session"]!.GetValue<string>()), Wcp1.UnB64u(info["pcPub"]!.GetValue<string>()), info["expiresAt"]!.GetValue<long>(), Wcp1.SecretFromCode("111-111-111"));
        var rw = await Post(http, "/wcp1/hello", HelloBody(new Wcp1.PhoneHandshake(offer).Hello));
        Assert.Equal(403, rw["_status"]!.GetValue<int>()); Assert.Equal("bad_proof", rw["error"]!.GetValue<string>());

        var good = new Wcp1.PhoneHandshake(offer with { Secret = Wcp1.SecretFromCode(code) });
        var rg = await Post(http, "/wcp1/hello", HelloBody(good.Hello));
        Assert.Equal(200, rg["_status"]!.GetValue<int>());
        var keys = good.Finish(new Wcp1.Accept(Wcp1.UnB64u(rg["nonceC"]!.GetValue<string>()), Wcp1.UnB64u(rg["proof"]!.GetValue<string>())));
        Assert.Equal(server.Sas, keys.Sas);
        var ch = new Wcp1.Channel(keys, offer.SessionId, server: false);
        async Task<JsonObject> Req(JsonObject m)
        {
            var r = await Post(http, "/wcp1/msg", new JsonObject { ["frame"] = Wcp1.B64u(ch.Send(Encoding.UTF8.GetBytes(m.ToJsonString()))) });
            return JsonNode.Parse(Encoding.UTF8.GetString(ch.Receive(Wcp1.UnB64u(r["frame"]!.GetValue<string>()))))!.AsObject();
        }
        var started = await Req(new JsonObject { ["type"] = "start_scan" }); Assert.False(string.IsNullOrEmpty(started["scanId"]!.GetValue<string>()));
        long since = 0; JsonObject? result = null; var progressSeen = 0;
        for (var i = 0; i < 20 && result is null; i++)
        {
            var p = await Req(new JsonObject { ["type"] = "poll", ["since"] = since, ["waitMs"] = 2000 }); since = p["next"]!.GetValue<long>();
            foreach (var e in p["events"]!.AsArray()) { if (e!["kind"]!.GetValue<string>() == "progress") progressSeen++; if (e["kind"]!.GetValue<string>() == "result") result = e["payload"]!.AsObject(); }
        }
        Assert.True(progressSeen >= 1); Assert.NotNull(result);
        Assert.Equal("TEST-PC", result!["device"]!["name"]!.GetValue<string>()); Assert.Equal(1, result["schemaVersion"]!.GetValue<int>());
        var again = await Post(http, "/wcp1/hello", HelloBody(good.Hello));
        Assert.Equal("used", again["error"]!.GetValue<string>());
    }
}

public class RealInspectionTests
{
    [Fact]
    public async Task InspectingThisMachineEndsEveryStageAndProducesAContractShapedResult()
    {
        var runner = new InspectionRunner(new RulesEvaluator(Shared.Read("rules.json"))); var progress = new List<JsonObject>(); runner.Progress += progress.Add;
        var r = await runner.RunAsync("test-scan", CancellationToken.None);
        var last = progress.Last();
        Assert.Equal(InspectionRunner.StageList.Length, last["totalStages"]!.GetValue<int>()); Assert.True(last["finished"]!.GetValue<bool>());
        Assert.All(last["stages"]!.AsArray(), s => Assert.Contains(s!["state"]!.GetValue<string>(), new[] { "done", "failed", "skipped" }));
        var counts = progress.Select(p => p["completedStages"]!.GetValue<int>()).ToList();
        Assert.True(counts.SequenceEqual(counts.OrderBy(x => x)), "progress never goes backwards");
        Assert.Equal("quickcheck", r["source"]!.GetValue<string>()); Assert.Equal(1, r["schemaVersion"]!.GetValue<int>());
        var f = r["findings"]!.AsArray(); Assert.Equal(f.Count, r["passed"]!.GetValue<int>() + r["attention"]!.GetValue<int>() + r["critical"]!.GetValue<int>());
        Assert.All(f, x => { Assert.Contains(x!["severity"]!.GetValue<string>(), new[] { "healthy", "attention", "critical" }); Assert.Contains(x["evidenceType"]!.GetValue<string>(), new[] { "measured", "tested", "inferred" }); });
        Assert.NotEmpty(runner.Inventory!["identity"]!["hostname"]!.GetValue<string>());
        Assert.Contains("does not prove long-term reliability", r["disclaimer"]!.GetValue<string>());
    }
}

public class DeepAuditTests
{
    static InspectionRunner Runner() => new(new RulesEvaluator(Shared.Read("rules.json")));

    [Fact]
    public async Task TheFreeScanRunsNoDeepCheckAndOnlyNamesWhatItDidNotRun()
    {
        var r = await Runner().RunAsync("free", CancellationToken.None, deep: false);
        Assert.Equal("essential", r["depth"]!.GetValue<string>());
        Assert.DoesNotContain(r["findings"]!.AsArray(), f => f!["tier"]?.GetValue<string>() == "deep");
        var notRun = r["deepNotRun"]!.AsArray(); Assert.True(notRun.Count >= 6);
        // names and what they look at, never a result
        Assert.All(notRun, n => { Assert.False(string.IsNullOrWhiteSpace(n!["title"]!.GetValue<string>())); Assert.DoesNotContain("found", n["why"]!.GetValue<string>(), StringComparison.OrdinalIgnoreCase); });
        Assert.DoesNotContain(r["notMeasured"]!.AsArray(), n => n!.GetValue<string>().StartsWith("Drive encryption") || n.GetValue<string>().StartsWith("Windows support"));
    }

    [Fact]
    public async Task TheDeepScanReadsThisMachineAndTagsItsFindingsDeep()
    {
        var runner = Runner(); var stages = new List<JsonObject>(); runner.Progress += stages.Add;
        var r = await runner.RunAsync("deep", CancellationToken.None, deep: true);
        Assert.Equal("deep", r["depth"]!.GetValue<string>()); Assert.Null(r["deepNotRun"]);
        var deepFindings = r["findings"]!.AsArray().Where(f => f!["tier"]?.GetValue<string>() == "deep").ToList();
        Assert.NotEmpty(deepFindings);                                                     // a real PC always yields some deep readings (updates, settings, reliability)
        Assert.All(deepFindings, f => Assert.StartsWith("deep.", f!["id"]!.GetValue<string>()));
        Assert.True(stages.Last()["totalStages"]!.GetValue<int>() == InspectionRunner.StageList.Length + InspectionRunner.DeepStageList.Length);
        Assert.All(stages.Last()["stages"]!.AsArray(), s => Assert.Contains(s!["state"]!.GetValue<string>(), new[] { "done", "failed", "skipped" }));
        var dump = Environment.GetEnvironmentVariable("QC_DUMP"); if (!string.IsNullOrEmpty(dump)) File.WriteAllText(dump, r.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }) + "\n\nINVENTORY\n" + runner.Inventory!["deep"]!.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    }

    [Fact]
    public void AnUnreadableInputIsSkippedNotGuessed()
    {
        var eval = new RulesEvaluator(Shared.Read("rules.json"));
        var r = eval.Evaluate(JsonNode.Parse("{\"schemaVersion\":1,\"deep\":{\"os\":{\"build\":\"26200\",\"daysSinceSupportEnded\":-400,\"supportEnds\":\"2027-10-12\"}}}")!, includeDeep: true);
        Assert.Contains(r.Findings, f => f["id"]!.GetValue<string>() == "deep.os_support" && f["severity"]!.GetValue<string>() == "healthy" && f["evidenceType"]!.GetValue<string>() == "inferred");
        Assert.Contains("deep.bitlocker", r.Skipped);                                    // nothing read, so nothing claimed
        Assert.DoesNotContain(r.Findings, f => f["id"]!.GetValue<string>() == "deep.bitlocker");
        Assert.Empty(eval.Evaluate(JsonNode.Parse("{\"schemaVersion\":1,\"deep\":{\"secureBoot\":false}}")!, includeDeep: false).Findings);
    }
}
