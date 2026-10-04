using System.Management;
using System.Text.Json;
using Microsoft.Win32;
using Viro.Agent.Repair;

namespace Viro.Agent;

/// <summary>
/// Security posture from Windows-native sources only (Defender WMI, Security Center, registry, BitLocker/TPM providers).
/// Viro does not have its own antivirus engine and never reports a detection Windows did not report.
/// Anything unreadable (permissions, unsupported edition) is null and shown as "not measured", never guessed.
/// </summary>
public static class SecurityCollector
{
    static List<ManagementBaseObject> Wmi(string ns, string wql)
    {
        using var s = new ManagementObjectSearcher(new ManagementScope($@"\\.\{ns}"), new ObjectQuery(wql));
        return [.. s.Get().Cast<ManagementBaseObject>()];
    }
    static bool? B(ManagementBaseObject? o, string p) => o?[p] is bool b ? b : null;
    static string? S(ManagementBaseObject? o, string p) => o?[p]?.ToString()?.Trim() is { Length: > 0 } v ? v : null;
    static string? Iso(ManagementBaseObject? o, string p)
    {
        try { return o?[p] is string t && t.Length >= 14 ? ManagementDateTimeConverter.ToDateTime(t).ToUniversalTime().ToString("O") : null; } catch { return null; }
    }
    static T? Try<T>(Func<T> f) { try { return f(); } catch { return default; } }

