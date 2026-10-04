using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Viro.Agent;
using Viro.Agent.Care;
using Viro.Agent.Repair;
using Xunit;

/// <summary>A print system in memory: what Windows would report, and what each repair step changes.</summary>
sealed class FakePrinters : IPrinterSystem
{
    public string? Spooler = "Running"; public string Start = "Auto"; public bool Recovers = true; public int QueueFiles;
    public List<PrinterFact> Printers = [];
    public readonly List<string> Calls = [];
    public bool ReRegisterFixes, ClassDriverFixes, UpdateFixes; public bool NetworkOnly;
    public Func<PrinterFact, IReadOnlyList<PendingUpdate>> Updates = _ => [];

    public static PrinterFact P(string name = "Office HP", string driver = "HP Universal PCL6", bool installed = true, bool network = false, bool? reach = null, int status = 3, int err = 2, bool offline = false, int errJobs = 0, int stuck = 0, int? pnp = null)
        => new(name, driver, installed, "PORT", network, reach, status, err, offline, errJobs, stuck, pnp);
    public Task<PrinterSnapshot> SnapshotAsync(CancellationToken ct) => Task.FromResult(new PrinterSnapshot(Spooler, Start, Recovers, QueueFiles, [.. Printers]));
    public Task<(string start, bool recovers)> HardenSpoolerAsync(CancellationToken ct) { Calls.Add("harden"); var prior = (Start, Recovers); Start = "Auto"; Recovers = true; return Task.FromResult(prior); }
    public Task RestoreSpoolerAsync(string start, CancellationToken ct) { Calls.Add("restore " + start); Start = start; return Task.CompletedTask; }
    public Task ClearQueueAsync(CancellationToken ct) { Calls.Add("clear"); QueueFiles = 0; Spooler = "Running"; Printers = [.. Printers.Select(p => p with { ErrorJobs = 0, StuckJobs = 0 })]; return Task.CompletedTask; }
    public Task SetOnlineAsync(string printer, CancellationToken ct) { Calls.Add("online " + printer); Printers = [.. Printers.Select(p => p.Name == printer ? p with { WorkOffline = false, Status = 3 } : p)]; return Task.CompletedTask; }
    public Task<bool> ReRegisterDriverAsync(string driver, CancellationToken ct) { Calls.Add("reregister " + driver); if (ReRegisterFixes) Printers = [.. Printers.Select(p => p.Driver == driver ? p with { DriverInstalled = true, PnpError = null, Status = 3 } : p)]; return Task.FromResult(true); }
    public Task<bool> SetDriverAsync(string printer, string driver, CancellationToken ct)
    {
        Calls.Add($"setdriver {printer} -> {driver}");
        Printers = [.. Printers.Select(p => p.Name == printer ? p with { Driver = driver, DriverInstalled = driver == PrinterRepairRecipe.ClassDriver ? ClassDriverFixes || driver != PrinterRepairRecipe.ClassDriver : true, PnpError = ClassDriverFixes || driver != PrinterRepairRecipe.ClassDriver ? null : p.PnpError, Status = ClassDriverFixes || driver != PrinterRepairRecipe.ClassDriver ? 3 : p.Status } : p)];
        return Task.FromResult(true);
    }
    public Task<IReadOnlyList<PendingUpdate>> FindDriverUpdatesAsync(PrinterFact printer, CancellationToken ct) { Calls.Add("find " + printer.Name); return Task.FromResult(Updates(printer)); }
    public Task<bool> InstallDriverUpdatesAsync(IReadOnlyList<PendingUpdate> list, CancellationToken ct) { Calls.Add("install " + list[0].Title); if (UpdateFixes) Printers = [.. Printers.Select(p => p with { DriverInstalled = true, PnpError = null, Status = 3 })]; return Task.FromResult(true); }
}

public class PrinterTests
{
    static RepairContext Ctx(string opts = "{}") => new(new SlowEnv(), new FakeProc(), new FakeServices(), NullLogger.Instance, JsonDocument.Parse(opts).RootElement);
    static IReadOnlyDictionary<string, IRepairRecipe> With(IRepairRecipe r) => Recipes.All.ToDictionary(x => x.Key, x => x.Key == r.Id ? r : x.Value);
    static PendingUpdate Upd(string title) => new("id1", 1, title, null, true, null, 1000, false, ["Drivers"], new("HP", "Universal", "Printer", "1.2.3", "USB\\VID_03F0", null));

