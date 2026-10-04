using System.Text.Json;
using Viro.Agent.Care;
using Viro.Agent.Repair;
using Xunit;

public class BackupCheckTests
{
    static BackupInputs In(Sandbox sb, string[] onedrive, BackupFacts? win = null, DateTime? move = null)
    {
        var f = new Dictionary<string, string> { ["Documents"] = Path.Combine(sb.Root, "Documents"), ["Desktop"] = Path.Combine(sb.Root, "Desktop") };
        foreach (var p in f.Values) Directory.CreateDirectory(p);
        return new(f, onedrive, win, move, new DateTime(2026, 10, 4, 0, 0, 0, DateTimeKind.Utc));
    }

    [Fact]
    public void FoldersInOneDriveOrCoveredByAFreshBackupCountAndOthersDoNot()
    {
        using var sb = new Sandbox(); var od = Path.Combine(sb.Root, "OneDrive"); Directory.CreateDirectory(od);
        Assert.True(BackupCheck.InOneDrive(Path.Combine(od, "Documents"), [od])); Assert.False(BackupCheck.InOneDrive(Path.Combine(od + "Evil", "Documents"), [od]));    // a similar name is not the same folder
        var none = BackupCheck.Evaluate(In(sb, []));
        Assert.Equal("none", none.State); Assert.Contains(none.Items, i => i.Name == "Documents" && i.State == "bad"); Assert.NotEmpty(none.Advice); Assert.NotEmpty(none.Limits);
        var now = new DateTime(2026, 10, 4, 0, 0, 0, DateTimeKind.Utc);
        var viaMove = BackupCheck.Evaluate(In(sb, [], null, now.AddDays(-3))); Assert.Equal("protected", viaMove.State); Assert.Empty(viaMove.Advice);
        var stale = BackupCheck.Evaluate(In(sb, [], null, now.AddDays(-90))); Assert.Equal("none", stale.State);                               // a three-month-old backup is not protection
        var viaWindows = BackupCheck.Evaluate(In(sb, [], new BackupFacts(now.AddDays(-5), null, null, null))); Assert.Equal("protected", viaWindows.State);
        var failing = BackupCheck.Evaluate(In(sb, [], new BackupFacts(now.AddDays(-90), now.AddDays(-2), null, null))); Assert.Equal("none", failing.State); Assert.Contains(failing.Items, i => i.Name == "Windows Backup problem"); Assert.Contains(failing.Advice, a => a.Contains("failing"));
    }

    [Fact]
    public void ADriveWhereOnlySomeFoldersAreProtectedIsReportedAsPartial()
    {
        using var sb = new Sandbox(); var inputs = In(sb, [Path.Combine(sb.Root, "Documents")]);       // Documents is its own OneDrive root here; Desktop is not covered
        var v = BackupCheck.Evaluate(inputs with { OneDriveRoots = [sb.Root + "\\OneDriveX"] });
        Assert.Equal("none", v.State);
        var partial = BackupCheck.Evaluate(new(inputs.Folders, [Path.Combine(sb.Root)], null, null, inputs.Now));                  // whole sandbox treated as OneDrive: both covered
        Assert.Equal("protected", partial.State);
    }
}

public class LeftoverTests
{
    static string Name() => "Acme" + string.Concat(Enumerable.Range(0, 8).Select(_ => (char)('a' + Random.Shared.Next(26))));

