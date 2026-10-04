using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Viro.Agent;
using Viro.Agent.Repair;
using Xunit;

public class SelfUpdateTests : IDisposable
{
    readonly string _root = Path.Combine(Path.GetTempPath(), "viro-upd-" + Guid.NewGuid().ToString("N"));
    readonly ECDsa _server = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    string Data => Path.Combine(_root, "data"); string Install => Path.Combine(_root, "install");
    public SelfUpdateTests() { Directory.CreateDirectory(Data); Directory.CreateDirectory(Install); }
    public void Dispose() { try { Directory.Delete(_root, true); } catch { } }

    static string Hex(byte[] b) => Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant();
    byte[] Zip(params (string name, byte[] data)[] files)
    {
        using var ms = new MemoryStream();
        using (var z = new ZipArchive(ms, ZipArchiveMode.Create, true)) foreach (var (n, d) in files) { var e = z.CreateEntry(n); using var s = e.Open(); s.Write(d); }
        return ms.ToArray();
    }
    UpdateOffer Offer(string version, byte[] zip, byte[] exe, Action<Dictionary<string, object>>? tweak = null, bool badSig = false)
    {
        var m = new Dictionary<string, object> { ["component"] = "agent", ["version"] = version, ["sha256"] = Hex(zip), ["size"] = zip.Length, ["exeSha256"] = Hex(exe), ["createdAt"] = "2026-01-01T00:00:00Z" };
        tweak?.Invoke(m);
        var text = JsonSerializer.Serialize(m);
        var sig = Convert.ToBase64String(_server.SignData(Encoding.UTF8.GetBytes(text), HashAlgorithmName.SHA256));
        if (badSig) sig = Convert.ToBase64String(ECDsa.Create(ECCurve.NamedCurves.nistP256).SignData(Encoding.UTF8.GetBytes(text), HashAlgorithmName.SHA256));
        return new(version, "/agent/v1/releases/" + version + "/download", text, sig, Hex(zip), zip.Length);
    }
    SelfUpdater Make(string current = "1.0.0", IProcessRunner? proc = null, Func<DateTime>? now = null) =>
        new(Data, Install, current, Convert.ToBase64String(_server.ExportSubjectPublicKeyInfo()), proc ?? new FakeProc((_, a) => new ProcResult(0, "2.0.0\r\n", false)), now);
    static Func<Stream, Task> Serve(byte[] bytes) => async s => await s.WriteAsync(bytes);
    static readonly byte[] Exe = Encoding.ASCII.GetBytes("MZ-new-agent-binary");

    [Fact]
    public async Task A_correctly_signed_and_hashed_package_is_verified_extracted_and_smoke_tested()
    {
        var zip = Zip(("viro-agent.exe", Exe)); var o = Offer("2.0.0", zip, Exe);
        var staged = await Make().PrepareAsync(o, Serve(zip), default);
        Assert.Equal(Exe, File.ReadAllBytes(staged));
    }

