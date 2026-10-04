using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Viro.Agent.Repair;

namespace Viro.Agent.Care;

/// <summary>The normal environment, but undo records live in the signed-in user's own profile so they survive and the person can reverse a change later.</summary>
public sealed class UserRepairEnv : RepairEnv
{
    readonly string? dir;
    public UserRepairEnv(string? stateDir = null) { dir = stateDir; }
    public override string StateDir => dir ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Viro", "repairs");
}

public sealed record UndoEntry(string Id, string Recipe, string Title, DateTime CreatedAt, string Summary);
public sealed record MemoryView(double UsedPercent, double? CommitPercent, double TotalGb, IReadOnlyList<CommitConsumer> TopConsumers);

/// <summary>
/// Everything the person at the PC can do without a terminal, a console login or an administrator: free space, choose start-up programs, give back idle memory, and
/// undo a change. It uses the very same engines and safety rules as the service (nothing here is a separate, looser code path), and runs as the signed-in user,
/// so it can only touch what that user can. The window in <see cref="LocalAppForm"/> is a thin view over this class.
/// </summary>
public sealed class LocalActions(RepairEnv env, IProcessSource? source = null, IProcessActions? actions = null)
{
    public RepairEnv Env => env;
    static readonly IReadOnlyDictionary<string, string> Plain = new Dictionary<string, string>
    {
        ["startup.disable"] = "Stopped programs from starting with Windows", ["startup.enable"] = "Let programs start with Windows again", ["startup.optimize"] = "Sped up start-up",
        ["memory.trim-idle"] = "Freed memory held by idle programs", ["cleanup.safe"] = "Cleaned temporary files",
    };

    RepairContext Ctx(string optionsJson = "{}") => new(env, new SystemProcessRunner(), new WindowsServices(), NullLogger.Instance, JsonDocument.Parse(optionsJson).RootElement);

    // ---- free space ---------------------------------------------------------------------------------------------
    /// <summary>What each category holds, how much of it is too new to delete safely by default, and which need the person's say-so.</summary>
    public Task<List<CategoryResult>> PreviewCleanupAsync(CancellationToken ct) => Task.Run(() => Cleanup.Preview(env, Cleanup.Catalog.Where(c => c.Id != "windows-old").Select(c => c.Id), ct: ct), ct);
    public Task<List<CategoryResult>> CleanAsync(IEnumerable<string> ids, CancellationToken ct) => Cleanup.RunAsync(env, new SystemProcessRunner(), ids, approveReview: true, ct: ct);   // the person chose and confirmed them in the window

    // ---- start-up programs ---------------------------------------------------------------------------------------
    public IReadOnlyList<StartupAssessment> StartupPrograms() => [.. StartupOptimizeRecipe.Items(env).Select(StartupClassifier.Assess).OrderByDescending(a => a.Item.Enabled).ThenBy(a => a.Class == StartupClass.SAFE_TO_DISABLE ? 0 : a.Class == StartupClass.ASK ? 1 : 2).ThenBy(a => a.Item.Name, StringComparer.OrdinalIgnoreCase)];

