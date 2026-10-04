using System.Text.Json;
using Viro.Agent;
using Viro.Agent.Repair;

string? Arg(string n) { var i = Array.IndexOf(args, n); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
bool Has(string n) => Array.IndexOf(args, n) >= 0;
var pretty = new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true };

if (args.Length > 0)
{
    string? NonEmpty(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;
    var opts = new InstallOptions(NonEmpty(Arg("--server")), NonEmpty(Arg("--token")), NonEmpty(Arg("--dir")), Has("--keep-data"), Has("--force"));
    var installer = new Installer(new SystemProcessRunner(), Installer.IsElevated, Console.WriteLine);
    var exe = Environment.ProcessPath!;
    switch (args[0])
    {
        case "install": return await installer.InstallAsync(opts, exe, CancellationToken.None);
        case "setup": return await installer.SetupAsync(opts, exe, CancellationToken.None);
        case "connect":
        {
            // Joins this PC to a workspace from a connection code. Writes a small result file for the window that asked, because this runs as administrator in its own process.
            var said = new List<string>(); var resultPath = Arg("--result");
            void Finish(int code, string msg) { if (resultPath is not null) { try { File.WriteAllText(resultPath, JsonSerializer.Serialize(new { exit = code, message = msg })); } catch { /* the window falls back to the exit code */ } } }
            try
            {
                var cc = Viro.Agent.Care.ConnectionCode.Parse(Arg("--code"));
                var inst = new Installer(new SystemProcessRunner(), Installer.IsElevated, s => { Console.WriteLine(s); said.Add(s); });
                var rc = await inst.SetupAsync(new InstallOptions(cc.Server, cc.Token, null, false, Has("--move")), exe, CancellationToken.None);
                Finish(rc, rc == 0 ? "This PC is now connected to its workspace." : (said.LastOrDefault() ?? "Connecting did not finish.")); return rc;
            }
            catch (ArgumentException e) { Console.WriteLine(e.Message); Finish(2, e.Message); return 2; }
        }
        case "teardown": return await installer.TeardownAsync(CancellationToken.None);
        case "uninstall": return await installer.UninstallAsync(opts, CancellationToken.None);
        case "status": Console.WriteLine(JsonSerializer.Serialize(await installer.StatusAsync(CancellationToken.None), pretty)); return 0;
        case "version": Console.WriteLine(Collectors.AgentVersion); return 0;
        case "enroll": return await Enroller.RunAsync(opts);
        case "inventory":
            Collectors.CpuPercent(); Thread.Sleep(500);
            Console.WriteLine(JsonSerializer.Serialize(new { os = Collectors.Os(), user = Collectors.LoggedInUser(), ip = Collectors.LocalIPv4(), hardware = Collectors.Hardware(), software = Collectors.Software(), metrics = Collectors.Metrics() }, pretty));
            return 0;
        case "security": Console.WriteLine(JsonSerializer.Serialize(SecurityCollector.Collect(), pretty)); return 0;
        case "care-plan":
        {
            // Shows what the memory guard sees on this PC and what it would do. With --trim it really trims idle programs (reversible: Windows brings pages back on demand) and prints the measured result.
            using var ui = new Viro.Agent.Care.UserUiBridge(Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance);
            var src = new Viro.Agent.Care.SystemProcessSource(ui); var guard = new Viro.Agent.Care.MemoryGuard(src, new Viro.Agent.Care.SystemProcessActions());
            var target = int.TryParse(Arg("--target"), out var tg) ? tg : 50;
            var plan = await guard.PlanAsync(target, CancellationToken.None);
            Console.WriteLine(JsonSerializer.Serialize(new { plan.UsedPercent, plan.TargetPercent, plan.NeedToFreeMb, sessionObservable = plan.SessionObservable, plan.Note, wouldTrim = plan.Trim.Take(12), closeSuggestions = plan.CloseSuggestions, askUser = plan.AskUser }, pretty));
            if (Has("--trim")) { var run = await guard.RunAsync(target, CancellationToken.None, force: true); Console.WriteLine(JsonSerializer.Serialize(new { run.BeforePercent, run.AfterPercent, run.ReclaimedMb, run.TargetReached, trimmed = run.Trimmed }, pretty)); }
            return 0;
        }
        case "resources": Console.WriteLine(JsonSerializer.Serialize(Viro.Agent.Care.ResourceHealth.Collect(), pretty)); return 0;
        case "startup-disable":
        {
            // Disables the named start-up programs (an explicit choice by the person, any classification) through the reversible start-up recipe. Names are separated by ';'.
            var names = (Arg("--names") ?? throw new ArgumentException("--names \"A;B\" required")).Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            var env2 = new Viro.Agent.Care.UserRepairEnv(); var items = Viro.Agent.Care.StartupOptimizeRecipe.Items(env2).Where(i => i.Enabled).ToList();
            var chosen = names.Select(n => (n, item: items.FirstOrDefault(i => string.Equals(i.Name, n, StringComparison.OrdinalIgnoreCase)))).ToList();
            foreach (var c in chosen.Where(c => c.item is null)) Console.WriteLine($"not found or already disabled: {c.n}");
            var entries = chosen.Where(c => c.item is not null).Select(c => new { location = c.item!.Location, name = c.item.Name }).ToList();
            if (entries.Count == 0) return 1;
            var disableOpts = JsonSerializer.SerializeToElement(new { entries });
            var rep2 = await RepairEngine.RunAsync(Recipes.All["startup.disable"], new RepairContext(env2, new SystemProcessRunner(), new WindowsServices(), Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, disableOpts), CancellationToken.None);
            Console.WriteLine(JsonSerializer.Serialize(new { rep2.RepairId, rep2.Applied, rep2.Verified, rep2.RollbackAvailable, rep2.Summary, steps = rep2.Steps }, pretty)); return rep2.Verified == true ? 0 : 1;
        }
        case "app":
        {
            // The window for the person at the PC (Start menu: Viro WorkCare). Everything it does is reversible from the same window.
            // The interface needs a single-threaded UI thread (a requirement of the web view), so the whole window runs on its own.
            // One window per person: opening Viro again (a second click while the first is still starting, or a shortcut pressed twice) brings the existing window forward instead of starting another.
            // ("Run as administrator" reopens the window with --relaunch and waits for the old one to close.)
            using var single = new Mutex(false, @"Local\ViroWorkCareWindow");
            bool first; try { first = single.WaitOne(Has("--relaunch") ? 10_000 : 0); } catch (AbandonedMutexException) { first = true; }
            if (!first) { Viro.Agent.Care.LocalWebForm.BringExistingToFront(); return 0; }
            var localActions = new Viro.Agent.Care.LocalActions(new Viro.Agent.Care.UserRepairEnv()); var page = Arg("--page");
            var ui = new Thread(() =>
            {
                System.Windows.Forms.Application.EnableVisualStyles(); System.Windows.Forms.Application.SetHighDpiMode(System.Windows.Forms.HighDpiMode.PerMonitorV2);
                var web = new Viro.Agent.Care.LocalWebForm(new Viro.Agent.Care.LocalBridge(localActions, null, Viro.Agent.Care.LocalWebForm.Relaunch, null, null, url => { if (Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps) System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); }), page);
                web.Shown += async (_, _) => { if (!await web.InitializeAsync()) { web.NeedsPlainWindow = true; web.Close(); } };
                System.Windows.Forms.Application.Run(web);
                if (web.NeedsPlainWindow) System.Windows.Forms.Application.Run(new Viro.Agent.Care.LocalAppForm(localActions) { StartPage = page, FallbackReason = Viro.Agent.Care.LocalWebForm.LastFailure ?? "the full interface could not start" });      // no web view runtime: the plain window still works
            });
            ui.SetApartmentState(ApartmentState.STA); ui.Start(); ui.Join();
            return 0;
        }
        case "maintain":
        {
            // The weekly care task: runs as the signed-in person, applies every safe fix and sends the result to Viro. Quiet: no window.
            var act = new Viro.Agent.Care.LocalActions(new Viro.Agent.Care.UserRepairEnv());
            var r = await Viro.Agent.Care.Maintenance.RunAsync(act, new Viro.Agent.Care.AccountService(new Viro.Agent.Care.DpapiAccountStore()), CancellationToken.None);
            Console.WriteLine(r.Message); return r.Ok ? 0 : 1;
        }
        case "startup-optimize":
        case "startup-rollback":
        {
            // Runs the same diagnose / apply / verify / rollback pipeline as the service, for the signed-in user, keeping the undo record under the user's profile.
            var env = new Viro.Agent.Care.UserRepairEnv();
            var ctx = new RepairContext(env, new SystemProcessRunner(), new WindowsServices(), Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, JsonDocument.Parse("{}").RootElement);
            if (args[0] == "startup-rollback")
            {
                var rb = await RepairEngine.RollbackAsync(Recipes.All, Arg("--id") ?? throw new ArgumentException("--id required"), ctx, CancellationToken.None);
                Console.WriteLine(JsonSerializer.Serialize(new { rb.Summary, rb.RolledBack }, pretty)); return 0;
            }
            var rep = await RepairEngine.RunAsync(Recipes.All["startup.optimize"], ctx, CancellationToken.None);
            Console.WriteLine(JsonSerializer.Serialize(new { rep.RepairId, rep.Needed, rep.Applied, rep.Verified, rep.RollbackAvailable, rep.Summary, steps = rep.Steps, before = rep.Before }, pretty)); return rep.Verified == true || !rep.Needed ? 0 : 1;
        }
        case "startup-plan":
        {
            var items = Viro.Agent.Care.StartupOptimizeRecipe.Items(new RepairEnv());
            Console.WriteLine(JsonSerializer.Serialize(items.Select(i => Viro.Agent.Care.StartupClassifier.Assess(i)).Select(a => new { a.Item.Name, a.Item.Enabled, cls = a.Class.ToString(), a.Reason }), pretty));
            return 0;
        }
        case "ui-test":
        {
            // Development check of the user-session helper: lists open windows and shows one real notice, then prints the button that was clicked.
            using var ui = new Viro.Agent.Care.UserUiBridge(Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance);
            var w = await ui.WindowsAsync(CancellationToken.None);
            Console.WriteLine(w is null ? "helper unavailable" : $"windows seen: {w.Count}, foreground pid: {w.FirstOrDefault(x => x.Foreground)?.Pid}");
            var choice = await ui.NotifyAsync(new Viro.Agent.Care.Notice("t", "Your PC is getting too hot", "CPU temperature has reached 87°C. Viro has paused background compute.", ["Chrome — high CPU", "Teams — medium CPU"],
                [new("close", "CLOSE SAFE IDLE APPS"), new("view", "VIEW DETAILS"), new("later", "REMIND ME")], 25, "warning"), CancellationToken.None);
            Console.WriteLine("clicked: " + (choice ?? "(nothing: timed out)"));
            return 0;
        }
        case "ui-helper": return await Viro.Agent.Care.UserUiHelper.RunAsync(Arg("--pipe") ?? throw new ArgumentException("--pipe required"), CancellationToken.None);
        case "desktop-helper": return await DesktopHelper.RunAsync(Arg("--pipe") ?? throw new ArgumentException("--pipe required"), CancellationToken.None);
        case "hardware": Console.WriteLine(JsonSerializer.Serialize(HardwareDiagnostics.Run(), pretty)); return 0;
        case "health":
        {
            var cache = new UpdateStateCache();
            cache.RefreshIfStale();
            if (Has("--with-updates")) for (var i = 0; i < 900 && cache.Latest is null && cache.LastError is null; i++) Thread.Sleep(1000);
            Console.WriteLine(JsonSerializer.Serialize(await HealthCollector.CollectAsync(cache), pretty));
            return 0;
        }
        case "app-updates":
        {
            var list = await Viro.Agent.Care.AppUpdates.ListAsync(new SystemProcessRunner(), CancellationToken.None);
            Console.WriteLine(list is null ? "winget is not available on this PC" : JsonSerializer.Serialize(list, pretty)); return 0;
        }
        case "upgrade-bench":
        {
            // The controlled measurement used for upgrade advice, run by hand (about a minute; stops by itself if the processor gets too hot).
            var ub = Viro.Agent.Care.UpgradeBenchmark.Run(new Viro.Agent.Care.UpgradeBenchmark.Options(), CancellationToken.None);
            Console.WriteLine(JsonSerializer.Serialize(ub, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true })); return 0;
        }
        case "anatomy":
        {
            // The full anatomy of this PC, exactly as it would be reported (read-only). Needs administrator rights for firmware, disk and event-log details.
            var an = Viro.Agent.Anatomy.Collect(new SystemProcessRunner());
            Console.WriteLine(JsonSerializer.Serialize(an, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true })); return 0;
        }
        case "printers":
        {
            // What Windows says about printing on this PC and what Viro would do about it (add --repair to run the repair ladder for real).
            var sys = new Viro.Agent.Care.WindowsPrinterSystem(new SystemProcessRunner(), new WindowsServices(), new RepairEnv());
            var snap = await sys.SnapshotAsync(CancellationToken.None);
            Console.WriteLine(JsonSerializer.Serialize(new { snap.Spooler, snap.SpoolerStart, snap.SpoolerRecovers, snap.QueueFiles, printers = snap.Printers, issues = Viro.Agent.Care.PrinterDiagnosis.Diagnose(snap) }, pretty));
            if (Has("--repair")) { var r = await RepairEngine.RunAsync(new Viro.Agent.Care.PrinterRepairRecipe(), new RepairContext(new RepairEnv(), new SystemProcessRunner(), new WindowsServices(), Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, JsonDocument.Parse("{\"level\":" + (Arg("--level") ?? "3") + "}").RootElement), CancellationToken.None); Console.WriteLine(JsonSerializer.Serialize(r, pretty)); }
            return 0;
        }
        case "stability":
        {
            // What Windows recorded about crashes and freezes on this PC, and the likely causes Viro draws from it.
            var ev = Viro.Agent.Care.StabilityReader.Collect(30);
            Console.WriteLine(JsonSerializer.Serialize(new { evidence = ev, causes = Viro.Agent.Care.StabilityReader.Analyse(ev), hung = Viro.Agent.Care.HungApps.List() }, pretty)); return 0;
        }
        case "slow-analyze":
        {
            // What Windows recorded about slow start-up and shut-down on this PC, plus the settings that could cause it. Needs administrator rights to read the timing log.
            var envS = new RepairEnv();
            Console.WriteLine(JsonSerializer.Serialize(new { shutdown = Viro.Agent.Care.ShutdownHistory.Read(), boot = Viro.Agent.Care.BootHistory.Read(), settings = envS.ReadShutdownSettings(), pageFileWipe = envS.ClearsPageFileAtShutdown(), delayedCandidates = envS.ServiceEntries().Count(e => e.DelayedAutostart == 0) }, pretty)); return 0;
        }
        case "space-clean":
        {
            // Same path as the window's Free space page: measures, then removes the chosen categories (default: every SAFE one) and prints the real result.
            var act = new Viro.Agent.Care.LocalActions(new Viro.Agent.Care.UserRepairEnv()); var sw = System.Diagnostics.Stopwatch.StartNew();
            var cats = await act.PreviewCleanupAsync(CancellationToken.None); Console.WriteLine($"measured in {sw.Elapsed.TotalSeconds:0.0}s");
            foreach (var c in cats) Console.WriteLine($"  {c.Id,-22} {c.Class,-7} {c.BytesFound / 1048576,8} MB in {c.FilesFound} files (too new: {c.RecentBytes / 1048576} MB)");
            if (!Has("--run")) return 0;
            var ids = (Arg("--ids") ?? string.Join(";", cats.Where(c => c.Class == "SAFE" && c.BytesFound > 0).Select(c => c.Id))).Split(";", StringSplitOptions.RemoveEmptyEntries);
            var res = await act.CleanAsync(ids, CancellationToken.None);
            foreach (var r in res) Console.WriteLine($"  cleaned {r.Id,-22} freed {r.BytesFreed / 1048576} MB, removed {r.FilesRemoved} files, skipped {r.Skipped}");
            Console.WriteLine(Viro.Agent.Care.LocalActions.Describe(res, false)); return 0;
        }
        case "cleanup-preview": Console.WriteLine(JsonSerializer.Serialize(Cleanup.Preview(new RepairEnv(), null), pretty)); return 0;
        case "run": break; // console-hosted service mode
        default:
            Console.Error.WriteLine("usage: viro-agent [install|setup|uninstall|status|version|enroll|inventory|health|hardware|cleanup-preview|run] [--server URL --token TOKEN --dir PATH --keep-data --force]");
            return 2;
    }
}

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = Installer.ServiceName);
builder.Services.AddHostedService<AgentWorker>();
builder.Services.AddHostedService<Viro.Agent.Care.CareWorker>();
builder.Services.AddHostedService<Viro.Agent.Care.LocalViewServer>();
builder.Logging.AddProvider(new FileLoggerProvider());
await builder.Build().RunAsync();
return 0;

static class Enroller
{
    public static async Task<int> RunAsync(InstallOptions o)
    {
        if (o.Server is null || o.Token is null) { Console.Error.WriteLine("usage: viro-agent enroll --server <https-url> --token <enrollment-token>"); return 2; }
        try
        {
            var client = new ControlClient(o.Server);
            var r = await client.EnrollAsync(o.Token, Collectors.MachineGuid(), Environment.MachineName, Collectors.AgentVersion, CancellationToken.None);
            var cfg = new AgentConfig { ServerUrl = o.Server.TrimEnd('/'), DeviceId = r.DeviceId, HeartbeatIntervalSeconds = r.HeartbeatIntervalSeconds, JobSigningPublicKey = r.JobSigningPublicKey, OrganizationId = r.OrganizationId };
            cfg.SetSecret(r.DeviceSecret);
            cfg.Save();
            Console.WriteLine($"Enrolled as device {r.DeviceId}");
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine($"Enrollment failed: {e.Message}"); return 1; }
    }
}
