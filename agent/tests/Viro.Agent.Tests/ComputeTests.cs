using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Viro.Agent;
using Viro.Compute;
using Xunit;

public class ComputePolicyTests
{
    [Fact]
    public void Defaults_are_conservative_and_a_disabled_policy_is_the_starting_point()
    {
        var p = ComputePolicy.Parse("{\"enabled\":true}");
        Assert.True(p.Enabled); Assert.Equal(30, p.MaxCpuPercent); Assert.Equal(10, p.StartAfterIdleMinutes); Assert.False(p.AllowOnBattery); Assert.Equal(70, p.MaxTempC); Assert.Equal(15, p.MaxMemoryPercent); Assert.True(p.PauseOnFullscreen); Assert.Equal("none", p.Fallback);
        Assert.False(ComputePolicy.Disabled.Enabled); Assert.False(ComputePolicy.Parse("{}").Enabled);
    }
    [Fact]
    public void Hostile_or_absurd_values_are_clamped_to_hard_limits_and_unknown_engines_become_none()
    {
        var p = ComputePolicy.Parse("{\"enabled\":true,\"maxCpuPercent\":100000,\"startAfterIdleMinutes\":0,\"maxTempC\":500,\"maxMemoryPercent\":99,\"utcOffsetMinutes\":99999,\"fallback\":\"cmd /c calc\"}");
        Assert.Equal(90, p.MaxCpuPercent); Assert.Equal(1, p.StartAfterIdleMinutes); Assert.Equal(95, p.MaxTempC); Assert.Equal(50, p.MaxMemoryPercent); Assert.Equal(840, p.UtcOffsetMinutes); Assert.Equal("none", p.Fallback);
        Assert.Equal(5, ComputePolicy.Parse("{\"maxCpuPercent\":-4}").MaxCpuPercent);
    }
    [Fact]
    public void Malformed_schedule_windows_are_dropped_not_trusted()
    {
        var p = ComputePolicy.Parse("{\"enabled\":true,\"windows\":[{\"days\":[1,9],\"start\":\"18:00\",\"end\":\"07:00\"},{\"days\":[1],\"start\":\"25:99\",\"end\":\"07:00\"},{\"days\":[],\"start\":\"01:00\",\"end\":\"02:00\"}]}");
        Assert.Single(p.Windows!); Assert.Equal([1], p.Windows![0].Days);
        Assert.ThrowsAny<System.Text.Json.JsonException>(() => ComputePolicy.Parse("not json"));
    }
}

public class PolicyEngineTests
{
    static readonly DateTime Now = new(2026, 10, 7, 12, 0, 0, DateTimeKind.Utc);   // a Wednesday
    static ComputePolicy P(Func<ComputePolicy, ComputePolicy>? f = null) { var p = new ComputePolicy(true, 1, 30, 10, null, false, 70, 15, true, 0, "selftest", "w", null); return f?.Invoke(p) ?? p; }
    static Signals Idle(double idleSeconds = 1200, Func<Signals, Signals>? f = null) { var s = new Signals(idleSeconds, false, 55, 40, null, false, false, true); return f?.Invoke(s) ?? s; }

    [Fact] public void An_idle_PC_within_policy_runs_at_the_policy_cap() { var d = PolicyEngine.Decide(P(), Idle(), false, Now); Assert.True(d.Run); Assert.Equal("running", d.State); Assert.Equal(30, d.CpuCapPercent); }
    [Fact] public void Disabled_policy_never_runs() => Assert.Equal("disabled", PolicyEngine.Decide(P(p => p with { Enabled = false }), Idle(), false, Now).State);
    [Fact] public void An_expired_policy_stops_compute_until_a_fresh_one_arrives() { Assert.False(PolicyEngine.Decide(P(p => p with { ValidUntil = Now.AddMinutes(-1) }), Idle(), true, Now).Run); Assert.True(PolicyEngine.Decide(P(p => p with { ValidUntil = Now.AddHours(1) }), Idle(), false, Now).Run); }