    public async Task<RepairReport> SetStartupAsync(IEnumerable<StartupItem> items, bool enable, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(new { entries = items.Select(i => new { location = i.Location, name = i.Name }) }, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        return await RepairEngine.RunAsync(Recipes.All[enable ? "startup.enable" : "startup.disable"], Ctx(json), ct);
    }

    // ---- memory ------------------------------------------------------------------------------------------------
    MemoryGuard Guard() => new(source ?? new SystemProcessSource(null), actions ?? new SystemProcessActions());
    public MemoryView MemoryNow()
    {
        var (used, total) = (source ?? new SystemProcessSource(null)).Memory(); var c = ResourceHealth.Commit(); var r = ResourceHealth.Collect();
        return new(used, c?.percent, Math.Round(total / 1073741824.0, 1), r.TopCommit);
    }
    /// <summary>Gives back memory held by programs that are not in use. Nothing is closed. Measured, not estimated.</summary>
    public Task<MemoryRun> TrimMemoryAsync(CancellationToken ct) => Guard().RunAsync(CareRuntime.Policy.RamTargetPercent, ct, force: true);

    // ---- the whole picture from the service ----------------------------------------------------------------------
    /// <summary>This computer's full view (health, security, protection, heat, battery, updates, activity) as the service holds it. Null when the service is not running or not yet connected.</summary>
    public async Task<JsonElement?> SelfAsync(CancellationToken ct)
    {
        // Development only: VIRO_DEV_VIEW names a saved copy of the view, so the interface can be reviewed without the service.
        if (Environment.GetEnvironmentVariable("VIRO_DEV_VIEW") is { Length: > 0 } path && File.Exists(path)) { using var d = JsonDocument.Parse(await File.ReadAllTextAsync(path, ct)); return d.RootElement.Clone(); }
        return await LocalViewServer.ReadAsync(ct);
    }

    /// <summary>The finding fixes the person can run right here as themselves. Anything else is done by Autopilot or by their administrator, and the window says so.</summary>
    public static bool CanFixHere(string? recipe) => recipe is "memory.trim-idle" or "startup.optimize" or "cleanup.safe";

    /// <summary>Runs one approved recipe in this window. Machine-wide ones fail with a clear message unless the window runs as administrator.</summary>
    public async Task<RepairReport> RunRecipeAsync(string recipe, CancellationToken ct, string optionsJson = "{}")
    {
        if (!Recipes.All.TryGetValue(recipe, out var r)) throw new InvalidOperationException("unknown repair");
        return await RepairEngine.RunAsync(r, Ctx(optionsJson), ct);
    }

    // ---- undo ---------------------------------------------------------------------------------------------------
    public IReadOnlyList<UndoEntry> History()
    {
        var o = new List<UndoEntry>();
        if (!Directory.Exists(env.StateDir)) return o;
        foreach (var f in Directory.EnumerateFiles(env.StateDir, "*.json"))
        {
            try
            {
                using var d = JsonDocument.Parse(File.ReadAllText(f)); var r = d.RootElement; var recipe = r.GetProperty("recipe").GetString() ?? "";
                var n = r.TryGetProperty("state", out var st) && st.TryGetProperty("entries", out var e) && e.ValueKind == JsonValueKind.Array ? e.GetArrayLength() : 0;
                var title = Plain.TryGetValue(recipe, out var t) ? t : Recipes.All.TryGetValue(recipe, out var rc) ? rc.Title : recipe;
                o.Add(new(Path.GetFileNameWithoutExtension(f), recipe, title, r.GetProperty("createdAt").GetDateTime().ToLocalTime(), n > 0 ? $"{n} program{(n == 1 ? "" : "s")}" : ""));
            }
            catch (Exception ex) when (ex is JsonException or IOException or KeyNotFoundException or InvalidOperationException) { /* an unreadable record is simply not listed */ }
        }
        return [.. o.OrderByDescending(x => x.CreatedAt)];
    }

    public async Task<RepairReport> UndoAsync(string id, CancellationToken ct) => await RepairEngine.RollbackAsync(Recipes.All, id, Ctx(), ct);

    /// <summary>Plain-language one-liner for a cleanup result, including what was too new to delete.</summary>
    public static string Describe(IReadOnlyList<CategoryResult> r, bool ranReview)
    {
        var freed = r.Sum(x => x.BytesFreed); var recent = r.Where(x => x.Id != "recent-temp").Sum(x => x.RecentBytes); var skipped = r.Sum(x => x.Skipped);
        var s = $"Freed {Gb(freed)}.";
        if (skipped > 0) s += $" {skipped:N0} file{(skipped == 1 ? " was" : "s were")} in use and left alone.";
        if (!ranReview && recent > 50 * 1048576L) s += $" {Gb(recent)} more is temporary but too new to delete safely by default; choose \"Recent temporary files\" to include it.";
        return s;
    }
    public static string Gb(long bytes) => bytes >= 1073741824 ? $"{bytes / 1073741824.0:0.0} GB" : $"{bytes / 1048576.0:0} MB";
}
