using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Viro.Agent.Repair;

/// <summary>
/// Protection and privacy hardening. Every control is a normal repair recipe: diagnose first, record the previous value, make the smallest
/// change, verify it by reading it back, and undo it if it cannot be verified. Nothing here installs software, exempts anything from
/// scanning, or hides from the user; each setting is a documented Windows or Microsoft Defender setting an administrator could set by hand.
/// </summary>
public interface IPolicyStore
{
    int? GetInt(string key, string name);
    void SetInt(string key, string name, int value);
    void Delete(string key, string name);
}

/// <summary>HKLM only, and only under the keys the recipes below name.</summary>
public sealed class RegistryPolicyStore : IPolicyStore
{
    const string Hklm = @"HKEY_LOCAL_MACHINE\";
    public int? GetInt(string key, string name) => Registry.GetValue(Hklm + key, name, null) is int v ? v : null;
    public void SetInt(string key, string name, int value) => Registry.SetValue(Hklm + key, name, value, RegistryValueKind.DWord);
    public void Delete(string key, string name) { using var k = Registry.LocalMachine.OpenSubKey(key, writable: true); k?.DeleteValue(name, throwOnMissingValue: false); }
}

public sealed record RegSetting(string Key, string Name, int Desired, bool AbsentOk = false);

public sealed class PolicyRecipe(string id, string title, RepairRisk risk, IReadOnlyList<RegSetting> settings, IPolicyStore? store = null, Func<IPolicyStore, bool>? applicable = null, string? notApplicable = null) : IRepairRecipe
{
    readonly IPolicyStore store = store ?? new RegistryPolicyStore();
    public string Id => id; public string Title => title; public RepairRisk Risk => risk;
    public bool AutoSafe => false; public bool Reversible => true;
    bool Ok(RegSetting s) => store.GetInt(s.Key, s.Name) is { } v ? v == s.Desired : s.AbsentOk;    // absent counts as fine only where Windows' own default is already the safe state

    public Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        if (applicable is not null && !applicable(store)) return Task.FromResult(new Finding(false, notApplicable ?? "not applicable on this PC"));
        var off = settings.Where(s => !Ok(s)).ToList();
        return Task.FromResult(new Finding(off.Count > 0, off.Count == 0 ? "already in place" : $"{off.Count} of {settings.Count} setting(s) are not set: {string.Join(", ", off.Select(o => o.Name))}",
            settings.Select(s => new { s.Key, s.Name, current = store.GetInt(s.Key, s.Name), s.Desired }).ToList()));
    }

    public Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        c.RollbackState["previous"] = settings.Select(s => new { s.Key, s.Name, value = store.GetInt(s.Key, s.Name) }).ToList();
        foreach (var s in settings) store.SetInt(s.Key, s.Name, s.Desired);
        c.After = settings.Select(s => new { s.Name, value = store.GetInt(s.Key, s.Name) }).ToList();
        return Task.CompletedTask;
    }

    public Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var bad = settings.Where(s => !Ok(s)).Select(s => s.Name).ToList();
        return Task.FromResult((bad.Count == 0, bad.Count == 0 ? "all settings read back as applied" : "did not take effect: " + string.Join(", ", bad)));
    }

    public Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        foreach (var p in saved.GetProperty("previous").EnumerateArray())
        {
            var key = p.GetProperty("key").GetString()!; var name = p.GetProperty("name").GetString()!;
            if (!settings.Any(s => s.Key == key && s.Name == name)) continue;       // a saved file can only ever touch this recipe's own settings
            if (p.GetProperty("value").ValueKind == JsonValueKind.Number) store.SetInt(key, name, p.GetProperty("value").GetInt32()); else store.Delete(key, name);
        }
        return Task.CompletedTask;
    }
}

/// <summary>Microsoft Defender preference (Set-MpPreference) with fixed command text. It refuses to act when Defender is not the active antivirus.</summary>
public sealed partial class DefenderPreferenceRecipe(string id, string title, RepairRisk risk, string read, Func<int, bool> compliant, Func<int, string> apply, int desired, string meaning) : IRepairRecipe
{
    public string Id => id; public string Title => title; public RepairRisk Risk => risk;
    public bool AutoSafe => false; public bool Reversible => true;

    static string PowerShell => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    static Task<ProcResult> Run(RepairContext c, string script, CancellationToken ct) => c.Proc.RunAsync(PowerShell, $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"{script}\"", TimeSpan.FromMinutes(2), ct);

    /// <summary>"active|value" on one line, or null when Defender cannot be queried.</summary>
    async Task<(bool active, int? value)?> Probe(RepairContext c, CancellationToken ct)
    {
        var r = await Run(c, $"$s=Get-MpComputerStatus; $v={read}; Write-Output ('VIRO|' + ($s.AntivirusEnabled -and $s.AMRunningMode -notmatch 'Passive|Not running') + '|' + $v)", ct);
        var m = Probed().Match(r.Output);
        if (r.ExitCode != 0 || !m.Success) return null;
        return (m.Groups[1].Value == "True", int.TryParse(m.Groups[2].Value, out var n) ? n : null);
    }