    [Fact]
    public void Diagnosis_separates_what_software_can_fix_from_paper_toner_cables_and_networks()
    {
        var s = new PrinterSnapshot("Running", "Auto", true, 0, [FakePrinters.P("A", err: 4), FakePrinters.P("B", network: true, reach: false), FakePrinters.P("C", driver: "Gone", installed: false), FakePrinters.P("D", offline: true), FakePrinters.P("E", pnp: 28)]);
        var d = PrinterDiagnosis.Diagnose(s);
        Assert.Equal(["printer.physical|False", "printer.unreachable|False", "printer.driver|True", "printer.offline|True", "printer.driver|True"], d.Select(i => i.Code + "|" + i.SoftwareFixable));
        Assert.Contains("out of paper", d[0].Detail); Assert.Equal(2, d.First(i => i.Code == "printer.driver").Level);
        Assert.Empty(PrinterDiagnosis.Diagnose(new PrinterSnapshot("Running", "Auto", true, 0, [FakePrinters.P()])));            // a healthy printer raises nothing
        Assert.Empty(PrinterDiagnosis.Diagnose(new PrinterSnapshot(null, null, false, 0, [])));                                  // a PC with no print system raises nothing
        Assert.Contains(PrinterDiagnosis.Diagnose(new PrinterSnapshot("Stopped", "Auto", true, 0, [])), i => i.Code == "spooler.down");
        Assert.Contains(PrinterDiagnosis.Diagnose(new PrinterSnapshot("Running", "Manual", false, 0, [])), i => i.Code == "spooler.config");   // the fix must last, not just work once
    }

    [Fact]
    public async Task A_stopped_spooler_and_stuck_jobs_are_cleared_and_the_spooler_is_made_to_restart_itself()
    {
        var sys = new FakePrinters { Spooler = "Stopped", Start = "Manual", Recovers = false, QueueFiles = 4, Printers = [FakePrinters.P(stuck: 2)] };
        var r = new PrinterRepairRecipe(sys); var rep = await RepairEngine.RunAsync(r, Ctx(), default);
        Assert.True(rep.Applied && rep.Verified == true, rep.Summary);
        Assert.Equal(["harden", "clear"], sys.Calls);
        Assert.Equal("Auto", sys.Start); Assert.True(sys.Recovers);
        Assert.Contains("No action needed", (await RepairEngine.RunAsync(r, Ctx(), default)).Summary);                         // healthy now: nothing left to do
        await RepairEngine.RollbackAsync(With(r), rep.RepairId, Ctx(), default); Assert.Equal("Manual", sys.Start);
    }

    [Fact]
    public async Task A_missing_driver_is_put_back_first_then_a_network_printer_falls_back_to_the_class_driver_and_the_old_driver_is_restorable()
    {
        var sys = new FakePrinters { Printers = [FakePrinters.P(driver: "Old Vendor Driver", installed: false, network: true, reach: true)], ReRegisterFixes = true };
        var rep = await RepairEngine.RunAsync(new PrinterRepairRecipe(sys), Ctx(), default);
        Assert.True(rep.Verified == true, rep.Summary); Assert.Equal(["reregister Old Vendor Driver"], sys.Calls);              // stops at the first rung that works

        var net = new FakePrinters { Printers = [FakePrinters.P(driver: "Old Vendor Driver", installed: false, network: true, reach: true)], ReRegisterFixes = false, ClassDriverFixes = true };
        var r = new PrinterRepairRecipe(net); var rep2 = await RepairEngine.RunAsync(r, Ctx(), default);
        Assert.True(rep2.Verified == true, rep2.Summary);
        Assert.Contains(net.Calls, c => c == $"setdriver Office HP -> {PrinterRepairRecipe.ClassDriver}"); Assert.DoesNotContain(net.Calls, c => c.StartsWith("find"));
        await RepairEngine.RollbackAsync(With(r), rep2.RepairId, Ctx(), default);
        Assert.Equal("Old Vendor Driver", net.Printers[0].Driver);                                                               // undone
    }

    [Fact]
    public async Task The_makers_newer_driver_comes_from_windows_update_only_when_the_lower_rungs_failed_and_the_level_allows_it()
    {
        PrinterFact Broken() => FakePrinters.P(driver: "HP Universal PCL6", installed: false, pnp: 28);          // a USB printer: no class-driver fallback
        var up = new FakePrinters { Printers = [Broken()], UpdateFixes = true, Updates = _ => [Upd("HP - Printer - 1.2.3 Universal Print Driver")] };
        var rep = await RepairEngine.RunAsync(new PrinterRepairRecipe(up), Ctx(), default);
        Assert.True(rep.Verified == true, rep.Summary); Assert.Contains(up.Calls, c => c.StartsWith("install HP - Printer"));
        var capped = new FakePrinters { Printers = [Broken()], UpdateFixes = true, Updates = _ => [Upd("HP - Printer - 1.2.3")] };
        var rep2 = await RepairEngine.RunAsync(new PrinterRepairRecipe(capped), Ctx("{\"level\":2}"), default);
        Assert.NotEqual(true, rep2.Verified); Assert.DoesNotContain(capped.Calls, c => c.StartsWith("find") || c.StartsWith("install"));      // policy said no driver downloads
        var none = new FakePrinters { Printers = [Broken()] };
        var rep3 = await RepairEngine.RunAsync(new PrinterRepairRecipe(none), Ctx(), default);
        Assert.NotEqual(true, rep3.Verified); Assert.Contains("still wrong", rep3.Summary);                                      // never claims success
    }

