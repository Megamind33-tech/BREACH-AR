using System.Management;
using System.Text.Json;
using System.Text.RegularExpressions;
using Viro.Agent.Repair;

namespace Viro.Agent;

public sealed record DriverInfo(string? Manufacturer, string? Model, string? Class, string? Version, string? HardwareId, string? Date);
public sealed record PendingUpdate(string Id, int Revision, string Title, string? Kb, bool IsDriver, string? Severity, long SizeBytes, bool RebootMayBeRequired, string[] Categories, DriverInfo? Driver);
public sealed record UpdateOutcome(string Id, string Title, int ResultCode, int HResult, bool RebootRequired);
public sealed record InstallResult(IReadOnlyList<UpdateOutcome> Updates, bool RebootRequired);

/// <summary>The Windows Update Agent, behind an interface so patch logic can be tested without installing real updates.</summary>
public interface IUpdateAgent
{
    Task<IReadOnlyList<PendingUpdate>> SearchAsync(CancellationToken ct);
    Task<InstallResult> InstallAsync(IReadOnlyList<PendingUpdate> updates, CancellationToken ct);
}

/// <summary>Microsoft-supported COM API (Microsoft.Update.Session). Requires administrator/SYSTEM to install.</summary>
public sealed partial class WindowsUpdateAgent : IUpdateAgent
{
    // The Windows Update COM call cannot be interrupted; WaitAsync lets the job time out (or be cancelled) on schedule instead of hanging for as long as Windows Update does.
    public Task<IReadOnlyList<PendingUpdate>> SearchAsync(CancellationToken ct) => Task.Run<IReadOnlyList<PendingUpdate>>(() =>
    {
        var t = Type.GetTypeFromProgID("Microsoft.Update.Session") ?? throw new InvalidOperationException("Windows Update Agent is not available");
        dynamic session = Activator.CreateInstance(t)!;
        dynamic result = session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0");
        var list = new List<PendingUpdate>();
        foreach (dynamic u in result.Updates) { ct.ThrowIfCancellationRequested(); list.Add(Describe(u)); }
        return list;
    }, ct).WaitAsync(ct);

    static PendingUpdate Describe(dynamic u)
    {
        var cats = new List<string>(); foreach (dynamic c in u.Categories) cats.Add((string)c.Name);
        string? kb = null; try { foreach (dynamic k in u.KBArticleIDs) { kb = "KB" + (string)k; break; } } catch { }
        var isDriver = (int)u.Type == 2;
        DriverInfo? drv = null;
        if (isDriver)
        {
            string? Get(Func<object?> f) { try { return f()?.ToString(); } catch { return null; } }
            string title = u.Title;
            var ver = VersionAtEnd().Match(title);
            string? hw = Get(() => u.DriverHardwareID);
            drv = new DriverInfo(Get(() => u.DriverManufacturer), Get(() => u.DriverModel), Get(() => u.DriverClass), ver.Success ? ver.Value : null, hw, Get(() => ((DateTime)u.DriverVerDate).ToString("yyyy-MM-dd")));
        }
        int reboot = 0; try { reboot = (int)u.InstallationBehavior.RebootBehavior; } catch { }
        return new PendingUpdate((string)u.Identity.UpdateID, (int)u.Identity.RevisionNumber, (string)u.Title, kb, isDriver, (string?)u.MsrcSeverity is { Length: > 0 } s ? s : null, (long)(decimal)u.MaxDownloadSize, reboot != 0, [.. cats], drv);
    }

    [GeneratedRegex(@"\d+(\.\d+){2,3}$")] private static partial Regex VersionAtEnd();