    public async Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var p = await Probe(c, ct);
        if (p is null) return new(false, "Microsoft Defender cannot be queried on this PC");
        if (!p.Value.active) return new(false, "Microsoft Defender is not the active antivirus here (another product is managing protection)");
        if (p.Value.value is not { } v) return new(false, "the setting could not be read");
        return new(!compliant(v), compliant(v) ? $"already {meaning}" : $"not {meaning}", new { current = v });
    }

    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var current = (await Probe(c, ct))?.value ?? throw new InvalidOperationException("the current value could not be read, so nothing was changed");
        c.RollbackState["previous"] = current;
        var r = await Run(c, apply(desired), ct);
        if (r.ExitCode != 0) throw new InvalidOperationException(r.Output.Contains("0x80070005") || r.Output.Contains("denied", StringComparison.OrdinalIgnoreCase) ? "access denied (Defender tamper protection or missing administrator rights)" : "Defender reported an error: " + (r.Output.Length > 250 ? r.Output[..250] : r.Output.Trim()));
    }

    public async Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var p = await Probe(c, ct); c.After = new { now = p?.value };
        return p?.value is { } v && compliant(v) ? (true, $"Defender now reports it {meaning}") : (false, "Defender did not keep the change (tamper protection or a policy may be overriding it)");
    }

    public async Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        var r = await Run(c, apply(saved.GetProperty("previous").GetInt32()), ct);
        if (r.ExitCode != 0) throw new InvalidOperationException("could not restore the previous Defender setting");
    }

    [GeneratedRegex(@"VIRO\|(True|False)\|(-?\d*)")] private static partial Regex Probed();
}

/// <summary>Windows Firewall on for every profile (Domain, Private, Public). The previous state of each profile is recorded.</summary>
public sealed class FirewallRecipe : IRepairRecipe
{
    public string Id => "protect.firewall"; public string Title => "Turn Windows Firewall on for every network profile";
    public RepairRisk Risk => RepairRisk.Safe; public bool AutoSafe => false; public bool Reversible => true;
    static readonly string[] Profiles = ["Domain", "Private", "Public"];
    static string PowerShell => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    static Task<ProcResult> Run(RepairContext c, string script, CancellationToken ct) => c.Proc.RunAsync(PowerShell, $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"{script}\"", TimeSpan.FromMinutes(2), ct);

    public static Dictionary<string, bool> Parse(string output) =>
        Regex.Matches(output, @"^(Domain|Private|Public)=(True|False)\s*$", RegexOptions.Multiline).ToDictionary(m => m.Groups[1].Value, m => m.Groups[2].Value == "True");
    static async Task<Dictionary<string, bool>> Read(RepairContext c, CancellationToken ct) =>
        Parse((await Run(c, "Get-NetFirewallProfile -All | ForEach-Object { $_.Name + '=' + $_.Enabled }", ct)).Output);

    public async Task<Finding> DiagnoseAsync(RepairContext c, CancellationToken ct)
    {
        var s = await Read(c, ct);
        if (s.Count < 3) return new(false, "the firewall state could not be read");
        var off = Profiles.Where(p => !s[p]).ToList();
        return new(off.Count > 0, off.Count == 0 ? "the firewall is on for every profile" : $"the firewall is off for: {string.Join(", ", off)}", s);
    }
    public async Task ApplyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        c.RollbackState["previous"] = await Read(c, ct);
        var r = await Run(c, "Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True", ct);
        if (r.ExitCode != 0) throw new InvalidOperationException("the firewall could not be changed: " + r.Output.Trim());
    }
    public async Task<(bool ok, string detail)> VerifyAsync(RepairContext c, Finding f, CancellationToken ct)
    {
        var s = await Read(c, ct); c.After = s;
        var off = Profiles.Where(p => !s.GetValueOrDefault(p)).ToList();
        return (off.Count == 0, off.Count == 0 ? "the firewall now reports on for every profile" : "still off for: " + string.Join(", ", off));
    }
    public async Task RollbackAsync(RepairContext c, JsonElement saved, CancellationToken ct)
    {
        foreach (var p in saved.GetProperty("previous").EnumerateObject().Where(p => Profiles.Contains(p.Name) && p.Value.ValueKind == JsonValueKind.False))
            await Run(c, $"Set-NetFirewallProfile -Profile {p.Name} -Enabled False", ct);
    }
}

public static class Protection
{
    const string Asr = "c1db55ab-c21a-4637-bb3f-a12568109d35";   // "Use advanced protection against ransomware"
    const string Pol = @"SOFTWARE\Policies\Microsoft\Windows\";

    static DefenderPreferenceRecipe Pref(string id, string title, RepairRisk risk, string prop, int desired, Func<int, bool> ok, string meaning) =>
        new(id, title, risk, $"$(Get-MpPreference).{prop}", ok, v => $"Set-MpPreference -{prop} {v}", desired, meaning);

