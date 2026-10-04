using System.Management;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using Viro.Agent.Repair;

namespace Viro.Agent.Care;

/// <summary>One printer as Windows reports it.</summary>
public sealed record PrinterFact(string Name, string Driver, bool DriverInstalled, string Port, bool Network, bool? Reachable, int Status, int ErrorState, bool WorkOffline, int ErrorJobs, int StuckJobs, int? PnpError);
public sealed record PrinterSnapshot(string? Spooler, string? SpoolerStart, bool SpoolerRecovers, int QueueFiles, IReadOnlyList<PrinterFact> Printers);
/// <summary>Something wrong with printing. Level is the first rung of the repair ladder that can fix it; SoftwareFixable false means paper, toner, a jam, a cable or the network (nothing Viro can repair from software).</summary>
public sealed record PrinterIssue(string Code, string? Printer, string Detail, bool SoftwareFixable, int Level);

public static class PrinterDiagnosis
{
    static readonly HashSet<int> DriverProblemCodes = [10, 28, 31, 37, 39, 43, 52];                 // Device Manager codes for a driver that is missing, damaged or will not load
    static readonly Dictionary<int, string> Physical = new() { [4] = "out of paper", [6] = "out of toner or ink", [7] = "a door or cover is open", [8] = "paper is jammed", [10] = "it asks for service", [11] = "the output tray is full" };

    public static List<PrinterIssue> Diagnose(PrinterSnapshot s)
    {
        var o = new List<PrinterIssue>();
        if (s.Spooler is null) return o;                                                              // no print system on this PC: nothing to look after
        if (s.Spooler != "Running") o.Add(new("spooler.down", null, $"The Print Spooler service is {s.Spooler.ToLowerInvariant()}, so nothing can print.", true, 1));
        else if (!string.Equals(s.SpoolerStart, "Auto", StringComparison.OrdinalIgnoreCase) || !s.SpoolerRecovers) o.Add(new("spooler.config", null, "The Print Spooler is not set to start by itself and restart if it crashes, so a printing problem comes back.", true, 1));
        var stuck = s.QueueFiles > 0 || s.Printers.Any(p => p.ErrorJobs + p.StuckJobs > 0);
        if (stuck) o.Add(new("jobs.stuck", null, "Print jobs are stuck in the queue and block everything behind them.", true, 1));
        foreach (var p in s.Printers)
        {
            if (Physical.TryGetValue(p.ErrorState, out var why)) { o.Add(new("printer.physical", p.Name, $"{p.Name} reports it is {why}.", false, 0)); continue; }
            if (p.Network && p.Reachable == false) { o.Add(new("printer.unreachable", p.Name, $"{p.Name} cannot be reached on the network (switched off, unplugged or on another network).", false, 0)); continue; }
            if (!p.DriverInstalled || (p.PnpError is { } e && DriverProblemCodes.Contains(e))) o.Add(new("printer.driver", p.Name, $"{p.Name} has a missing or damaged driver ({(p.Driver.Length == 0 ? "none set" : p.Driver)}).", true, 2));
            else if (p.WorkOffline) o.Add(new("printer.offline", p.Name, $"{p.Name} is set to \"Use Printer Offline\".", true, 1));
            else if (p.Status == 7 || p.ErrorState == 9) o.Add(new("printer.offline", p.Name, $"{p.Name} shows as offline although it can be reached; its driver or port is probably at fault.", true, 2));
        }
        return o;
    }
}

/// <summary>Everything the printer repair touches, behind an interface so the whole ladder can be proven without a printer.</summary>
public interface IPrinterSystem
{
    Task<PrinterSnapshot> SnapshotAsync(CancellationToken ct);
    Task<(string start, bool recovers)> HardenSpoolerAsync(CancellationToken ct);
    Task RestoreSpoolerAsync(string start, CancellationToken ct);
    Task ClearQueueAsync(CancellationToken ct);                       // stops the spooler, empties the queue, starts it again
    Task SetOnlineAsync(string printer, CancellationToken ct);
    Task<bool> ReRegisterDriverAsync(string driver, CancellationToken ct);
    Task<bool> SetDriverAsync(string printer, string driver, CancellationToken ct);
    Task<IReadOnlyList<PendingUpdate>> FindDriverUpdatesAsync(PrinterFact printer, CancellationToken ct);
    Task<bool> InstallDriverUpdatesAsync(IReadOnlyList<PendingUpdate> updates, CancellationToken ct);
}

