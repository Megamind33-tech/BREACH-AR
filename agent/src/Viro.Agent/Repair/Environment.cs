using System.Diagnostics;
using System.Management;
using System.ServiceProcess;
using System.Net;
using System.Net.NetworkInformation;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Viro.Agent.Repair;

/// <summary>Where things live on this machine. Tests point every path at a sandbox.</summary>
public partial class RepairEnv
{
    public virtual string WindowsDir => Environment.GetFolderPath(Environment.SpecialFolder.Windows);
    public virtual string SystemDrive => Path.GetPathRoot(Environment.SystemDirectory)!;
    public virtual string ProgramDataDir => Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
    public virtual string StateDir => Path.Combine(AgentConfig.DataDir, "repairs");

    public virtual bool NetworkLinkUp() => NetworkInterface.GetIsNetworkAvailable();

    /// <summary>Whether the PC is running on battery and the charge percentage, or null when it cannot be read.</summary>
    public virtual (bool onBattery, int percent)? Battery() => Native.GetSystemPowerStatus(out var p) && p.ACLineStatus != 255 && p.BatteryLifePercent <= 100 ? (p.ACLineStatus == 0, p.BatteryLifePercent) : null;

    /// <summary>Average processor load over a few seconds, or null when it cannot be measured.</summary>
    public virtual async Task<double?> CpuBusyPercentAsync(CancellationToken ct)
    {
        Collectors.CpuPercent(); var samples = new List<double>();
        for (var i = 0; i < 3; i++) { await Task.Delay(1000, ct); if (Collectors.CpuPercent() is { } c) samples.Add(c); }
        return samples.Count == 0 ? null : samples.Average();
    }
    public virtual async Task<bool> CanResolveAsync(CancellationToken ct)
    {
        try { return (await Dns.GetHostAddressesAsync("www.msftconnecttest.com", ct)).Length > 0; } catch (Exception e) when (e is System.Net.Sockets.SocketException or ArgumentException) { return false; }
    }

