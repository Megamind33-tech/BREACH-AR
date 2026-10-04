using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Viro.Compute;

public sealed record WorkloadSpec(string Exe, string Args, int CpuCapPercent, long MemoryLimitBytes);

/// <summary>
/// Runs a compute workload as a child process inside a Windows Job Object, so the limits are enforced by the operating system rather than
/// by the workload's good behaviour: a hard CPU cap (percent of the whole machine), a per-process memory limit, idle priority, and
/// kill-on-close (if the worker dies, the workload dies with it). This is the isolation boundary a future third-party workload will also use.
/// </summary>
public sealed class WorkloadHost : IDisposable
{
    SafeFileHandle? _job; Process? _proc; readonly object _gate = new();
    public bool IsRunning { get { lock (_gate) return _proc is { HasExited: false }; } }
    public int? ProcessId => _proc?.Id;
    public event Action<string>? OutputLine;

    public void Start(WorkloadSpec spec)
    {
        lock (_gate)
        {
            if (IsRunning) throw new InvalidOperationException("a workload is already running");
            _job?.Dispose(); _job = CreateJobObject(IntPtr.Zero, null);
            if (_job.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            ext.BasicLimitInformation.LimitFlags = LIMIT_KILL_ON_JOB_CLOSE | LIMIT_PRIORITY_CLASS | LIMIT_PROCESS_MEMORY;
            ext.BasicLimitInformation.PriorityClass = IDLE_PRIORITY_CLASS;
            ext.ProcessMemoryLimit = (UIntPtr)(ulong)Math.Max(64L * 1024 * 1024, spec.MemoryLimitBytes);
            Set(_job, 9 /* JobObjectExtendedLimitInformation */, ext);
            SetCpuCap(spec.CpuCapPercent);

            var psi = new ProcessStartInfo(spec.Exe, spec.Args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            _proc = Process.Start(psi) ?? throw new InvalidOperationException("workload did not start");
            if (!AssignProcessToJobObject(_job, _proc.Handle)) { var e = Marshal.GetLastWin32Error(); try { _proc.Kill(true); } catch { } throw new System.ComponentModel.Win32Exception(e, "could not place the workload in its job object"); }
            _proc.OutputDataReceived += (_, e) => { if (e.Data is not null) OutputLine?.Invoke(e.Data); };
            _proc.BeginOutputReadLine(); _proc.BeginErrorReadLine();
        }
    }

    /// <summary>Hard cap: percent of total machine CPU. Can be changed while running.</summary>
    public void SetCpuCap(int percent)
    {
        lock (_gate)
        {
            if (_job is null) return;
            var info = new JOBOBJECT_CPU_RATE_CONTROL_INFORMATION { ControlFlags = CPU_RATE_ENABLE | CPU_RATE_HARD_CAP, CpuRate = (uint)(Math.Clamp(percent, 1, 100) * 100) };
            Set(_job, 15 /* JobObjectCpuRateControlInformation */, info);
        }
    }

    /// <summary>Total CPU time consumed by everything in the job (user + kernel).</summary>
    public double TotalCpuSeconds()
    {
        lock (_gate)
        {
            if (_job is null) return 0;
            var info = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
            return QueryInformationJobObject(_job, 1, ref info, Marshal.SizeOf<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(), out _) ? (info.TotalUserTime + info.TotalKernelTime) / 1e7 : 0;
        }
    }

    public void Stop()
    {
        lock (_gate)
        {
            try { if (_proc is { HasExited: false }) { _proc.Kill(true); _proc.WaitForExit(3000); } } catch { }
            _proc?.Dispose(); _proc = null;
        }
    }

    public void Dispose() { Stop(); lock (_gate) { _job?.Dispose(); _job = null; } }

    static void Set<T>(SafeFileHandle job, int cls, T info) where T : struct
    {
        var size = Marshal.SizeOf<T>(); var p = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(info, p, false); if (!SetInformationJobObject(job, cls, p, size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), $"SetInformationJobObject({cls})"); }
        finally { Marshal.FreeHGlobal(p); }
    }

    const uint LIMIT_PRIORITY_CLASS = 0x20, LIMIT_PROCESS_MEMORY = 0x100, LIMIT_KILL_ON_JOB_CLOSE = 0x2000, IDLE_PRIORITY_CLASS = 0x40, CPU_RATE_ENABLE = 0x1, CPU_RATE_HARD_CAP = 0x4;
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION { public uint ControlFlags; public uint CpuRate; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern SafeFileHandle CreateJobObject(IntPtr attrs, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, IntPtr info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(SafeFileHandle job, int infoClass, ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int size, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
}
