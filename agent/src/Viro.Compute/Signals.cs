using System.Diagnostics;
using System.IO.Pipes;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Viro.Agent;

namespace Viro.Compute;

/// <summary>What the person at the PC is doing, reported by a tiny probe running in their session (a service in Session 0 cannot see input).</summary>
public sealed record UserActivity(double IdleSeconds, bool Fullscreen, DateTime AtUtc);

public static class ProbeMain
{
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("kernel32.dll")] static extern uint GetTickCount();
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize, dwTime; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT Monitor, Work; public uint Flags; }

    public static double IdleSeconds() { var i = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() }; return GetLastInputInfo(ref i) ? (GetTickCount() - i.dwTime) / 1000.0 : -1; }

    /// <summary>True when the foreground window covers its whole monitor (video, game, presentation) and is not the desktop itself.</summary>
    public static bool ForegroundIsFullscreen()
    {
        var h = GetForegroundWindow(); if (h == IntPtr.Zero) return false;
        var cls = new System.Text.StringBuilder(64); GetClassName(h, cls, 64); if (cls.ToString() is "Progman" or "WorkerW" or "Shell_TrayWnd") return false;
        if (!GetWindowRect(h, out var r)) return false;
        var mi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() }; if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;
        return r.L <= mi.Monitor.L && r.T <= mi.Monitor.T && r.R >= mi.Monitor.R && r.B >= mi.Monitor.B;
    }

    /// <summary>The probe process: connects to the worker's pipe and reports idle time and full-screen state every 2 seconds. It has no other capability.</summary>
    public static async Task<int> RunAsync(string pipeName, CancellationToken ct)
    {
        await using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(10_000, ct);
        while (!ct.IsCancellationRequested)
        {
            var msg = JsonSerializer.SerializeToUtf8Bytes(new { idle = IdleSeconds(), fullscreen = ForegroundIsFullscreen() });
            try { await PipeFrames.WriteAsync(pipe, PipeFrames.Idle, msg, ct); await Task.Delay(2000, ct); } catch { return 0; }
        }
        return 0;
    }
}

/// <summary>Service-side owner of the probe: launches it in the user's session, restarts it if the user logs out and in, and exposes the latest reading.</summary>
public sealed class UserProbeHost(ILogger log, Func<string, Process?>? launcher = null) : IDisposable
{
    NamedPipeServerStream? _pipe; Process? _proc; CancellationTokenSource? _cts;
    public UserActivity? Latest { get; private set; }

    public void EnsureRunning()
    {
        if (_proc is { HasExited: false } && Latest is { } l && DateTime.UtcNow - l.AtUtc < TimeSpan.FromSeconds(15)) return;
        Dispose();
        var name = "viro-probe-" + Guid.NewGuid().ToString("N");
        var sec = new PipeSecurity();
        sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        sec.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User!, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        if (UserSessionLauncher.ActiveUserSid() is { } sid) sec.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        _pipe = NamedPipeServerStreamAcl.Create(name, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, sec);
        _proc = (launcher ?? (n => UserSessionLauncher.Launch(Environment.ProcessPath!, $"user-probe --pipe {n}", log)))(name);
        if (_proc is null) { _pipe.Dispose(); _pipe = null; Latest = null; return; }   // nobody is signed in: idle stays unknown, so nothing runs
        _cts = new CancellationTokenSource(); var pipe = _pipe; var ct = _cts.Token;
        _ = Task.Run(async () =>
        {
            try
            {
                await pipe.WaitForConnectionAsync(ct);
                while (await PipeFrames.ReadAsync(pipe, ct) is { } m)
                    if (m.type == PipeFrames.Idle) { using var d = JsonDocument.Parse(m.payload); Latest = new(d.RootElement.GetProperty("idle").GetDouble(), d.RootElement.GetProperty("fullscreen").GetBoolean(), DateTime.UtcNow); }
            }
            catch { /* probe ended */ }
        }, ct);
    }

    /// <summary>Idle time only when the probe reported recently; otherwise unknown (which the policy treats as "do not run").</summary>
    public UserActivity? Fresh() => Latest is { } l && DateTime.UtcNow - l.AtUtc < TimeSpan.FromSeconds(10) && l.IdleSeconds >= 0 ? l : null;

    public void Dispose()
    {
        try { _cts?.Cancel(); } catch { } try { _pipe?.Dispose(); } catch { }
        try { if (_proc is { HasExited: false }) _proc.Kill(); } catch { }
        _pipe = null; _proc = null; _cts = null;
    }
}

/// <summary>Reads the machine facts the policy needs. Each reading is independent and null/false when unavailable.</summary>
public static class SignalReader
{
    static readonly string[] MaintenanceProcesses = ["TiWorker", "TrustedInstaller", "MpCmdRun", "MoUsoCoreWorker", "wuauclt", "musnotificationux"];

    [StructLayout(LayoutKind.Sequential)] struct MEMORYSTATUSEX { public uint dwLength, dwMemoryLoad; public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual; }
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX s);
    [StructLayout(LayoutKind.Sequential)] struct SYSTEM_POWER_STATUS { public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag; public uint BatteryLifeTime, BatteryFullLifeTime; }
    [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS s);

    public static (double usedPercent, long totalBytes) Memory() { var m = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() }; return GlobalMemoryStatusEx(ref m) ? (m.dwMemoryLoad, (long)m.ullTotalPhys) : (0, 8L << 30); }
    public static int? BatteryPercent() => GetSystemPowerStatus(out var p) && p.BatteryLifePercent <= 100 ? p.BatteryLifePercent : null;
    public static bool? OnBattery() => GetSystemPowerStatus(out var p) && p.ACLineStatus != 255 ? p.ACLineStatus == 0 : null;

    public static double? CpuTempC() => Viro.Agent.Care.ThermalSensors.CpuTempC();
    public static double? CriticalTripC() => Viro.Agent.Care.ThermalSensors.CriticalTripC();

    public static bool MaintenanceRunning(Func<string, bool>? isRunning = null)
    {
        isRunning ??= n => { var ps = Process.GetProcessesByName(n); foreach (var p in ps) p.Dispose(); return ps.Length > 0; };
        return MaintenanceProcesses.Any(isRunning);
    }
}