    [Fact] public async Task A_manifest_not_signed_by_the_pinned_server_key_is_refused_before_anything_is_downloaded()
    {
        var zip = Zip(("viro-agent.exe", Exe)); var downloaded = false;
        var ex = await Assert.ThrowsAsync<UpdateRejectedException>(() => Make().PrepareAsync(Offer("2.0.0", zip, Exe, badSig: true), s => { downloaded = true; return Task.CompletedTask; }, default));
        Assert.Contains("signature", ex.Message); Assert.False(downloaded);
    }
    [Fact] public async Task A_tampered_manifest_fails_signature_verification()
    {
        var zip = Zip(("viro-agent.exe", Exe)); var o = Offer("2.0.0", zip, Exe);
        await Assert.ThrowsAsync<UpdateRejectedException>(() => Make().PrepareAsync(o with { Manifest = o.Manifest.Replace("2.0.0", "2.0.1") }, Serve(zip), default));
        await Assert.ThrowsAsync<UpdateRejectedException>(() => Make().PrepareAsync(o with { Signature = "!!not base64!!" }, Serve(zip), default));
    }
    [Fact] public async Task A_manifest_for_a_different_version_than_offered_is_refused()
    {
        var zip = Zip(("viro-agent.exe", Exe)); var o = Offer("2.0.0", zip, Exe);
        var ex = await Assert.ThrowsAsync<UpdateRejectedException>(() => Make().PrepareAsync(o with { Version = "3.0.0" }, Serve(zip), default)); Assert.Contains("does not describe", ex.Message);
    }
    [Fact] public async Task A_package_modified_in_transit_fails_the_hash_check()
    {
        var zip = Zip(("viro-agent.exe", Exe)); var evil = (byte[])zip.Clone(); evil[evil.Length / 2] ^= 0xFF;
        var ex = await Assert.ThrowsAsync<UpdateRejectedException>(() => Make().PrepareAsync(Offer("2.0.0", zip, Exe), Serve(evil), default)); Assert.Contains("hash", ex.Message);
    }
    [Fact] public async Task A_validly_signed_package_whose_executable_differs_from_the_signed_hash_is_refused()
    {
        var zip = Zip(("viro-agent.exe", Encoding.ASCII.GetBytes("MZ-something-else")));
        var ex = await Assert.ThrowsAsync<UpdateRejectedException>(() => Make().PrepareAsync(Offer("2.0.0", zip, Exe), Serve(zip), default)); Assert.Contains("executable hash", ex.Message);
    }
    [Fact] public async Task A_package_without_the_agent_executable_is_refused() { var zip = Zip(("readme.txt", Exe)); await Assert.ThrowsAsync<UpdateRejectedException>(() => Make().PrepareAsync(Offer("2.0.0", zip, Exe), Serve(zip), default)); }
    [Fact] public async Task Zip_slip_entries_cannot_write_outside_the_staging_folder()
    {
        var zip = Zip(("viro-agent.exe", Exe), (@"..\..\..\pwned.txt", Exe)); var target = Path.GetFullPath(Path.Combine(Data, "updates", "2.0.0", "new", @"..\..\..\pwned.txt"));
        await Assert.ThrowsAsync<UpdateRejectedException>(() => Make().PrepareAsync(Offer("2.0.0", zip, Exe), Serve(zip), default));
        Assert.False(File.Exists(target));
    }
    [Fact] public async Task A_download_larger_than_the_signed_size_is_cut_off()
    {
        var zip = Zip(("viro-agent.exe", Exe)); var big = zip.Concat(new byte[5000]).ToArray();
        await Assert.ThrowsAsync<UpdateRejectedException>(() => Make().PrepareAsync(Offer("2.0.0", zip, Exe), Serve(big), default));
    }
    [Fact] public async Task The_compute_worker_in_the_package_is_staged_only_when_it_matches_the_signed_hash()
    {
        var comp = Encoding.UTF8.GetBytes("MZ compute worker bytes"); var zip = Zip(("viro-agent.exe", Exe), ("viro-compute.exe", comp));
        var u = Make(); await u.PrepareAsync(Offer("2.0.0", zip, Exe, m => m["computeExeSha256"] = Hex(comp)), Serve(zip), default);
        Assert.NotNull(u.StagedComputePath); Assert.EndsWith("viro-compute.exe", u.StagedComputePath);
        var bad = Make(); await Assert.ThrowsAsync<UpdateRejectedException>(() => bad.PrepareAsync(Offer("2.0.0", zip, Exe, m => m["computeExeSha256"] = Hex(Exe)), Serve(zip), default));
        var plain = Make(); await plain.PrepareAsync(Offer("2.0.0", Zip(("viro-agent.exe", Exe)), Exe), Serve(Zip(("viro-agent.exe", Exe))), default); Assert.Null(plain.StagedComputePath);
    }