    [Theory]
    [InlineData(0, false, "user-active")]     [InlineData(599, false, "user-active")]      [InlineData(600, false, "running")]     // must be idle 10 minutes to START
    [InlineData(2, true, "user-active")]      [InlineData(3, true, "running")]             [InlineData(0, true, "user-active")]     // once running, input within 3 s stops it at once
    public void The_user_always_wins_and_starting_needs_the_configured_idle_time(double idle, bool running, string expected) => Assert.Equal(expected, PolicyEngine.Decide(P(), Idle(idle), running, Now).State);

    [Fact] public void Unknown_user_activity_is_never_permission_to_run() { var d = PolicyEngine.Decide(P(), Idle(f: s => s with { IdleSeconds = null }), false, Now); Assert.False(d.Run); Assert.Equal("idle-unknown", d.State); }
    [Fact] public void Battery_disables_compute_unless_the_policy_allows_it() { Assert.Equal("on-battery", PolicyEngine.Decide(P(), Idle(f: s => s with { OnBattery = true }), false, Now).State); Assert.True(PolicyEngine.Decide(P(p => p with { AllowOnBattery = true }), Idle(f: s => s with { OnBattery = true }), false, Now).Run); Assert.True(PolicyEngine.Decide(P(), Idle(f: s => s with { OnBattery = null }), false, Now).Run, "a desktop has no battery"); }
    [Fact] public void Higher_priority_work_stops_compute_immediately()
    {
        var d = PolicyEngine.Decide(P(), Idle(f: s => s with { BusyReason = "security.scan" }), true, Now); Assert.False(d.Run); Assert.Equal("busy", d.State); Assert.Contains("security.scan", d.Reason);
        Assert.Equal("busy", PolicyEngine.Decide(P(), Idle(f: s => s with { MaintenanceProcessRunning = true }), true, Now).State);
    }
    [Fact] public void Thermal_limit_stops_compute_and_it_only_restarts_after_cooling_down()
    {
        Assert.Equal("hot", PolicyEngine.Decide(P(), Idle(f: s => s with { CpuTempC = 70 }), true, Now).State);
        var warm = PolicyEngine.Decide(P(), Idle(f: s => s with { CpuTempC = 69 }), true, Now); Assert.True(warm.Run, "below the limit it may run, but only throttled"); Assert.Equal(15, warm.CpuCapPercent); Assert.Equal(ThermalLevel.Warm, warm.Thermal);
        Assert.Equal("hot", PolicyEngine.Decide(P(), Idle(f: s => s with { CpuTempC = 66 }), false, Now, null, null, ThermalLevel.Warning).State);      // restart needs limit - 5
        Assert.True(PolicyEngine.Decide(P(), Idle(f: s => s with { CpuTempC = 64 }), false, Now, null, null, ThermalLevel.Warning).Run);
        Assert.True(PolicyEngine.Decide(P(), Idle(f: s => s with { CpuTempC = null }), false, Now).Run, "no sensor: no false alarm");
        Assert.Contains("not readable", PolicyEngine.Decide(P(), Idle(f: s => s with { CpuTempC = null }), false, Now).Reason);
        Assert.Equal(30, PolicyEngine.Decide(P(), Idle(f: s => s with { CpuTempC = 55 }), false, Now).CpuCapPercent);   // cool: full policy cap
    }
    [Fact] public void Battery_default_stops_compute_and_even_when_allowed_it_stops_below_half_charge()
    {
        Assert.Equal("on-battery", PolicyEngine.Decide(P(), Idle(f: s => s with { OnBattery = true, BatteryPercent = 95 }), false, Now).State);
        var allowed = P(p => p with { AllowOnBattery = true });
        Assert.True(PolicyEngine.Decide(allowed, Idle(f: s => s with { OnBattery = true, BatteryPercent = 80 }), false, Now).Run);
        Assert.Equal("battery-low", PolicyEngine.Decide(allowed, Idle(f: s => s with { OnBattery = true, BatteryPercent = 49 }), true, Now).State);
        Assert.True(PolicyEngine.Decide(allowed, Idle(f: s => s with { OnBattery = false, BatteryPercent = 20 }), false, Now).Run, "on AC the charge level does not matter");
    }
    [Fact] public void Heat_is_graded_normal_throttle_pause_block_and_a_blocked_PC_stays_blocked_until_it_has_cooled()
    {
        var t = Thermal.Derive(70, null); Assert.Equal(new ThermalThresholds(62, 70, 80, 60), t);
        Assert.Equal("thermal-blocked", PolicyEngine.Decide(P(), Idle(f: s => s with { CpuTempC = 81 }), true, Now).State);
        var stillHot = PolicyEngine.Decide(P(), Idle(f: s => s with { CpuTempC = 66 }), false, Now, null, null, ThermalLevel.Critical); Assert.Equal("thermal-blocked", stillHot.State); Assert.Contains("cools below 60", stillHot.Reason);
        Assert.Equal("thermal-blocked", PolicyEngine.Decide(P(), Idle(f: s => s with { CpuTempC = null }), false, Now, null, null, ThermalLevel.Critical).State);   // no reading never clears a blocked state
        var cooled = PolicyEngine.Decide(P(), Idle(f: s => s with { CpuTempC = 59 }), false, Now, null, null, ThermalLevel.Critical); Assert.True(cooled.Run); Assert.Equal(ThermalLevel.Warm, cooled.Thermal); Assert.Equal(15, cooled.CpuCapPercent);   // restarts gently, at half the cap, and only goes to full after cooling further
        Assert.Equal("THROTTLE", Thermal.Gate(ThermalLevel.Warm)); Assert.Equal("PAUSE", Thermal.Gate(ThermalLevel.Warning)); Assert.Equal("BLOCK", Thermal.Gate(ThermalLevel.Critical)); Assert.Equal("ALLOW", Thermal.Gate(ThermalLevel.Normal));
    }
    [Fact] public void Thresholds_follow_the_hardware_when_the_firmware_reports_a_critical_temperature_and_never_trust_nonsense()
    {
        var hot = Thermal.Derive(85, 100); Assert.Equal(95, hot.Critical); Assert.Equal(85, hot.Warning);            // 5 below the firmware limit
        var lowCrit = Thermal.Derive(85, 80); Assert.Equal(75, lowCrit.Critical); Assert.Equal(65, lowCrit.Warning);   // a fragile processor lowers the policy limit
        Assert.Equal(Thermal.Derive(70, null), Thermal.Derive(70, 5)); Assert.Equal(Thermal.Derive(70, null), Thermal.Derive(70, 400));
        // no flapping around each threshold
        var th = Thermal.Derive(70, null); var l = ThermalLevel.Normal;
        foreach (var (temp, want) in new (double, ThermalLevel)[] { (61, ThermalLevel.Normal), (63, ThermalLevel.Warm), (61, ThermalLevel.Warm), (58, ThermalLevel.Normal), (71, ThermalLevel.Warning), (67, ThermalLevel.Warning), (64, ThermalLevel.Warm), (80, ThermalLevel.Critical), (70, ThermalLevel.Critical), (61, ThermalLevel.Critical), (59, ThermalLevel.Warm), (50, ThermalLevel.Normal) })
        { l = Thermal.Evaluate(temp, th, l); Assert.Equal(want, l); }
    }
    [Fact] public void Memory_pressure_has_hysteresis_so_compute_does_not_flap_at_the_threshold()
    {
        Assert.Equal("low-memory", PolicyEngine.Decide(P(), Idle(f: s => s with { MemoryUsedPercent = 90 }), true, Now).State);      // running: stops at 90
        Assert.True(PolicyEngine.Decide(P(), Idle(f: s => s with { MemoryUsedPercent = 89 }), true, Now).Run);                     // ...but keeps running just below it
        Assert.Equal("low-memory", PolicyEngine.Decide(P(), Idle(f: s => s with { MemoryUsedPercent = 85 }), false, Now).State);    // stopped: waits until it has recovered
        Assert.True(PolicyEngine.Decide(P(), Idle(f: s => s with { MemoryUsedPercent = 79 }), false, Now).Run);
    }
    [Fact] public void Memory_pressure_and_fullscreen_apps_pause_compute()
    {
        Assert.Equal("low-memory", PolicyEngine.Decide(P(), Idle(f: s => s with { MemoryUsedPercent = 93 }), false, Now).State);
        Assert.Equal("fullscreen", PolicyEngine.Decide(P(), Idle(f: s => s with { Fullscreen = true }), false, Now).State);
        Assert.True(PolicyEngine.Decide(P(p => p with { PauseOnFullscreen = false }), Idle(f: s => s with { Fullscreen = true }), false, Now).Run);
    }
    [Fact] public void Schedule_windows_are_respected_including_windows_that_cross_midnight_and_the_org_timezone()
    {
        var night = new[] { new TimeWindow([1, 2, 3, 4, 5], "18:00", "07:00") };      // weeknights into the next morning
        var p = P(x => x with { Windows = night });
        Assert.Equal("outside-window", PolicyEngine.Decide(p, Idle(), false, Now).State);                                        // Wed 12:00
        Assert.True(PolicyEngine.Decide(p, Idle(), false, new DateTime(2026, 10, 7, 19, 0, 0, DateTimeKind.Utc)).Run);           // Wed 19:00
        Assert.True(PolicyEngine.Decide(p, Idle(), false, new DateTime(2026, 10, 8, 3, 0, 0, DateTimeKind.Utc)).Run);            // Thu 03:00 belongs to Wednesday night
        Assert.True(PolicyEngine.Decide(p, Idle(), false, new DateTime(2026, 10, 10, 3, 0, 0, DateTimeKind.Utc)).Run);          // Sat 03:00 is still Friday night
        Assert.False(PolicyEngine.Decide(p, Idle(), false, new DateTime(2026, 10, 11, 3, 0, 0, DateTimeKind.Utc)).Run);         // Sun 03:00 would be Saturday night: not allowed
        Assert.True(PolicyEngine.Decide(p with { UtcOffsetMinutes = 120 }, Idle(), false, new DateTime(2026, 10, 7, 17, 0, 0, DateTimeKind.Utc)).Run, "17:00 UTC is 19:00 local at UTC+2");
    }
    [Fact] public void Nothing_to_run_is_reported_honestly() { var d = PolicyEngine.Decide(P(), Idle(f: s => s with { WorkAvailable = false }), false, Now); Assert.False(d.Run); Assert.Equal("no-work", d.State); }
    [Fact] public void Stop_conditions_have_a_fixed_priority_so_the_reported_reason_is_the_most_important_one()
    {
        var all = Idle(0, s => s with { BusyReason = "updates.install", OnBattery = true, CpuTempC = 99, MemoryUsedPercent = 99, Fullscreen = true });
        Assert.Equal("thermal-blocked", PolicyEngine.Decide(P(), all, true, Now).State);   // heat outranks everything else
        var cool = all with { CpuTempC = 50 };
        Assert.Equal("busy", PolicyEngine.Decide(P(), cool, true, Now).State);
        Assert.Equal("user-active", PolicyEngine.Decide(P(), cool with { BusyReason = null }, true, Now).State);
    }
}

