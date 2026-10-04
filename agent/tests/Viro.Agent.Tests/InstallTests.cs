using Microsoft.Extensions.Logging;
using System.Net;
using System.Runtime.CompilerServices;
using System.Text;
using Viro.Agent;
using Viro.Agent.Repair;
using Xunit;

static class TestEnv
{
    public static readonly string Data = Path.Combine(Path.GetTempPath(), "viro-data-" + Guid.NewGuid().ToString("N"));
    // Must run before anything touches AgentConfig.DataDir (a static that reads the environment once).
    [ModuleInitializer] public static void Init() => Environment.SetEnvironmentVariable("VIRO_DATA_DIR", Data);
}

/// <summary>Stateful stand-in for sc.exe: services exist after "create" and disappear after "delete".</summary>
sealed class FakeSc : IProcessRunner
{
    public readonly List<string> Calls = [];
    public bool Exists, Running;
    public int StartExit = 0;
    public Task<ProcResult> RunAsync(string exe, string args, TimeSpan t, CancellationToken ct, Encoding? enc = null)
    {
        Calls.Add(exe + " " + args);
        var a = args.Split(' ')[0];
        ProcResult r = (exe, a) switch
        {
            ("sc.exe", "query") => Exists ? new(0, Running ? "STATE : 4 RUNNING" : "STATE : 1 STOPPED", false) : new(1060, "The specified service does not exist", false),
            ("sc.exe", "create") => Do(() => Exists = true),
            ("sc.exe", "config") => new(Exists ? 0 : 1060, "", false),
            ("sc.exe", "start") => StartExit == 0 ? Do(() => Running = true) : new(StartExit, "start failed", false),
            ("sc.exe", "stop") => Do(() => Running = false),
            ("sc.exe", "delete") => Do(() => { Exists = false; Running = false; }),
            _ => new(0, "", false),
        };
        return Task.FromResult(r);
        static ProcResult Do(Action a) { a(); return new(0, "[SC] Success", false); }
    }
}

sealed class EnrollHandler(HttpStatusCode code = HttpStatusCode.Created) : HttpMessageHandler
{
    public int Hits;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
    {
        Hits++;
        var body = code == HttpStatusCode.Created ? "{\"deviceId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"deviceSecret\":\"vds_secret\",\"heartbeatIntervalSeconds\":30,\"jobSigningPublicKey\":\"KEY\",\"organizationId\":\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\"}" : "{\"error\":\"nope\"}";
        return Task.FromResult(new HttpResponseMessage(code) { Content = new StringContent(body) });
    }
}

[Collection("uses-agent-data-dir")]
public class InstallTests : IDisposable
{
    readonly List<string> _said = [];
    public InstallTests() { if (Directory.Exists(TestEnv.Data)) Directory.Delete(TestEnv.Data, true); }
    public void Dispose() { try { Directory.Delete(TestEnv.Data, true); } catch { } }
    Installer Make(FakeSc sc, bool elevated = true, HttpStatusCode enroll = HttpStatusCode.Created, EnrollHandler? h = null)
        => new(sc, () => elevated, _said.Add, u => new ControlClient("http://localhost:1", h ?? new EnrollHandler(enroll)));
    static InstallOptions Opts(string? dir = null, string? token = "tok", bool force = false) => new("http://localhost:1", token, dir, Force: force, ProtectDataDir: false);

    [Fact]
    public async Task Refuses_to_do_anything_without_administrator_rights()
    {
        var sc = new FakeSc();
        Assert.Equal(5, await Make(sc, elevated: false).SetupAsync(Opts(), @"C:\x\viro-agent.exe", default));
        Assert.Equal(5, await Make(sc, elevated: false).UninstallAsync(Opts(), default));
        Assert.Empty(sc.Calls); Assert.False(File.Exists(AgentConfig.ConfigPath));
    }