    [Theory] [InlineData("1.0.0")] [InlineData("garbage")] [InlineData("")]
    public async Task A_new_executable_that_reports_the_wrong_version_or_will_not_run_is_refused(string reported)
    {
        var zip = Zip(("viro-agent.exe", Exe));
        await Assert.ThrowsAsync<UpdateRejectedException>(() => Make(proc: new FakeProc((_, _) => new ProcResult(0, reported, false))).PrepareAsync(Offer("2.0.0", zip, Exe), Serve(zip), default));
        await Assert.ThrowsAsync<UpdateRejectedException>(() => Make(proc: new FakeProc((_, _) => new ProcResult(1, "2.0.0", false))).PrepareAsync(Offer("2.0.0", zip, Exe), Serve(zip), default));
    }
    [Fact] public async Task An_out_of_bounds_signed_size_is_refused_even_if_the_signature_is_valid()
    {
        var zip = Zip(("viro-agent.exe", Exe));
        await Assert.ThrowsAsync<UpdateRejectedException>(() => Make().PrepareAsync(Offer("2.0.0", zip, Exe, m => m["size"] = 999L * 1024 * 1024), Serve(zip), default));
    }

    [Fact]
    public void Only_newer_unblocked_versions_are_attempted_and_failures_back_off()
    {
        var t = new DateTime(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc); var clock = t;
        var u = Make("1.5.0", now: () => clock); var zip = Zip(("viro-agent.exe", Exe));
        Assert.True(u.WantsToUpdate(Offer("1.6.0", zip, Exe))); Assert.False(u.WantsToUpdate(Offer("1.5.0", zip, Exe))); Assert.False(u.WantsToUpdate(Offer("1.4.9", zip, Exe)));
        Assert.True(u.WantsToUpdate(Offer("1.10.0", zip, Exe)), "1.10 is newer than 1.5 (numeric, not text, comparison)");
        u.State.FailCounts["1.6.0"] = 5; Assert.False(u.WantsToUpdate(Offer("1.6.0", zip, Exe)), "abandoned only after repeated failures"); u.State.FailCounts["1.6.0"] = 1; Assert.True(u.WantsToUpdate(Offer("1.6.0", zip, Exe)), "one failure is retried, not banned");
        u.State.LastAttemptUtc = t; clock = t.AddMinutes(10); Assert.False(u.WantsToUpdate(Offer("1.7.0", zip, Exe)), "backs off after an attempt");
        clock = t.AddMinutes(31); Assert.True(u.WantsToUpdate(Offer("1.7.0", zip, Exe)));
        u.State.PendingVersion = "1.7.0"; Assert.False(u.WantsToUpdate(Offer("1.8.0", zip, Exe)), "one update at a time");
    }

    [Fact]
    public async Task Apply_records_the_pending_update_and_launches_a_detached_swap_script()
    {
        var p = new FakeProc(); var u = Make("1.0.0", p);
        var staged = Path.Combine(Data, "updates", "2.0.0", "new", "viro-agent.exe"); Directory.CreateDirectory(Path.GetDirectoryName(staged)!); File.WriteAllBytes(staged, Exe);
        await u.ApplyAsync(staged, "2.0.0", "ViroAgent", default);
        Assert.Equal("2.0.0", Make("1.0.0").State.PendingVersion);   // persisted
        Assert.Contains(p.Calls, c => c.StartsWith("schtasks.exe /create /tn ViroAgentUpdate") && c.Contains("/ru SYSTEM") && c.Contains("apply-update.ps1"));   // its own process tree, not a child of the service
        Assert.Contains(p.Calls, c => c == "schtasks.exe /run /tn ViroAgentUpdate"); Assert.Contains(p.Calls, c => c.StartsWith("powershell.exe") && c.Contains("-AllowStartIfOnBatteries"));
        var script = File.ReadAllText(Path.Combine(Data, "apply-update.ps1"));
        Assert.Contains("sc.exe stop $svc", script); Assert.Contains("CopyRetry $staged $exe", script); Assert.Contains("rolling back", script); Assert.Contains("update-rolled-back.json", script);
        Assert.Contains("CopyRetry $staged $exe", script);   // a locked executable is retried, not fatal
        Assert.Contains("catch { RollBack", script);                 // any failure restores the previous executable and restarts the service
        Assert.Contains("schtasks.exe /delete /tn ViroAgentUpdate", script);
        Assert.True(script.IndexOf("CopyRetry $exe $backup") < script.IndexOf("CopyRetry $staged $exe"), "the current executable is backed up before it is replaced");
        Assert.Contains("Stop-Process -Force", script); Assert.Contains("'viro-agent', 'viro-compute'", script);   // user-session processes lock the exe too
        Assert.Contains("$confirmSeconds = 300", script);
        Assert.Contains("$stagedCompute = $null", script);
    }

