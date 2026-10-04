using System.Text.Json;

namespace Viro.Agent.Care;

/// <summary>The weekly care run: refresh the plan, run every safe fix, and send the result to Viro so it can email the weekly report.</summary>
public static class Maintenance
{
    public static async Task<(bool Ok, string Message)> RunAsync(LocalActions act, AccountService account, CancellationToken ct)
    {
        await account.RefreshAsync(ct);
        if (!account.State().SignedIn) return (false, "Sign in to your Viro account in the Viro window first.");
        if (!account.Has("maintenance.scheduled")) return (false, "Scheduled care is part of Viro Care.");
        var r = await FixAll.RunAsync(act, ct);
        var body = new
        {
            machine = Environment.MachineName, version = Collectors.AgentVersion,
            before = new { freeBytes = r.Before.FreeBytes, memoryPercent = r.Before.MemoryPercent, startupItems = r.Before.StartupItems },
            after = new { freeBytes = r.After.FreeBytes, memoryPercent = r.After.MemoryPercent, startupItems = r.After.StartupItems },
            steps = r.Steps.Select(s => new { title = s.Title, applied = s.Applied, verified = s.Verified, summary = s.Summary.Length > 300 ? s.Summary[..300] : s.Summary }),
        };
        var (status, resp) = await account.SendAsync(HttpMethod.Post, "/api/v1/my-pc/maintenance-report", body, ct);
        var ok = status is >= 200 and < 300;
        return (ok, ok ? "Done. Your weekly report is on its way by email." : resp.TryGetProperty("error", out var e) ? e.GetString() ?? "The report could not be sent." : "The report could not be sent.");
    }
}
