using System.Text.Json;
using Viro.Agent;
using Viro.Agent.Repair;
using Viro.Compute;

string? Arg(string n) { var i = Array.IndexOf(args, n); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
var pretty = new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true };

if (args.Length > 0)
{
    var installer = new ComputeInstaller(new SystemProcessRunner(), Installer.IsElevated, Console.WriteLine);
    switch (args[0])
    {
        case "setup": return await installer.SetupAsync(Environment.ProcessPath!, CancellationToken.None);
        case "teardown": case "uninstall": return await installer.TeardownAsync(CancellationToken.None);
        case "status": Console.WriteLine(JsonSerializer.Serialize(await installer.StatusAsync(CancellationToken.None), pretty)); return 0;
        case "version": Console.WriteLine(Collectors.AgentVersion); return 0;
        case "burn": return await BurnWorkload.RunAsync(int.TryParse(Arg("--seconds"), out var s) ? s : 0, CancellationToken.None);
        case "user-probe": return await ProbeMain.RunAsync(Arg("--pipe") ?? throw new ArgumentException("--pipe required"), CancellationToken.None);
        case "run": break;
        default: Console.Error.WriteLine("usage: viro-compute [setup|teardown|status|version|run]"); return 2;
    }
}

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = ComputeInstaller.ServiceName);
builder.Services.AddHostedService<ComputeWorker>();
builder.Logging.AddProvider(new FileLoggerProvider(Path.Combine(AgentConfig.DataDir, "logs", "compute")));
await builder.Build().RunAsync();
return 0;

/// <summary>Registers the compute worker as its own service, separate from the WorkCare agent. It reuses the agent's device identity.</summary>
public sealed class ComputeInstaller(IProcessRunner proc, Func<bool> isElevated, Action<string> say)
{
    public const string ServiceName = "ViroCompute";
    static readonly TimeSpan T = TimeSpan.FromSeconds(60);

    public async Task<int> SetupAsync(string exePath, CancellationToken ct)
    {
        if (!isElevated()) { say("Setup needs administrator rights."); return 5; }
        // Registering never needs enrollment: the worker waits for the agent to enroll, so it can be installed in the same step as the agent.
        var exists = (await proc.RunAsync("sc.exe", $"query {ServiceName}", T, ct)).ExitCode != 1060;
        var r = await proc.RunAsync("sc.exe", $"{(exists ? "config" : "create")} {ServiceName} binPath= \"\\\"{exePath}\\\"\" start= delayed-auto obj= LocalSystem DisplayName= \"Viro Compute Worker\"", T, ct);
        if (r.ExitCode != 0) { say("Could not register the service: " + r.Output.Trim()); return 1; }
        await proc.RunAsync("sc.exe", $"description {ServiceName} \"Viro idle-time compute worker. Runs only when the PC is idle and the organization's policy allows it.\"", T, ct);
        await proc.RunAsync("sc.exe", $"failure {ServiceName} reset= 86400 actions= restart/5000/restart/5000/restart/60000", T, ct);
        var s = await proc.RunAsync("sc.exe", $"start {ServiceName}", T, ct);
        if (s.ExitCode != 0 && !s.Output.Contains("1056")) { say("Registered but did not start: " + s.Output.Trim()); return 1; }
        say("Viro Compute Worker is installed and running."); return 0;
    }

    public async Task<int> TeardownAsync(CancellationToken ct)
    {
        if (!isElevated()) { say("Teardown needs administrator rights."); return 5; }
        await proc.RunAsync("sc.exe", $"stop {ServiceName}", T, ct); await Task.Delay(1500, ct);
        var d = await proc.RunAsync("sc.exe", $"delete {ServiceName}", T, ct);
        say(d.ExitCode is 0 or 1060 ? "Compute worker removed." : "Could not remove the service: " + d.Output.Trim()); return d.ExitCode is 0 or 1060 ? 0 : 1;
    }

    public async Task<object> StatusAsync(CancellationToken ct)
    {
        var q = await proc.RunAsync("sc.exe", $"query {ServiceName}", T, ct); var installed = q.ExitCode != 1060;
        return new { installed, service = !installed ? "not installed" : q.Output.Contains("RUNNING") ? "running" : "stopped", version = Collectors.AgentVersion, busy = BusyLease.Read(AgentConfig.DataDir) };
    }
}
