using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace Viro.Agent;

public sealed record JobEnvelope(string Id, string Payload, string Signature);
public sealed record VerifiedJob(string Id, string Type, JsonElement Params, int TimeoutSeconds);
public sealed record JobOutcome(bool Success, object? Result = null, string? Error = null);
public sealed record JobContext(VerifiedJob Job, ControlClient Client, UpdateStateCache Updates, ILogger Log);

public interface IJobHandler
{
    string Type { get; }
    Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct);
}

/// <summary>
/// Remembers job ids so a captured signed job can never be run twice. A job counts as used once it has STARTED (that is written to disk, so it survives restarts). A job that was only accepted
/// is remembered in memory: if the agent restarts or is updated before the job began, Control offers it again and it runs, instead of being refused as a "replay" of something that never ran.
/// </summary>
public sealed class ReplayStore(string path, int capacity = 2000)
{
    readonly object _gate = new();
    HashSet<string>? _started; readonly HashSet<string> _accepted = [];
    List<string> Load() => File.Exists(path) ? [.. File.ReadAllLines(path).Where(l => l.Length > 0)] : [];

    public bool TryMarkSeen(string id)
    {
        lock (_gate)
        {
            _started ??= [.. Load()];
            if (_started.Contains(id)) return false;
            return _accepted.Add(id);
        }
    }

    /// <summary>The job is about to run: from now on it can never be accepted again, even after a restart.</summary>
    public void MarkStarted(string id)
    {
        lock (_gate)
        {
            var list = Load(); _started ??= [.. list];
            if (!_started.Add(id)) return;
            list.Add(id);
            if (list.Count > capacity) list.RemoveRange(0, list.Count - capacity);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllLines(path, list);
        }
    }
}

/// <summary>
/// The only gate between the network and code execution. A job is accepted only if the pinned server key signed the exact
/// bytes, it is addressed to this device and organization, it has not expired, it is a known compiled-in type, and its id
/// has never been seen. Everything else is rejected with a reason.
/// </summary>
public sealed class JobVerifier
{
    readonly ECDsa _key;
    readonly string _deviceId, _orgId;
    readonly ISet<string> _knownTypes;
    readonly ReplayStore _replay;
    readonly Func<DateTimeOffset> _now;
    static readonly TimeSpan ClockSkew = TimeSpan.FromMinutes(5);

    public JobVerifier(string publicKeySpkiBase64, string deviceId, string orgId, IEnumerable<string> knownTypes, ReplayStore replay, Func<DateTimeOffset>? now = null)
    {
        _key = ECDsa.Create();
        _key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(publicKeySpkiBase64), out _);
        (_deviceId, _orgId, _replay) = (deviceId, orgId, replay);
        _knownTypes = new HashSet<string>(knownTypes);
        _now = now ?? (() => DateTimeOffset.UtcNow);
    }

    public void MarkStarted(string id) => _replay.MarkStarted(id);

    public (VerifiedJob? job, string? rejection) Verify(JobEnvelope e)
    {
        bool sigOk;
        try { sigOk = _key.VerifyData(Encoding.UTF8.GetBytes(e.Payload), Convert.FromBase64String(e.Signature), HashAlgorithmName.SHA256); }
        catch (FormatException) { sigOk = false; }
        if (!sigOk) return (null, "signature verification failed");

        JsonElement p;
        try { p = JsonDocument.Parse(e.Payload).RootElement.Clone(); } catch (JsonException) { return (null, "payload is not valid JSON"); }
        string? S(string n) => p.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        if (!(p.TryGetProperty("v", out var ver) && ver.ValueKind == JsonValueKind.Number && ver.GetInt32() == 1)) return (null, "unsupported job format version");
        if (S("jobId") != e.Id) return (null, "job id does not match the signed payload");
        if (S("deviceId") != _deviceId) return (null, "job is addressed to a different device");
        if (S("orgId") != _orgId) return (null, "job belongs to a different organization");
        if (!DateTimeOffset.TryParse(S("expiresAt"), out var exp) || !DateTimeOffset.TryParse(S("issuedAt"), out var iss)) return (null, "job has no valid validity window");
        var now = _now();
        if (now > exp + ClockSkew) return (null, "job has expired");
        if (iss > now + ClockSkew) return (null, "job is issued in the future");
        var type = S("type");
        if (type is null || !_knownTypes.Contains(type)) return (null, $"unsupported job type \"{type}\"");
        if (!_replay.TryMarkSeen(e.Id)) return (null, "job id was already processed (replay)");
        var timeout = p.TryGetProperty("timeoutSeconds", out var t) && t.ValueKind == JsonValueKind.Number ? Math.Clamp(t.GetInt32(), 5, 3600) : 300;
        return (new VerifiedJob(e.Id, type, p.TryGetProperty("params", out var pr) ? pr.Clone() : JsonDocument.Parse("{}").RootElement.Clone(), timeout), null);
    }
}