    public static Dictionary<string, object?> Collect()
    {
        const string def = @"root\Microsoft\Windows\Defender";
        var st = Try(() => Wmi(def, "SELECT * FROM MSFT_MpComputerStatus").FirstOrDefault());
        var pref = Try(() => Wmi(def, "SELECT EnableControlledFolderAccess,PUAProtection,EnableNetworkProtection,AttackSurfaceReductionRules_Ids,AttackSurfaceReductionRules_Actions FROM MSFT_MpPreference").FirstOrDefault());
        int? cfa = pref?["EnableControlledFolderAccess"] is null ? null : Convert.ToInt32(pref["EnableControlledFolderAccess"]);
        var products = Try(() => Wmi(@"root\SecurityCenter2", "SELECT displayName,productState FROM AntiVirusProduct")
            .Where(a => (Convert.ToUInt32(a["productState"] ?? 0u) & 0xF000) == 0x1000).Select(a => S(a, "displayName")!).ToList()) ?? [];
        var mode = S(st, "AMRunningMode");
        var defenderActive = st is not null && B(st, "AntivirusEnabled") == true && !(mode?.Contains("Passive", StringComparison.OrdinalIgnoreCase) ?? false) && !string.Equals(mode, "Not running", StringComparison.OrdinalIgnoreCase);   // "SxS Passive Mode" means another antivirus is in charge
        var other = products.Where(n => !n.Contains("Defender", StringComparison.OrdinalIgnoreCase)).ToList();

        return new()
        {
            ["engine"] = defenderActive && other.Count == 0 ? "Microsoft Defender" : other.Count > 0 ? other[0] : st is not null ? "Microsoft Defender" : null,
            ["engineIsDefender"] = defenderActive && other.Count == 0,
            ["runningMode"] = mode,
            ["tamperProtection"] = B(st, "IsTamperProtected"),
            ["behaviorMonitor"] = B(st, "BehaviorMonitorEnabled"),
            ["networkInspection"] = B(st, "NISEnabled"),
            ["signatureVersion"] = S(st, "AntivirusSignatureVersion"),
            ["signatureUpdatedAt"] = Iso(st, "AntivirusSignatureLastUpdated"),
            ["engineVersion"] = S(st, "AMEngineVersion"),
            ["lastQuickScan"] = Iso(st, "QuickScanEndTime"),
            ["lastFullScan"] = Iso(st, "FullScanEndTime"),
            ["controlledFolderAccess"] = cfa switch { 1 => "on", 2 => "audit", 0 => "off", _ => null },
            ["bitLocker"] = Try(BitLocker),
            ["secureBoot"] = Try(() => Registry.GetValue(@"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\SecureBoot\State", "UEFISecureBootEnabled", null) is int v ? v == 1 : (bool?)null),
            ["tpm"] = Try(Tpm),
            ["uacEnabled"] = Try(() => Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "EnableLUA", null) is int v ? v == 1 : (bool?)null),
            ["rdp"] = Try(Rdp),
            ["hardening"] = Try(() => Hardening(pref)),
            ["hijackingExtensions"] = Try(() => SecurityAnalysis.Analyze(new SystemFacts([], [], [], [], [], [], new(null, null, null), BrowserExtensions.Read()), []).Where(f => f.Kind == "browser-extension").Select(f => new { browser = f.Location, id = f.Name, reason = f.Evidence }).ToList()),
            ["threats"] = Try(Threats) ?? [],
        };
    }

    static object BitLocker()
    {
        var sysDrive = Path.GetPathRoot(Environment.SystemDirectory)!.TrimEnd('\\');
        var vols = Wmi(@"root\CIMV2\Security\MicrosoftVolumeEncryption", "SELECT DriveLetter,ProtectionStatus FROM Win32_EncryptableVolume");
        var v = vols.FirstOrDefault(x => string.Equals(S(x, "DriveLetter"), sysDrive, StringComparison.OrdinalIgnoreCase));
        return new { systemDrive = v is null ? "unknown" : Convert.ToInt32(v["ProtectionStatus"] ?? 2) switch { 1 => "on", 0 => "off", _ => "unknown" } };
    }

    static object? Tpm()
    {
        var t = Wmi(@"root\CIMV2\Security\MicrosoftTpm", "SELECT IsEnabled_InitialValue,IsActivated_InitialValue,SpecVersion FROM Win32_Tpm").FirstOrDefault();
        return t is null ? new { present = false } : new { present = true, enabled = t["IsEnabled_InitialValue"] as bool?, activated = t["IsActivated_InitialValue"] as bool?, specVersion = S(t, "SpecVersion") };
    }

    const string AsrRansomware = "c1db55ab-c21a-4637-bb3f-a12568109d35";
    static int? Reg(string key, string name) => Registry.GetValue(@"HKEY_LOCAL_MACHINE\" + key, name, null) is int v ? v : null;

    /// <summary>The state of the protection and privacy controls Viro can apply. null means "could not be read", never "off".</summary>
    static object Hardening(ManagementBaseObject? pref)
    {
        int? I(string p) => pref?[p] is null ? null : Convert.ToInt32(pref[p]);
        string? Mode(int? v) => v switch { 1 => "on", 2 => "audit", 0 => "off", _ => null };
        string? asr = null;
        if (pref is not null) { var ids = pref["AttackSurfaceReductionRules_Ids"] as string[] ?? []; var acts = pref["AttackSurfaceReductionRules_Actions"] as byte[] ?? []; var k = Array.FindIndex(ids, x => string.Equals(x, AsrRansomware, StringComparison.OrdinalIgnoreCase)); asr = k >= 0 && k < acts.Length ? Mode(acts[k]) : "off"; }
        const string Pol = @"SOFTWARE\Policies\Microsoft\Windows\";
        return new
        {
            pua = Mode(I("PUAProtection")), networkProtection = Mode(I("EnableNetworkProtection")), asrRansomware = asr,
            smb1Enabled = Reg(@"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters", "SMB1") is { } sm ? sm != 0 : (bool?)null,
            llmnrDisabled = Reg(@"SOFTWARE\Policies\Microsoft\Windows NT\DNSClient", "EnableMulticast") == 0,
            scriptBlockLogging = Reg(Pol + @"PowerShell\ScriptBlockLogging", "EnableScriptBlockLogging") == 1,
            telemetryLevel = Reg(Pol + "DataCollection", "AllowTelemetry"),
            advertisingIdDisabled = Reg(Pol + "AdvertisingInfo", "DisabledByGroupPolicy") == 1,
            activityHistoryDisabled = Reg(Pol + "System", "EnableActivityFeed") == 0 && Reg(Pol + "System", "UploadUserActivities") == 0,
            consumerContentDisabled = Reg(Pol + "CloudContent", "DisableWindowsConsumerFeatures") == 1,
            locationDisabled = Reg(Pol + "LocationAndSensors", "DisableLocation") == 1,
            restorePoints = Try(() => Wmi(@"root\CIMV2", "SELECT ID FROM Win32_ShadowCopy").Count),
            systemRestoreOff = Reg(@"SOFTWARE\Policies\Microsoft\Windows NT\SystemRestore", "DisableSR") == 1,
        };
    }

    static object Rdp()
    {
        var deny = Registry.GetValue(@"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Terminal Server", "fDenyTSConnections", null) as int?;
        var nla = Registry.GetValue(@"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp", "UserAuthentication", null) as int?;
        return new { enabled = deny is null ? (bool?)null : deny == 0, networkLevelAuth = nla is null ? (bool?)null : nla == 1 };
    }

    static List<object> Threats()
    {
        const string def = @"root\Microsoft\Windows\Defender";
        var names = new Dictionary<string, (string name, int sev, bool active)>();
        foreach (var t in Wmi(def, "SELECT ThreatID,ThreatName,SeverityID,IsActive FROM MSFT_MpThreat")) names[S(t, "ThreatID") ?? ""] = (S(t, "ThreatName") ?? "unknown", Convert.ToInt32(t["SeverityID"] ?? 0), B(t, "IsActive") == true);
        var since = DateTime.UtcNow.AddDays(-30);
        return [.. Wmi(def, "SELECT ThreatID,InitialDetectionTime,ActionSuccess,Resources FROM MSFT_MpThreatDetection")
            .Select(d => (d, at: Iso(d, "InitialDetectionTime")))
            .Where(x => x.at is not null && DateTime.Parse(x.at).ToUniversalTime() >= since)
            .OrderByDescending(x => x.at).Take(20)
            .Select(x => { names.TryGetValue(S(x.d, "ThreatID") ?? "", out var n); return (object)new { name = n.name ?? "unknown", severity = n.sev switch { 5 => "severe", 4 => "high", 2 => "moderate", 1 => "low", _ => "unknown" }, active = n.active, detectedAt = x.at, remediated = B(x.d, "ActionSuccess"), resources = (x.d["Resources"] as string[] ?? []).Take(3).ToArray() }; })];
    }
}