    [Fact]
    public void The_swap_script_also_replaces_the_compute_worker_when_the_package_carries_one()
    {
        var script = SelfUpdater.BuildScript("ViroAgent", @"C:\Program Files\Viro\Agent", @"C:\d\new\viro-agent.exe", "2.0.0", @"C:\ProgramData\Viro\Agent", @"C:\d\new\viro-compute.exe");
        Assert.Contains(@"$stagedCompute = 'C:\d\new\viro-compute.exe'", script);
        Assert.Contains("CopyRetry $stagedCompute $computeExe", script);
        Assert.Contains("CopyRetry $computeBackup $computeExe", script);   // rollback restores it too
        Assert.Throws<ArgumentException>(() => SelfUpdater.BuildScript("ViroAgent", @"C:\x", @"C:\d\a.exe", "2.0.0", @"C:\y", @"C:\d`whoami`.exe"));
    }

    [Theory]
    [InlineData("ViroAgent'; calc; '", @"C:\Program Files\Viro\Agent", "2.0.0")]
    [InlineData("ViroAgent", @"C:\Program Files\Viro\Agent'; calc; '", "2.0.0")]
    [InlineData("ViroAgent", @"C:\x`whoami`", "2.0.0")]
    [InlineData("ViroAgent", @"C:\x$env:USERNAME", "2.0.0")]
    [InlineData("ViroAgent", @"C:\Program Files\Viro\Agent", "2.0.0'; calc")]
    [InlineData("ViroAgent", @"relative\path", "2.0.0")]
    public void The_swap_script_refuses_values_that_could_inject_commands(string svc, string dir, string ver) =>
        Assert.Throws<ArgumentException>(() => SelfUpdater.BuildScript(svc, dir, @"C:\d\new\viro-agent.exe", ver, @"C:\ProgramData\Viro\Agent"));

    [Fact]
    public void A_confirmed_update_writes_the_marker_the_script_waits_for_and_reports_success_once()
    {
        var u = Make("2.0.0"); u.State.PendingVersion = "2.0.0"; u.State.PreviousVersion = "1.0.0"; u.State.LastAttemptUtc = DateTime.UtcNow;
        u.ConfirmIfPending();
        Assert.Null(u.State.LastAttemptUtc);   // a success must not hold back the next release
        Assert.Equal("2.0.0", File.ReadAllText(Path.Combine(Data, "update-confirmed.txt")));
        var r = u.TakeResult()!; Assert.Equal(("2.0.0", "ok"), (r.Version, r.Status));
        u.AckResult(); Assert.Null(u.TakeResult()); Assert.Null(Make("2.0.0").State.LastResult);   // acknowledged results do not repeat after a restart
        Make("2.0.0").ConfirmIfPending();   // nothing pending: no effect
    }

    [Fact]
    public void After_a_rollback_the_agent_reports_it_and_retries_the_version_after_a_backoff()
    {
        File.WriteAllText(Path.Combine(Data, "update-rolled-back.json"), "{\"version\":\"2.0.0\",\"reason\":\"the new agent did not confirm within 300 seconds\"}");
        var u = Make("1.0.0"); u.RecoverOnStartup();
        Assert.Equal("rolled_back", u.State.LastResult!.Status); Assert.Contains("did not confirm", u.State.LastResult.Detail);
        Assert.Contains("2.0.0", u.State.Blocked); Assert.Equal(1, u.State.FailCounts["2.0.0"]);
        u.State.LastAttemptUtc = DateTime.UtcNow; Assert.False(u.WantsToUpdate(Offer("2.0.0", Zip(("viro-agent.exe", Exe)), Exe)), "waits before the retry");
        u.State.LastAttemptUtc = DateTime.UtcNow.AddDays(-2); Assert.True(u.WantsToUpdate(Offer("2.0.0", Zip(("viro-agent.exe", Exe)), Exe)), "then tries again");
        Assert.False(File.Exists(Path.Combine(Data, "update-rolled-back.json")));
    }

