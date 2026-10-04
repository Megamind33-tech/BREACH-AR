using System.Text.Json;

namespace Viro.Agent.Repair;

public enum RepairRisk { Safe, Review }

public sealed record Finding(bool Needed, string Detail, object? Before = null);
public sealed record Step(string Name, bool Ok, string Detail);
public sealed record RepairReport(
    string RepairId, string Recipe, string Title, bool Needed, bool Applied, bool? Verified, bool RolledBack, bool RollbackAvailable,
    bool RebootRequired, string Summary, IReadOnlyList<Step> Steps, object? Before, object? After);

public sealed class RepairContext(RepairEnv env, IProcessRunner proc, IServices services, ILogger log, JsonElement options)
{
    public RepairEnv Env { get; } = env;
    public IProcessRunner Proc { get; } = proc;
    public IServices Services { get; } = services;
    public ILogger Log { get; } = log;
    public JsonElement Options { get; } = options;
    /// <summary>Whatever the recipe records here is persisted before the change so it can be undone later.</summary>
    public Dictionary<string, object?> RollbackState { get; } = [];
    public bool RebootRequired { get; set; }
    public object? After { get; set; }
    public bool Force => Options.ValueKind == JsonValueKind.Object && Options.TryGetProperty("force", out var f) && f.ValueKind == JsonValueKind.True;
}

public interface IRepairRecipe
{
    string Id { get; }
    string Title { get; }
    RepairRisk Risk { get; }
    /// <summary>Eligible for the one-click "Fix my PC" pass (diagnosed first; applied only if a problem is found).</summary>
    bool AutoSafe { get; }
    bool Reversible { get; }
    Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct);
    Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct);
    Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct);
    Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct);
}

/// <summary>
/// The pipeline every repair goes through: diagnose first; record current state; make the smallest change; verify;
/// on failed verification undo it if the recipe is reversible; report every step.
/// </summary>
public static class RepairEngine
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static async Task<RepairReport> RunAsync(IRepairRecipe r, RepairContext c, CancellationToken ct)
    {
        var id = Guid.NewGuid().ToString();
        var steps = new List<Step>();
        Finding f = new(false, "not diagnosed");
        try { f = await r.DiagnoseAsync(c, ct); }
        catch (OperationCanceledException) { throw; }
        catch (RepairDeferredException d) { steps.Add(new("diagnose", true, d.Message)); return Report(true, false, null, false, "Deferred: " + d.Message); }   // appropriate, but not now; nothing was changed
        catch (Exception e) { steps.Add(new("diagnose", false, e.Message)); return Report(false, false, null, false, $"Diagnosis failed: {e.Message}"); }
        steps.Add(new("diagnose", true, f.Detail));
        if (!f.Needed && !c.Force) return Report(false, false, null, false, "No action needed: " + f.Detail);

        try
        {
            await r.ApplyAsync(c, f, ct);
            steps.Add(new("apply", true, "change applied"));
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception e)
        {
            steps.Add(new("apply", false, e.Message));
            var undone = await TryRollback($"apply failed ({e.Message})");
            return Report(true, false, false, undone, $"Repair failed while applying: {e.Message}");
        }
        Persist(c, r, id);

        (bool ok, string detail) v;
        try { v = await r.VerifyAsync(c, f, ct); }
        catch (OperationCanceledException) { throw; }
        catch (Exception e) { v = (false, e.Message); }
        steps.Add(new("verify", v.ok, v.detail));
        if (v.ok) return Report(true, true, true, false, "Repaired and verified: " + v.detail);
        var rolled = await TryRollback("verification failed");
        return Report(true, true, false, rolled, "Change was applied but could not be verified: " + v.detail + (rolled ? " (rolled back)" : ""));

        async Task<bool> TryRollback(string why)
        {
            if (!r.Reversible || c.RollbackState.Count == 0) { steps.Add(new("rollback", false, "not available for this repair")); return false; }
            try { await r.RollbackAsync(c, JsonSerializer.SerializeToElement(c.RollbackState, Json), ct); steps.Add(new("rollback", true, "undone because " + why)); DeleteState(c, id); return true; }
            catch (Exception e) { steps.Add(new("rollback", false, e.Message)); return false; }
        }
        RepairReport Report(bool needed, bool applied, bool? verified, bool rolled, string summary) =>
            new(id, r.Id, r.Title, needed, applied, verified, rolled, applied && r.Reversible && !rolled && c.RollbackState.Count > 0, c.RebootRequired, summary, steps, f.Before, c.After);
    }

    // ---- rollback state persisted on the device so an administrator can undo later --------------------------------
    static string StatePath(RepairContext c, string id) => Path.Combine(c.Env.StateDir, id + ".json");

    static void Persist(RepairContext c, IRepairRecipe r, string id)
    {
        if (!r.Reversible || c.RollbackState.Count == 0) return;
        Directory.CreateDirectory(c.Env.StateDir);
        File.WriteAllText(StatePath(c, id), JsonSerializer.Serialize(new { recipe = r.Id, createdAt = DateTime.UtcNow, state = c.RollbackState }, Json));
    }
    static void DeleteState(RepairContext c, string id) { try { File.Delete(StatePath(c, id)); } catch { } }

    public static async Task<RepairReport> RollbackAsync(IReadOnlyDictionary<string, IRepairRecipe> recipes, string repairId, RepairContext c, CancellationToken ct)
    {
        if (!Guid.TryParse(repairId, out _)) throw new ArgumentException("invalid repair id");
        var path = StatePath(c, repairId);
        if (!File.Exists(path)) throw new InvalidOperationException("no rollback information exists for this repair (already rolled back, not reversible, or made on another device)");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var recipe = recipes[doc.RootElement.GetProperty("recipe").GetString()!];
        await recipe.RollbackAsync(c, doc.RootElement.GetProperty("state").Clone(), ct);
        File.Delete(path);
        return new(repairId, recipe.Id, recipe.Title, true, false, null, true, false, c.RebootRequired, "Rolled back: " + recipe.Title,
            [new("rollback", true, "previous state restored")], null, null);
    }
}