/// <summary>Runs verified jobs one at a time, reporting every state change to Control. Supports cancel and per-job timeout.</summary>
public sealed class JobRunner(ControlClient client, JobVerifier verifier, IEnumerable<IJobHandler> handlers, UpdateStateCache updates, ILogger log)
{
    readonly Dictionary<string, IJobHandler> _handlers = handlers.ToDictionary(h => h.Type);
    readonly Channel<VerifiedJob> _queue = Channel.CreateUnbounded<VerifiedJob>();
    readonly HashSet<string> _known = [];   // ids queued or running in this process
    readonly Dictionary<string, CancellationTokenSource> _running = [];
    readonly HashSet<string> _cancelled = [];
    readonly object _gate = new();

    public IEnumerable<string> Types => _handlers.Keys;

    /// <summary>Called with the jobs from a heartbeat response. Invalid jobs are rejected and reported failed.</summary>
    public async Task OfferAsync(IEnumerable<JobEnvelope> envelopes, CancellationToken ct)
    {
        foreach (var e in envelopes)
        {
            lock (_gate) if (_known.Contains(e.Id)) continue;
            var (job, rejection) = verifier.Verify(e);
            if (job is null)
            {
                log.LogWarning("Rejected job {Id}: {Reason}", e.Id, rejection);
                try { await client.StartJobAsync(e.Id, ct); await client.ReportJobAsync(e.Id, "failed", null, "rejected by agent: " + rejection, ct); } catch (Exception ex) { log.LogWarning("Could not report rejection of {Id}: {Msg}", e.Id, ex.Message); }
                continue;
            }
            lock (_gate) _known.Add(job.Id);
            await _queue.Writer.WriteAsync(job, ct);
        }
    }

    public void Cancel(IEnumerable<string> ids)
    {
        lock (_gate)
            foreach (var id in ids) { _cancelled.Add(id); if (_running.TryGetValue(id, out var cts)) cts.Cancel(); }
    }

    public async Task RunAsync(CancellationToken stop)
    {
        await foreach (var job in _queue.Reader.ReadAllAsync(stop))
        {
            try { await ExecuteAsync(job, stop); }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { return; }
            catch (Exception ex) { log.LogError(ex, "Job {Id} runner failure", job.Id); }
            finally { lock (_gate) { _known.Remove(job.Id); _running.Remove(job.Id); _cancelled.Remove(job.Id); } }
        }
    }