// ---------------------------------------------------------------------------------------------------------------------
public sealed class SecurityStatusHandler : IJobHandler
{
    public string Type => "security.status";
    public Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct) => Task.FromResult(new JobOutcome(true, SecurityCollector.Collect()));
}

/// <summary>Defender scan / signature update via the documented Defender PowerShell module (fixed command text only).</summary>
public sealed class DefenderActionHandler(string type, Func<JsonElement, (string script, TimeSpan timeout)> plan, IProcessRunner? proc = null, Func<Dictionary<string, object?>>? collect = null) : IJobHandler
{
    public string Type => type;
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var read = collect ?? SecurityCollector.Collect;
        var before = read();
        if (before["engineIsDefender"] is not true)
            return new(false, before, $"Microsoft Defender is not the active antivirus on this PC (engine: {before["engine"] ?? "none detected"}); this action can only manage Defender.");
        var (script, timeout) = plan(ctx.Job.Params);
        var started = DateTime.UtcNow;
        var r = await (proc ?? new SystemProcessRunner()).RunAsync(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"{script}\"", timeout, ct);
        var after = read();
        var result = new { action = type, durationSeconds = (int)(DateTime.UtcNow - started).TotalSeconds, exitCode = r.ExitCode, output = r.Output.Length > 800 ? r.Output[^800..] : r.Output.Trim(), before, after };
        if (r.TimedOut) return new(false, result, $"timed out after {(int)timeout.TotalMinutes} minutes");
        if (r.ExitCode != 0) return new(false, result, r.Output.Contains("0x80070005") || r.Output.Contains("Access is denied", StringComparison.OrdinalIgnoreCase) ? "access denied: Defender actions need the agent to run as SYSTEM/administrator" : "Defender reported an error: " + (r.Output.Length > 300 ? r.Output[..300] : r.Output.Trim()));
        return new(true, result);
    }

    public static DefenderActionHandler Scan(IProcessRunner? proc = null, Func<Dictionary<string, object?>>? collect = null) => new("security.scan", p =>
    {
        var full = p.TryGetProperty("scanType", out var t) && t.GetString() == "full";   // scanType is validated server-side; anything else is a quick scan
        return (full ? "Start-MpScan -ScanType FullScan" : "Start-MpScan -ScanType QuickScan", full ? TimeSpan.FromHours(6) : TimeSpan.FromMinutes(45));
    }, proc, collect);
    /// <summary>Removes the threats Defender currently lists as active (Remove-MpThreat). It acts only on Defender's own detections.</summary>
    public static DefenderActionHandler Remediate(IProcessRunner? proc = null, Func<Dictionary<string, object?>>? collect = null) => new("security.remediate", _ => ("Remove-MpThreat", TimeSpan.FromMinutes(15)), proc, collect);
    public static DefenderActionHandler UpdateSignatures(IProcessRunner? proc = null, Func<Dictionary<string, object?>>? collect = null) => new("security.update-signatures", _ => ("Update-MpSignature", TimeSpan.FromMinutes(10)), proc, collect);
}
