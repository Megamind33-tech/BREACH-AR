using System.Text.Json;
using Viro.Agent.Care;
using Viro.Agent.Repair;
using Xunit;

sealed class FakeCatalog(params AppEntry[] entries) : IAppCatalog
{
    public readonly Dictionary<string, AppEntry> Items = entries.ToDictionary(e => e.Hive + "|" + e.Key);
    public AppEntry? Find(string hive, string key) => Items.GetValueOrDefault(hive + "|" + key);
    public void DeleteRegistration(string hive, string key) => Items.Remove(hive + "|" + key);
}

public class AppUninstallTests
{
    const string Guid1 = "{12345678-1234-1234-1234-123456789012}";
    static AppEntry App(string key, string name, string hive = "HKCU", string kind = "other", string? loc = null, string? un = null, string pub = "Acme") =>
        new(key, hive, name, "1.0", pub, kind, loc, un, null, 1024L * 1024 * 50, null, false, null);
    static string Opts(string kind, string id, string hive = "HKCU", bool forced = false) => JsonSerializer.Serialize(new { kind, id, hive, forced });

    [Fact]
    public async Task MsiProgramIsRemovedByWindowsInstallerAndVerifiedGone()
    {
        using var sb = new Sandbox(); var cat = new FakeCatalog(App(Guid1, "Acme Suite", "HKLM", "msi"));
        var proc = new FakeProc((exe, a) => { if (exe == "msiexec.exe") cat.Items.Clear(); return new(0, "", false); });
        var r = await RepairEngine.RunAsync(new AppUninstallRecipe(cat), T.Ctx(sb, proc, null, Opts("msi", Guid1, "HKLM")), default);
        Assert.True(r.Applied); Assert.True(r.Verified); Assert.Contains($"msiexec.exe /x {Guid1} /qn /norestart", proc.Calls);
        Assert.False(r.RollbackAvailable);            // a normal uninstall is not something we can undo
    }

    [Fact]
    public async Task BrokenUninstallerFailsPlainlyUnlessForcedRemovalIsAsked()
    {
        using var sb = new Sandbox(); var folder = Path.Combine(sb.Root, "Apps", "Acme"); sb.Mk(@"Apps\Acme\acme.exe");
        var cat = new FakeCatalog(App("Acme", "Acme Tool", loc: folder, un: Path.Combine(sb.Root, "gone", "unins000.exe")));
        var r = await RepairEngine.RunAsync(new AppUninstallRecipe(cat), T.Ctx(sb, null, null, Opts("other", "Acme")), default);
        Assert.False(r.Applied); Assert.Contains("uninstaller file is missing", r.Summary);
        Assert.True(Directory.Exists(folder)); Assert.Single(cat.Items);                       // nothing was touched
    }

    [Fact]
    public async Task ForcedRemovalMovesFilesAsideRemovesRegistrationAndCanBeUndone()
    {
        using var sb = new Sandbox(); var folder = Path.Combine(sb.Root, "Apps", "Acme"); sb.Mk(@"Apps\Acme\acme.exe", 0, "program");
        var cat = new FakeCatalog(App("Acme", "Acme Tool", loc: folder, un: Path.Combine(sb.Root, "gone", "unins000.exe")));
        var proc = new FakeProc((exe, a) => { if (exe == "reg.exe" && a.StartsWith("export")) File.WriteAllText(a.Split('"')[3], "REGEDIT4"); return new(0, "", false); }); var recipe = new AppUninstallRecipe(cat); var ctx = T.Ctx(sb, proc, null, Opts("other", "Acme", forced: true));
        var r = await RepairEngine.RunAsync(recipe, ctx, default);
        Assert.True(r.Applied && r.Verified == true, r.Summary); Assert.True(r.RollbackAvailable);
        Assert.False(Directory.Exists(folder)); Assert.Empty(cat.Items);
        Assert.Contains(proc.Calls, c => c.StartsWith("reg.exe export"));
        var moved = Directory.GetFiles(sb.StateDir, "acme.exe", SearchOption.AllDirectories); Assert.Single(moved);   // quarantined, not deleted

        await recipe.RollbackAsync(ctx, JsonSerializer.SerializeToElement(ctx.RollbackState), default);
        Assert.True(File.Exists(Path.Combine(folder, "acme.exe"))); Assert.Contains(proc.Calls, c => c.StartsWith("reg.exe import"));
    }