public class PolicyStoreTests : IDisposable
{
    readonly string _dir = Path.Combine(Path.GetTempPath(), "viro-ps-" + Guid.NewGuid().ToString("N"));
    readonly ECDsa _server = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }
    string Key => Convert.ToBase64String(_server.ExportSubjectPublicKeyInfo());
    (string text, string sig) Signed(int version, string worker = "org-dev", ECDsa? by = null, bool enabled = true)
    {
        var text = $"{{\"version\":{version},\"enabled\":{enabled.ToString().ToLower()},\"maxCpuPercent\":25,\"workerId\":\"{worker}\",\"validUntil\":\"{DateTime.UtcNow.AddDays(2):O}\"}}";
        return (text, Convert.ToBase64String((by ?? _server).SignData(Encoding.UTF8.GetBytes(text), HashAlgorithmName.SHA256)));
    }

    [Fact] public void A_policy_signed_by_the_pinned_server_key_is_applied()
    { var s = new PolicyStore(_dir, Key); var (t, sig) = Signed(1); Assert.True(s.TryApply(t, sig, "org-dev")); Assert.Equal(25, s.Current.MaxCpuPercent); Assert.True(s.Current.Enabled); }
    [Fact] public void Policies_from_another_key_or_with_edited_text_are_ignored_and_the_previous_policy_stays()
    {
        var s = new PolicyStore(_dir, Key); var (t, sig) = Signed(1); s.TryApply(t, sig);
        var (t2, sig2) = Signed(2, by: ECDsa.Create(ECCurve.NamedCurves.nistP256)); Assert.False(s.TryApply(t2, sig2));
        Assert.False(s.TryApply(t.Replace("25", "90"), sig)); Assert.False(s.TryApply(t, "garbage")); Assert.Equal(25, s.Current.MaxCpuPercent);
    }
    [Fact] public void A_policy_issued_for_a_different_PC_or_an_older_version_is_refused()
    {
        var s = new PolicyStore(_dir, Key); var (t5, s5) = Signed(5); Assert.True(s.TryApply(t5, s5, "org-dev"));
        var (tOther, sOther) = Signed(6, "org-OTHER"); Assert.False(s.TryApply(tOther, sOther, "org-dev"));
        var (t4, s4) = Signed(4); Assert.False(s.TryApply(t4, s4, "org-dev"), "no rollback to an older policy");
    }
    [Fact] public void The_last_verified_policy_survives_a_restart_and_a_tampered_cache_file_is_not_trusted()
    {
        var a = new PolicyStore(_dir, Key); var (t, sig) = Signed(3); a.TryApply(t, sig);
        var b = new PolicyStore(_dir, Key); b.LoadCached(); Assert.Equal(3, b.Current.Version);
        var path = Path.Combine(_dir, "compute", "policy.json"); File.WriteAllText(path, File.ReadAllText(path).Replace("25", "90"));
        var c = new PolicyStore(_dir, Key); c.LoadCached(); Assert.False(c.Current.Enabled);
    }
}

