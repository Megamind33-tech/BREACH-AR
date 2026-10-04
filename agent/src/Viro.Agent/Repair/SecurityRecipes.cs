using System.Text.Json;

namespace Viro.Agent.Repair;

/// <summary>
/// Approved security-remediation recipes. They are fixed procedures that restore a validated Windows configuration; none of them runs a
/// command built from detection data, and none deletes a file. Each records what it changed so it can be undone, then verifies by reading
/// the system again. All need an administrator's approval because each can also be how an organization legitimately configures its PCs.
/// </summary>
public static class SecurityRecipeSet
{
    public static IEnumerable<IRepairRecipe> Create(ISecurityState? state = null) => [new RestoreProxyRecipe(state), new RestoreDnsRecipe(state), new RestoreHostsRecipe(state), new RestoreDefenderPolicyRecipe(state), new RemovePersistenceRecipe(state), new BlockExtensionRecipe(state)];
}

public abstract class SecurityRecipe(string id, string title, string kind, ISecurityState? state) : IRepairRecipe
{
    protected readonly ISecurityState S = state ?? new WindowsSecurityState();
    public string Id => id; public string Title => title; public RepairRisk Risk => RepairRisk.Review;
    public bool AutoSafe => false; public bool Reversible => true;

    protected static List<string> ThreatPaths(RepairContext c) =>
        c.Options.ValueKind == JsonValueKind.Object && c.Options.TryGetProperty("threatPaths", out var t) && t.ValueKind == JsonValueKind.Array ? t.EnumerateArray().Select(x => x.GetString() ?? "").ToList() : [];
    protected List<SecFinding> Mine(RepairContext c) => SecurityAnalysis.Analyze(S.Read(), ThreatPaths(c)).Where(f => f.Recipe == id).ToList();

    public virtual Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var f = Mine(c);
        return Task.FromResult(new Finding(f.Count > 0, f.Count == 0 ? $"no {kind} problem was found" : string.Join(" | ", f.Select(x => x.Evidence)), f));
    }
    public abstract Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct);
    public virtual Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var left = Mine(c); c.After = new { remaining = left.Count };
        return Task.FromResult((left.Count == 0, left.Count == 0 ? $"a fresh check finds no {kind} problem" : $"{left.Count} {kind} problem(s) remain"));
    }
    public abstract Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct);
}

public sealed class RestoreProxyRecipe(ISecurityState? state = null) : SecurityRecipe("security.restore-proxy", "Remove an unexpected web proxy setting", "proxy", state)
{
    public override Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var scopes = ((List<SecFinding>)f.Before!).Select(x => x.Location).Distinct().ToList();
        c.RollbackState["proxies"] = scopes.Select(s => S.RawProxy(s)).Where(p => p is not null).ToList();
        foreach (var s in scopes) S.ClearProxy(s);
        return Task.CompletedTask;
    }
    public override Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        foreach (var p in saved.GetProperty("proxies").EnumerateArray()) S.SetProxy(new(p.GetProperty("scope").GetString()!, p.GetProperty("enabled").GetBoolean(), p.GetProperty("server").GetString(), p.GetProperty("autoConfigUrl").GetString()));
        return Task.CompletedTask;
    }
}

public sealed class RestoreDnsRecipe(ISecurityState? state = null) : SecurityRecipe("security.restore-dns", "Return DNS to automatic (from the network) on adapters with unexpected fixed servers", "DNS", state)
{
    public override Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var adapters = ((List<SecFinding>)f.Before!).Select(x => x.Location).Distinct().ToList();
        var now = S.Read().Dns;
        c.RollbackState["dns"] = adapters.Select(a => new { adapter = a, servers = now.FirstOrDefault(d => d.Adapter == a)?.Servers ?? [] }).ToList();
        foreach (var a in adapters) S.SetDnsAutomatic(a);
        return Task.CompletedTask;
    }
    public override Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        foreach (var d in saved.GetProperty("dns").EnumerateArray()) { var s = d.GetProperty("servers").EnumerateArray().Select(x => x.GetString()!).ToArray(); if (s.Length > 0) S.SetDns(d.GetProperty("adapter").GetString()!, s); }
        return Task.CompletedTask;
    }
}

public sealed class RestoreHostsRecipe(ISecurityState? state = null) : SecurityRecipe("security.restore-hosts", "Remove hosts-file entries that redirect or block update and security addresses", "hosts-file", state)
{
    public override Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var bad = ((List<SecFinding>)f.Before!).Select(x => x.Name).ToHashSet();
        var original = S.Read().Hosts; c.RollbackState["hosts"] = original;
        S.WriteHosts(original.Where(l => !bad.Contains(l.Trim())));      // only the flagged lines are dropped; comments and other entries are kept
        return Task.CompletedTask;
    }
    public override Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct) { S.WriteHosts(saved.GetProperty("hosts").EnumerateArray().Select(x => x.GetString() ?? "")); return Task.CompletedTask; }
}

public sealed class RestoreDefenderPolicyRecipe(ISecurityState? state = null) : SecurityRecipe("security.restore-defender-policy", "Remove a policy that turns Microsoft Defender protection off", "Defender policy", state)
{
    public override Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var names = ((List<SecFinding>)f.Before!).Select(x => x.Name).Distinct().ToList();
        c.RollbackState["values"] = names;
        foreach (var n in names) S.DeletePolicyValue(n);
        return Task.CompletedTask;
    }
    public override Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        foreach (var n in saved.GetProperty("values").EnumerateArray().Select(x => x.GetString()!).Where(n => n is "DisableAntiSpyware" or "DisableRealtimeMonitoring")) S.SetPolicyValue(n, 1);
        return Task.CompletedTask;
    }
}