/// <summary>
/// printer.repair { level 1..3, printer? }: fixes printing the way a technician would, one rung at a time, checking after each: (1) clear stuck jobs, restart the spooler, bring printers back online and make
/// the spooler restart itself if it ever crashes; (2) put the printer's driver back, or use Microsoft's own class driver for a network printer; (3) fetch the maker's newer driver from Windows Update.
/// It stops as soon as printing is healthy and says plainly when the cause is paper, toner, a cable or the network. Drivers it replaced are restorable.
/// </summary>
public sealed class PrinterRepairRecipe(IPrinterSystem? system = null, Func<PrinterSnapshot, Task>? settle = null) : IRepairRecipe
{
    public string Id => "printer.repair"; public string Title => "Repair printing (clear stuck jobs, restart the spooler, fix or update the printer driver)";
    public RepairRisk Risk => RepairRisk.Review; public bool AutoSafe => false; public bool Reversible => true;
    public const string ClassDriver = "Microsoft IPP Class Driver";

    IPrinterSystem Sys(RepairContext c) => system ?? new WindowsPrinterSystem(c.Proc, c.Services, c.Env);
    static int Level(RepairContext c) => c.Options.ValueKind == JsonValueKind.Object && c.Options.TryGetProperty("level", out var l) && l.ValueKind == JsonValueKind.Number ? Math.Clamp(l.GetInt32(), 1, 3) : 3;
    static string? Only(RepairContext c) => c.Options.ValueKind == JsonValueKind.Object && c.Options.TryGetProperty("printer", out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
    static List<PrinterIssue> Fixable(PrinterSnapshot s, int level, string? only) => [.. PrinterDiagnosis.Diagnose(s).Where(i => i.SoftwareFixable && i.Level <= level && (only is null || i.Printer is null || i.Printer == only))];

    public async Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var snap = await Sys(c).SnapshotAsync(ct); var all = PrinterDiagnosis.Diagnose(snap); var fix = Fixable(snap, Level(c), Only(c));
        var cannot = all.Where(i => !i.SoftwareFixable).ToList();
        var detail = fix.Count > 0 ? string.Join(" ", fix.Select(i => i.Detail)) : cannot.Count > 0 ? "Nothing Viro can repair from software: " + string.Join(" ", cannot.Select(i => i.Detail)) : snap.Spooler is null ? "this PC has no print system" : "printing is healthy";
        return new(fix.Count > 0, detail, new { issues = fix.Select(i => i.Code).ToList(), cannot = cannot.Select(i => i.Detail).ToList() });
    }

    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var sys = Sys(c); var level = Level(c); var only = Only(c); var steps = new List<string>(); var changed = new List<object>(); c.RollbackState["drivers"] = changed;
        async Task<PrinterSnapshot> Look() { var s = await sys.SnapshotAsync(ct); if (settle is not null) await settle(s); return s; }
        var snap = await Look();

        // Rung 1: the spooler, the queue, offline printers, and making the fix last.
        var fixable = Fixable(snap, 1, only);
        if (fixable.Any(i => i.Code == "spooler.config") || fixable.Any(i => i.Code == "spooler.down")) { var prior = await sys.HardenSpoolerAsync(ct); c.RollbackState["spooler"] = new { prior.start, prior.recovers }; steps.Add("the Print Spooler now starts automatically and restarts itself after a crash"); }
        if (fixable.Any(i => i.Code is "spooler.down" or "jobs.stuck")) { await sys.ClearQueueAsync(ct); steps.Add("stuck print jobs cleared and the spooler restarted"); }
        foreach (var p in snap.Printers.Where(p => p.WorkOffline && fixable.Any(i => i.Code == "printer.offline" && i.Printer == p.Name))) { await sys.SetOnlineAsync(p.Name, ct); steps.Add($"{p.Name} brought back online"); }
        snap = await Look();