public class WorkloadTests : IDisposable
{
    readonly WorkloadHost _host = new();
    public void Dispose() => _host.Dispose();
    static WorkloadSpec Burn(int cap, int seconds = 20) => new("dotnet", $"\"{Path.Combine(AppContext.BaseDirectory, "viro-compute.dll")}\" burn --seconds {seconds}", cap, 512L * 1024 * 1024);

    /// <summary>Blocks until the workload has actually started doing work (its first reported rate), however slow the machine is to start it.</summary>
    static async Task Warm(WorkloadHost h)
    {
        var seen = new TaskCompletionSource(); void on(string l) { if (l.StartsWith("rate=")) seen.TrySetResult(); } h.OutputLine += on;
        await seen.Task.WaitAsync(TimeSpan.FromSeconds(40)); h.OutputLine -= on;
    }

    /// <summary>Average share of the whole machine used over a window, from the job's own accounting.</summary>
    static async Task<double> Share(WorkloadHost h, int ms)
    {
        var c0 = h.TotalCpuSeconds(); var t0 = Stopwatch.StartNew(); await Task.Delay(ms);
        return (h.TotalCpuSeconds() - c0) / t0.Elapsed.TotalSeconds / Environment.ProcessorCount * 100;
    }

    [Fact]
    public async Task The_operating_system_enforces_the_CPU_cap_even_though_the_workload_tries_to_use_every_core()
    {
        _host.Start(Burn(20, 60)); await Warm(_host); await Task.Delay(1500);
        var share = await Share(_host, 6000);
        Assert.InRange(share, 0.5, 28);                                   // never above the 20% cap (plus measurement slack); the lower bound is lenient because an idle-priority process is starved by other apps on a busy PC
    }

