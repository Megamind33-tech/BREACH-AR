using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Management;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace WorkCare.QuickCheck;

/// <summary>
/// The deep Windows audit (WorkCare Plus). Read-only, like everything in QuickCheck: it reads settings, registry values, event logs and WMI, and changes nothing.
/// Each reading is independent. A value that cannot be read (no administrator rights, an unusual Windows edition, another language) is left out, and the matching rule is
/// skipped and reported as not measured. Nothing is guessed. Facts come from the machine; only the Windows support dates come from a table in this file, and that rule is labelled inferred.
/// </summary>
public static class DeepInspection
{
    /// <summary>What the deep audit looks at, by name. The free scan lists these as "not run" and says nothing about what they would find.</summary>
    public static readonly (string Id, string Title, string Why)[] Catalogue =
    [
        ("deep.bitlocker", "Drive encryption", "Whether the system drive is encrypted, so a lost or stolen PC cannot simply be read."),
        ("deep.secure_boot", "Secure Boot and security chip", "Whether the firmware verifies what starts before Windows, and whether a TPM protects keys."),
        ("deep.update_age", "Windows update state", "How long since Windows last installed an update, and whether a restart is waiting."),
        ("deep.os_support", "Windows support status", "Whether Microsoft still provides security updates for this version of Windows."),
        ("deep.defender_signatures", "Defender freshness", "How old the virus definitions are and when Defender last scanned."),
        ("deep.uac", "Risky Windows settings", "User Account Control, the old SMBv1 protocol, Remote Desktop, automatic sign-in and the Guest account."),
        ("deep.bluescreens", "The last 30 days of reliability", "Blue-screen crashes, unexpected shutdowns, disk errors and crashing programs, from the Windows event log."),
        ("deep.wifi_security", "Wi-Fi security", "Whether the connected Wi-Fi network is open or uses outdated encryption."),
    ];

    public static JsonObject Run(CancellationToken ct, Action<string>? stage = null)
    {
        var deep = new JsonObject();
        void Do(string name, Action a) { ct.ThrowIfCancellationRequested(); stage?.Invoke(name); try { a(); } catch (OperationCanceledException) { throw; } catch { /* unreadable: left out, reported as not measured */ } }
        Do("encryption", () => { var e = Encryption(); if (e is not null) deep["encryption"] = e; if (SecureBoot() is bool sb) deep["secureBoot"] = sb; if (Tpm() is { } t) deep["tpm"] = t; });
        Do("updates", () => { deep["updates"] = Updates(); if (OsSupport() is { } os) deep["os"] = os; });
        Do("defender", () => { if (DefenderFreshness() is { } d) deep["defender"] = d; });
        Do("settings", () => { deep["settings"] = Settings(); if (Wifi() is { } w) deep["wifi"] = w; if (Startup() is { } s) deep["startup"] = s; });
        Do("reliability", () => { if (Reliability(ct) is { } r) deep["reliability"] = r; });
        return deep;
    }