        // Rung 2: the driver.
        if (level >= 2)
            foreach (var p in snap.Printers.Where(p => Fixable(snap, 2, only).Any(i => i.Printer == p.Name && i.Code is "printer.driver" or "printer.offline")).ToList())
            {
                if (p.Driver.Length > 0 && await sys.ReRegisterDriverAsync(p.Driver, ct)) steps.Add($"the driver for {p.Name} was put back from Windows' driver store");
                snap = await Look(); var now = snap.Printers.FirstOrDefault(x => x.Name == p.Name);
                if (now is not null && Fixable(snap, 2, only).Any(i => i.Printer == p.Name) && p.Network && await sys.SetDriverAsync(p.Name, ClassDriver, ct)) { changed.Add(new { printer = p.Name, previous = p.Driver }); steps.Add($"{p.Name} now uses Microsoft's own network printer driver"); snap = await Look(); }
            }

        // Rung 3: the maker's newer driver from Windows Update.
        if (level >= 3)
            foreach (var p in snap.Printers.Where(p => Fixable(snap, 3, only).Any(i => i.Printer == p.Name && i.Code is "printer.driver" or "printer.offline")).ToList())
            {
                var found = await sys.FindDriverUpdatesAsync(p, ct);
                if (found.Count > 0 && await sys.InstallDriverUpdatesAsync(found, ct)) { steps.Add($"a newer driver for {p.Name} was installed from Windows Update ({found[0].Title})"); snap = await Look(); }
                else steps.Add($"Windows Update has no newer driver for {p.Name}");
            }
        c.After = new { steps };
    }

    public async Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var snap = await Sys(c).SnapshotAsync(ct); var left = Fixable(snap, Level(c), Only(c));
        if (left.Count == 0) return (true, "printing is healthy again: spooler running and set to restart itself, no stuck jobs, printers online with working drivers");
        return (false, "still wrong: " + string.Join(" ", left.Select(i => i.Detail)));
    }

    public async Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        var sys = Sys(c);
        if (saved.TryGetProperty("drivers", out var d) && d.ValueKind == JsonValueKind.Array) foreach (var e in d.EnumerateArray()) if (e.GetProperty("previous").GetString() is { Length: > 0 } prev) await sys.SetDriverAsync(e.GetProperty("printer").GetString()!, prev, ct);
        if (saved.TryGetProperty("spooler", out var s) && s.TryGetProperty("start", out var st)) await sys.RestoreSpoolerAsync(st.GetString() ?? "Auto", ct);
    }
}

/// <summary>The real thing: WMI for what Windows reports, PowerShell's print cmdlets for changes, Windows Update for the maker's driver.</summary>
public sealed class WindowsPrinterSystem(IProcessRunner proc, IServices services, RepairEnv env, IUpdateAgent? updates = null) : IPrinterSystem
{
    static readonly Regex Safe = new(@"^[\p{L}\p{N} ._\-()#,/+]{1,120}$");
    static string Q(string s) => "'" + s.Replace("'", "''") + "'";
    string Queue => Path.Combine(env.WindowsDir, "System32", "spool", "PRINTERS");