    [Fact]
    public async Task The_cap_can_be_changed_while_running_and_the_workload_runs_at_idle_priority()
    {
        _host.Start(Burn(40, 60)); await Warm(_host); await Task.Delay(1500);
        var high = await Share(_host, 4000);
        _host.SetCpuCap(10); await Task.Delay(1500);
        var low = await Share(_host, 4000);
        Assert.True(low < high * 0.6, $"cap 40% -> {high:0.0}%, cap 10% -> {low:0.0}%");
        Assert.InRange(low, 2, 16);
        using var p = Process.GetProcessById(_host.ProcessId!.Value); Assert.Equal(ProcessPriorityClass.Idle, p.PriorityClass);
    }

    [Fact]
    public async Task Stop_ends_the_workload_and_disposing_the_host_kills_it_too()
    {
        _host.Start(Burn(15)); var pid = _host.ProcessId!.Value; Assert.True(_host.IsRunning);
        _host.Stop(); Assert.False(_host.IsRunning); await Task.Delay(500); Assert.Throws<ArgumentException>(() => Process.GetProcessById(pid));
        _host.Start(Burn(15)); var pid2 = _host.ProcessId!.Value; _host.Dispose(); await Task.Delay(800);
        Assert.Throws<ArgumentException>(() => Process.GetProcessById(pid2));
    }