    /// <summary>A finished job's result must not be lost to a network blip: retry transient failures, give up at once on a definitive 4xx.</summary>
    async Task ReportWithRetryAsync(string id, string status, object? result, string? error)
    {
        for (var attempt = 1; ; attempt++)
        {
            try { await client.ReportJobAsync(id, status, result, error, CancellationToken.None); return; }
            catch (HttpRequestException e) when (e.StatusCode is >= System.Net.HttpStatusCode.BadRequest and < System.Net.HttpStatusCode.InternalServerError)
            { log.LogError("Server rejected the result of job {Id} ({Code}); not retrying", id, (int)e.StatusCode!); return; }
            catch (Exception e) when (attempt < RetryDelays.Length + 1)
            { log.LogWarning("Reporting job {Id} failed ({Msg}); retry {N}", id, e.Message, attempt); await Task.Delay(RetryDelays[attempt - 1]); }
            catch (Exception e) { log.LogError("Giving up reporting job {Id}: {Msg}", id, e.Message); return; }
        }
    }
    public static TimeSpan[] RetryDelays { get; set; } = [TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(60)];

    async Task ExecuteAsync(VerifiedJob job, CancellationToken stop)
    {
        bool preCancelled; lock (_gate) preCancelled = _cancelled.Contains(job.Id);
        try { await client.StartJobAsync(job.Id, stop); }
        catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.Conflict || ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        { log.LogInformation("Job {Id} is no longer runnable on the server; skipping", job.Id); return; }
        if (preCancelled) { await client.ReportJobAsync(job.Id, "cancelled", null, null, stop); return; }
        verifier.MarkStarted(job.Id);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(stop);
        cts.CancelAfter(TimeSpan.FromSeconds(job.TimeoutSeconds));
        lock (_gate) _running[job.Id] = cts;
        log.LogInformation("Running job {Id} ({Type})", job.Id, job.Type);
        JobOutcome outcome;
        using var lease = BusyLease.BusyJobTypes.Contains(job.Type) ? new BusyLease.Hold(AgentConfig.DataDir, job.Type) : null;
        using var awake = BusyLease.BusyJobTypes.Contains(job.Type) ? new KeepAwake("Viro maintenance job: " + job.Type) : null;   // no sleeping mid-repair
        try { outcome = await _handlers[job.Type].RunAsync(new JobContext(job, client, updates, log), cts.Token); }
        catch (OperationCanceledException) when (!stop.IsCancellationRequested)
        {
            bool byAdmin; lock (_gate) byAdmin = _cancelled.Contains(job.Id);
            await ReportWithRetryAsync(job.Id, byAdmin ? "cancelled" : "failed", null, byAdmin ? null : $"timed out after {job.TimeoutSeconds}s");
            return;
        }
        catch (Exception ex) { outcome = new(false, null, $"{ex.GetType().Name}: {ex.Message}"); }
        await ReportWithRetryAsync(job.Id, outcome.Success ? "completed" : "failed", outcome.Result, outcome.Error);
        log.LogInformation("Job {Id} {Status}", job.Id, outcome.Success ? "completed" : "failed");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Handlers. Each is a specific, parameter-validated capability; there is no generic command execution.
// ---------------------------------------------------------------------------------------------------------------------

public sealed class HealthCheckHandler : IJobHandler
{
    public string Type => "health.check";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var snap = await HealthCollector.CollectAsync(ctx.Updates);
        await ctx.Client.SendHealthAsync(snap, ct);
        return new(true, new { uploaded = true, collectionErrors = snap["collectionErrors"] });
    }
}

public sealed class InventoryRefreshHandler : IJobHandler
{
    public string Type => "inventory.refresh";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var sw = Collectors.Software();
        await ctx.Client.SendInventoryAsync(new { collectedAt = DateTime.UtcNow.ToString("O"), hardware = Collectors.Hardware(), software = sw }, ct);
        return new(true, new { uploaded = true, softwareCount = sw.Count });
    }
}

public sealed class HardwareDiagnoseHandler : IJobHandler
{
    public string Type => "hardware.diagnose";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
        => new(true, await Task.Run(() => HardwareDiagnostics.Run(ct), ct));
}

public sealed class AnatomyCollectHandler : IJobHandler
{
    public string Type => "anatomy.collect";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var a = await Task.Run(() => Anatomy.Collect(null, ct), ct);
        await ctx.Client.SendAnatomyAsync(a, ct);
        return new(true, new { uploaded = true, unavailable = a.TryGetValue("unavailable", out var u) ? u : null });
    }
}