    public async Task<PrinterSnapshot> SnapshotAsync(CancellationToken ct) => await Task.Run(() =>
    {
        var state = services.Status("Spooler"); if (state is null) return new PrinterSnapshot(null, null, false, 0, []);
        string? start = null; try { using var s = new ManagementObjectSearcher("SELECT StartMode FROM Win32_Service WHERE Name='Spooler'"); start = s.Get().Cast<ManagementObject>().Select(x => x["StartMode"]?.ToString()).FirstOrDefault(); } catch (ManagementException) { }
        var recovers = false; try { using var k = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\Spooler"); recovers = k?.GetValue("FailureActions") is byte[] { Length: > 0 }; } catch (System.Security.SecurityException) { }
        var files = 0; try { files = Directory.Exists(Queue) ? Directory.EnumerateFiles(Queue).Count(p => DateTime.UtcNow - File.GetLastWriteTimeUtc(p) > TimeSpan.FromMinutes(10)) : 0; } catch (UnauthorizedAccessException) { /* a normal user cannot read the spool folder; the service can */ }
        var printers = new List<PrinterFact>();
        if (state == "Running")
        {
            var drivers = new List<string>(); try { using var d = new ManagementObjectSearcher("SELECT Name FROM Win32_PrinterDriver"); drivers = d.Get().Cast<ManagementObject>().Select(x => (x["Name"]?.ToString() ?? "").Split(',')[0]).ToList(); } catch (ManagementException) { }
            var hosts = new Dictionary<string, (string host, int port)>(StringComparer.OrdinalIgnoreCase); try { using var h = new ManagementObjectSearcher("SELECT Name,HostAddress,PortNumber FROM Win32_TCPIPPrinterPort"); foreach (ManagementObject x in h.Get()) hosts[x["Name"]?.ToString() ?? ""] = (x["HostAddress"]?.ToString() ?? "", Convert.ToInt32(x["PortNumber"] ?? 9100)); } catch (ManagementException) { }
            var jobs = new List<(string printer, string status, DateTime? at)>(); try { using var j = new ManagementObjectSearcher("SELECT Name,JobStatus,Status,TimeSubmitted FROM Win32_PrintJob"); foreach (ManagementObject x in j.Get()) jobs.Add(((x["Name"]?.ToString() ?? "").Split(',')[0], (x["JobStatus"]?.ToString() ?? "") + " " + (x["Status"]?.ToString() ?? ""), x["TimeSubmitted"] is string ts ? ManagementDateTimeConverter.ToDateTime(ts).ToUniversalTime() : null)); } catch (ManagementException) { }
            var pnp = new List<(string name, int code)>(); try { using var q = new ManagementObjectSearcher("SELECT Name,ConfigManagerErrorCode FROM Win32_PnPEntity WHERE PNPClass='Printer' OR PNPClass='PrintQueue'"); foreach (ManagementObject x in q.Get()) pnp.Add((x["Name"]?.ToString() ?? "", Convert.ToInt32(x["ConfigManagerErrorCode"] ?? 0))); } catch (ManagementException) { }
            try
            {
                using var ps = new ManagementObjectSearcher("SELECT Name,DriverName,PortName,PrinterStatus,DetectedErrorState,WorkOffline,Network FROM Win32_Printer WHERE Local=TRUE OR Network=FALSE OR Network=TRUE");
                foreach (ManagementObject x in ps.Get())
                {
                    var name = x["Name"]?.ToString() ?? ""; var drv = x["DriverName"]?.ToString() ?? ""; var port = x["PortName"]?.ToString() ?? "";
                    if (Regex.IsMatch(name, @"^(Microsoft Print to PDF|Microsoft XPS Document Writer|OneNote|Fax|Send To OneNote|Adobe PDF|Snagit)", RegexOptions.IgnoreCase)) continue;      // virtual printers cannot fail like a device
                    var tcp = hosts.TryGetValue(port, out var hp); bool? reach = tcp ? TcpOpen(hp.host, hp.port) : null;
                    var mine = jobs.Where(j => j.printer == name).ToList();
                    int? code = pnp.Where(n => n.name.Equals(name, StringComparison.OrdinalIgnoreCase) || n.name.Contains(name, StringComparison.OrdinalIgnoreCase)).Select(n => (int?)n.code).FirstOrDefault(c => c != 0);
                    printers.Add(new(name, drv, drv.Length > 0 && drivers.Any(d => d.Equals(drv, StringComparison.OrdinalIgnoreCase)), port, tcp, reach, Convert.ToInt32(x["PrinterStatus"] ?? 3), Convert.ToInt32(x["DetectedErrorState"] ?? 2), x["WorkOffline"] is true,
                        mine.Count(j => Regex.IsMatch(j.status, "error|blocked|offline|paperout|user intervention", RegexOptions.IgnoreCase)), mine.Count(j => j.at is { } t && DateTime.UtcNow - t > TimeSpan.FromMinutes(15)), code));
                }
            }
            catch (ManagementException) { }
        }
        return new PrinterSnapshot(state, start, recovers, files, printers);
    }, ct);

    static bool? TcpOpen(string host, int port) { try { using var c = new TcpClient(); return c.ConnectAsync(host, port).Wait(TimeSpan.FromSeconds(2)) && c.Connected; } catch (Exception) { return false; } }

    public async Task<(string start, bool recovers)> HardenSpoolerAsync(CancellationToken ct)
    {
        string prior = "Auto"; try { using var s = new ManagementObjectSearcher("SELECT StartMode FROM Win32_Service WHERE Name='Spooler'"); prior = s.Get().Cast<ManagementObject>().Select(x => x["StartMode"]?.ToString()).FirstOrDefault() ?? "Auto"; } catch (ManagementException) { }
        await proc.RunAsync("sc.exe", "config Spooler start= auto", TimeSpan.FromSeconds(30), ct);
        await proc.RunAsync("sc.exe", "failure Spooler reset= 86400 actions= restart/5000/restart/5000/restart/30000", TimeSpan.FromSeconds(30), ct);
        return (prior, false);
    }
    public async Task RestoreSpoolerAsync(string start, CancellationToken ct) { var mode = start.ToLowerInvariant() switch { "manual" => "demand", "disabled" => "disabled", _ => "auto" }; await proc.RunAsync("sc.exe", $"config Spooler start= {mode}", TimeSpan.FromSeconds(30), ct); }

    public async Task ClearQueueAsync(CancellationToken ct)
    {
        await services.StopAsync("Spooler", TimeSpan.FromSeconds(45));
        if (Directory.Exists(Queue)) foreach (var p in Directory.EnumerateFiles(Queue)) { try { File.Delete(p); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { /* still locked: the restart below releases it */ } }
        await services.StartAsync("Spooler", TimeSpan.FromSeconds(45));
    }

    public async Task SetOnlineAsync(string printer, CancellationToken ct) => await Task.Run(() =>
    {
        if (!Safe.IsMatch(printer)) return;
        using var s = new ManagementObjectSearcher($"SELECT * FROM Win32_Printer WHERE Name='{printer.Replace("\\", "\\\\").Replace("'", "\\'")}'");
        foreach (ManagementObject x in s.Get()) { x["WorkOffline"] = false; x.Put(); }
    }, ct);

    public async Task<bool> ReRegisterDriverAsync(string driver, CancellationToken ct)
    {
        if (!Safe.IsMatch(driver)) return false;
        var r = await proc.RunAsync("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"Add-PrinterDriver -Name {Q(driver)} -ErrorAction Stop\"", TimeSpan.FromMinutes(2), ct);
        return r.ExitCode == 0;
    }

    public async Task<bool> SetDriverAsync(string printer, string driver, CancellationToken ct)
    {
        if (!Safe.IsMatch(printer) || !Safe.IsMatch(driver)) return false;
        var r = await proc.RunAsync("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"Add-PrinterDriver -Name {Q(driver)} -ErrorAction SilentlyContinue; Set-Printer -Name {Q(printer)} -DriverName {Q(driver)} -ErrorAction Stop\"", TimeSpan.FromMinutes(2), ct);
        return r.ExitCode == 0;
    }

    public async Task<IReadOnlyList<PendingUpdate>> FindDriverUpdatesAsync(PrinterFact printer, CancellationToken ct)
    {
        var words = Regex.Matches(printer.Driver.Length > 0 ? printer.Driver : printer.Name, @"[A-Za-z0-9]{3,}").Select(m => m.Value).Where(w => !Regex.IsMatch(w, "^(PCL|Universal|Printing|Series|Class|Driver|PS|XPS|Microsoft)$", RegexOptions.IgnoreCase)).Take(4).ToList();
        if (words.Count == 0) return [];
        var all = await (updates ?? new WindowsUpdateAgent()).SearchAsync(ct);
        return [.. all.Where(u => u.IsDriver && (u.Driver?.Class is "Printer" or "PrintQueue" or null) && words.Any(w => u.Title.Contains(w, StringComparison.OrdinalIgnoreCase)) && Regex.IsMatch(u.Title + " " + u.Driver?.Class, "print", RegexOptions.IgnoreCase))];
    }

    public async Task<bool> InstallDriverUpdatesAsync(IReadOnlyList<PendingUpdate> list, CancellationToken ct) { var r = await (updates ?? new WindowsUpdateAgent()).InstallAsync(list, ct); return r.Updates.Count > 0 && r.Updates.All(u => u.ResultCode is 2 or 3); }
}

// ---------------------------------------------------------------------------------------------------------------------
/// <summary>
/// The always-on part: checks printing every few minutes, and when something stays wrong it repairs it by itself, one rung higher each time it persists, with a pause between attempts.
/// What the organization allows decides how far it may go (the spooler and queue always; drivers when the policy permits). Every attempt and every failure is recorded and reported.
/// </summary>
public sealed class PrinterWatcher(IPrinterSystem sys, Func<int, string?, CancellationToken, Task<RepairReport>> repair, Func<DateTime>? clock = null)
{
    readonly Func<DateTime> now = clock ?? (() => DateTime.UtcNow);
    sealed class Track { public int Seen; public int Rung; public DateTime NextTry = DateTime.MinValue; public DateTime LastReport = DateTime.MinValue; }
    readonly Dictionary<string, Track> tracks = [];
    public static readonly TimeSpan Pause = TimeSpan.FromMinutes(20), ReportEvery = TimeSpan.FromHours(6);
    public const int NeededSightings = 2;                          // the same problem on two checks in a row, so a job that is merely printing is never "fixed"

    public sealed record Outcome(string Kind, object Data);

    public async Task<List<Outcome>> StepAsync(bool allowRepair, bool allowDrivers, CancellationToken ct)
    {
        var o = new List<Outcome>(); var snap = await sys.SnapshotAsync(ct); var issues = PrinterDiagnosis.Diagnose(snap);
        var keys = issues.Select(i => i.Code + "|" + i.Printer).ToHashSet();
        foreach (var gone in tracks.Keys.Where(k => !keys.Contains(k)).ToList()) tracks.Remove(gone);           // fixed, by us or by itself
        foreach (var i in issues)
        {
            var key = i.Code + "|" + i.Printer; var t = tracks.TryGetValue(key, out var ex) ? ex : tracks[key] = new Track(); t.Seen++;
            if (t.Seen < NeededSightings) continue;
            if (!i.SoftwareFixable) { if (now() - t.LastReport > ReportEvery) { t.LastReport = now(); o.Add(new("printer.failing", new { code = i.Code, printer = i.Printer, detail = i.Detail, fixable = false })); } continue; }
            if (!allowRepair || now() < t.NextTry) continue;
            var maxLevel = allowDrivers ? 3 : 1; var level = Math.Min(Math.Max(i.Level, 1) + t.Rung, maxLevel);
            if (i.Level > maxLevel) { if (now() - t.LastReport > ReportEvery) { t.LastReport = now(); o.Add(new("printer.failing", new { code = i.Code, printer = i.Printer, detail = i.Detail + " Changing the driver is not allowed by this organization's policy.", fixable = true, blocked = true })); } continue; }
            t.NextTry = now() + Pause; var report = await repair(level, i.Printer, ct);
            o.Add(new("printer.fix", new { code = i.Code, printer = i.Printer, level, verified = report.Verified == true, summary = report.Summary, repairId = report.RepairId }));
            if (report.Verified == true) { tracks.Remove(key); continue; }
            t.Rung++;                                                                                              // it persisted: next time try the next rung
            if (level >= maxLevel && now() - t.LastReport > ReportEvery) { t.LastReport = now(); o.Add(new("printer.failing", new { code = i.Code, printer = i.Printer, detail = i.Detail, fixable = true, tried = level, summary = report.Summary })); }
        }
        return o;
    }
}

/// <summary>What the health report says about printing: only the problems, in plain words, with whether software can fix them.</summary>
public static class PrintingFacts
{
    public static object? Collect()
    {
        try
        {
            var snap = new WindowsPrinterSystem(new SystemProcessRunner(), new WindowsServices(), new Viro.Agent.Repair.RepairEnv()).SnapshotAsync(CancellationToken.None).GetAwaiter().GetResult();
            if (snap.Spooler is null) return null;
            return new { spooler = snap.Spooler, printers = snap.Printers.Count, issues = PrinterDiagnosis.Diagnose(snap).Select(i => new { i.Code, i.Printer, i.Detail, fixable = i.SoftwareFixable }).ToList() };
        }
        catch (Exception e) when (e is ManagementException or InvalidOperationException) { return null; }
    }
}
