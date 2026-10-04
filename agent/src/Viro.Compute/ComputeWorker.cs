using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Viro.Agent;

namespace Viro.Compute;

public sealed record ComputeStatus(string State, string Reason, int CpuCapPercent, double ComputeSeconds, double? HashRate, bool WorkloadRunning);

/// <summary>
/// Whether the mining engine is actually reaching the pool, not just running. A process that never connects (or stops connecting) is most often a
/// firewall or antivirus product blocking the connection, not a Viro problem; Viro never works around security software, it only reports this plainly.
/// </summary>
public static class PoolReachability
{
    static readonly TimeSpan NeverConnectedGrace = TimeSpan.FromSeconds(45), ReconnectGrace = TimeSpan.FromMinutes(3);

    /// <returns>A plain-words reason once the grace period has passed without a pool connection, otherwise null.</returns>
    public static string? Describe(DateTime? startedAt, DateTime? lastConnectedAt, DateTime now, string? poolHost)
    {
        if (startedAt is not { } started) return null;
        var sinceConnected = lastConnectedAt is { } c ? now - c : (TimeSpan?)null;
        var elapsed = sinceConnected ?? now - started;
        if (elapsed <= (sinceConnected is null ? NeverConnectedGrace : ReconnectGrace)) return null;
        var host = string.IsNullOrWhiteSpace(poolHost) ? "the configured pool" : poolHost;
        return $"The mining pool ({host}) could not be reached from this PC for {(int)elapsed.TotalMinutes} minute(s). This is usually a firewall or antivirus product blocking the connection; Viro does not work around security software. Allow {host} through it, or ask your IT team to add an exception, and mining resumes automatically.";
    }
}

/// <summary>Fetches and caches the signed compute policy. A policy that cannot be verified, or has expired, is never used.</summary>
public sealed class PolicyStore(string dataDir, string publicKeySpkiBase64)
{
    readonly ECDsa _key = Import(publicKeySpkiBase64);
    static ECDsa Import(string b64) { var k = ECDsa.Create(); k.ImportSubjectPublicKeyInfo(Convert.FromBase64String(b64), out _); return k; }
    string CachePath => Path.Combine(dataDir, "compute", "policy.json");
    public ComputePolicy Current { get; private set; } = ComputePolicy.Disabled;
    public DateTime? FetchedUtc { get; private set; }

    /// <summary>Verifies signature over the exact policy text, then applies it. Returns false (and keeps the old policy) on any failure.</summary>
    public bool TryApply(string policyText, string signatureB64, string? expectedWorkerId = null)
    {
        try
        {
            if (!_key.VerifyData(Encoding.UTF8.GetBytes(policyText), Convert.FromBase64String(signatureB64), HashAlgorithmName.SHA256)) return false;
            var p = ComputePolicy.Parse(policyText);
            if (expectedWorkerId is not null && p.WorkerId != expectedWorkerId) return false;   // a policy issued for another PC is not for us
            if (p.Version < Current.Version) return false;                                       // never roll back to an older policy
            Current = p; FetchedUtc = DateTime.UtcNow;
            Directory.CreateDirectory(Path.GetDirectoryName(CachePath)!);
            File.WriteAllText(CachePath, JsonSerializer.Serialize(new { policy = policyText, signature = signatureB64 }));
            return true;
        }
        catch { return false; }
    }

    /// <summary>After a restart with no network: the last verified policy, until it expires.</summary>
    public void LoadCached(string? expectedWorkerId = null)
    {
        try { using var d = JsonDocument.Parse(File.ReadAllText(CachePath)); TryApply(d.RootElement.GetProperty("policy").GetString()!, d.RootElement.GetProperty("signature").GetString()!, expectedWorkerId); } catch { }
    }
}