    [Fact]
    public async Task Paper_toner_and_network_problems_are_reported_and_nothing_is_touched()
    {
        var sys = new FakePrinters { Printers = [FakePrinters.P("A", err: 8), FakePrinters.P("B", network: true, reach: false)] };
        var rep = await RepairEngine.RunAsync(new PrinterRepairRecipe(sys), Ctx(), default);
        Assert.False(rep.Applied); Assert.Contains("Nothing Viro can repair from software", rep.Summary); Assert.Contains("jammed", rep.Summary); Assert.Empty(sys.Calls);
    }

    // ---- the background watcher ----
    static RepairReport Report(bool ok) => new("rid", "printer.repair", "t", true, true, ok, false, true, false, ok ? "fixed" : "not fixed", [], null, null);

    [Fact]
    public async Task The_watcher_waits_for_the_problem_to_stay_then_repairs_by_itself_one_rung_higher_each_time_with_a_pause_between_attempts()
    {
        var sys = new FakePrinters { Printers = [FakePrinters.P(driver: "X", installed: false)] }; var t = new DateTime(2026, 1, 1, 9, 0, 0, DateTimeKind.Utc); var levels = new List<int?>();
        var w = new PrinterWatcher(sys, (level, printer, _) => { levels.Add(level); return Task.FromResult(Report(false)); }, () => t);
        Assert.Empty(await w.StepAsync(true, true, default)); Assert.Empty(levels);                                               // seen once: it may just be busy
        t = t.AddMinutes(3); var o1 = await w.StepAsync(true, true, default); Assert.Equal([2], levels); Assert.Contains(o1, o => o.Kind == "printer.fix");
        t = t.AddMinutes(3); await w.StepAsync(true, true, default); Assert.Equal([2], levels);                                   // paused for 20 minutes after an attempt
        t = t.AddMinutes(20); var o2 = await w.StepAsync(true, true, default); Assert.Equal([2, 3], levels);                       // persisted: next rung
        Assert.Contains(o2, o => o.Kind == "printer.failing");                                                                   // that was the last rung: tell the administrator
        t = t.AddMinutes(21); var o3 = await w.StepAsync(true, true, default); Assert.Equal([2, 3, 3], levels);                  // it keeps trying every 20 minutes
        Assert.DoesNotContain(o3, o => o.Kind == "printer.failing");                                                              // but does not repeat the alarm
    }

    [Fact]
    public async Task The_watcher_respects_the_policy_and_stops_tracking_a_problem_once_it_is_gone()
    {
        var sys = new FakePrinters { Printers = [FakePrinters.P(driver: "X", installed: false)], Spooler = "Stopped" }; var t = DateTime.UtcNow; var calls = new List<int>();
        var w = new PrinterWatcher(sys, (l, _, _) => { calls.Add(l); return Task.FromResult(Report(true)); }, () => t);
        await w.StepAsync(false, false, default); t = t.AddMinutes(3); Assert.Empty(await w.StepAsync(false, false, default)); Assert.Empty(calls);      // repairs not allowed: it only watches
        t = t.AddMinutes(3); var drivers = await w.StepAsync(true, false, default);
        Assert.Equal([1], calls);                                                                                                 // spooler: allowed at level 1
        Assert.Contains(drivers, o => o.Kind == "printer.failing" && o.Data.ToString()!.Contains("not allowed by this organization"));   // the driver change is blocked by policy, and says so
        sys.Spooler = "Running"; sys.Printers = []; t = t.AddMinutes(3); Assert.Empty(await w.StepAsync(true, true, default));    // healed: nothing more happens
    }

    [Fact]
    public async Task The_watcher_reports_unfixable_problems_once_and_never_tries_to_repair_them()
    {
        var sys = new FakePrinters { Printers = [FakePrinters.P(err: 4)] }; var t = DateTime.UtcNow; var n = 0;
        var w = new PrinterWatcher(sys, (_, _, _) => { n++; return Task.FromResult(Report(true)); }, () => t);
        await w.StepAsync(true, true, default); t = t.AddMinutes(3); var o = await w.StepAsync(true, true, default);
        Assert.Contains(o, x => x.Kind == "printer.failing"); Assert.Equal(0, n);
        t = t.AddMinutes(3); Assert.Empty(await w.StepAsync(true, true, default));
    }

    [Fact]
    public void The_repair_is_registered_and_the_policy_carries_the_printer_switches()
    {
        Assert.True(Recipes.All.ContainsKey("printer.repair")); Assert.Equal(RepairRisk.Review, Recipes.All["printer.repair"].Risk);
        var p = CarePolicy.Parse(JsonDocument.Parse("{\"printerAuto\":true,\"printerDrivers\":true}").RootElement); Assert.True(p.PrinterAuto && p.PrinterDrivers);
        Assert.False(CarePolicy.Parse(JsonDocument.Parse("{\"printerDrivers\":false}").RootElement).PrinterDrivers);
    }
}