    public Task<InstallResult> InstallAsync(IReadOnlyList<PendingUpdate> updates, CancellationToken ct) => Task.Run(() =>
    {
        var t = Type.GetTypeFromProgID("Microsoft.Update.Session")!;
        dynamic session = Activator.CreateInstance(t)!;
        dynamic found = session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0");
        var wanted = updates.Select(u => u.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
        dynamic coll = Activator.CreateInstance(Type.GetTypeFromProgID("Microsoft.Update.UpdateColl")!)!;
        var order = new List<PendingUpdate>();
        foreach (dynamic u in found.Updates)
        {
            string id = u.Identity.UpdateID;
            if (!wanted.Contains(id)) continue;
            if (!(bool)u.EulaAccepted) u.AcceptEula();
            coll.Add(u); order.Add(updates.First(x => string.Equals(x.Id, id, StringComparison.OrdinalIgnoreCase)));
        }
        if (order.Count == 0) throw new InvalidOperationException("none of the requested updates are still pending");
        ct.ThrowIfCancellationRequested();
        dynamic dl = session.CreateUpdateDownloader(); dl.Updates = coll; dl.Download();
        ct.ThrowIfCancellationRequested();
        dynamic inst = session.CreateUpdateInstaller(); inst.Updates = coll; inst.AllowSourcePrompts = false;
        dynamic res = inst.Install();
        var outcomes = new List<UpdateOutcome>();
        for (var i = 0; i < order.Count; i++)
        {
            dynamic ur = res.GetUpdateResult(i);
            outcomes.Add(new UpdateOutcome(order[i].Id, order[i].Title, (int)ur.ResultCode, (int)ur.HResult, (bool)ur.RebootRequired));
        }
        return new InstallResult(outcomes, (bool)res.RebootRequired);
    }, ct);
}

public static class PatchFacts
{
    /// <summary>Currently installed drivers (Win32_PnPSignedDriver): used to record what an update replaced, so it can be rolled back.</summary>
    public static IReadOnlyList<object> InstalledDrivers(string? hardwareIdFragment = null)
    {
        using var s = new ManagementObjectSearcher("SELECT DeviceName,DriverVersion,InfName,Manufacturer,HardWareID,DriverDate FROM Win32_PnPSignedDriver WHERE DriverVersion IS NOT NULL");
        return [.. s.Get().Cast<ManagementBaseObject>()
            .Select(o => (name: o["DeviceName"]?.ToString(), ver: o["DriverVersion"]?.ToString(), inf: o["InfName"]?.ToString(), mfr: o["Manufacturer"]?.ToString(), hw: o["HardWareID"] as string[] ?? [], date: o["DriverDate"]?.ToString()))
            .Where(d => hardwareIdFragment is null || d.hw.Any(h => h.Contains(hardwareIdFragment, StringComparison.OrdinalIgnoreCase)))
            .Select(d => (object)new { deviceName = d.name, version = d.ver, infName = d.inf, manufacturer = d.mfr, hardwareId = d.hw.FirstOrDefault() })
            .Take(200)];
    }

    /// <summary>Third-party driver packages in the driver store (pnputil XML, locale independent). Unlike the bound-device list this also sees packages for hardware that is not present.</summary>
    public static async Task<IReadOnlyList<string>> DriverStoreAsync(IProcessRunner? proc, CancellationToken ct)
    {
        var r = await (proc ?? new SystemProcessRunner()).RunAsync("pnputil.exe", "/enum-drivers /format xml", TimeSpan.FromMinutes(2), ct);
        return ParseDriverStore(r.Output);
    }

    public static IReadOnlyList<string> ParseDriverStore(string xml)
    {
        var at = xml.IndexOf("<?xml", StringComparison.Ordinal); if (at < 0) return [];
        try { return [.. System.Xml.Linq.XDocument.Parse(xml[at..]).Descendants("Driver").Select(d => (d.Attribute("DriverName")?.Value ?? "").ToLowerInvariant()).Where(n => System.Text.RegularExpressions.Regex.IsMatch(n, @"^oem\d{1,5}\.inf$"))]; }
        catch (System.Xml.XmlException) { return []; }
    }

