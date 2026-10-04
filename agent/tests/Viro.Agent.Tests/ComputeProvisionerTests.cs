using Viro.Agent.Repair;
using Viro.Agent;
using Xunit;

public class ComputeProvisionerTests : IDisposable
{
    readonly string _dir = Path.Combine(Path.GetTempPath(), "viro-prov-" + Guid.NewGuid().ToString("N"));
    public ComputeProvisionerTests() => Directory.CreateDirectory(_dir);
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }
    void WithWorker() => File.WriteAllText(Path.Combine(_dir, "viro-compute.exe"), "x");

    [Fact] public async Task Installs_the_worker_once_when_Control_wants_it_and_it_is_missing()
    {
        WithWorker(); var clock = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var p = new FakeProc((exe, a) => a.StartsWith("query") ? new ProcResult(1060, "", false) : new ProcResult(0, "", false));
        var prov = new ComputeProvisioner(p, _dir, () => clock);
        Assert.Contains("installed automatically", await prov.EnsureAsync(true, default));
        Assert.Contains(p.Calls, c => c == "viro-compute.exe setup");
        Assert.Null(await prov.EnsureAsync(true, default)); Assert.Single(p.Calls, c => c == "viro-compute.exe setup");   // not again within the hour
        clock = clock.AddMinutes(61); await prov.EnsureAsync(true, default); Assert.Equal(2, p.Calls.Count(c => c == "viro-compute.exe setup"));
    }

    [Fact] public async Task Does_nothing_when_not_wanted_already_registered_or_the_package_has_no_worker()
    {
        var p = new FakeProc(); var prov = new ComputeProvisioner(p, _dir);
        Assert.Null(await prov.EnsureAsync(false, default)); Assert.Empty(p.Calls);
        Assert.Null(await prov.EnsureAsync(true, default)); Assert.Empty(p.Calls);   // no viro-compute.exe beside the agent
        WithWorker(); Assert.Null(await new ComputeProvisioner(p, _dir).EnsureAsync(true, default)); Assert.DoesNotContain(p.Calls, c => c.Contains("setup"));   // sc query exit 0 = already there
    }

    [Fact] public async Task A_failed_setup_is_reported_not_hidden()
    {
        WithWorker(); var p = new FakeProc((_, a) => a.StartsWith("query") ? new ProcResult(1060, "", false) : new ProcResult(5, "denied", false));
        Assert.Contains("failed (5)", await new ComputeProvisioner(p, _dir).EnsureAsync(true, default));
    }
}