    public static IEnumerable<IRepairRecipe> Create(IPolicyStore? store = null)
    {
        // ---- ransomware ----
        yield return Pref("protect.ransomware-audit", "Ransomware shield: watch protected folders (audit mode, blocks nothing)", RepairRisk.Safe, "EnableControlledFolderAccess", 2, v => v is 1 or 2, "watching protected folders");
        yield return Pref("protect.ransomware-block", "Ransomware shield: block untrusted programs from changing protected folders", RepairRisk.Review, "EnableControlledFolderAccess", 1, v => v == 1, "blocking untrusted changes to protected folders");
        yield return new DefenderPreferenceRecipe("protect.asr-ransomware", "Ransomware shield: advanced cloud protection against ransomware", RepairRisk.Safe,
            $"$(& {{ $p=Get-MpPreference; $i=@($p.AttackSurfaceReductionRules_Ids); $a=@($p.AttackSurfaceReductionRules_Actions); $k=[array]::IndexOf(@($i | ForEach-Object {{ $_.ToString().ToLower() }}),'{Asr}'); if($k -ge 0){{ [int]$a[$k] }} else {{ -1 }} }})",
            v => v is 1 or 2, v => v switch { -1 => $"Remove-MpPreference -AttackSurfaceReductionRules_Ids {Asr}", 0 => $"Add-MpPreference -AttackSurfaceReductionRules_Ids {Asr} -AttackSurfaceReductionRules_Actions Disabled", 2 => $"Add-MpPreference -AttackSurfaceReductionRules_Ids {Asr} -AttackSurfaceReductionRules_Actions AuditMode", _ => $"Add-MpPreference -AttackSurfaceReductionRules_Ids {Asr} -AttackSurfaceReductionRules_Actions Enabled" }, 1, "on");
        // ---- attacks ----
        yield return Pref("protect.pua", "Block potentially unwanted applications", RepairRisk.Safe, "PUAProtection", 1, v => v == 1, "on");
        yield return Pref("protect.network-protection", "Block connections to known malicious sites (Network Protection)", RepairRisk.Review, "EnableNetworkProtection", 1, v => v == 1, "on");
        yield return new FirewallRecipe();
        yield return new PolicyRecipe("protect.smb1-off", "Turn off the obsolete SMBv1 file-sharing protocol", RepairRisk.Safe, [new(@"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters", "SMB1", 0, AbsentOk: true)], store);
        yield return new PolicyRecipe("protect.rdp-nla", "Require Network Level Authentication for Remote Desktop", RepairRisk.Review, [new(@"SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp", "UserAuthentication", 1)], store,
            s => s.GetInt(@"SYSTEM\CurrentControlSet\Control\Terminal Server", "fDenyTSConnections") == 0, "Remote Desktop is not enabled on this PC");
        yield return new PolicyRecipe("protect.llmnr-off", "Turn off LLMNR name resolution (used in credential-capture attacks)", RepairRisk.Safe, [new(@"SOFTWARE\Policies\Microsoft\Windows NT\DNSClient", "EnableMulticast", 0)], store);
        yield return new PolicyRecipe("protect.ps-logging", "Record PowerShell script activity in the event log", RepairRisk.Safe, [new(@"SOFTWARE\Policies\Microsoft\Windows\PowerShell\ScriptBlockLogging", "EnableScriptBlockLogging", 1)], store);
        // ---- tracking and privacy ----
        yield return new PolicyRecipe("privacy.telemetry-minimum", "Limit Windows diagnostic data to the required minimum", RepairRisk.Safe, [new(Pol + "DataCollection", "AllowTelemetry", 1), new(Pol + "DataCollection", "DoNotShowFeedbackNotifications", 1)], store);
        yield return new PolicyRecipe("privacy.advertising-id", "Turn off the advertising ID used to track people across apps", RepairRisk.Safe, [new(Pol + "AdvertisingInfo", "DisabledByGroupPolicy", 1)], store);
        yield return new PolicyRecipe("privacy.activity-history", "Stop collecting and uploading activity history", RepairRisk.Safe, [new(Pol + "System", "EnableActivityFeed", 0), new(Pol + "System", "PublishUserActivities", 0), new(Pol + "System", "UploadUserActivities", 0)], store);
        yield return new PolicyRecipe("privacy.consumer-features", "Turn off tailored ads, suggestions and consumer content", RepairRisk.Safe, [new(Pol + "CloudContent", "DisableWindowsConsumerFeatures", 1), new(Pol + "CloudContent", "DisableTailoredExperiencesWithDiagnosticData", 1)], store);
        yield return new PolicyRecipe("privacy.location-off", "Turn off location services for this PC", RepairRisk.Review, [new(Pol + "LocationAndSensors", "DisableLocation", 1)], store);
    }
}
