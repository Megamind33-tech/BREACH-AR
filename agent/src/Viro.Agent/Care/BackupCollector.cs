using System.Diagnostics.Eventing.Reader;
using System.Management;

namespace Viro.Agent.Care;

/// <summary>
/// What Windows itself knows about backups of this PC: the last successful Windows Backup and the newest restore point. It does not look for third-party
/// backup products (it cannot know whether they succeeded) and it does not verify that a backup can be restored. Anything it cannot read is null.
/// </summary>
public sealed record BackupFacts(DateTime? LastWindowsBackupAt, DateTime? LastWindowsBackupFailureAt, DateTime? NewestRestorePointAt, int? RestorePoints);

public static class BackupCollector
{
    const string Log = "Microsoft-Windows-Backup";

    public static BackupFacts? Collect()
    {
        DateTime? Last(string ids)
        {
            try
            {
                using var r = new EventLogReader(new EventLogQuery(Log, PathType.LogName, $"*[System[({ids})]]") { ReverseDirection = true });
                using var ev = r.ReadEvent(); return ev?.TimeCreated?.ToUniversalTime();
            }
            catch (Exception e) when (e is EventLogException or UnauthorizedAccessException or InvalidOperationException) { return null; }
        }
        DateTime? newest = null; int? count = null;
        try
        {
            using var s = new ManagementObjectSearcher("SELECT InstallDate FROM Win32_ShadowCopy");
            var dates = s.Get().Cast<ManagementBaseObject>().Select(m => m["InstallDate"] as string).Where(x => x is { Length: >= 14 }).Select(x => ManagementDateTimeConverter.ToDateTime(x!).ToUniversalTime()).ToList();
            count = dates.Count; newest = dates.Count > 0 ? dates.Max() : null;
        }
        catch { /* needs administrator rights */ }
        var ok = Last("EventID=4"); var failed = Last("EventID=5 or EventID=9 or EventID=517 or EventID=521");
        return ok is null && failed is null && count is null ? null : new(ok, failed, newest, count);
    }
}
