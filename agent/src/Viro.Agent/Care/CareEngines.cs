using System.Management;
using System.Text.Json;
using System.Text.RegularExpressions;
using Viro.Agent.Repair;
using Viro.Compute;

namespace Viro.Agent.Care;

/// <summary>What the organization allows Viro to do about memory, heat and popups on this PC. Derived on the server from the Autopilot level; clamped here.</summary>
public sealed record CarePolicy(int RamTargetPercent, bool AutoTrimIdle, bool SuggestClose, bool AutoCloseSafe, bool Popups, int ThermalWarningC, bool PrinterAuto = true, bool PrinterDrivers = false)
{
    public static readonly CarePolicy Default = new(50, true, true, false, true, 85);
    public static CarePolicy Parse(JsonElement r)
    {
        int I(string n, int d, int lo, int hi) => r.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Number ? Math.Clamp(v.GetInt32(), lo, hi) : d;
        bool B(string n, bool d) => r.TryGetProperty(n, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : d;
        return new(I("ramTargetPercent", 50, 30, 90), B("autoTrimIdle", true), B("suggestClose", true), B("autoCloseSafe", false), B("popups", true), I("thermalWarningC", 85, 60, 95), B("printerAuto", true), B("printerDrivers", false));
    }
}

/// <summary>Shared state for the care engines. Static so repair recipes and jobs (which are created without dependencies) use the same sources as the background loop; tests replace them.</summary>
public static class CareRuntime
{
    public static CarePolicy Policy { get; set; } = CarePolicy.Default;
    public static IUserUi? Ui { get; set; }
    /// <summary>The agent's file logger, so the user-session helper's failures are written down instead of vanishing.</summary>
    public static ILogger Log { get; set; } = Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance;
    public static IProcessSource? Source { get; set; }
    public static IProcessActions Actions { get; set; } = new SystemProcessActions();
    public static MemoryGuard? Guard { get; set; }
    public static ThermalMonitor Thermal { get; } = new();
    public static MemoryGuard GuardOrDefault => Guard ??= new MemoryGuard(Source ?? new SystemProcessSource(Ui ??= new UserUiBridge(Log)), Actions);
    public static object State() => new { thermal = Thermal.Snapshot(), ramTargetPercent = Policy.RamTargetPercent, popups = Policy.Popups, lastMemoryRun = LastMemory, memory = MemoryState };
    /// <summary>{ usedPercent, targetPercent, idleTrimmableMb, askUserMb } as of the last memory check.</summary>
    public static object? MemoryState { get; set; }
    public static void RecordMemory(double usedPercent, double target, MemoryPlan? plan) => MemoryState = new { usedPercent = Math.Round(usedPercent, 1), targetPercent = target, idleTrimmableMb = plan is null ? 0 : Math.Round(plan.Trim.Sum(t => t.Mb)), askUserMb = plan is null ? 0 : Math.Round(plan.AskUser.Sum(a => a.MemoryUsageMb)) };
    public static object? LastMemory { get; set; }
}

// ---------------------------------------------------------------------------------------------------------------------
/// <summary>memory.trim-idle: lets Windows take back the memory held by programs that are not in use. Nothing is closed; it is measured, not estimated.</summary>
public sealed class MemoryTrimRecipe : IRepairRecipe
{
    public string Id => "memory.trim-idle"; public string Title => "Free memory held by idle programs (nothing is closed)";
    public RepairRisk Risk => RepairRisk.Safe; public bool AutoSafe => true; public bool Reversible => false;
    MemoryRun? run;