    [Fact]
    public async Task Setup_enrolls_stores_the_credential_protected_and_registers_a_self_healing_auto_start_service()
    {
        var sc = new FakeSc();
        var rc = await Make(sc).SetupAsync(Opts(), @"C:\Program Files\Viro\Agent\viro-agent.exe", default);
        Assert.Equal(0, rc);
        var cfg = AgentConfig.Load();
        Assert.True(cfg.IsEnrolled); Assert.Equal("KEY", cfg.JobSigningPublicKey); Assert.Equal("vds_secret", cfg.DeviceSecret);
        Assert.DoesNotContain("vds_secret", File.ReadAllText(AgentConfig.ConfigPath), StringComparison.Ordinal);   // DPAPI protected at rest
        var create = sc.Calls.Single(c => c.StartsWith("sc.exe create"));
        Assert.Contains("binPath= \"\\\"C:\\Program Files\\Viro\\Agent\\viro-agent.exe\\\"\"", create);   // quoted path with spaces
        Assert.Contains("start= delayed-auto", create); Assert.Contains("obj= LocalSystem", create);
        Assert.Contains(sc.Calls, c => c.Contains("failure ViroAgent reset= 86400 actions= restart/5000/restart/5000/restart/60000"));
        Assert.Contains(sc.Calls, c => c.StartsWith("sc.exe start ViroAgent"));
        Assert.True(sc.Running);
    }

    [Fact]
    public async Task Setup_is_idempotent_and_keeps_the_existing_identity_on_reinstall_or_upgrade()
    {
        var sc = new FakeSc(); var h = new EnrollHandler();
        await Make(sc, h: h).SetupAsync(Opts(), @"C:\a\viro-agent.exe", default);
        sc.Calls.Clear();
        Assert.Equal(0, await Make(sc, h: h).SetupAsync(Opts(token: null), @"C:\a\viro-agent.exe", default));
        Assert.Equal(1, h.Hits);                                            // an upgrade (no token) keeps the identity
        Assert.Contains(sc.Calls, c => c.StartsWith("sc.exe config"));      // reconfigured, not re-created
        Assert.DoesNotContain(sc.Calls, c => c.StartsWith("sc.exe create"));
        await Make(sc, h: h).SetupAsync(Opts(), @"C:\a\viro-agent.exe", default);
        Assert.Equal(3, h.Hits);                                            // an explicit token for the same workspace is checked, then re-enrolls (the old identity may have been revoked by an uninstall)
    }

    [Fact]
    public async Task Failed_enrollment_registers_no_service_and_leaves_no_identity()
    {
        var sc = new FakeSc();
        Assert.Equal(1, await Make(sc, enroll: HttpStatusCode.Unauthorized).SetupAsync(Opts(), @"C:\a\viro-agent.exe", default));
        Assert.DoesNotContain(sc.Calls, c => c.StartsWith("sc.exe create")); Assert.False(AgentConfig.Load().IsEnrolled);
        Assert.Contains(_said, s => s.Contains("Enrollment failed"));
    }

    [Fact]
    public async Task Setup_without_a_token_on_an_unenrolled_machine_explains_what_is_needed()
    {
        var sc = new FakeSc();
        Assert.Equal(2, await Make(sc).SetupAsync(Opts(token: null), @"C:\a\viro-agent.exe", default));
        Assert.Empty(sc.Calls);
    }

    [Fact]
    public async Task A_service_that_will_not_start_is_reported_not_hidden()
    {
        var sc = new FakeSc { StartExit = 1053 };
        Assert.Equal(1, await Make(sc).SetupAsync(Opts(), @"C:\a\viro-agent.exe", default));
        Assert.Contains(_said, s => s.Contains("did not start"));
    }