    public static bool RebootPending()
    {
        using var lm = Microsoft.Win32.Registry.LocalMachine;
        return lm.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired") is not null
            || lm.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") is not null;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
static class UpdateJson
{
    public static object Summary(PendingUpdate u) => new { id = u.Id, revision = u.Revision, title = u.Title, kb = u.Kb, isDriver = u.IsDriver, severity = u.Severity, sizeBytes = u.SizeBytes, categories = u.Categories, driver = u.Driver };
    public static bool IsSecurity(PendingUpdate u) => !u.IsDriver && (u.Categories.Any(c => c is "Security Updates" or "Critical Updates") || u.Severity is "Critical" or "Important");
}

/// <summary>updates.scan: full detail of what Windows Update would install (drivers listed separately). Read-only.</summary>
public sealed class UpdatesScanHandler(IUpdateAgent? wu = null) : IJobHandler
{
    public string Type => "updates.scan";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var all = await (wu ?? new WindowsUpdateAgent()).SearchAsync(ct);
        return new(true, new
        {
            scannedAt = DateTime.UtcNow.ToString("O"), rebootRequired = PatchFacts.RebootPending(),
            pendingCount = all.Count(u => !u.IsDriver), securityCount = all.Count(UpdateJson.IsSecurity), driverCount = all.Count(u => u.IsDriver),
            updates = all.Where(u => !u.IsDriver).Take(200).Select(UpdateJson.Summary), drivers = all.Where(u => u.IsDriver).Take(200).Select(UpdateJson.Summary),
        });
    }
}

/// <summary>updates.install { scope: "security" | "all", updateIds? }: non-driver Windows updates only. Drivers have their own staged path.</summary>
public sealed class UpdatesInstallHandler(IUpdateAgent? wu = null) : IJobHandler
{
    public string Type => "updates.install";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var agent = wu ?? new WindowsUpdateAgent();
        var p = ctx.Job.Params;
        var scope = p.TryGetProperty("scope", out var s) ? s.GetString() : "security";
        var ids = p.TryGetProperty("updateIds", out var a) && a.ValueKind == JsonValueKind.Array ? a.EnumerateArray().Select(x => x.GetString()!).ToHashSet(StringComparer.OrdinalIgnoreCase) : null;
        var pending = (await agent.SearchAsync(ct)).Where(u => !u.IsDriver).ToList();
        var chosen = pending.Where(u => ids is null ? (scope == "all" || UpdateJson.IsSecurity(u)) : ids.Contains(u.Id)).ToList();
        if (ids is not null && chosen.Count != ids.Count) return new(false, new { requested = ids.Count, found = chosen.Count }, "some requested updates are not pending (or are drivers, which are installed through the driver rollout)");
        if (chosen.Count == 0) return new(true, new { installed = 0, message = "nothing to install", rebootRequired = PatchFacts.RebootPending() });
        var r = await agent.InstallAsync(chosen, ct);
        var ok = r.Updates.Where(u => u.ResultCode is 2).ToList(); var bad = r.Updates.Where(u => u.ResultCode is not 2 and not 3).ToList();
        return new(bad.Count == 0, new { installed = ok.Count, failed = bad.Count, rebootRequired = r.RebootRequired, updates = r.Updates }, bad.Count == 0 ? null : $"{bad.Count} update(s) failed: {string.Join("; ", bad.Take(3).Select(b => $"{b.Title} (0x{b.HResult:X8})"))}");
    }
}

/// <summary>driver.install { updateIds }: Windows Update driver packages only. Records the drivers it replaced so the change can be undone.</summary>
public sealed class DriverInstallHandler(IUpdateAgent? wu = null, Func<string?, IReadOnlyList<object>>? installed = null, IProcessRunner? proc = null) : IJobHandler
{
    public string Type => "driver.install";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var agent = wu ?? new WindowsUpdateAgent(); var snap = installed ?? PatchFacts.InstalledDrivers;
        var ids = ctx.Job.Params.GetProperty("updateIds").EnumerateArray().Select(x => x.GetString()!).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var drivers = (await agent.SearchAsync(ct)).Where(u => u.IsDriver && ids.Contains(u.Id)).ToList();
        if (drivers.Count != ids.Count) return new(false, new { requested = ids.Count, found = drivers.Count }, "some requested driver updates are no longer pending, or are not driver packages");
        var before = drivers.Select(d => new { d.Id, installed = d.Driver?.HardwareId is { } h ? snap(h.Split('&')[0]) : [] }).ToList();
        // The driver store is the source of truth for what this install added: a package for hardware that is not attached never shows up as a bound device.
        var storeBefore = await PatchFacts.DriverStoreAsync(proc, ct);
        var r = await agent.InstallAsync(drivers, ct);
        var after = drivers.Select(d => new { d.Id, installed = d.Driver?.HardwareId is { } h ? snap(h.Split('&')[0]) : [] }).ToList();
        var storeAfter = await PatchFacts.DriverStoreAsync(proc, ct);
        var packagesAdded = storeAfter.Except(storeBefore).ToList();
        var bad = r.Updates.Where(u => u.ResultCode is not 2 and not 3).ToList();
        return new(bad.Count == 0, new { installed = r.Updates.Count(u => u.ResultCode == 2), rebootRequired = r.RebootRequired, updates = r.Updates, driversBefore = before, driversAfter = after, packagesAdded, storeKnown = storeBefore.Count > 0 && storeAfter.Count > 0 },
            bad.Count == 0 ? null : $"{bad.Count} driver(s) failed: {string.Join("; ", bad.Take(3).Select(b => $"{b.Title} (0x{b.HResult:X8})"))}");
    }
}

/// <summary>driver.rollback { infName }: removes a driver package (oemNN.inf) so Windows falls back to the previous driver in the driver store.</summary>
public sealed partial class DriverRollbackHandler(IProcessRunner? proc = null) : IJobHandler
{
    public string Type => "driver.rollback";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var inf = ctx.Job.Params.GetProperty("infName").GetString()!;
        if (!OemInf().IsMatch(inf)) return new(false, null, "infName must be a third-party driver package such as oem12.inf");
        var r = await (proc ?? new SystemProcessRunner()).RunAsync("pnputil.exe", $"/delete-driver {inf} /uninstall /force", TimeSpan.FromMinutes(5), ct);
        var ok = r.ExitCode == 0 || r.ExitCode == 3010;
        return new(ok, new { infName = inf, exitCode = r.ExitCode, rebootRequired = r.ExitCode == 3010, output = r.Output.Trim() }, ok ? null : "pnputil failed: " + (r.Output.Length > 300 ? r.Output[..300] : r.Output.Trim()));
    }
    [GeneratedRegex(@"^oem\d{1,5}\.inf$", RegexOptions.IgnoreCase)] private static partial Regex OemInf();
}