    // ------------------------------------------------------------------------------------------ helpers
    static object? Reg(RegistryHive hive, string path, string name) { try { using var b = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64); using var k = b.OpenSubKey(path); return k?.GetValue(name); } catch { return null; } }
    static bool RegKeyExists(RegistryHive hive, string path) { try { using var b = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64); using var k = b.OpenSubKey(path); return k is not null; } catch { return false; } }
    static List<ManagementBaseObject> Wmi(string ns, string wql) { using var s = new ManagementObjectSearcher(new ManagementScope($@"\\.\{ns}"), new ObjectQuery(wql)); return [.. s.Get().Cast<ManagementBaseObject>()]; }

    // ------------------------------------------------------------------------------------------ encryption, boot, TPM
    /// <summary>Administrator rights give the authoritative WMI answer. Without them, the Explorer property is used only for the two values whose meaning is certain (1 on, 2 off); anything else is "not measured", never a guess.</summary>
    static JsonObject? Encryption()
    {
        var sysRoot = Path.GetPathRoot(Environment.SystemDirectory)?.TrimEnd('\\') ?? "C:";
        try
        {
            var v = Wmi(@"root/CIMv2/Security/MicrosoftVolumeEncryption", $"SELECT ProtectionStatus,DriveLetter FROM Win32_EncryptableVolume WHERE DriveLetter='{sysRoot}'").FirstOrDefault();
            if (v is not null) { var ps = Convert.ToInt32(v["ProtectionStatus"] ?? -1); if (ps is 0 or 1) return new JsonObject { ["systemDriveProtected"] = ps == 1, ["source"] = "wmi" }; }
        }
        catch { /* not elevated */ }
        try
        {
            var t = Type.GetTypeFromProgID("Shell.Application"); if (t is null) return null;
            dynamic shell = Activator.CreateInstance(t)!; dynamic ns = shell.NameSpace(sysRoot + "\\"); var p = ns.Self.ExtendedProperty("System.Volume.BitLockerProtection");
            if (p is int i && i is 1 or 2) return new JsonObject { ["systemDriveProtected"] = i == 1, ["source"] = "shell" };
        }
        catch { }
        return null;
    }
    static bool? SecureBoot() => Reg(RegistryHive.LocalMachine, @"SYSTEM\CurrentControlSet\Control\SecureBoot\State", "UEFISecureBootEnabled") is int v ? v == 1 : null;   // missing key: legacy BIOS or unreadable, so no claim
    static JsonObject? Tpm()
    {
        try { var t = Wmi(@"root/CIMv2/Security/MicrosoftTpm", "SELECT IsEnabled_InitialValue,IsActivated_InitialValue,SpecVersion FROM Win32_Tpm").FirstOrDefault(); if (t is null) return new JsonObject { ["present"] = false }; return new JsonObject { ["present"] = true, ["ready"] = Convert.ToBoolean(t["IsEnabled_InitialValue"] ?? false) && Convert.ToBoolean(t["IsActivated_InitialValue"] ?? false) }; }
        catch { return null; }          // Windows only lets administrators ask: unknown, not "absent"
    }

    // ------------------------------------------------------------------------------------------ updates and support
    static JsonObject Updates()
    {
        var o = new JsonObject();
        try
        {
            var dates = Wmi("root/cimv2", "SELECT InstalledOn FROM Win32_QuickFixEngineering").Select(h => h["InstalledOn"]?.ToString()).Select(s => DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var d) || DateTime.TryParse(s, out d) ? (DateTime?)d : null).Where(d => d is not null).Select(d => d!.Value).ToList();
            if (dates.Count > 0) o["lastInstalledDaysAgo"] = Math.Max(0, (int)(DateTime.Now - dates.Max()).TotalDays);
        }
        catch { }
        o["pendingReboot"] = RegKeyExists(RegistryHive.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired") || RegKeyExists(RegistryHive.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending");
        return o;
    }
    /// <summary>End of standard (Home and Pro) support by Windows build. This is a published table, so the rule that uses it is labelled inferred. Enterprise, Education and LTSC have different dates and are skipped.</summary>
    static readonly (int From, int To, string Ends)[] Support =
    [
        (19041, 19045, "2025-10-14"), (22000, 22000, "2023-10-10"), (22621, 22621, "2024-10-08"), (22631, 22631, "2025-11-11"), (26100, 26100, "2026-10-13"), (26200, 26299, "2027-10-12"),
    ];
    static JsonObject? OsSupport()
    {
        var os = Wmi("root/cimv2", "SELECT Caption,BuildNumber FROM Win32_OperatingSystem").FirstOrDefault(); var caption = os?["Caption"]?.ToString() ?? ""; var build = os?["BuildNumber"]?.ToString();
        if (build is null || !int.TryParse(build, out var b) || System.Text.RegularExpressions.Regex.IsMatch(caption, "Enterprise|Education|LTSC|IoT|Server", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return null;
        foreach (var (from, to, ends) in Support) if (b >= from && b <= to) return new JsonObject { ["build"] = build, ["supportEnds"] = ends, ["daysSinceSupportEnded"] = (int)(DateTime.Now.Date - DateTime.Parse(ends, CultureInfo.InvariantCulture)).TotalDays };
        return null;      // a build newer than this table: no claim
    }

    // ------------------------------------------------------------------------------------------ Defender freshness
    static JsonObject? DefenderFreshness()
    {
        var s = Wmi(@"root/Microsoft/Windows/Defender", "SELECT AntivirusSignatureLastUpdated,QuickScanEndTime FROM MSFT_MpComputerStatus").FirstOrDefault(); if (s is null) return null;
        var o = new JsonObject();
        if (s["AntivirusSignatureLastUpdated"] is string sig && ManagementDateTimeConverter.ToDateTime(sig) is var sd && sd.Year > 2000) o["signatureAgeDays"] = Math.Max(0, (int)(DateTime.Now - sd).TotalDays);
        if (s["QuickScanEndTime"] is string q && ManagementDateTimeConverter.ToDateTime(q) is var qd && qd.Year > 2000) o["daysSinceQuickScan"] = Math.Max(0, (int)(DateTime.Now - qd).TotalDays);
        return o.Count == 0 ? null : o;
    }

    // ------------------------------------------------------------------------------------------ risky settings, Wi-Fi, start-up
    static JsonObject Settings()
    {
        var o = new JsonObject();
        if (Reg(RegistryHive.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "EnableLUA") is int lua) o["uacEnabled"] = lua != 0; else o["uacEnabled"] = true;     // absent means Windows' default, which is on
        if (Reg(RegistryHive.LocalMachine, @"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters", "SMB1") is int smb) o["smb1Enabled"] = smb != 0;                                      // absent: unknown, left out
        if (Reg(RegistryHive.LocalMachine, @"SYSTEM\CurrentControlSet\Control\Terminal Server", "fDenyTSConnections") is int rdp) o["rdpEnabled"] = rdp == 0;
        o["autoLogon"] = Reg(RegistryHive.LocalMachine, @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon", "AutoAdminLogon")?.ToString() == "1";
        try { var g = Wmi("root/cimv2", "SELECT Disabled FROM Win32_UserAccount WHERE LocalAccount=True AND Name='Guest'").FirstOrDefault(); if (g is not null) o["guestEnabled"] = !Convert.ToBoolean(g["Disabled"] ?? true); } catch { }
        return o;
    }
    /// <summary>Parses the English output of "netsh wlan show interfaces". On another Windows language the labels differ, so nothing is claimed. The network name is never read or stored.</summary>
    static JsonObject? Wifi()
    {
        var psi = new ProcessStartInfo("netsh", "wlan show interfaces") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
        using var p = Process.Start(psi); if (p is null) return null; var text = p.StandardOutput.ReadToEnd(); p.WaitForExit(4000);
        string? Field(string name) => text.Split('\n').Select(l => l.Split(':', 2)).Where(a => a.Length == 2 && a[0].Trim().Equals(name, StringComparison.OrdinalIgnoreCase)).Select(a => a[1].Trim()).FirstOrDefault();
        if (!(Field("State")?.Equals("connected", StringComparison.OrdinalIgnoreCase) ?? false)) return null;
        var auth = Field("Authentication")?.ToLowerInvariant(); if (auth is null) return null;
        var norm = auth.Contains("wpa3") ? "wpa3" : auth.Contains("wpa2") ? "wpa2" : auth.Contains("wpa") ? "wpa" : auth.Contains("wep") || auth.Contains("shared") ? "wep" : auth.Contains("open") ? "open" : null;
        return norm is null ? null : new JsonObject { ["security"] = norm };
    }
    static JsonObject? Startup() { try { return new JsonObject { ["count"] = Wmi("root/cimv2", "SELECT Name FROM Win32_StartupCommand").Count }; } catch { return null; } }

    // ------------------------------------------------------------------------------------------ the last 30 days
    static int CountEvents(string log, string xpath, CancellationToken ct, Action<EventRecord>? each = null)
    {
        var n = 0; using var reader = new EventLogReader(new EventLogQuery(log, PathType.LogName, xpath));
        for (EventRecord? e = reader.ReadEvent(); e is not null; e = reader.ReadEvent()) { using (e) { ct.ThrowIfCancellationRequested(); n++; each?.Invoke(e); } if (n > 5000) break; }
        return n;
    }
    const string Window = "TimeCreated[timediff(@SystemTime) <= 2592000000]";
    static JsonObject? Reliability(CancellationToken ct)
    {
        var o = new JsonObject(); var any = false;
        try { o["bluescreens30d"] = CountEvents("System", $"*[System[Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting'] and (EventID=1001) and {Window}]]", ct); any = true; } catch (EventLogException) { }
        try { var k = CountEvents("System", $"*[System[Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=41) and {Window}]]", ct); var d = CountEvents("System", $"*[System[(EventID=6008) and {Window}]]", ct); o["unexpectedShutdowns30d"] = Math.Max(k, d); any = true; } catch (EventLogException) { }
        try { o["diskErrors30d"] = CountEvents("System", $"*[System[Provider[@Name='disk'] and (EventID=7 or EventID=11 or EventID=15 or EventID=51 or EventID=153) and {Window}]]", ct); any = true; } catch (EventLogException) { }
        try
        {
            var apps = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var n = CountEvents("Application", $"*[System[Provider[@Name='Application Error'] and (EventID=1000) and {Window}]]", ct, e => { var a = e.Properties.Count > 0 ? e.Properties[0].Value?.ToString() : null; if (!string.IsNullOrWhiteSpace(a)) apps[a] = apps.GetValueOrDefault(a) + 1; });
            o["appCrashes30d"] = n; if (apps.Count > 0) o["topCrashingApp"] = apps.OrderByDescending(x => x.Value).First().Key; any = true;
        }
        catch (EventLogException) { }
        return any ? o : null;
    }
}
