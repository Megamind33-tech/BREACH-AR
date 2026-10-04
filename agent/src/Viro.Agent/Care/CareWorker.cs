using System.Text.Json;
using Viro.Compute;

namespace Viro.Agent.Care;

/// <summary>
/// The always-on part of Viro's care: watches heat, keeps idle programs from holding memory, samples the battery, tells the person when something needs
/// their attention, and reports what it did to Control (which is where the "What Viro did" timeline and the measured results come from).
/// Everything it does by itself is conservative and logged: trimming idle working sets, pausing optional Viro activity, and showing notices.
/// </summary>
public sealed class CareWorker(ILogger<CareWorker> log) : BackgroundService
{
    readonly List<object> outbox = [];
    PrinterWatcher? printers; DateTime lastPrinterCheck = DateTime.MinValue; DateTime lastAnatomy = DateTime.MinValue; readonly DateTime startedAt = DateTime.UtcNow;
    DateTime snoozeHeat = DateTime.MinValue, lastMemoryAsk = DateTime.MinValue, lastBatteryAsk = DateTime.MinValue, lastHogAsk = DateTime.MinValue, lastPolicy = DateTime.MinValue;

    void Emit(string kind, object data) { lock (outbox) { outbox.Add(new { at = DateTime.UtcNow.ToString("O"), kind, data }); if (outbox.Count > 300) outbox.RemoveRange(0, outbox.Count - 300); } }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        // The service starts before enrollment has finished on a fresh install; wait for it instead of giving up for good.
        var cfg = AgentConfig.Load();
        while (!cfg.IsEnrolled) { try { await Task.Delay(TimeSpan.FromSeconds(15), ct); } catch (OperationCanceledException) { return; } cfg = AgentConfig.Load(); }
        var client = new ControlClient(cfg.ServerUrl); client.UseDevice(cfg.DeviceId, cfg.DeviceSecret);
        CareRuntime.Log = log; using var ui = new UserUiBridge(log); CareRuntime.Ui = ui; CareRuntime.Source = new SystemProcessSource(ui); CareRuntime.Guard = new MemoryGuard(CareRuntime.Source, CareRuntime.Actions);
        var closer = new SafeIdleAppCloser(CareRuntime.Source, CareRuntime.Actions);
        var tick = 0; var lastBattery = DateTime.MinValue; var lastFlush = DateTime.UtcNow;
        log.LogInformation("Viro care started (memory, heat, battery)");
        _ = Task.Run(async () => { try { var w = await ui.WindowsAsync(ct); log.LogInformation("User-session helper warm-up: {Result}", w is null ? "not available (nobody signed in, or it could not start)" : $"{w.Count} open windows seen"); } catch (Exception e) when (!ct.IsCancellationRequested) { log.LogInformation("User-session helper warm-up failed: {Msg}", e.Message); } }, ct);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        do
        {
            try
            {
                if (DateTime.UtcNow - lastPolicy > TimeSpan.FromMinutes(10)) { lastPolicy = DateTime.UtcNow; await FetchPolicyAsync(client, ct); }
                await ThermalStepAsync(ui, closer, ct);
                if (tick % 2 == 0) await MemoryStepAsync(ui, closer, ct);
                if (DateTime.UtcNow - lastBattery > TimeSpan.FromMinutes(5)) { lastBattery = DateTime.UtcNow; await BatteryStepAsync(ui, closer, ct); }
                if (DateTime.UtcNow - lastPrinterCheck > TimeSpan.FromMinutes(3)) { lastPrinterCheck = DateTime.UtcNow; await PrinterStepAsync(ct); }
                if (DateTime.UtcNow - startedAt > TimeSpan.FromMinutes(10) && DateTime.UtcNow - lastAnatomy > TimeSpan.FromHours(24)) { lastAnatomy = DateTime.UtcNow; _ = Task.Run(() => AnatomyStepAsync(client, ct), ct); }
                if (DateTime.UtcNow - lastFlush > TimeSpan.FromMinutes(1)) { lastFlush = DateTime.UtcNow; await FlushAsync(client, ct); }
            }
            catch (Exception e) when (!ct.IsCancellationRequested) { log.LogWarning("Care cycle failed: {Msg}", e.Message); }
            tick++;
        } while (await timer.WaitForNextTickAsync(ct));
    }

    /// <summary>Printing is looked after all the time, not when someone remembers to ask: a problem that stays is repaired by itself, one rung higher each time it persists (queue and spooler, then the driver, then the maker's driver from Windows Update), within what the organization allows.</summary>
    async Task PrinterStepAsync(CancellationToken ct)
    {
        var pol = CareRuntime.Policy;
        printers ??= new PrinterWatcher(new WindowsPrinterSystem(new Viro.Agent.Repair.SystemProcessRunner(), new Viro.Agent.Repair.WindowsServices(), new Viro.Agent.Repair.RepairEnv()), async (level, printer, token) =>
        {
            var opts = JsonSerializer.SerializeToElement(printer is null ? (object)new { level } : new { level, printer });
            return await Viro.Agent.Repair.RepairEngine.RunAsync(new PrinterRepairRecipe(), new Viro.Agent.Repair.RepairContext(new Viro.Agent.Repair.RepairEnv(), new Viro.Agent.Repair.SystemProcessRunner(), new Viro.Agent.Repair.WindowsServices(), log, opts), token);
        });
        foreach (var o in await printers.StepAsync(pol.PrinterAuto, pol.PrinterDrivers, ct)) { Emit(o.Kind, o.Data); log.LogInformation("Printing: {Kind} {Data}", o.Kind, JsonSerializer.Serialize(o.Data)); }
    }

    /// <summary>The full anatomy is read once a day, a few minutes after start so it never competes with boot, and sent to Control; it only reads the machine.</summary>
    async Task AnatomyStepAsync(ControlClient client, CancellationToken ct)
    {
        try { var a = Anatomy.Collect(null, ct); await client.SendAnatomyAsync(a, ct); log.LogInformation("Anatomy reported"); }
        catch (Exception e) when (!ct.IsCancellationRequested) { lastAnatomy = DateTime.UtcNow - TimeSpan.FromHours(23); log.LogInformation("Anatomy could not be reported ({Msg}); will retry in an hour", e.Message); }
    }

    async Task FetchPolicyAsync(ControlClient client, CancellationToken ct)
    {
        try { using var d = await client.CallAsync(HttpMethod.Get, "agent/v1/care/policy", null, ct); if (d is not null) CareRuntime.Policy = CarePolicy.Parse(d.RootElement); }
        catch (Exception e) when (!ct.IsCancellationRequested) { log.LogInformation("Could not refresh the care policy ({Msg}); using the last one", e.Message); }
    }

    async Task FlushAsync(ControlClient client, CancellationToken ct)
    {
        object[] batch; lock (outbox) { batch = [.. outbox]; }
        if (batch.Length == 0) return;
        try { await client.CallAsync(HttpMethod.Post, "agent/v1/care/events", new { events = batch }, ct); lock (outbox) outbox.RemoveRange(0, Math.Min(batch.Length, outbox.Count)); }
        catch (Exception e) when (!ct.IsCancellationRequested) { log.LogInformation("Care events will be sent later ({Msg})", e.Message); }
    }

    // ---- heat -------------------------------------------------------------------------------------------------------
    async Task ThermalStepAsync(IUserUi ui, SafeIdleAppCloser closer, CancellationToken ct)
    {
        var temp = ThermalSensors.CpuTempC(); if (temp is null) return;     // no sensor: "THERMAL DATA UNAVAILABLE" is reported through the state, nothing is invented
        var load = Collectors.CpuPercent() ?? 0;
        var ev = CareRuntime.Thermal.Observe(new(DateTime.UtcNow, temp, load, ThermalSensors.CriticalTripC(), ComputeRunning()), CareRuntime.Policy.ThermalWarningC);
        if (ev is null) return;
        var procs = await CareRuntime.Source!.SnapshotAsync(ct);
        var top = procs.Where(p => !p.Name.StartsWith("Viro", StringComparison.OrdinalIgnoreCase) && p.Name != "Idle").OrderByDescending(p => p.CpuPercent).Take(5).Select(p => ProcessClassifier.Assess(p)).ToList();
        Emit("thermal." + ev.Kind, new { level = ev.Level.ToString().ToLowerInvariant(), previous = ev.Previous.ToString().ToLowerInvariant(), tempC = ev.TempC, cpuLoad = ev.CpuLoad, gate = ev.Gate, computeRunning = ev.ComputeRunning, detail = ev.Detail,
            topProcesses = top.Select(t => new { name = t.ApplicationName, cpu = t.CpuUsage, memoryMb = t.MemoryUsageMb, category = t.Category }).ToList(), action = ev.Kind == "heat" ? "optional Viro work paused; compute stopped by its own thermal limit" : null });
        log.LogInformation("Thermal {Kind}: {Detail}", ev.Kind, ev.Detail);
        if (ev.Kind == "heat" && CareRuntime.Policy.Popups && DateTime.UtcNow > snoozeHeat)
        {
            var safe = top.Where(t => t.CloseRisk == CloseRisk.SAFE).ToList();
            var lines = top.Take(3).Select(t => $"{t.ApplicationName} — {(t.CpuUsage >= 25 ? "high" : t.CpuUsage >= 8 ? "medium" : "low")} CPU ({t.CpuUsage:0}%)").ToList();
            var choice = await ui.NotifyAsync(new("heat", "Your PC is getting too hot", $"CPU temperature has reached {ev.TempC:0}°C. Viro has already reduced background compute and optional work.",
                lines.Count > 0 ? lines : ["Nothing Viro can name is using much CPU."], [new("close", "CLOSE SAFE IDLE APPS"), new("view", "VIEW DETAILS"), new("later", "REMIND ME")], 90, ev.Level == ThermalLevel.Critical ? "critical" : "warning"), ct);
            Emit("ui.heat-notice", new { shown = choice is not null || CareRuntime.Policy.Popups, choice });
            if (choice == "close") await CloseSafeAsync(closer, safe.Select(s => s.ProcessId), "heat", ct);
            else if (choice == "view") await ui.NotifyAsync(new("heat2", "What is using your CPU", "Close applications you are no longer using. Viro will not close programs that may hold unsaved work.", top.Select(t => $"{t.ApplicationName}: {t.Recommendation}").Take(5).ToList(), [new("ok", "OK")], 60, "info"), ct);
            else snoozeHeat = DateTime.UtcNow.AddMinutes(30);
        }
        if (ev.Kind == "cooling-suspect") Emit("thermal.cooling-suspect", new { tempC = ev.TempC, cpuLoad = ev.CpuLoad, detail = ev.Detail });
    }

    static bool ComputeRunning() => System.Diagnostics.Process.GetProcessesByName("viro-compute").Length > 0;

    async Task CloseSafeAsync(SafeIdleAppCloser closer, IEnumerable<int> pids, string why, CancellationToken ct)
    {
        var res = await closer.CloseAsync(pids, ct);
        Emit("apps.closed", new { why, results = res.Select(r => new { r.Name, r.Closed, r.Reason }).ToList() });
    }

    // ---- memory -----------------------------------------------------------------------------------------------------
    async Task MemoryStepAsync(IUserUi ui, SafeIdleAppCloser closer, CancellationToken ct)
    {
        var pol = CareRuntime.Policy; if (!pol.AutoTrimIdle) return;
        var (used, _) = CareRuntime.Source!.Memory(); if (used <= pol.RamTargetPercent) { CareRuntime.RecordMemory(used, pol.RamTargetPercent, null); return; }
        var run = await CareRuntime.GuardOrDefault.RunAsync(pol.RamTargetPercent, ct); CareRuntime.LastMemory = MemoryTrimRecipe.Summary(run);
        CareRuntime.RecordMemory(run.AfterPercent, pol.RamTargetPercent, await CareRuntime.GuardOrDefault.PlanAsync(pol.RamTargetPercent, ct));
        if (run.Trimmed.Count > 0) Emit("memory.trim", MemoryTrimRecipe.Summary(run));
        if (pol.AutoCloseSafe && run.Plan.CloseSuggestions.Count > 0 && !run.TargetReached) await CloseSafeAsync(closer, run.Plan.CloseSuggestions.Select(c => c.ProcessId), "memory", ct);
        // The usual cause of Windows running out of memory is one idle program holding gigabytes of commit. Say so, with its numbers, at most every two hours.
        if (pol.Popups && ResourceHealth.Commit() is { percent: >= 85 } cm && DateTime.UtcNow - lastHogAsk > TimeSpan.FromHours(2) && run.Plan.SessionObservable)
        {
            var hog = MemoryPlanner.FindHog(await CareRuntime.Source!.SnapshotAsync(ct), (long)(cm.ramMb * 1048576));
            if (hog is not null)
            {
                lastHogAsk = DateTime.UtcNow;
                var choice = await ui.NotifyAsync(new("hog", "Windows is running low on memory", $"{hog.Name} is holding {hog.PrivateMb / 1024:0.0} GB of memory and is not in use. Memory use is at {cm.percent:0}% of what Windows can promise.",
                    [$"Restart {hog.Name} to give the memory back; if it keeps growing, update or reinstall it.", "Viro will not close it for you: it may hold unsaved work."], [new("ok", "OK"), new("later", "REMIND ME")], 90, "warning"), ct);
                Emit("ui.memory-notice", new { choice, hog = hog.Name, privateMb = hog.PrivateMb, commitPercent = cm.percent });
            }
        }
        // Still above the target after trimming: tell the person what is holding the rest, at most once an hour, and only about programs that are idle.
        if (!run.TargetReached && pol.Popups && pol.SuggestClose && run.Plan.AskUser.Count + run.Plan.CloseSuggestions.Count > 0 && DateTime.UtcNow - lastMemoryAsk > TimeSpan.FromHours(1) && run.Plan.SessionObservable)
        {
            lastMemoryAsk = DateTime.UtcNow;
            var lines = run.Plan.CloseSuggestions.Concat(run.Plan.AskUser).Take(5).Select(a => $"{a.ApplicationName} — {a.MemoryUsageMb / 1024:0.0} GB, not in use").ToList();
            var buttons = run.Plan.CloseSuggestions.Count > 0 ? new List<NoticeButton> { new("close", "CLOSE SAFE IDLE APPS"), new("later", "REMIND ME") } : [new("ok", "OK"), new("later", "REMIND ME")];
            var choice = await ui.NotifyAsync(new("mem", "Idle programs are using your memory", $"Memory use is {run.AfterPercent:0}%. Viro has freed what it safely could. These programs are not in use right now:", lines, buttons, 90, "info"), ct);
            Emit("ui.memory-notice", new { choice });
            if (choice == "close") await CloseSafeAsync(closer, run.Plan.CloseSuggestions.Select(c => c.ProcessId), "memory-notice", ct);
        }
    }

    // ---- battery ----------------------------------------------------------------------------------------------------
    int fastDrainStreak;
    async Task BatteryStepAsync(IUserUi ui, SafeIdleAppCloser closer, CancellationToken ct)
    {
        var b = BatteryProbe.Read(); if (b is null) return;
        Emit("battery.sample", b);
        // Measured, not guessed: the projected runtime from the power being drawn right now, on battery, for three samples in a row (about 15 minutes).
        var projected = b is { OnBattery: true, DischargeWatts: > 0, FullChargeWh: > 0 } ? b.FullChargeWh / b.DischargeWatts * 60 : null;
        fastDrainStreak = projected is < 120 ? fastDrainStreak + 1 : 0;
        if (fastDrainStreak < 3 || !CareRuntime.Policy.Popups || DateTime.UtcNow - lastBatteryAsk < TimeSpan.FromHours(24)) return;
        lastBatteryAsk = DateTime.UtcNow;
        var procs = await CareRuntime.Source!.SnapshotAsync(ct);
        var top = procs.Where(p => !p.Name.StartsWith("Viro", StringComparison.OrdinalIgnoreCase) && p.Name != "Idle" && p.CpuPercent >= 5).OrderByDescending(p => p.CpuPercent).Take(3).Select(p => ProcessClassifier.Assess(p)).ToList();
        var lines = top.Select(t => $"{t.ApplicationName} — {t.CpuUsage:0}% CPU").ToList(); lines.Add("Viro compute is paused while on battery.");
        var health = b.HealthPercent is { } hp ? $"Current battery health: {hp:0}%. " : "";
        var choice = await ui.NotifyAsync(new("battery", "Your battery is draining unusually fast", $"{health}At the current power draw ({b.DischargeWatts:0.#} W) this battery would last about {projected / 60:0.#} hours.", lines, [new("reduce", "REDUCE BACKGROUND ACTIVITY"), new("view", "VIEW DETAILS"), new("ignore", "IGNORE FOR NOW")], 90, "warning"), ct);
        Emit("ui.battery-notice", new { choice, projectedMinutes = Math.Round(projected ?? 0), dischargeWatts = b.DischargeWatts, healthPercent = b.HealthPercent });
        if (choice == "reduce")
        {
            var run = await CareRuntime.GuardOrDefault.RunAsync(CareRuntime.Policy.RamTargetPercent, ct, force: true); Emit("memory.trim", MemoryTrimRecipe.Summary(run));
            await CloseSafeAsync(closer, run.Plan.CloseSuggestions.Select(c => c.ProcessId), "battery", ct);
        }
        else if (choice == "view") await ui.NotifyAsync(new("battery2", "What is using power", "Close what you are not using. Viro will not close programs that may hold unsaved work.", top.Select(t => $"{t.ApplicationName}: {t.Recommendation}").ToList(), [new("ok", "OK")], 60, "info"), ct);
    }
}