    /// <summary>Registry Run locations we can enable/disable through the StartupApproved mechanism.</summary>
    public virtual IReadOnlyList<StartupSlot> StartupSlots()
    {
        const string run = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", wow = @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run";
        const string ap = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\";
        var list = new List<StartupSlot>
        {
            new(@"HKLM\" + run, () => Registry.LocalMachine.OpenSubKey(run), w => w ? Registry.LocalMachine.CreateSubKey(ap + "Run", true) : Registry.LocalMachine.OpenSubKey(ap + "Run")),
            new(@"HKLM\" + wow, () => Registry.LocalMachine.OpenSubKey(wow), w => w ? Registry.LocalMachine.CreateSubKey(ap + "Run32", true) : Registry.LocalMachine.OpenSubKey(ap + "Run32")),
        };
        foreach (var sid in Registry.Users.GetSubKeyNames().Where(n => Regex.IsMatch(n, @"^S-1-5-21-[\d-]+$")))
        {
            var s = sid;
            list.Add(new($@"HKU\{s}\{run}", () => Registry.Users.OpenSubKey(s + "\\" + run), w => w ? Registry.Users.CreateSubKey(s + "\\" + ap + "Run", true) : Registry.Users.OpenSubKey(s + "\\" + ap + "Run")));
        }
        // Startup folders: the shared one, and one for each real user. Same StartupApproved switch, under its StartupFolder key.
        const string apf = ap + "StartupFolder";
        list.Add(new(@"HKLM\Startup folder (all users)", () => null, w => w ? Registry.LocalMachine.CreateSubKey(apf, true) : Registry.LocalMachine.OpenSubKey(apf), Path.Combine(ProgramDataDir, @"Microsoft\Windows\Start Menu\Programs\StartUp")));
        foreach (var sid in Registry.Users.GetSubKeyNames().Where(n => Regex.IsMatch(n, @"^S-1-5-21-[\d-]+$")))
        {
            var s = sid; using var sf = Registry.Users.OpenSubKey(s + @"\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders");
            if (sf?.GetValue("Startup") is not string folder) continue;
            list.Add(new($@"HKU\{s}\Startup folder", () => null, w => w ? Registry.Users.CreateSubKey(s + "\\" + apf, true) : Registry.Users.OpenSubKey(s + "\\" + apf), folder));
        }
        return list;
    }

    /// <summary>Real user profile folders (excludes Public/Default/system profiles).</summary>
    public virtual IEnumerable<string> UserProfiles()
    {
        var users = Path.Combine(SystemDrive, "Users");
        if (!Directory.Exists(users)) yield break;
        var skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Public", "Default", "Default User", "All Users", "defaultuser0" };
        foreach (var d in Directory.EnumerateDirectories(users))
        {
            if (skip.Contains(Path.GetFileName(d))) continue;
            FileAttributes a; try { a = File.GetAttributes(d); } catch { continue; }
            if ((a & FileAttributes.ReparsePoint) != 0) continue;
            yield return d;
        }
    }
}

public sealed record ProcResult(int ExitCode, string Output, bool TimedOut);

public interface IProcessRunner
{
    Task<ProcResult> RunAsync(string exe, string args, TimeSpan timeout, CancellationToken ct, Encoding? encoding = null);
}

/// <summary>Runs a fixed executable with fixed/validated arguments. Never invoked with a shell and never with user-supplied text.</summary>
public sealed class SystemProcessRunner : IProcessRunner
{
    public async Task<ProcResult> RunAsync(string exe, string args, TimeSpan timeout, CancellationToken ct, Encoding? encoding = null)
    {
        var psi = new ProcessStartInfo(exe, args)
        {
            CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = encoding ?? Encoding.Default, StandardErrorEncoding = encoding ?? Encoding.Default,
        };
        using var p = Process.Start(psi) ?? throw new InvalidOperationException($"could not start {exe}");
        var sb = new StringBuilder();
        p.OutputDataReceived += (_, e) => { if (e.Data is not null) lock (sb) sb.AppendLine(e.Data); };
        p.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (sb) sb.AppendLine(e.Data); };
        p.BeginOutputReadLine(); p.BeginErrorReadLine();
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        linked.CancelAfter(timeout);
        try { await p.WaitForExitAsync(linked.Token); }
        catch (OperationCanceledException)
        {
            try { p.Kill(entireProcessTree: true); } catch { /* already gone */ }
            ct.ThrowIfCancellationRequested();
            return new ProcResult(-1, sb.ToString(), TimedOut: true);
        }
        p.WaitForExit(); // flush async readers
        return new ProcResult(p.ExitCode, sb.ToString(), false);
    }
}

public sealed record FailedService(string Name, string? DisplayName, int ExitCode);

public interface IServices
{
    string? Status(string name);                    // null if the service does not exist
    string? StartMode(string name);
    Task StopAsync(string name, TimeSpan timeout);
    Task StartAsync(string name, TimeSpan timeout);
    IReadOnlyList<FailedService> FailedAutoServices();
}

public sealed class WindowsServices : IServices
{
    public string? Status(string name)
    {
        try { using var s = new ServiceController(name); return s.Status.ToString(); } catch (InvalidOperationException) { return null; }
    }
    public string? StartMode(string name)
    {
        using var s = new ManagementObjectSearcher($"SELECT StartMode FROM Win32_Service WHERE Name='{name.Replace("'", "''")}'");
        return s.Get().Cast<ManagementBaseObject>().FirstOrDefault()?["StartMode"]?.ToString();
    }
    public Task StopAsync(string name, TimeSpan timeout) => Task.Run(() =>
    {
        using var s = new ServiceController(name);
        if (s.Status == ServiceControllerStatus.Stopped) return;
        s.Stop(); s.WaitForStatus(ServiceControllerStatus.Stopped, timeout);
    });
    public Task StartAsync(string name, TimeSpan timeout) => Task.Run(() =>
    {
        using var s = new ServiceController(name);
        if (s.Status == ServiceControllerStatus.Running) return;
        s.Start(); s.WaitForStatus(ServiceControllerStatus.Running, timeout);
    });
    public IReadOnlyList<FailedService> FailedAutoServices()
    {
        using var s = new ManagementObjectSearcher("SELECT Name,DisplayName,ExitCode FROM Win32_Service WHERE StartMode='Auto' AND State='Stopped'");
        return [.. s.Get().Cast<ManagementBaseObject>()
            .Select(o => new FailedService(o["Name"]!.ToString()!, o["DisplayName"]?.ToString(), Convert.ToInt32(o["ExitCode"] ?? 0)))
            .Where(f => f.ExitCode is not (0 or 1077))]; // 0 = clean stop, 1077 = trigger-start / never started
    }
}