    public async Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var plan = await CareRuntime.GuardOrDefault.PlanAsync(CareRuntime.Policy.RamTargetPercent, ct);
        var need = plan.UsedPercent > plan.TargetPercent && plan.Trim.Count > 0;
        var detail = plan.UsedPercent <= plan.TargetPercent ? $"memory use is {plan.UsedPercent:0}%, within the {plan.TargetPercent:0}% target"
            : plan.Trim.Count == 0 ? $"memory use is {plan.UsedPercent:0}% but {plan.Note ?? "no idle program is holding enough memory to trim"}"
            : $"memory use is {plan.UsedPercent:0}% (target {plan.TargetPercent:0}%); {plan.Trim.Count} idle program(s) hold {plan.Trim.Sum(t => t.Mb):0} MB";
        return new(need, detail, plan);
    }
    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct) { run = await CareRuntime.GuardOrDefault.RunAsync(CareRuntime.Policy.RamTargetPercent, ct); CareRuntime.LastMemory = Summary(run); c.After = Summary(run); }
    public Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var r = run!;
        if (r.ReclaimedMb <= 0 && r.Failures is { Count: > 0 } fl) return Task.FromResult((false, $"Windows refused the request for {fl.Count} program(s): {string.Join(", ", fl.GroupBy(x => x.Error).Select(g => $"error {g.Key} ({new System.ComponentModel.Win32Exception(g.Key).Message}) for {string.Join("/", g.Select(x => x.Name).Distinct().Take(3))}"))}"));
        return Task.FromResult(r.ReclaimedMb > 0 ? (true, $"memory use went from {r.BeforePercent:0.#}% to {r.AfterPercent:0.#}% ({r.ReclaimedMb:0} MB freed){(r.TargetReached ? "" : $"; still above the {r.Plan.TargetPercent:0}% target: the rest is held by programs in use")}")
            : (false, $"no measurable memory was freed (before {r.BeforePercent:0.#}%, after {r.AfterPercent:0.#}%)"));
    }
    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct) => throw new NotSupportedException();
    public static object Summary(MemoryRun r) => new { r.BeforePercent, r.AfterPercent, r.ReclaimedMb, r.TargetReached, trimmed = r.Trimmed.Select(t => new { t.Name, t.Mb }).ToList(), failed = (r.Failures ?? []).Select(x => new { x.Name, x.Error }).ToList(), askUser = r.Plan.AskUser.Select(a => new { a.ApplicationName, a.MemoryUsageMb, a.Category }).ToList(), closeSuggestions = r.Plan.CloseSuggestions.Select(a => new { a.ApplicationName, a.MemoryUsageMb }).ToList(), r.Plan.Note };
}

/// <summary>memory.analyze: read-only. Which programs hold memory, how each is classified, and what Viro would and would not do about it.</summary>
public sealed class MemoryAnalyzeHandler : IJobHandler
{
    public string Type => "memory.analyze";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var plan = await CareRuntime.GuardOrDefault.PlanAsync(CareRuntime.Policy.RamTargetPercent, ct);
        var all = (await (CareRuntime.Source ?? new SystemProcessSource(CareRuntime.Ui ??= new UserUiBridge(CareRuntime.Log))).SnapshotAsync(ct)).OrderByDescending(p => p.WorkingSetBytes).Take(15).Select(p => ProcessClassifier.Assess(p)).ToList();
        return new(true, new { plan, top = all, policy = CareRuntime.Policy });
    }
}

// ---------------------------------------------------------------------------------------------------------------------
public sealed record ThermalSample(DateTime At, double? TempC, double CpuLoadPercent, double? CriticalTripC, bool ComputeRunning);
public sealed record ThermalEvent(string Kind, ThermalLevel Level, ThermalLevel Previous, double? TempC, double CpuLoad, string Gate, bool ComputeRunning, string Detail);

/// <summary>
/// Tracks the PC's heat with the same graded levels the compute worker uses, and notices two things: the moment it becomes hot (so the person can be told),
/// and heat that persists although nothing optional is running (so a cooling fault can be suspected, and a software cause ruled out, with evidence).
/// </summary>
public sealed class ThermalMonitor
{
    public ThermalLevel Level { get; private set; } = ThermalLevel.Normal;
    public double? TempC { get; private set; }
    DateTime? hotSince, lowLoadHotSince; bool suspected;
    public const double LowLoadPercent = 30; public static readonly TimeSpan SuspectAfter = TimeSpan.FromMinutes(15);
    public int WarningEvents7d { get; set; }

    public ThermalEvent? Observe(ThermalSample s, int warningC)
    {
        var thr = Compute.Thermal.Derive(warningC, s.CriticalTripC);
        var prev = Level; var next = Compute.Thermal.Evaluate(s.TempC, thr, prev); Level = next; TempC = s.TempC ?? TempC;
        var hot = next >= ThermalLevel.Warning;
        hotSince = hot ? hotSince ?? s.At : null;
        // Software cause unlikely: hot for a long time although the CPU is not busy and Viro's own compute is off.
        if (hot && s.CpuLoadPercent < LowLoadPercent && !s.ComputeRunning) lowLoadHotSince ??= s.At; else { lowLoadHotSince = null; suspected = false; }
        if (!suspected && lowLoadHotSince is { } lh && s.At - lh >= SuspectAfter)
        { suspected = true; return new("cooling-suspect", next, prev, s.TempC, s.CpuLoadPercent, Compute.Thermal.Gate(next), s.ComputeRunning, $"The CPU has been at {s.TempC:0}°C for {(s.At - lh).TotalMinutes:0} minutes while it is mostly idle ({s.CpuLoadPercent:0}% load) and Viro compute is off. Software is unlikely to be the cause; a cooling problem (vents, fan, heatsink) is possible."); }
        if (prev < ThermalLevel.Warning && hot) { WarningEvents7d++; return new("heat", next, prev, s.TempC, s.CpuLoadPercent, Compute.Thermal.Gate(next), s.ComputeRunning, $"CPU temperature reached {s.TempC:0}°C (limit {thr.Warning:0}°C)."); }
        if (prev >= ThermalLevel.Warning && !hot) return new("recovered", next, prev, s.TempC, s.CpuLoadPercent, Compute.Thermal.Gate(next), s.ComputeRunning, $"CPU temperature is back to {s.TempC:0}°C.");
        return null;
    }