    [Fact]
    public async Task The_workload_reports_its_rate_and_only_one_runs_at_a_time()
    {
        var rates = new List<double>(); _host.OutputLine += l => { if (l.StartsWith("rate=")) lock (rates) rates.Add(double.Parse(l[5..])); };
        _host.Start(Burn(30));
        Assert.Throws<InvalidOperationException>(() => _host.Start(Burn(30)));
        var sw = Stopwatch.StartNew(); while (sw.Elapsed < TimeSpan.FromSeconds(15)) { lock (rates) if (rates.Count > 0) break; await Task.Delay(200); }
        lock (rates) Assert.True(rates.Count > 0 && rates[0] > 0);
    }

    [Fact]
    public void The_provider_only_offers_the_self_test_and_says_plainly_why_the_engine_is_not_available()
    {
        var pr = new WorkloadProvider("viro-compute.exe"); var p = ComputePolicy.Parse("{\"enabled\":true,\"maxCpuPercent\":30,\"maxMemoryPercent\":10,\"fallback\":\"selftest\"}");
        var w = pr.Next(p, 8L << 30, out _)!; Assert.Equal(30, w.CpuCapPercent); Assert.Equal((8L << 30) / 10, w.MemoryLimitBytes); Assert.Equal("burn", w.Args);
        Assert.Null(pr.Next(p with { Fallback = "xmrig" }, 8L << 30, out var why)); Assert.Contains("store is unavailable", why);
        Assert.Null(pr.Next(p with { Fallback = "none" }, 8L << 30, out var why2)); Assert.Contains("no workload", why2);
    }
}

public class CoordinationTests : IDisposable
{
    readonly string _dir = Path.Combine(Path.GetTempPath(), "viro-lease-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }

    [Fact] public void The_agent_holds_a_lease_while_important_work_runs_and_releases_it_afterwards()
    {
        Assert.Null(BusyLease.Read(_dir));
        using (new BusyLease.Hold(_dir, "security.scan")) Assert.Equal("security.scan", BusyLease.Read(_dir));
        Assert.Null(BusyLease.Read(_dir));
    }
    [Fact] public void A_lease_left_behind_by_a_crashed_agent_expires_on_its_own()
    {
        Directory.CreateDirectory(_dir); File.WriteAllText(BusyLease.PathFor(_dir), $"{{\"reason\":\"repair.run\",\"until\":\"{DateTime.UtcNow.AddSeconds(-5):O}\"}}");
        Assert.Null(BusyLease.Read(_dir)); Assert.Equal("repair.run", BusyLease.Read(_dir, DateTime.UtcNow.AddMinutes(-1)));
        File.WriteAllText(BusyLease.PathFor(_dir), "corrupt"); Assert.Null(BusyLease.Read(_dir));
    }
    [Theory] [InlineData("security.scan")] [InlineData("updates.install")] [InlineData("repair.fix-safe")] [InlineData("cleanup.run")] [InlineData("driver.install")] [InlineData("software.install")]
    public void Every_security_update_repair_and_maintenance_job_makes_compute_yield(string type) => Assert.Contains(type, BusyLease.BusyJobTypes);
    [Theory] [InlineData("health.check")] [InlineData("cleanup.preview")] [InlineData("inventory.refresh")]
    public void Light_read_only_jobs_do_not(string type) => Assert.DoesNotContain(type, BusyLease.BusyJobTypes);

    [Fact] public void Signals_are_read_from_the_real_machine_and_maintenance_detection_can_be_injected()
    {
        var (used, total) = SignalReader.Memory(); Assert.InRange(used, 1, 100); Assert.True(total > 1L << 30);
        _ = SignalReader.OnBattery(); _ = SignalReader.BatteryPercent(); var trip = SignalReader.CriticalTripC(); if (trip is { } tc) Assert.InRange(tc, 60, 125); var t = SignalReader.CpuTempC(); if (t is { } c) Assert.InRange(c, 5, 130);
        Assert.True(SignalReader.MaintenanceRunning(n => n == "TiWorker")); Assert.False(SignalReader.MaintenanceRunning(_ => false));
    }
}