    [Fact]
    public void A_restart_that_lands_on_a_different_version_than_the_pending_one_is_reported_failed()
    {
        var u = Make("1.0.0"); u.State.PendingVersion = "2.0.0"; File.WriteAllText(Path.Combine(Data, "update-state.json"), JsonSerializer.Serialize(u.State));
        var again = Make("1.0.0"); again.RecoverOnStartup();
        Assert.Equal("failed", again.State.LastResult!.Status); Assert.Null(again.State.PendingVersion);
    }

    [Theory] [InlineData("1.10.0", "1.9.0", 1)] [InlineData("2.0", "2.0.0", 0)] [InlineData("1.0.9", "1.0.10", -1)]
    public void Versions_compare_numerically(string a, string b, int expected) => Assert.Equal(expected, SelfUpdater.CompareVersions(a, b));
}

public class IntegrityTests : IDisposable
{
    readonly string _dir = Path.Combine(Path.GetTempPath(), "viro-int-" + Guid.NewGuid().ToString("N"));
    public IntegrityTests() => Directory.CreateDirectory(_dir);
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }
    const string Exe = @"C:\Program Files\Viro\Agent\viro-agent.exe";

    [Fact] public void A_service_matching_the_installer_has_no_issue() => Assert.Null(Integrity.ServiceIssue(2, "LocalSystem", "\"" + Exe + "\"", Exe));
    [Fact] public void Service_drift_is_described()
    {
        Assert.Contains("not registered", Integrity.ServiceIssue(null, null, null, Exe));
        Assert.Contains("instead of", Integrity.ServiceIssue(2, "LocalSystem", @"C:\Temp\evil.exe", Exe));
        Assert.Contains("start type", Integrity.ServiceIssue(3, "LocalSystem", Exe, Exe));
        Assert.Contains("start type", Integrity.ServiceIssue(4, "LocalSystem", Exe, Exe));
        Assert.Contains("LocalSystem", Integrity.ServiceIssue(2, @"NT AUTHORITY\LocalService", Exe, Exe));
    }
    [Fact] public void The_executable_hash_is_correct_cached_and_recomputed_when_the_file_changes()
    {
        var f = Path.Combine(_dir, "a.exe"); File.WriteAllText(f, "one");
        var h1 = Integrity.Sha256Of(f); Assert.Equal(Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("one"))).ToLowerInvariant(), h1);
        Assert.Equal(h1, Integrity.Sha256Of(f));
        File.WriteAllText(f, "two-changed"); Assert.NotEqual(h1, Integrity.Sha256Of(f));
    }
    [Fact] public void An_unsigned_binary_is_reported_unsigned() { var f = Path.Combine(_dir, "u.exe"); File.WriteAllBytes(f, Encoding.ASCII.GetBytes("MZ")); Assert.False(Integrity.Signature(f).signed); }
    [Fact] public void A_folder_readable_by_ordinary_users_is_reported_exposed_until_it_is_protected()
    {
        Assert.False(Integrity.DataDirProtected(_dir));       // temp folders inherit access for the current user
        var locked = Path.Combine(_dir, "locked"); Directory.CreateDirectory(locked); Installer.ProtectDataDirectory(locked);
        Assert.True(Integrity.DataDirProtected(locked));
    }
    [Fact] public void Integrity_collection_for_this_process_produces_a_complete_report()
    {
        var o = System.Text.Json.JsonSerializer.SerializeToElement(Integrity.Collect("ViroAgent", false));
        Assert.Equal(64, o.GetProperty("exeSha256").GetString()!.Length); Assert.True(o.TryGetProperty("signed", out _));
    }
}