    public object Snapshot() => new { level = Level.ToString().ToLowerInvariant(), cpuTempC = TempC, sustainedHotMinutesLowLoad = lowLoadHotSince is { } l ? Math.Round((DateTime.UtcNow - l).TotalMinutes, 1) : 0, warningEvents = WarningEvents7d, coolingSuspected = suspected, available = TempC is not null };
    public bool CoolingSuspected => suspected;
}

// ---------------------------------------------------------------------------------------------------------------------
public sealed record BatteryReading(int? Percent, bool? OnBattery, double? DischargeWatts, double? RemainingWh, double? FullChargeWh, double? DesignWh, double? HealthPercent, int? CycleCount);

public static class BatteryProbe
{
    static T? Try<T>(Func<T> f) { try { return f(); } catch { return default; } }
    static List<ManagementBaseObject> Q(string ns, string wql) { using var s = new ManagementObjectSearcher(new ManagementScope($@"\\.\{ns}"), new ObjectQuery(wql)); return [.. s.Get().Cast<ManagementBaseObject>()]; }

    /// <summary>Live battery facts from Windows. Anything Windows does not report is null, never a guess; a desktop PC returns null overall.</summary>
    public static BatteryReading? Read()
    {
        var b = Try(() => Q("root\\CIMV2", "SELECT EstimatedChargeRemaining,BatteryStatus FROM Win32_Battery").FirstOrDefault());
        if (b is null) return null;
        var st = Try(() => Q("root\\WMI", "SELECT Discharging,Charging,PowerOnline,DischargeRate,RemainingCapacity FROM BatteryStatus").FirstOrDefault());
        var full = Try(() => Q("root\\WMI", "SELECT FullChargedCapacity FROM BatteryFullChargedCapacity").FirstOrDefault());
        var design = Try(() => Q("root\\WMI", "SELECT DesignedCapacity FROM BatteryStaticData").FirstOrDefault());
        var cycles = Try(() => Q("root\\WMI", "SELECT CycleCount FROM BatteryCycleCount").FirstOrDefault());
        double? Mwh(ManagementBaseObject? o, string p) => o?[p] is null ? null : Convert.ToDouble(o[p]) / 1000.0;
        var fullWh = Mwh(full, "FullChargedCapacity"); var designWh = Mwh(design, "DesignedCapacity");
        var rate = st?["DischargeRate"] is null ? (double?)null : Convert.ToDouble(st["DischargeRate"]) / 1000.0;
        var onBat = st?["Discharging"] as bool? ?? (st?["PowerOnline"] as bool? is { } po ? !po : (bool?)null);
        return new(b["EstimatedChargeRemaining"] is null ? null : Convert.ToInt32(b["EstimatedChargeRemaining"]), onBat, rate is > 0 ? Math.Round(rate.Value, 1) : null, Mwh(st, "RemainingCapacity") is { } r ? Math.Round(r, 1) : null,
            fullWh is > 0 ? Math.Round(fullWh.Value, 1) : null, designWh is > 0 ? Math.Round(designWh.Value, 1) : null,
            fullWh is > 0 && designWh is > 0 ? Math.Round(Math.Min(100, fullWh.Value / designWh.Value * 100), 1) : null, cycles?["CycleCount"] is null ? null : Convert.ToInt32(cycles["CycleCount"]));
    }

    /// <summary>"powercfg /requests": which programs are keeping the screen or the PC awake.</summary>
    public static List<object> ParseRequests(string output)
    {
        var o = new List<object>(); string? section = null;
        foreach (var raw in output.Split('\n'))
        {
            var line = raw.Trim(); if (line.Length == 0) continue;
            if (Regex.IsMatch(line, @"^(DISPLAY|SYSTEM|AWAYMODE|EXECUTION|PERFBOOST|ACTIVELOCKSCREEN):$", RegexOptions.IgnoreCase)) { section = line.TrimEnd(':'); continue; }
            if (section is null || line.Equals("None.", StringComparison.OrdinalIgnoreCase)) continue;
            var m = Regex.Match(line, @"^\[(PROCESS|DRIVER|SERVICE)\]\s*(.+)$", RegexOptions.IgnoreCase);
            if (m.Success) o.Add(new { kind = section, type = m.Groups[1].Value.ToUpperInvariant(), name = m.Groups[2].Value.Trim() });
        }
        return o;
    }
}