public sealed class ServiceRestartHandler : IJobHandler
{
    public string Type => "service.restart";
    // Never restartable through a remote job: the agent itself and services whose restart can take the machine down.
    static readonly HashSet<string> Protected = new(StringComparer.OrdinalIgnoreCase)
    { "ViroAgent", "RpcSs", "RpcEptMapper", "DcomLaunch", "LSM", "SamSs", "EventLog", "CryptSvc", "Winmgmt", "BFE", "mpssvc", "TrustedInstaller", "gpsvc", "ProfSvc", "Schedule", "PlugPlay", "Power", "LanmanWorkstation" };

    public Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct) => Task.Run(() =>
    {
        var name = ctx.Job.Params.GetProperty("name").GetString()!;
        if (Protected.Contains(name)) return new JobOutcome(false, null, $"\"{name}\" is a protected service and cannot be restarted remotely");
        ServiceController sc;
        try { sc = new ServiceController(name); _ = sc.Status; }
        catch (InvalidOperationException) { return new JobOutcome(false, null, $"service \"{name}\" was not found"); }
        using (sc)
        {
            var before = sc.Status.ToString();
            try
            {
                if (sc.Status == ServiceControllerStatus.Running)
                {
                    if (!sc.CanStop) return new JobOutcome(false, new { name, previousStatus = before }, "service does not accept stop requests");
                    sc.Stop(); sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(60));
                }
                ct.ThrowIfCancellationRequested();
                sc.Refresh();
                if (sc.Status != ServiceControllerStatus.Running) { sc.Start(); sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(60)); }
            }
            catch (Exception e) when (e is InvalidOperationException or System.ServiceProcess.TimeoutException or System.ComponentModel.Win32Exception)
            {
                sc.Refresh();
                return new JobOutcome(false, new { name, previousStatus = before, newStatus = sc.Status.ToString() }, (e.InnerException ?? e).Message);
            }
            sc.Refresh();
            var verified = sc.Status == ServiceControllerStatus.Running;
            return new JobOutcome(verified, new { name, displayName = sc.DisplayName, previousStatus = before, newStatus = sc.Status.ToString(), verified }, verified ? null : "service did not reach Running");
        }
    }, ct);
}

public static class JobHandlers
{
    public static IEnumerable<IJobHandler> All() => [new HealthCheckHandler(), new InventoryRefreshHandler(), new HardwareDiagnoseHandler(), new AnatomyCollectHandler(), new ServiceRestartHandler(),
        new Repair.RepairRunHandler(), new Repair.RepairFixSafeHandler(), new Repair.RepairRollbackHandler(), new Repair.CleanupPreviewHandler(), new Repair.CleanupRunHandler(),
        new SecurityStatusHandler(), new SecurityInvestigateHandler(), new Care.MemoryAnalyzeHandler(), new Care.BatteryDiagnoseHandler(), new Care.UiNotifyHandler(), DefenderActionHandler.Remediate(), DefenderActionHandler.Scan(), DefenderActionHandler.UpdateSignatures(),
        new UpdatesScanHandler(), new UpdatesInstallHandler(), new DriverInstallHandler(), new DriverRollbackHandler(),
        new SoftwareActionHandler("software.install"), new SoftwareActionHandler("software.update"), new SoftwareActionHandler("software.uninstall"), new SoftwareCheckUpdatesHandler(),
        new MessageSendHandler(), new RebootHandler(), new ShutdownHandler(), new WakeOnLanHandler(), new RebootCancelHandler(), new BenchmarkHandler(), new Care.UpgradeBenchmarkHandler(), new Care.StartupInspectHandler(), new Care.StartupQuarantineHandler(), new Care.StartupRestoreHandler(), new Care.PersistenceHuntHandler()];
}