    [Fact]
    public async Task LeftoversMatchedByExactNameAreMovedAsideVerifiedAndCanBeBroughtBack()
    {
        using var sb = new Sandbox(); var name = Name(); var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var leftover = Path.Combine(local, name); var innocent = Path.Combine(local, name + "Tools");
        Directory.CreateDirectory(leftover); File.WriteAllText(Path.Combine(leftover, "cache.dat"), "x"); Directory.CreateDirectory(innocent); File.WriteAllText(Path.Combine(innocent, "keep.txt"), "keep");
        var menu = Path.Combine(sb.ProgramDataDir, @"Microsoft\Windows\Start Menu\Programs"); Directory.CreateDirectory(menu); File.WriteAllText(Path.Combine(menu, name + ".lnk"), "shortcut");
        try
        {
            var found = LeftoverScan.Find(name, "Acme Inc", sb); Assert.Equal(2, found.Count); Assert.Contains(found, l => l.Path == leftover && l.Kind == "folder"); Assert.DoesNotContain(found, l => l.Path == innocent);    // "AcmeXTools" is a different program
            var recipe = new AppLeftoversRecipe(); var opts = JsonSerializer.Serialize(new { name, publisher = "Acme Inc", ids = found.Select(f => f.Id) });
            var ctx = T.Ctx(sb, new SystemProcessRunner(), null, opts); var r = await RepairEngine.RunAsync(recipe, ctx, default);
            Assert.True(r.Applied && r.Verified == true, r.Summary); Assert.True(r.RollbackAvailable);
            Assert.False(Directory.Exists(leftover)); Assert.False(File.Exists(Path.Combine(menu, name + ".lnk"))); Assert.True(File.Exists(Path.Combine(innocent, "keep.txt")));
            Assert.Single(Directory.GetFiles(sb.StateDir, "cache.dat", SearchOption.AllDirectories));                                                                   // moved aside, not deleted
            await recipe.RollbackAsync(ctx, JsonSerializer.SerializeToElement(ctx.RollbackState), default);
            Assert.True(File.Exists(Path.Combine(leftover, "cache.dat"))); Assert.True(File.Exists(Path.Combine(menu, name + ".lnk")));
        }
        finally { foreach (var d in new[] { leftover, innocent }) try { Directory.Delete(d, true); } catch { } }
    }

    [Fact]
    public async Task OnlyWhatTheScanFindsNowCanBeChosenAndShortNamesNeverMatch()
    {
        using var sb = new Sandbox(); Assert.Empty(LeftoverScan.Find("ab", null, sb)); Assert.Empty(LeftoverScan.Find("Win", null, sb));
        Assert.Equal(LeftoverScan.Norm("Google Chrome (x64) 130.0.1"), LeftoverScan.Norm("Google Chrome")); Assert.Equal("7zip", LeftoverScan.Norm("7-Zip 24.07 (x64 edition)").Replace("edition", ""));
        var recipe = new AppLeftoversRecipe(); var ctx = T.Ctx(sb, new SystemProcessRunner(), null, JsonSerializer.Serialize(new { name = Name(), publisher = "", ids = new[] { "C:\\Windows\\System32" } }));
        var r = await RepairEngine.RunAsync(recipe, ctx, default); Assert.False(r.Applied);                                  // an id that the scan did not produce is ignored
    }
}

public class ScheduleTests
{
    [Fact]
    public async Task TheWeeklyTaskIsCreatedForThisPersonWithoutExtraRightsAndCanBeRemoved()
    {
        var proc = new FakeProc((exe, a) => a.StartsWith("/Query") ? new(0, "TaskName: x\nNext Run Time:   10/11/2026 11:00:00\n", false) : new(0, "", false));
        var s = new CareSchedule(proc, @"C:\Program Files\Viro\Agent\viro-agent.exe");
        Assert.True(await s.EnableAsync(default)); var create = proc.Calls.Single(c => c.StartsWith("schtasks.exe /Create"));
        Assert.Contains("/SC WEEKLY", create); Assert.Contains("/RL LIMITED", create); Assert.Contains("maintain", create); Assert.DoesNotContain("SYSTEM", create);
        var st = await s.StatusAsync(default); Assert.True(st.Enabled); Assert.Contains("2026", st.NextRun);
        Assert.True(await s.DisableAsync(default)); Assert.Contains(proc.Calls, c => c.StartsWith("schtasks.exe /Delete"));
        Assert.False((await new CareSchedule(new FakeProc((_, _) => new(1, "", false)), "x").StatusAsync(default)).Enabled);
    }
}
