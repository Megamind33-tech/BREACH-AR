using System.Text.Json;

namespace Viro.Agent;

public sealed class AgentWorker(ILogger<AgentWorker> log) : BackgroundService
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    static readonly TimeSpan InventoryEvery = TimeSpan.FromHours(6);
    static readonly TimeSpan HealthEvery = TimeSpan.FromMinutes(30);

    object? SafeIntegrity(bool installed) { try { return Integrity.Collect(Installer.ServiceName, installed); } catch (Exception e) { log.LogWarning("Integrity collection failed: {Msg}", e.Message); return null; } }

    async Task TryUpdateAsync(SelfUpdater updater, ControlClient client, UpdateOffer offer, CancellationToken ct)
    {
        try
        {
            log.LogInformation("Agent update {Version} offered; verifying", offer.Version);
            var staged = await updater.PrepareAsync(offer, s => client.DownloadAsync(offer.Url, s, ct), ct);
            log.LogInformation("Update {Version} verified (signature, hashes, smoke test); applying", offer.Version);
            await updater.ApplyAsync(staged, offer.Version, Installer.ServiceName, ct);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            log.LogError("Update to {Version} rejected: {Msg}", offer.Version, e.Message);
            updater.State.LastResult = new(offer.Version, "failed", e.Message.Length > 300 ? e.Message[..300] : e.Message);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var cfg = AgentConfig.Load();
        if (!cfg.IsEnrolled) { log.LogCritical("Agent is not enrolled. Run: viro-agent enroll --server <url> --token <token>"); return; }
        var client = new ControlClient(cfg.ServerUrl);
        client.UseDevice(cfg.DeviceId, cfg.DeviceSecret);
        var queue = new OfflineQueue(Path.Combine(AgentConfig.DataDir, "queue.jsonl"));
        var interval = TimeSpan.FromSeconds(Math.Clamp(cfg.HeartbeatIntervalSeconds, 5, 600));
        var lastInventory = DateTime.MinValue;
        var lastHealth = DateTime.MinValue;
        var updates = new UpdateStateCache();
        updates.RefreshIfStale();
        var runner = cfg.JobSigningPublicKey == ""
            ? null
            : new JobRunner(client, new JobVerifier(cfg.JobSigningPublicKey, cfg.DeviceId, cfg.OrganizationId, JobHandlers.All().Select(h => h.Type), new ReplayStore(Path.Combine(AgentConfig.DataDir, "jobs-seen.txt"))), JobHandlers.All(), updates, log);
        if (runner is null) log.LogWarning("No pinned job-signing key (enrolled by an older agent): remote jobs are disabled. Re-enroll to enable them.");
        else _ = Task.Run(() => runner.RunAsync(ct), ct);
        var installed = Microsoft.Extensions.Hosting.WindowsServices.WindowsServiceHelpers.IsWindowsService();
        var provisioner = installed ? new ComputeProvisioner(new Viro.Agent.Repair.SystemProcessRunner(), Path.GetDirectoryName(Environment.ProcessPath)!) : null;
        var updater = cfg.JobSigningPublicKey == "" ? null : new SelfUpdater(AgentConfig.DataDir, Path.GetDirectoryName(Environment.ProcessPath)!, Collectors.AgentVersion, cfg.JobSigningPublicKey);
        updater?.RecoverOnStartup();
        var support = new SupportManager(client, new SupportSessionRunner(new SessionNotifier(), new FilePolicy(AgentConfig.DataDir, Environment.GetFolderPath(Environment.SpecialFolder.Windows)), () => new PowerShellTerminal(), log, DesktopBridge.TryCreate(log)), log);
        Collectors.CpuPercent(); // prime the CPU delta
        log.LogInformation("Viro Agent {Version} started for device {Device}", Collectors.AgentVersion, cfg.DeviceId);

        using var timer = new PeriodicTimer(interval);
        do
        {
            try
            {
                var os = Collectors.Os();
                var beat = JsonSerializer.SerializeToElement(new
                {
                    hostname = Environment.MachineName, agentVersion = Collectors.AgentVersion,
                    loggedInUser = Collectors.LoggedInUser(), ipAddress = Collectors.LocalIPv4(),
                    osCaption = os.Caption, osBuild = os.Build, uptimeSeconds = os.UptimeSeconds,
                    metrics = Collectors.Metrics(), observedAt = DateTime.UtcNow.ToString("O"),
                    integrity = SafeIntegrity(installed), updateResult = updater?.TakeResult(), network = NetworkFacts.Current(),
                }, Json);
                var beatSent = false;
                try
                {
                    await queue.DrainAsync(async item => { try { await client.SendHeartbeatAsync(item, ct); } catch (HttpRequestException e) when (Transient.IsPermanentRejection(e)) { log.LogWarning("Dropping a queued heartbeat the server rejected ({Code})", (int)e.StatusCode!); } });
                    var reply = await client.SendHeartbeatAsync(beat, ct);
                    if (reply.Sessions is { Count: > 0 }) support.Offer(reply.Sessions, ct);
                    var wanted = TimeSpan.FromSeconds(reply.PollSeconds is >= 2 and <= 120 ? reply.PollSeconds : cfg.HeartbeatIntervalSeconds);
                    if (timer.Period != wanted) timer.Period = wanted;   // poll faster while a support session is waiting for us
                    if (updater is not null)
                    {
                        updater.AckResult();
                        updater.ConfirmIfPending();
                        if (installed && reply.Update is { } offer && updater.WantsToUpdate(offer)) _ = Task.Run(() => TryUpdateAsync(updater, client, offer, ct), ct);
                    }
                    if (installed && provisioner is not null) { var note = await provisioner.EnsureAsync(reply.Compute?.Install == true, ct); if (note is not null) log.LogInformation("{Note}", note); }
                    if (runner is not null) { runner.Cancel(reply.Cancel); await runner.OfferAsync(reply.Jobs, ct); }
                    beatSent = true;
                    if (DateTime.UtcNow - lastInventory > InventoryEvery)
                    {
                        await client.SendInventoryAsync(new { collectedAt = DateTime.UtcNow.ToString("O"), hardware = Collectors.Hardware(), software = Collectors.Software() }, ct);
                        lastInventory = DateTime.UtcNow;
                        log.LogInformation("Inventory uploaded");
                    }
                    if (DateTime.UtcNow - lastHealth > HealthEvery)
                    {
                        updates.RefreshIfStale();
                        var snap = await HealthCollector.CollectAsync(updates);
                        await client.SendHealthAsync(snap, ct);
                        lastHealth = DateTime.UtcNow;
                        log.LogInformation("Health snapshot uploaded");
                    }
                }
                catch (AuthRejectedException e) { log.LogError("{Msg}; device may be revoked. Will keep retrying.", e.Message); }
                catch (HttpRequestException e) when (Transient.IsPermanentRejection(e)) { log.LogError("Control rejected the request ({Code}); not queuing it: {Msg}", (int)e.StatusCode!, e.Message); }
                catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException && !ct.IsCancellationRequested)
                {
                    // Only a heartbeat that never reached the server is queued; a failed inventory upload is simply retried next cycle.
                    if (!beatSent) queue.Enqueue(beat);
                    log.LogWarning("Control call failed ({Msg}); {Count} heartbeats pending", e.Message, queue.Count);
                }
            }
            catch (Exception e) when (!ct.IsCancellationRequested) { log.LogError(e, "Collection cycle failed"); }
        } while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false));
    }
}
