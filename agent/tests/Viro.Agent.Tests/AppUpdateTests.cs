using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Viro.Agent.Care;
using Viro.Agent.Repair;
using Xunit;

public class AppUpdateTests
{
    // winget redraws a spinner with carriage returns before the table; the columns are positioned by the header.
    const string Sample = "   -\r   \\\r   |\r\nName                           Id                       Version      Available Source\r\n" +
        "-------------------------------------------------------------------------------------\r\n" +
        "Docker Desktop                 Docker.DockerDesktop     4.90.0       4.91.0    winget\r\n" +
        "Cursor (User)                  Anysphere.Cursor         3.17.19      3.19.7    winget\r\n" +
        "Some Vendor Tool 2             Vendor.Tool              < 1.2        1.3       winget\r\n" +
        "3 upgrades available.\r\n";

    static RepairContext Ctx(IProcessRunner p, string opts) => new(new SlowEnv(), p, new FakeServices(), NullLogger.Instance, JsonDocument.Parse(opts).RootElement);

    [Fact]
    public void The_upgrade_table_is_read_by_its_own_header_columns()
    {
        var u = AppUpdates.Parse(Sample);
        Assert.Equal(["Docker.DockerDesktop", "Anysphere.Cursor", "Vendor.Tool"], u.Select(x => x.Id));
        Assert.Equal(("Docker Desktop", "4.90.0", "4.91.0"), (u[0].Name, u[0].Version, u[0].Available));
        Assert.Equal("1.2", u[2].Version);                                                           // "< 1.2" is how winget shows an unknown exact version
        Assert.Empty(AppUpdates.Parse("No installed package found matching input criteria."));
    }

    [Fact]
    public async Task A_program_is_updated_silently_and_counts_only_when_winget_stops_offering_it()
    {
        var done = false; var calls = new List<string>();
        var proc = new FakeProc((exe, args) => { calls.Add(args); if (args.StartsWith("upgrade --id")) { done = true; return new(0, "Successfully installed", false); } return new(0, done ? "Name Id Version Available Source\r\n------\r\n" : Sample, false); });
        var rep = await RepairEngine.RunAsync(new AppUpdateRecipe(), Ctx(proc, "{\"id\":\"Docker.DockerDesktop\"}"), default);
        Assert.True(rep.Applied && rep.Verified == true, rep.Summary);
        Assert.Contains(calls, c => c == "upgrade --id Docker.DockerDesktop --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity");
        var gone = await RepairEngine.RunAsync(new AppUpdateRecipe(), Ctx(proc, "{\"id\":\"Docker.DockerDesktop\"}"), default);
        Assert.Contains("No action needed", gone.Summary);
    }

    [Fact]
    public async Task A_failed_update_says_why_and_is_never_reported_as_done()
    {
        var inUse = new FakeProc((_, a) => a.StartsWith("upgrade --id") ? new(1, "The application is currently running. Close it.", false) : new(0, Sample, false));
        var rep = await RepairEngine.RunAsync(new AppUpdateRecipe(), Ctx(inUse, "{\"id\":\"Anysphere.Cursor\"}"), default);
        Assert.False(rep.Applied); Assert.Contains("close the program first", rep.Summary);
        var stays = new FakeProc((_, a) => new(0, Sample, false));                                    // installer said 0 but winget still offers the version
        var rep2 = await RepairEngine.RunAsync(new AppUpdateRecipe(), Ctx(stays, "{\"id\":\"Anysphere.Cursor\"}"), default);
        Assert.NotEqual(true, rep2.Verified);
    }

    [Fact]
    public async Task Package_ids_that_could_carry_extra_commands_are_refused()
    {
        foreach (var bad in new[] { "x; calc", "a b", "--source evil", "" })
            Assert.Contains("Diagnosis failed", (await RepairEngine.RunAsync(new AppUpdateRecipe(), Ctx(new FakeProc(), JsonSerializer.Serialize(new { id = bad })), default)).Summary);
        Assert.Equal(RepairRisk.Review, Recipes.All["app.update"].Risk);
    }
}
