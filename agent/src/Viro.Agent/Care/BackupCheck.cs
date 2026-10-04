namespace Viro.Agent.Care;

public sealed record BackupItem(string Name, string State, string Detail);          // State: ok | warn | bad | unknown
public sealed record BackupVerdict(string State, string Headline, IReadOnlyList<BackupItem> Items, IReadOnlyList<string> Advice, IReadOnlyList<string> Limits);

/// <summary>What is known about whether this PC's files are backed up, gathered in one place so the decision can be tested.</summary>
public sealed record BackupInputs(IReadOnlyDictionary<string, string> Folders, IReadOnlyList<string> OneDriveRoots, BackupFacts? Windows, DateTime? LastViroMoveAt, DateTime Now);

/// <summary>
/// Are the files that matter backed up? A folder counts as protected when it lives in OneDrive, or a Windows Backup or a Viro Move backup finished in the last 30 days.
/// It cannot see File History or other companies' backup programs, and it never claims a backup can be restored: it says what it could and could not see.
/// </summary>
public static class BackupCheck
{
    public static readonly TimeSpan Fresh = TimeSpan.FromDays(30);

    public static bool InOneDrive(string folder, IEnumerable<string> roots) =>
        roots.Any(r => r.Length > 3 && folder.TrimEnd('\\').StartsWith(r.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase));

    public static BackupVerdict Evaluate(BackupInputs i)
    {
        var items = new List<BackupItem>(); var covered = new List<string>(); var open = new List<string>();
        var winOk = i.Windows?.LastWindowsBackupAt is { } w && i.Now - w < Fresh; var moveOk = i.LastViroMoveAt is { } m && i.Now - m < Fresh;
        foreach (var (name, path) in i.Folders)
        {
            if (!Directory.Exists(path)) continue;
            var onedrive = InOneDrive(path, i.OneDriveRoots);
            if (onedrive) { items.Add(new(name, "ok", "Saved to OneDrive as you work.")); covered.Add(name); }
            else if (winOk || moveOk) { items.Add(new(name, "ok", moveOk && !winOk ? "Included in a recent Viro Move backup." : "Covered by a recent Windows Backup.")); covered.Add(name); }
            else { items.Add(new(name, "bad", "No recent backup of this folder that Viro can see.")); open.Add(name); }
        }
        if (i.Windows?.LastWindowsBackupAt is { } last) items.Add(new("Windows Backup", winOk ? "ok" : "warn", $"Last finished {(int)(i.Now - last).TotalDays} days ago."));
        else items.Add(new("Windows Backup", "unknown", "No finished Windows Backup was found."));
        if (i.Windows?.LastWindowsBackupFailureAt is { } bad && (i.Windows.LastWindowsBackupAt is null || bad > i.Windows.LastWindowsBackupAt)) items.Add(new("Windows Backup problem", "bad", $"The last attempt failed {(int)(i.Now - bad).TotalDays} days ago."));
        items.Add(new("Viro Move backup", i.LastViroMoveAt is null ? "unknown" : moveOk ? "ok" : "warn", i.LastViroMoveAt is { } mv ? $"Last backed up {(int)(i.Now - mv).TotalDays} days ago." : "You have not made one."));
        if (i.Windows?.NewestRestorePointAt is { } rp) items.Add(new("System restore point", "ok", $"Newest is {(int)(i.Now - rp).TotalDays} days old. A restore point protects Windows, not your files."));

        var state = open.Count == 0 && covered.Count > 0 ? "protected" : covered.Count > 0 ? "partial" : "none";
        var head = state switch { "protected" => "Your files are backed up", "partial" => $"Only some of your files are backed up: {string.Join(", ", open)} are not", _ => "Your files are not backed up" };
        var advice = new List<string>();
        if (open.Count > 0) { advice.Add("Make a Viro Move backup of these folders: it is encrypted, and it is what you restore on a new PC."); advice.Add("Or turn on OneDrive folder backup (OneDrive settings, Sync and backup) for Documents, Desktop and Pictures."); }
        if (i.Windows?.LastWindowsBackupFailureAt is not null && !winOk) advice.Add("Windows Backup is failing. Open Settings, Accounts, Windows backup to see why.");
        return new(state, head, items, advice, ["Viro cannot see File History or other companies' backup programs, so it may say a folder is not backed up when one of those protects it.", "A backup that was made is not proof that it can be restored. Try restoring one file now and then."]);
    }

    /// <summary>Reads this PC: the user's folders, OneDrive locations, and what Windows records about its own backup.</summary>
    public static BackupInputs Read(DateTime? lastViroMove)
    {
        var folders = new Dictionary<string, string>
        {
            ["Documents"] = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), ["Desktop"] = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), ["Pictures"] = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
        };
        var roots = new[] { "OneDrive", "OneDriveConsumer", "OneDriveCommercial" }.Select(n => Environment.GetEnvironmentVariable(n)).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).ToList();
        return new(folders, roots, BackupCollector.Collect(), lastViroMove, DateTime.UtcNow);
    }
}
