using System.Management;
using System.Security.Cryptography;
using System.Text.Json;

namespace Viro.Agent.Care;

/// <summary>
/// Takes a file out of the Startup folders so it can no longer run, without destroying it: it is moved (not deleted) into Viro's protected quarantine with its hash and
/// original location recorded, the move is verified, and it can be put back. Keeping the file preserves the evidence (what it did, where else it spread) and lets a person
/// make the final, irreversible decision. It can only act on files directly inside the Startup folders.
/// </summary>
public static class StartupQuarantine
{
    sealed record Meta(string Id, string Name, string Scope, string OriginalPath, string Sha256, long SizeBytes, string QuarantinedAt, string? JobId);
    static string DefaultRoot => Path.Combine(AgentConfig.DataDir, "quarantine");

    public static object Quarantine(string name, string? jobId, IEnumerable<(string Scope, string Dir)>? folders = null, string? root = null)
    {
        if (string.IsNullOrWhiteSpace(name) || Path.GetFileName(name) != name || name.Contains(':')) throw new ArgumentException("A file name inside a Startup folder is required, not a path.");
        root ??= DefaultRoot; var moved = new List<object>(); var failed = new List<object>(); var found = 0;
        foreach (var (scope, dir) in folders ?? StartupInspector.DefaultFolders())
        {
            var path = Path.Combine(dir, name); if (!File.Exists(path)) continue; found++;
            try
            {
                var sha = Hash(path); var size = new FileInfo(path).Length; var id = $"{DateTime.UtcNow:yyyyMMddHHmmss}-{sha[..8]}-{found}"; var qdir = Path.Combine(root, id); Directory.CreateDirectory(qdir);
                var target = Path.Combine(qdir, name + ".quarantined");
                File.Move(path, target);
                var ok = !File.Exists(path) && File.Exists(target) && Hash(target) == sha;
                if (!ok) { failed.Add(new { scope, file = name, reason = "The move could not be verified." }); continue; }
                File.WriteAllText(Path.Combine(qdir, "meta.json"), JsonSerializer.Serialize(new Meta(id, name, scope, path, sha, size, DateTime.UtcNow.ToString("O"), jobId)));
                File.SetAttributes(target, FileAttributes.ReadOnly);
                moved.Add(new { id, scope, originalPath = path, quarantinedTo = target, sha256 = sha, sizeBytes = size, verified = true });
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { failed.Add(new { scope, file = name, reason = e.Message }); }
        }
        return new { moved, failed, foundInFolders = found, runningNow = RunningNow(name),
            note = found == 0 ? "No file with that name is in a Startup folder." : "The file was moved, not deleted: it can no longer start with Windows, and it can be restored. A copy already running keeps running until the computer restarts. Run a full antivirus scan next." };
    }

    public static object Restore(string id, IEnumerable<(string Scope, string Dir)>? folders = null, string? root = null)
    {
        root ??= DefaultRoot; if (string.IsNullOrWhiteSpace(id) || id.Any(c => !(char.IsLetterOrDigit(c) || c == '-'))) throw new ArgumentException("Invalid quarantine id.");
        var qdir = Path.Combine(root, id); var metaPath = Path.Combine(qdir, "meta.json"); if (!File.Exists(metaPath)) return new { restored = false, reason = "That quarantine record was not found." };
        var m = JsonSerializer.Deserialize<Meta>(File.ReadAllText(metaPath))!; var allowed = (folders ?? StartupInspector.DefaultFolders()).Select(f => Path.GetFullPath(f.Dir)).ToList();
        var dest = Path.GetFullPath(m.OriginalPath); if (!allowed.Contains(Path.GetDirectoryName(dest)!, StringComparer.OrdinalIgnoreCase)) return new { restored = false, reason = "The original location is not a Startup folder, so it will not be restored there." };
        if (File.Exists(dest)) return new { restored = false, reason = "A file with that name already exists at the original location." };
        var src = Path.Combine(qdir, m.Name + ".quarantined"); File.SetAttributes(src, FileAttributes.Normal); File.Move(src, dest);
        var ok = File.Exists(dest) && Hash(dest) == m.Sha256; if (ok) { File.Delete(metaPath); try { Directory.Delete(qdir); } catch (IOException) { } }
        return new { restored = ok, restoredTo = dest, sha256 = m.Sha256 };
    }

    public static object List(string? root = null)
    {
        root ??= DefaultRoot; var items = new List<object>(); if (Directory.Exists(root)) foreach (var d in Directory.EnumerateDirectories(root)) { var p = Path.Combine(d, "meta.json"); if (File.Exists(p)) { try { items.Add(JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(p))); } catch (JsonException) { } } }
        return new { items };
    }

    static string Hash(string path) { using var s = File.OpenRead(path); return Convert.ToHexString(SHA256.HashData(s)).ToLowerInvariant(); }

    /// <summary>Command shells and script hosts whose command line names the file, so a person knows whether it is running right now. Read-only: nothing is stopped.</summary>
    static List<object> RunningNow(string name)
    {
        var o = new List<object>();
        try { using var s = new ManagementObjectSearcher("SELECT ProcessId,Name,CommandLine FROM Win32_Process WHERE CommandLine LIKE '%" + name.Replace("'", "''").Replace("%", "[%]") + "%'"); foreach (ManagementObject m in s.Get()) o.Add(new { pid = Convert.ToInt32(m["ProcessId"]), name = m["Name"]?.ToString(), commandLine = (m["CommandLine"]?.ToString() ?? "").Length > 300 ? m["CommandLine"]!.ToString()![..300] : m["CommandLine"]?.ToString() }); }
        catch (ManagementException) { }
        return o;
    }
}

public sealed class StartupQuarantineHandler : IJobHandler
{
    public string Type => "startup.quarantine";
    public Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct) => Task.Run(() =>
    {
        var name = ctx.Job.Params.GetProperty("name").GetString()!; var r = StartupQuarantine.Quarantine(name, ctx.Job.Id);
        var json = JsonSerializer.SerializeToElement(r); var moved = json.GetProperty("moved").GetArrayLength(); var failed = json.GetProperty("failed").GetArrayLength();
        return new JobOutcome(moved > 0 && failed == 0, r, moved == 0 ? (failed > 0 ? "The file could not be moved." : "No file with that name is in a Startup folder.") : failed > 0 ? "Some copies could not be moved." : null);
    }, ct);
}
public sealed class StartupRestoreHandler : IJobHandler
{
    public string Type => "startup.restore";
    public Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct) => Task.Run(() =>
    {
        var r = StartupQuarantine.Restore(ctx.Job.Params.GetProperty("id").GetString()!); var ok = JsonSerializer.SerializeToElement(r).GetProperty("restored").GetBoolean();
        return new JobOutcome(ok, r, ok ? null : "The file was not restored.");
    }, ct);
}