/// <summary>Stops a browser extension that hijacks search or the home page, by adding it to the browser's own policy blocklist (Chrome and Edge remove it and do not reinstall it). No file is deleted; removing the policy entry undoes it.</summary>
public sealed class BlockExtensionRecipe(ISecurityState? state = null) : SecurityRecipe("privacy.block-extension", "Block a browser extension that takes over search or the home page", "browser extension", state)
{
    static HashSet<(string loc, string name)>? Named(RepairContext c)
    {
        if (c.Options.ValueKind != JsonValueKind.Object || !c.Options.TryGetProperty("entries", out var e) || e.ValueKind != JsonValueKind.Array) return null;
        return [.. e.EnumerateArray().Select(x => (x.GetProperty("location").GetString() ?? "", x.GetProperty("name").GetString() ?? ""))];
    }
    public override Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var named = Named(c); var f = Mine(c).Where(x => named is null || named.Contains((x.Location, x.Name))).ToList();
        return Task.FromResult(new Finding(f.Count > 0, f.Count == 0 ? "no extension is taking over search or the home page" : string.Join(" | ", f.Select(x => x.Evidence)), f));
    }
    public override Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var done = new List<object>();
        foreach (var x in (List<SecFinding>)f.Before!) { if (x.Location is not ("chrome" or "edge") || !System.Text.RegularExpressions.Regex.IsMatch(x.Name, "^[a-p]{32}$")) continue; done.Add(new { browser = x.Location, valueName = S.BlockExtension(x.Location, x.Name), id = x.Name }); }
        if (done.Count == 0) throw new InvalidOperationException("no valid extension was named");
        c.RollbackState["blocked"] = done; return Task.CompletedTask;
    }
    public override Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var named = Named(c); var left = Mine(c).Where(x => named is null || named.Contains((x.Location, x.Name))).ToList(); c.After = new { remaining = left.Count };
        return Task.FromResult((left.Count == 0, left.Count == 0 ? "the browser policy now blocks it; it is removed the next time the browser starts" : $"{left.Count} extension(s) are not yet blocked"));
    }
    public override Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        foreach (var b in saved.GetProperty("blocked").EnumerateArray()) S.UnblockExtension(b.GetProperty("browser").GetString()!, b.GetProperty("valueName").GetString()!);
        return Task.CompletedTask;
    }
}

/// <summary>
/// Removes a startup entry or scheduled task, but only one that a Defender detection links to (the path Defender reported appears in its command)
/// and that the administrator named. "It looks unfamiliar" is never enough.
/// </summary>
public sealed class RemovePersistenceRecipe(ISecurityState? state = null) : SecurityRecipe("security.remove-persistence", "Remove startup entries and scheduled tasks that launch a detected threat", "persistence", state)
{
    static HashSet<(string loc, string name)>? Named(RepairContext c)
    {
        if (c.Options.ValueKind != JsonValueKind.Object || !c.Options.TryGetProperty("entries", out var e) || e.ValueKind != JsonValueKind.Array) return null;
        return [.. e.EnumerateArray().Select(x => (x.GetProperty("location").GetString() ?? "", x.GetProperty("name").GetString() ?? ""))];
    }
    public override Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var named = Named(c); var all = Mine(c);
        var f = all.Where(x => named is null || named.Contains((x.Location, x.Name))).ToList();
        return Task.FromResult(new Finding(f.Count > 0, f.Count == 0 ? (ThreatPaths(c).Count == 0 ? "no detected-threat path was supplied, so nothing qualifies for removal" : "no startup entry or task launches a detected threat") : string.Join(" | ", f.Select(x => x.Evidence)), f));
    }
    public override Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var named = Named(c); var left = Mine(c).Where(x => named is null || named.Contains((x.Location, x.Name))).ToList();   // only what was asked for is judged
        c.After = new { remaining = left.Count };
        return Task.FromResult((left.Count == 0, left.Count == 0 ? "a fresh check finds the named entries gone" : $"{left.Count} persistence entry(ies) remain"));
    }
    public override Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var saved = new List<object>();
        foreach (var x in (List<SecFinding>)f.Before!)
        {
            if (x.Kind == "startup-entry") { var cmd = S.Read().Run.FirstOrDefault(r => r.Location == x.Location && r.Name == x.Name)?.Command; if (cmd is null) continue; saved.Add(new { kind = x.Kind, location = x.Location, name = x.Name, data = cmd }); S.RemoveRunEntry(x.Location, x.Name); }
            else if (x.Kind == "scheduled-task") { var xml = S.TaskXml(x.Name); if (xml is null) continue; saved.Add(new { kind = x.Kind, location = x.Location, name = x.Name, data = xml }); S.RemoveTask(x.Name); }
        }
        if (saved.Count == 0) throw new InvalidOperationException("the entries could not be read, so nothing was removed");
        c.RollbackState["removed"] = saved; return Task.CompletedTask;
    }
    public override Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        foreach (var r in saved.GetProperty("removed").EnumerateArray())
        { var data = r.GetProperty("data").GetString()!; if (r.GetProperty("kind").GetString() == "startup-entry") S.SetRunEntry(r.GetProperty("location").GetString()!, r.GetProperty("name").GetString()!, data); else S.RestoreTask(r.GetProperty("name").GetString()!, data); }
        return Task.CompletedTask;
    }
}
