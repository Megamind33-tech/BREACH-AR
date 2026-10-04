using System.Text.Json;

namespace Viro.Agent.Repair;

static class RepairCtx
{
    public static RepairContext Make(JobContext j, JsonElement options, RepairEnv? env = null, IProcessRunner? proc = null, IServices? svc = null) =>
        new(env ?? new RepairEnv(), proc ?? new SystemProcessRunner(), svc ?? new WindowsServices(), j.Log, options);
    public static bool Flag(JsonElement p, string n) => p.ValueKind == JsonValueKind.Object && p.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.True;
}

/// <summary>repair.run { recipe, options?, approved? }: one named recipe through the diagnose/change/verify pipeline.</summary>
public sealed class RepairRunHandler(RepairEnv? env = null, IProcessRunner? proc = null, IServices? svc = null) : IJobHandler
{
    public string Type => "repair.run";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var p = ctx.Job.Params;
        var name = p.GetProperty("recipe").GetString()!;
        if (!Recipes.All.TryGetValue(name, out var recipe)) return new(false, null, $"unknown repair recipe \"{name}\"");
        if (recipe.Risk == RepairRisk.Review && !RepairCtx.Flag(p, "approved")) return new(false, null, $"\"{name}\" changes the system in a way that needs explicit administrator approval (approved:true)");
        var opts = p.TryGetProperty("options", out var o) ? o.Clone() : JsonDocument.Parse("{}").RootElement.Clone();
        if (await DisruptionGuard.CheckAsync(name, env ?? new RepairEnv(), ct) is { } why) return new(true, new { deferred = true, report = new { summary = "Deferred: " + why } });   // not now; nothing was changed
        var report = await RepairEngine.RunAsync(recipe, RepairCtx.Make(ctx, opts, env, proc, svc), ct);
        if (report.Summary.StartsWith("Deferred:")) return new(true, new { deferred = true, report });   // the job ran correctly; the repair is postponed and Control keeps the problem open
        var ok = !report.Applied || report.Verified == true;
        return new(ok, report, ok ? null : report.Summary);
    }
}

/// <summary>repair.fix-safe: the "Fix my PC" pass. Every auto-safe recipe is diagnosed; only those with a real problem are applied.</summary>
public sealed class RepairFixSafeHandler(RepairEnv? env = null, IProcessRunner? proc = null, IServices? svc = null) : IJobHandler
{
    public string Type => "repair.fix-safe";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var none = JsonDocument.Parse("{}").RootElement.Clone();
        var reports = new List<RepairReport>();
        foreach (var r in Recipes.All.Values.Where(r => r.AutoSafe && r.Risk == RepairRisk.Safe))
        {
            ct.ThrowIfCancellationRequested();
            reports.Add(await RepairEngine.RunAsync(r, RepairCtx.Make(ctx, none, env, proc, svc), ct));
        }
        var fixedN = reports.Count(r => r.Applied && r.Verified == true);
        var failed = reports.Count(r => r.Applied && r.Verified != true);
        var result = new { fixedCount = fixedN, failedCount = failed, unchangedCount = reports.Count - fixedN - failed, repairs = reports, rebootRequired = reports.Any(r => r.RebootRequired) };
        return new(failed == 0, result, failed == 0 ? null : $"{failed} repair(s) failed");
    }
}

public sealed class RepairRollbackHandler(RepairEnv? env = null, IProcessRunner? proc = null, IServices? svc = null) : IJobHandler
{
    public string Type => "repair.rollback";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        try
        {
            var id = ctx.Job.Params.GetProperty("repairId").GetString()!;
            var report = await RepairEngine.RollbackAsync(Recipes.All, id, RepairCtx.Make(ctx, ctx.Job.Params, env, proc, svc), ct);
            return new(true, report);
        }
        catch (Exception e) when (e is InvalidOperationException or ArgumentException or NotSupportedException) { return new(false, null, e.Message); }
    }
}

public sealed class CleanupPreviewHandler(RepairEnv? env = null) : IJobHandler
{
    public string Type => "cleanup.preview";
    public Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct) => Task.Run(() =>
    {
        var e = env ?? new RepairEnv();
        var cats = Cleanup.Preview(e, null, ct: ct);
        return new JobOutcome(true, new
        {
            categories = cats,
            safeBytes = cats.Where(c => c.Class == "SAFE").Sum(c => c.BytesFound),
            reviewBytes = cats.Where(c => c.Class == "REVIEW").Sum(c => c.BytesFound),
            systemDriveFreeBytes = Recipes.FreeBytes(e),
            personalDataNeverTouched = Cleanup.PersonalFoldersNeverTouched,
        });
    }, ct);
}

public sealed class CleanupRunHandler(RepairEnv? env = null, IProcessRunner? proc = null) : IJobHandler
{
    public string Type => "cleanup.run";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var p = ctx.Job.Params;
        var ids = p.GetProperty("categories").EnumerateArray().Select(x => x.GetString()!).ToList();
        var e = env ?? new RepairEnv();
        var before = Recipes.FreeBytes(e);
        try
        {
            var res = await Cleanup.RunAsync(e, proc ?? new SystemProcessRunner(), ids, RepairCtx.Flag(p, "approveReview"), ct: ct);
            return new(true, new { freedBytes = res.Sum(r => r.BytesFreed), filesRemoved = res.Sum(r => r.FilesRemoved), skippedInUse = res.Sum(r => r.Skipped), categories = res, systemDriveFreeBefore = before, systemDriveFreeAfter = Recipes.FreeBytes(e) });
        }
        catch (InvalidOperationException ex) { return new(false, null, ex.Message); }
    }
}