    [Fact]
    public async Task ProgramsWindowsAndViroDependOnAreRefused()
    {
        using var sb = new Sandbox();
        var cat = new FakeCatalog(App("a", "Viro WorkCare"), App("b", "Microsoft Visual C++ 2015-2022 Redistributable (x64)", pub: "Microsoft Corporation"));
        foreach (var id in new[] { "a", "b" })
        {
            var r = await RepairEngine.RunAsync(new AppUninstallRecipe(cat), T.Ctx(sb, null, null, Opts("other", id, forced: true)), default);
            Assert.False(r.Applied); Assert.Contains("protected", r.Summary);
        }
        Assert.Equal(2, cat.Items.Count);
    }

    [Fact]
    public void SystemFoldersAreNeverMovedAside()
    {
        using var sb = new Sandbox();
        Assert.False(AppGuard.SafeFolder(sb.WindowsDir, sb)); Assert.False(AppGuard.SafeFolder(Path.Combine(sb.WindowsDir, "System32"), sb));
        Assert.False(AppGuard.SafeFolder(@"C:\", sb)); Assert.False(AppGuard.SafeFolder(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), sb));
        Assert.True(AppGuard.SafeFolder(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Acme"), sb));
        Assert.False(AppGuard.SafeFolder(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WindowsApps"), sb));
    }

    [Fact]
    public void RegisteredUninstallCommandsAreSplitAndMadeQuiet()
    {
        Assert.Equal((@"C:\Program Files\Acme\unins000.exe", "/x"), Command.Split("\"C:\\Program Files\\Acme\\unins000.exe\" /x"));
        Assert.Equal((@"C:\Acme\un.exe", "--remove"), Command.Split(@"C:\Acme\un.exe --remove"));
        Assert.Contains("/VERYSILENT", Command.Silence(@"C:\Acme\unins000.exe", ""));
        Assert.Equal($"/x {Guid1} /qn /norestart", Command.Silence("msiexec.exe", $"/I{Guid1}"));
    }

    [Fact]
    public async Task BadRequestsAreRejected()
    {
        using var sb = new Sandbox();
        await Assert.ThrowsAsync<ArgumentException>(() => new AppUninstallRecipe(new FakeCatalog()).DiagnoseAsync(T.Ctx(sb, null, null, Opts("other", @"..\..\evil")), default));
    }
}

/// <summary>Runs against the real registry and the real reg.exe, with a made-up program that Viro itself creates and removes; it touches nothing else on the PC.</summary>
public class AppUninstallLiveTests
{
    [Fact]
    public async Task A_real_registered_program_with_a_missing_uninstaller_is_force_removed_and_restored()
    {
        var name = "AcmeTestApp-" + Guid.NewGuid().ToString("N")[..8];
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AcmeTestPrograms", name);
        Directory.CreateDirectory(folder); File.WriteAllText(Path.Combine(folder, "app.txt"), "x");
        var keyPath = RegistryAppCatalog.Path + "\\" + name;
        using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(keyPath))
        { k.SetValue("DisplayName", name); k.SetValue("DisplayVersion", "1.0"); k.SetValue("Publisher", "Viro Test"); k.SetValue("InstallLocation", folder); k.SetValue("UninstallString", "\"" + Path.Combine(folder, "missing-uninstall.exe") + "\""); k.SetValue("EstimatedSize", 1234); }
        using var sb = new Sandbox();
        try
        {
            var cat = new RegistryAppCatalog();
            Assert.Equal(1234 * 1024L, cat.Find("HKCU", name)!.SizeBytes);
            Assert.Contains(RegistryAppCatalog.All(), e => e.Key == name);
            var recipe = new AppUninstallRecipe(cat);
            var ctx = T.Ctx(sb, new SystemProcessRunner(), null, JsonSerializer.Serialize(new { kind = "other", id = name, hive = "HKCU", forced = true }));
            var r = await RepairEngine.RunAsync(recipe, ctx, default);
            Assert.True(r.Applied && r.Verified == true, r.Summary);
            Assert.Null(cat.Find("HKCU", name)); Assert.False(Directory.Exists(folder));
            await recipe.RollbackAsync(ctx, JsonSerializer.SerializeToElement(ctx.RollbackState), default);
            Assert.NotNull(cat.Find("HKCU", name)); Assert.True(File.Exists(Path.Combine(folder, "app.txt")));
        }
        finally { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(keyPath, false); try { Directory.Delete(Path.GetDirectoryName(folder)!, true); } catch { } }
    }
}