/// <summary>ui.notify { template, evidence }: shows one of a fixed set of notices to the signed-in user (text is fixed here; Control supplies only the evidence lines).</summary>
public sealed class UiNotifyHandler : IJobHandler
{
    public string Type => "ui.notify";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var p = ctx.Job.Params; var template = p.GetProperty("template").GetString();
        var evidence = p.TryGetProperty("evidence", out var e) && e.ValueKind == JsonValueKind.Array ? e.EnumerateArray().Select(x => (x.GetString() ?? "").Trim()).Where(x => x.Length > 0).Take(5).Select(x => x.Length > 160 ? x[..160] : x).ToList() : [];
        var ui = CareRuntime.Ui; if (ui is null) return new(true, new { shown = false, reason = "the user-session helper is not running" });
        if (template != "storage-failing") return new(false, null, "unknown notice template");
        var choice = await ui.NotifyAsync(new("storage", "Your storage drive may be deteriorating", "Viro has detected a problem with this computer's drive. Your data may be at risk. A backup check is recommended immediately.",
            evidence.Count > 0 ? evidence : ["The drive reported errors or a failing health status."], [new("backup", "CHECK BACKUP"), new("evidence", "VIEW EVIDENCE"), new("it", "CONTACT IT")], 120, "critical"), ct);
        if (choice == "backup") await ui.NotifyAsync(new("storage2", "Check your backup", "Open your backup tool, or ask IT to confirm a recent backup of this computer exists before anything else is done.", [], [new("ok", "OK")], 60, "info"), ct);
        else if (choice == "evidence") await ui.NotifyAsync(new("storage3", "What Viro found", "These are the readings that raised the alert:", evidence, [new("ok", "OK")], 90, "info"), ct);
        else if (choice == "it") await ui.NotifyAsync(new("storage4", "Contact IT", $"Tell your IT administrator that {Environment.MachineName} reported a failing drive. They can see the evidence in Viro.", [], [new("ok", "OK")], 60, "info"), ct);
        return new(true, new { shown = true, choice });
    }
}

/// <summary>battery.diagnose: read-only facts for working out why a battery drains quickly. The server ranks the causes; nothing here is changed.</summary>
public sealed class BatteryDiagnoseHandler(IProcessRunner? proc = null) : IJobHandler
{
    public string Type => "battery.diagnose";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var p = proc ?? new SystemProcessRunner(); var ps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "powercfg.exe");
        var reading = BatteryProbe.Read();
        if (reading is null) return new(true, new { hasBattery = false, note = "This computer has no battery." });
        var req = await p.RunAsync(ps, "/requests", TimeSpan.FromSeconds(30), ct);
        var plan = await p.RunAsync(ps, "/getactivescheme", TimeSpan.FromSeconds(30), ct);
        var wake = await p.RunAsync(ps, "/lastwake", TimeSpan.FromSeconds(30), ct);
        var procs = await (CareRuntime.Source ?? new SystemProcessSource(CareRuntime.Ui ??= new UserUiBridge(CareRuntime.Log))).SnapshotAsync(ct);
        var top = procs.Where(x => !x.Name.StartsWith("Viro", StringComparison.OrdinalIgnoreCase) && x.Name != "Idle").OrderByDescending(x => x.CpuPercent).Take(6).Select(x => new { name = x.Name, cpuPercent = x.CpuPercent, memoryMb = Math.Round(x.WorkingSetBytes / 1048576.0), assessment = ProcessClassifier.Assess(x).Category }).ToList();
        var chrome = procs.Where(x => Regex.IsMatch(x.Name, "^(chrome|msedge|firefox|brave)$", RegexOptions.IgnoreCase)).GroupBy(x => x.Name.ToLowerInvariant()).Select(g => new { browser = g.Key, processes = g.Count(), memoryMb = Math.Round(g.Sum(x => x.WorkingSetBytes) / 1048576.0) }).ToList();
        var bg = procs.Where(x => Regex.IsMatch(x.Name, "^(teams|ms-teams|zoom|slack|discord|skype|spotify|onedrive|dropbox)$", RegexOptions.IgnoreCase)).Select(x => x.Name).Distinct().ToList();
        return new(true, new
        {
            hasBattery = true, reading, wakeLocks = BatteryProbe.ParseRequests(req.Output), powerPlan = Regex.Match(plan.Output, @"\(([^)]+)\)").Groups[1].Value is { Length: > 0 } pl ? pl : null,
            lastWake = wake.Output.Trim().Length > 300 ? wake.Output.Trim()[..300] : wake.Output.Trim(), topCpu = top, browsers = chrome, backgroundApps = bg, computeNote = "Viro compute does not run on battery by default.", sampledAt = DateTime.UtcNow.ToString("O"),
        });
    }
}