    [Fact]
    public async Task Install_copies_the_program_files_then_registers_the_service()
    {
        var src = Path.Combine(Path.GetTempPath(), "viro-src-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(src);
        var exe = Path.Combine(src, "viro-agent.exe"); File.WriteAllText(exe, "MZ-fake"); File.WriteAllText(Path.Combine(src, "viro-agent.pdb"), "symbols");
        var dest = Path.Combine(Path.GetTempPath(), "viro-dest-" + Guid.NewGuid().ToString("N"));
        var sc = new FakeSc();
        Assert.Equal(0, await Make(sc).InstallAsync(Opts(dest), exe, default));
        Assert.True(File.Exists(Path.Combine(dest, "viro-agent.exe"))); Assert.False(File.Exists(Path.Combine(dest, "viro-agent.pdb")));
        Assert.Contains(sc.Calls, c => c.StartsWith("sc.exe create") && c.Contains(dest));
        Directory.Delete(src, true); Directory.Delete(dest, true);
    }

    [Fact]
    public async Task Upgrade_stops_the_running_service_before_replacing_files()
    {
        var src = Path.Combine(Path.GetTempPath(), "viro-src-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(src);
        var exe = Path.Combine(src, "viro-agent.exe"); File.WriteAllText(exe, "v2");
        var dest = Path.Combine(Path.GetTempPath(), "viro-dest-" + Guid.NewGuid().ToString("N"));
        var sc = new FakeSc { Exists = true, Running = true };
        await Make(sc).InstallAsync(Opts(dest), exe, default);
        Assert.True(sc.Calls.FindIndex(c => c.StartsWith("sc.exe stop")) < sc.Calls.FindIndex(c => c.StartsWith("sc.exe start")));
        Directory.Delete(src, true); Directory.Delete(dest, true);
    }

    [Fact]
    public async Task Uninstall_removes_the_service_and_agent_data_unless_told_to_keep_it()
    {
        var sc = new FakeSc();
        await Make(sc).SetupAsync(Opts(), @"C:\a\viro-agent.exe", default);
        var dir = Path.Combine(Path.GetTempPath(), "viro-uninst-" + Guid.NewGuid().ToString("N"));
        Assert.Equal(0, await Make(sc).UninstallAsync(Opts(dir) with { KeepData = true }, default));
        Assert.False(sc.Exists); Assert.True(File.Exists(AgentConfig.ConfigPath), "data kept");
        await Make(sc).SetupAsync(Opts(), @"C:\a\viro-agent.exe", default);
        Assert.Equal(0, await Make(sc).UninstallAsync(Opts(dir), default));
        Assert.False(Directory.Exists(AgentConfig.DataDir), "data removed");
    }

    [Fact]
    public void The_data_directory_can_be_restricted_to_SYSTEM_and_Administrators()
    {
        var d = Path.Combine(Path.GetTempPath(), "viro-acl-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(d);
        Installer.ProtectDataDirectory(d);
        var rules = new DirectoryInfo(d).GetAccessControl().GetAccessRules(true, false, typeof(System.Security.Principal.SecurityIdentifier)).Cast<System.Security.AccessControl.FileSystemAccessRule>().ToList();
        Assert.Equal(2, rules.Count);
        Assert.All(rules, r => Assert.Contains(r.IdentityReference.Value, new[] { "S-1-5-18", "S-1-5-32-544" }));
        Assert.True(new DirectoryInfo(d).GetAccessControl().AreAccessRulesProtected);
        try { Directory.Delete(d); } catch { /* we removed our own access on purpose; the temp folder can stay */ }
    }

    [Fact]
    public async Task Status_reports_real_installation_state()
    {
        var sc = new FakeSc();
        var before = System.Text.Json.JsonSerializer.SerializeToElement(await Make(sc).StatusAsync(default));
        Assert.False(before.GetProperty("installed").GetBoolean());
        await Make(sc).SetupAsync(Opts(), @"C:\a\viro-agent.exe", default);
        var after = System.Text.Json.JsonSerializer.SerializeToElement(await Make(sc).StatusAsync(default));
        Assert.True(after.GetProperty("installed").GetBoolean()); Assert.Equal("running", after.GetProperty("service").GetString()); Assert.True(after.GetProperty("enrolled").GetBoolean()); Assert.True(after.GetProperty("jobsEnabled").GetBoolean());
    }
}

public class FileLogTests
{
    [Fact]
    public void Log_lines_are_written_to_a_daily_file_and_old_files_are_pruned()
    {
        var dir = Path.Combine(Path.GetTempPath(), "viro-log-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var old = Path.Combine(dir, "agent-19990101.log"); File.WriteAllText(old, "old"); File.SetLastWriteTimeUtc(old, DateTime.UtcNow.AddDays(-30));
        var log = new FileLoggerProvider(dir).CreateLogger("Viro.Agent.Test");
        log.LogInformation("hello {X}", 42); log.LogDebug("hidden");
        var today = Path.Combine(dir, $"agent-{DateTime.UtcNow:yyyyMMdd}.log");
        var text = File.ReadAllText(today);
        Assert.Contains("hello 42", text); Assert.DoesNotContain("hidden", text); Assert.False(File.Exists(old));
        Directory.Delete(dir, true);
    }
}