/// <summary>
/// The Viro Compute Worker service loop. Every two seconds it observes the PC, asks the policy engine whether compute may run, and
/// starts or stops the workload accordingly. It reports state and compute time to Control and never touches anything else on the PC.
/// </summary>
public sealed class ComputeWorker(ILogger<ComputeWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var cfg = AgentConfig.Load();
        while (!cfg.IsEnrolled || cfg.JobSigningPublicKey == "")      // installed together with the agent: wait for enrollment instead of giving up
        {
            log.LogInformation("This PC is not enrolled with Viro Control yet; the compute worker is waiting.");
            try { await Task.Delay(TimeSpan.FromSeconds(30), ct); } catch (OperationCanceledException) { return; }
            cfg = AgentConfig.Load();
        }
        var client = new ControlClient(cfg.ServerUrl); client.UseDevice(cfg.DeviceId, cfg.DeviceSecret);
        var store = new PolicyStore(AgentConfig.DataDir, cfg.JobSigningPublicKey); store.LoadCached();
        var probe = new UserProbeHost(log); using var host = new WorkloadHost();
        var engines = new EngineStore(Path.Combine(AgentConfig.DataDir, "compute"));
        var provider = new WorkloadProvider(Environment.ProcessPath!, engines);
        var preparing = false; string? engineProblem = null;
        double? hashRate = null; host.OutputLine += l => { if (l.StartsWith("rate=") && double.TryParse(l[5..], out var r)) hashRate = r; };
        var tracker = new SessionTracker(); var outbox = new SessionOutbox(Path.Combine(AgentConfig.DataDir, "compute")); var lastSessionReport = DateTime.MinValue; var lastOutboxTry = DateTime.MinValue;
        var (_, totalMem) = SignalReader.Memory();
        var lastPolicyFetch = DateTime.MinValue; var lastBeat = DateTime.MinValue; double computeSecondsUnreported = 0; var lastTick = DateTime.UtcNow;
        var state = "starting"; var reason = ""; var disclosed = File.Exists(Path.Combine(AgentConfig.DataDir, "compute", "disclosed"));
        DateTime? miningStartedAt = null; DateTime? poolLastConnectedAt = null;   // tracks whether the engine is actually reaching the pool, not just running
        log.LogInformation("Viro Compute Worker {Version} started", Collectors.AgentVersion);

        (HealthGate Gate, DateTime At)? lastGate = null; var lastRate = DateTime.MinValue; var thermal = ThermalLevel.Normal; double? criticalTrip = null; var lastTrip = DateTime.MinValue; double? lastTemp = null;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        try
        {
        do
        {
            var now = DateTime.UtcNow; var dt = (now - lastTick).TotalSeconds; lastTick = now;
            try
            {
                if (now - lastPolicyFetch > TimeSpan.FromMinutes(1)) { lastPolicyFetch = now; await FetchPolicyAsync(client, store, ct); }
                probe.EnsureRunning();
                var act = probe.Fresh();
                var p = store.Current;
                // The engine is fetched from Control only when the signed policy asks for it, and only ever run after its checksum matches.
                if (p.Enabled && p.Fallback == "xmrig" && p.Engine is { } eng && !preparing && engines.NotReadyReason(eng) is not null && engineProblem is null)
                {
                    preparing = true;
                    _ = Task.Run(async () => { engineProblem = await engines.InstallAsync(eng, s => client.DownloadAsync("agent/v1/compute/engine/" + Uri.EscapeDataString(eng.Version), s, ct)); if (engineProblem is not null) { log.LogWarning("Mining engine not installed: {Problem}", engineProblem); preparing = false; await Task.Delay(TimeSpan.FromMinutes(10), ct); engineProblem = null; } preparing = false; }, ct);   // a failed download is retried after ten minutes
                }
                var work = provider.Next(p, totalMem, out var noWork);
                if (work is null && p.Fallback == "xmrig" && preparing) noWork = "the mining engine is being downloaded and verified";
                else if (work is null && p.Fallback == "xmrig" && engineProblem is not null && noWork is not null && noWork.Contains("not installed")) noWork = engineProblem;
                var sig = new Signals(act?.IdleSeconds, SignalReader.OnBattery(), SignalReader.CpuTempC(), SignalReader.Memory().usedPercent, BusyLease.Read(AgentConfig.DataDir), SignalReader.MaintenanceRunning(), act?.Fullscreen ?? false, work is not null);
                var gate = lastGate is { } lg && now - lg.At < TimeSpan.FromHours(6) ? lg.Gate : null;   // an old instruction is not held forever
                if (now - lastTrip > TimeSpan.FromMinutes(10)) { lastTrip = now; criticalTrip = SignalReader.CriticalTripC(); }
                sig = sig with { CriticalTripC = criticalTrip, BatteryPercent = SignalReader.BatteryPercent() }; lastTemp = sig.CpuTempC;
                var d = PolicyEngine.Decide(p, sig, host.IsRunning, now, null, gate, thermal);
                if (d.Thermal != thermal) log.LogInformation("Thermal level {From} -> {To} at {Temp}°C", thermal, d.Thermal, sig.CpuTempC); thermal = d.Thermal;
                if (d.State == "no-work" && noWork is not null) d = d with { Reason = noWork };

                if (tracker.Active && !host.IsRunning) await EndSessionAsync(client, tracker, outbox, now, "engine exited", ct);      // it stopped on its own: say so
                if (d.Run && !host.IsRunning && work is not null)
                {
                    Disclose(p, ref disclosed);
                    host.Start(work with { CpuCapPercent = d.CpuCapPercent }); hashRate = null;
                    log.LogInformation("Compute started at {Cap}% CPU cap", d.CpuCapPercent);
                    if (p.Fallback == "xmrig")      // only the real engine is reported as a mining session, never the self-test workload
                    {
                        tracker.Start(now, p.Engine?.Version, Collectors.AgentVersion); lastRate = DateTime.MinValue; lastSessionReport = now;
                        miningStartedAt = now; poolLastConnectedAt = null;
                        await SendSessionAsync(client, tracker.Report(now, null), ct);
                    }
                }
                else if (!d.Run && host.IsRunning) { host.Stop(); hashRate = null; miningStartedAt = null; log.LogInformation("Compute stopped: {Reason}", d.Reason); if (tracker.Active) await EndSessionAsync(client, tracker, outbox, now, d.Reason, ct); }
                else if (d.Run && host.IsRunning) host.SetCpuCap(d.CpuCapPercent);
                if (host.IsRunning && p.Fallback == "xmrig" && provider.MinerApi is { } api && now - lastRate > TimeSpan.FromSeconds(20))
                {
                    lastRate = now;
                    var sum = await MinerArgs.ReadSummaryAsync(api.Port, api.Token, ct); hashRate = sum?.Hashrate;
                    if (sum is not null) tracker.Observe(now, sum);
                    if (sum?.PoolConnected == true) poolLastConnectedAt = now;
                }
                // The engine can run perfectly well and still never reach the pool: a firewall or security product can block the connection outright.
                // That is never worked around here; it is just reported honestly, so an administrator can see it and allow the pool through their own tools.
                var poolUnreachable = host.IsRunning && p.Fallback == "xmrig"
                    ? PoolReachability.Describe(miningStartedAt, poolLastConnectedAt, now, p.Pool?.Host)
                    : null;
                if (tracker.Active && now - lastSessionReport > TimeSpan.FromSeconds(60))
                {
                    lastSessionReport = now;
                    await SendSessionAsync(client, tracker.Report(now, new SessionSample(null, lastTemp, SignalReader.Memory().usedPercent)), ct);
                }
                if (!tracker.Active && now - lastOutboxTry > TimeSpan.FromMinutes(1)) { lastOutboxTry = now; await FlushOutboxAsync(client, outbox, ct); }
                if (host.IsRunning) computeSecondsUnreported += dt;
                (state, reason) = poolUnreachable is not null ? ("pool-unreachable", poolUnreachable) : (host.IsRunning ? "running" : d.State, d.Reason);

                if (now - lastBeat > TimeSpan.FromSeconds(30))
                {
                    lastBeat = now;
                    using var beat = await client.CallAsync(HttpMethod.Post, "agent/v1/compute/heartbeat", new
                    {
                        state, reason, cpuCapPercent = p.MaxCpuPercent, computeSeconds = Math.Round(computeSecondsUnreported, 1), hashRate,
                        workerVersion = Collectors.AgentVersion, policyVersion = p.Version, userIdleSeconds = act?.IdleSeconds, integrity = TryIntegrity(), thermal = thermal.ToString().ToLowerInvariant(), cpuTempC = lastTemp,
                    }, ct);
                    computeSecondsUnreported = 0;
                    if (beat?.RootElement.TryGetProperty("health", out var hg) == true && hg.ValueKind == JsonValueKind.Object)
                        lastGate = (new HealthGate((hg.TryGetProperty("gate", out var g) ? g.GetString() : null) ?? "ALLOW", (hg.TryGetProperty("reason", out var r) ? r.GetString() : null) ?? ""), now);
                }
            }
            catch (Exception e) when (!ct.IsCancellationRequested)
            {
                if (host.IsRunning) host.Stop();      // when in doubt, stop
                log.LogWarning("Compute cycle failed: {Msg}", e.Message);
            }
        } while (await timer.WaitForNextTickAsync(ct));
        }
        catch (OperationCanceledException) { /* the service is stopping */ }
        finally
        {
            host.Stop(); probe.Dispose();
            if (tracker.Active) { using var last = new CancellationTokenSource(TimeSpan.FromSeconds(5)); await EndSessionAsync(client, tracker, outbox, DateTime.UtcNow, "worker shutting down", last.Token); }
        }
    }

    /// <summary>Delivers one session report. Progress reports are best-effort (the next one supersedes them); returns the failure kind for stop reports.</summary>
    async Task<bool> SendSessionAsync(ControlClient client, object report, CancellationToken ct)
    {
        try { using var _ = await client.CallAsync(HttpMethod.Post, "agent/v1/compute/session", report, ct); return true; }
        catch (HttpRequestException e) when (e.StatusCode is { } sc && (int)sc is >= 400 and < 500 && (int)sc is not (401 or 408 or 429)) { log.LogWarning("Control rejected a mining session report ({Status}); it will not be retried", (int)sc); return true; }
        catch (Exception e) when (!ct.IsCancellationRequested) { log.LogInformation("Could not report the mining session ({Msg})", e.Message); return false; }
    }

    /// <summary>Closes the session with its stop reason. A stop that cannot be delivered is saved and retried until Control has it.</summary>
    async Task EndSessionAsync(ControlClient client, SessionTracker tracker, SessionOutbox outbox, DateTime now, string? reason, CancellationToken ct)
    {
        var report = tracker.Stop(now, reason);
        if (!await SendSessionAsync(client, report, ct)) outbox.Save(report);
    }

    async Task FlushOutboxAsync(ControlClient client, SessionOutbox outbox, CancellationToken ct)
    {
        var text = outbox.Load(); if (text is null) return;
        try { using var body = JsonDocument.Parse(text); if (await SendSessionAsync(client, body.RootElement.Clone(), ct)) outbox.Clear(); }
        catch (JsonException) { outbox.Clear(); }      // unreadable leftovers are not worth keeping
    }

    static object? TryIntegrity() { try { return Integrity.Collect("ViroCompute", UserSessionLauncher.IsSystem()); } catch { return null; } }

    async Task FetchPolicyAsync(ControlClient client, PolicyStore store, CancellationToken ct)
    {
        try
        {
            using var doc = await client.CallAsync(HttpMethod.Get, "agent/v1/compute/policy", null, ct);
            var r = doc!.RootElement;
            if (!store.TryApply(r.GetProperty("policy").GetString()!, r.GetProperty("signature").GetString()!, r.TryGetProperty("workerId", out var w) ? w.GetString() : null)) log.LogWarning("Ignored a compute policy that failed verification");
        }
        catch (Exception e) when (!ct.IsCancellationRequested) { log.LogInformation("Could not refresh the compute policy ({Msg}); using the last verified policy", e.Message); }
    }

    /// <summary>The first time compute runs on a PC, the people using it are told once, in plain words.</summary>
    void Disclose(ComputePolicy p, ref bool done)
    {
        if (done) return;
        try
        {
            new SessionNotifier().Notify("Your organization uses idle time on this PC",
                $"Your organization has enabled idle-time compute sponsorship on this PC. It only runs while you are away from the keyboard, uses at most {p.MaxCpuPercent}% of the processor, and stops the moment you return. Ask your IT team for details.", 120);
            Directory.CreateDirectory(Path.Combine(AgentConfig.DataDir, "compute")); File.WriteAllText(Path.Combine(AgentConfig.DataDir, "compute", "disclosed"), DateTime.UtcNow.ToString("O")); done = true;
        }
        catch { /* try again next time */ }
    }
}
