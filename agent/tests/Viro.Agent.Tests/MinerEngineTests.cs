using System.Security.Cryptography;
using Viro.Compute;
using Xunit;

public class MinerEngineTests
{
    static readonly string Addr = "4" + new string('A', 94);
    static PoolSpec Pool(Func<PoolSpec, PoolSpec>? f = null) { var p = new PoolSpec("pool.example.org", 443, true, Addr); return f?.Invoke(p) ?? p; }
    static readonly string Token = new string('a', 32);

    [Fact]
    public void Arguments_are_fixed_validated_and_switch_off_everything_that_would_need_a_driver()
    {
        var a = MinerArgs.Build(Pool(), "org-dev.1", 30, 8, 18080, Token);
        Assert.Equal($"--url=pool.example.org:443 --tls --user={Addr} --pass=org-dev.1 --threads=2 --randomx-mode=light --randomx-no-rdmsr --randomx-wrmsr=-1 --no-color --print-time=60 --http-host=127.0.0.1 --http-port=18080 --http-access-token={Token}", a);
        Assert.DoesNotContain("--tls", MinerArgs.Build(Pool(p => p with { Tls = false }), "w", 30, 8, 18080, Token));
        Assert.DoesNotContain("--background", a); Assert.DoesNotContain("--cpu-affinity", a);
        Assert.Contains("--http-host=127.0.0.1", a);      // the local API is never reachable from the network
    }

    [Theory]
    [InlineData("bad host;calc", 443, "x")] [InlineData("pool.example.org && calc", 443, "x")] [InlineData("pool.example.org", 0, "x")] [InlineData("pool.example.org", 70000, "x")] [InlineData("-evil.org", 443, "x")] [InlineData("", 443, "x")]
    public void Malformed_pool_hosts_and_ports_never_reach_a_command_line(string host, int port, string _) =>
        Assert.Throws<ArgumentException>(() => MinerArgs.Build(new PoolSpec(host, port, true, Addr), "w", 30, 8, 18080, Token));

    [Theory]
    [InlineData("")] [InlineData("abandon ability able about above absent")] [InlineData("4short")] [InlineData("1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    public void Only_a_public_Monero_address_is_ever_used_never_a_key_or_a_phrase(string address)
    {
        Assert.False(MinerArgs.ValidPool(new PoolSpec("pool.example.org", 443, true, address)));
        Assert.False(MinerArgs.ValidPool(new PoolSpec("pool.example.org", 443, true, new string('a', 64))), "a 64-hex private key");
        Assert.True(MinerArgs.ValidPool(Pool())); Assert.True(MinerArgs.ValidPool(Pool(p => p with { Address = "8" + new string('B', 94) })));
    }

    [Fact]
    public void Other_arguments_are_validated_too_and_thread_count_follows_the_cpu_cap()
    {
        Assert.Throws<ArgumentException>(() => MinerArgs.Build(Pool(), "worker with space", 30, 8, 18080, Token));
        Assert.Throws<ArgumentException>(() => MinerArgs.Build(Pool(), "w", 30, 8, 80, Token));
        Assert.Throws<ArgumentException>(() => MinerArgs.Build(Pool(), "w", 30, 8, 18080, "tok;en"));
        Assert.Equal(1, MinerArgs.Threads(5, 4)); Assert.Equal(4, MinerArgs.Threads(90, 4)); Assert.Equal(1, MinerArgs.Threads(30, 1)); Assert.Equal(6, MinerArgs.Threads(75, 8));
        var (port, token) = MinerArgs.NewApiEndpoint(); Assert.InRange(port, 1024, 65535); Assert.Equal(48, token.Length); Assert.NotEqual(token, MinerArgs.NewApiEndpoint().token);
    }

    [Fact]
    public void The_hash_rate_is_read_from_the_engines_local_summary_and_junk_is_ignored()
    {
        Assert.Equal(123.4, MinerArgs.ParseHashrate("{\"hashrate\":{\"total\":[123.44,120.1,118.0]}}"));
        Assert.Null(MinerArgs.ParseHashrate("{\"hashrate\":{\"total\":[null,null,null]}}")); Assert.Null(MinerArgs.ParseHashrate("{\"hashrate\":{\"total\":[]}}"));
        Assert.Null(MinerArgs.ParseHashrate("{}")); Assert.Null(MinerArgs.ParseHashrate("not json")); Assert.Null(MinerArgs.ParseHashrate("{\"hashrate\":{\"total\":[-5]}}"));
    }

    static (string root, byte[] exe, EngineSpec spec) Sample(string version = "6.21.0")
    {
        var root = Path.Combine(Path.GetTempPath(), "viro-engine-" + Guid.NewGuid().ToString("N"));
        var exe = new byte[5000]; RandomNumberGenerator.Fill(exe); exe[0] = (byte)'M'; exe[1] = (byte)'Z';
        return (root, exe, new(version, Convert.ToHexString(SHA256.HashData(exe)).ToLowerInvariant(), exe.Length));
    }

    [Fact]
    public async Task An_engine_is_installed_only_when_size_format_and_checksum_all_match_and_is_never_run_after_it_changes()
    {
        var (root, exe, spec) = Sample(); var store = new EngineStore(root);
        try
        {
            Assert.Contains("not installed", store.NotReadyReason(spec));
            Assert.Null(await store.InstallAsync(spec, s => s.WriteAsync(exe).AsTask()));
            Assert.Null(store.NotReadyReason(spec)); Assert.True(File.Exists(store.ExePath(spec)));
            File.WriteAllBytes(store.ExePath(spec), exe.Select(b => (byte)(b ^ 1)).ToArray().Prepend((byte)'M').Skip(1).ToArray());       // tampered on disk
            Assert.Contains("does not match", store.NotReadyReason(spec));
            File.Delete(store.ExePath(spec)); Assert.Contains("removed", store.NotReadyReason(spec));   // e.g. quarantined by security software: reported, never worked around
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    [Fact]
    public async Task A_bad_download_is_rejected_and_leaves_nothing_behind()
    {
        var (root, exe, spec) = Sample(); var store = new EngineStore(root);
        try
        {
            Assert.Contains("checksum", await store.InstallAsync(spec with { Sha256 = new string('0', 64) }, s => s.WriteAsync(exe).AsTask()));
            Assert.Contains("wrong size", await store.InstallAsync(spec with { Size = exe.Length + 1 }, s => s.WriteAsync(exe).AsTask()));
            var notExe = exe.ToArray(); notExe[0] = (byte)'#';
            Assert.Contains("not a Windows program", await store.InstallAsync(spec with { Sha256 = Convert.ToHexString(SHA256.HashData(notExe)).ToLowerInvariant() }, s => s.WriteAsync(notExe).AsTask()));
            Assert.Contains("could not download", await store.InstallAsync(spec, _ => throw new IOException("network down")));
            Assert.False(File.Exists(store.ExePath(spec))); Assert.False(File.Exists(store.ExePath(spec) + ".part"));
            Assert.StartsWith(root, Path.GetFullPath(new EngineStore(root).ExePath(spec with { Version = "..\\..\\evil" })), StringComparison.OrdinalIgnoreCase);   // a version name cannot escape the engine folder
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    [Fact]
    public void The_signed_policy_is_parsed_strictly_engine_and_pool_or_nothing()
    {
        string Json(string engine, string pool) => "{\"enabled\":true,\"fallback\":\"xmrig\",\"workerId\":\"w1\"" + (engine == "" ? "" : ",\"engine\":" + engine) + (pool == "" ? "" : ",\"pool\":" + pool) + "}";
        var sha = new string('a', 64);
        var ok = ComputePolicy.Parse(Json($"{{\"version\":\"6.21.0\",\"sha256\":\"{sha}\",\"size\":5000000}}", $"{{\"endpoints\":[{{\"host\":\"pool.example.org\",\"port\":443,\"tls\":true}}],\"payoutAddress\":\"{Addr}\"}}"));
        Assert.Equal(new EngineSpec("6.21.0", sha, 5_000_000), ok.Engine); Assert.Equal(new PoolSpec("pool.example.org", 443, true, Addr), ok.Pool);
        Assert.Null(ComputePolicy.Parse(Json("", "")).Engine); Assert.Null(ComputePolicy.Parse(Json("", "")).Pool);
        Assert.Null(ComputePolicy.Parse(Json($"{{\"version\":\"../x\",\"sha256\":\"{sha}\",\"size\":5000000}}", "")).Engine);
        Assert.Null(ComputePolicy.Parse(Json("{\"version\":\"1\",\"sha256\":\"zz\",\"size\":5000000}", "")).Engine);
        Assert.Null(ComputePolicy.Parse(Json($"{{\"version\":\"1\",\"sha256\":\"{sha}\",\"size\":10}}", "")).Engine);
        Assert.Null(ComputePolicy.Parse(Json("", $"{{\"endpoints\":[{{\"host\":\"pool.example.org\",\"port\":443}}],\"payoutAddress\":\"{new string('a', 64)}\"}}")).Pool);
        Assert.Null(ComputePolicy.Parse(Json("", $"{{\"endpoints\":[{{\"host\":\"a b\",\"port\":443}}],\"payoutAddress\":\"{Addr}\"}}")).Pool);
        Assert.Null(ComputePolicy.Parse(Json("", $"{{\"endpoints\":[],\"payoutAddress\":\"{Addr}\"}}")).Pool);
    }

    [Fact]
    public async Task The_engine_slot_runs_only_with_a_pool_a_published_engine_a_matching_checksum_and_a_worker_id_and_says_why_otherwise()
    {
        var (root, exe, spec) = Sample(); var store = new EngineStore(root);
        try
        {
            var provider = new WorkloadProvider(@"C:\viro-compute.exe", store) { Cores = 8 };
            ComputePolicy P(Func<ComputePolicy, ComputePolicy>? f = null) { var p = new ComputePolicy(true, 1, 30, 10, null, false, 70, 15, true, 0, "xmrig", "w1", null, spec, Pool()); return f?.Invoke(p) ?? p; }
            const long mem = 8L * 1024 * 1024 * 1024;
            Assert.Null(provider.Next(P(p => p with { Pool = null }), mem, out var r1)); Assert.Contains("pool", r1);
            Assert.Null(provider.Next(P(p => p with { Engine = null }), mem, out var r2)); Assert.Contains("no mining engine has been published", r2);
            Assert.Null(provider.Next(P(), mem, out var r3)); Assert.Contains("not installed", r3);
            Assert.Null(await store.InstallAsync(spec, s => s.WriteAsync(exe).AsTask()));
            Assert.Null(provider.Next(P(p => p with { WorkerId = null }), mem, out var r4)); Assert.Contains("worker id", r4);
            var w = provider.Next(P(), mem, out var r5); Assert.Null(r5); Assert.NotNull(w);
            Assert.Equal(store.ExePath(spec), w!.Exe); Assert.Equal(30, w.CpuCapPercent); Assert.Equal(mem * 15 / 100, w.MemoryLimitBytes);
            Assert.Contains("--threads=2", w.Args); Assert.Contains("--randomx-no-rdmsr", w.Args); Assert.NotNull(provider.MinerApi);
            Assert.Contains($"--http-port={provider.MinerApi!.Value.Port}", w.Args); Assert.Contains(provider.MinerApi.Value.Token, w.Args);
            File.WriteAllBytes(store.ExePath(spec), new byte[5000]); Assert.Null(provider.Next(P(), mem, out var r6)); Assert.Contains("does not match", r6);
            Assert.NotNull(new WorkloadProvider(@"C:\x.exe", store).Next(P(p => p with { Fallback = "selftest" }), mem, out _));   // the self-test load is unaffected
            Assert.Null(new WorkloadProvider(@"C:\x.exe").Next(P(), mem, out var r7)); Assert.Contains("store is unavailable", r7);
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }
}
