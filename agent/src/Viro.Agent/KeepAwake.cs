using System.Runtime.InteropServices;

namespace Viro.Agent;

/// <summary>
/// Asks Windows not to put the PC to sleep while a long maintenance job runs (SFC, DISM, chkdsk, update installs): a laptop that
/// sleeps mid-repair makes the job fail with "the device stopped reporting". Power requests are per handle, so this is safe across
/// the threads an async job hops between; disposing releases it. Failure to obtain a request is harmless (the job just runs).
/// </summary>
public sealed class KeepAwake : IDisposable
{
    const uint PowerRequestVersion = 0, SimpleString = 0x1;
    const int SystemRequired = 1;   // PowerRequestSystemRequired

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ReasonContext { public uint Version; public uint Flags; [MarshalAs(UnmanagedType.LPWStr)] public string SimpleReasonString; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr PowerCreateRequest(ref ReasonContext context);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool PowerSetRequest(IntPtr request, int type);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool PowerClearRequest(IntPtr request, int type);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

    IntPtr _handle;

    public KeepAwake(string reason)
    {
        try
        {
            var ctx = new ReasonContext { Version = PowerRequestVersion, Flags = SimpleString, SimpleReasonString = reason };
            var h = PowerCreateRequest(ref ctx);
            if (h == IntPtr.Zero || h == new IntPtr(-1)) return;
            if (PowerSetRequest(h, SystemRequired)) _handle = h; else CloseHandle(h);
        }
        catch { /* not available: run without */ }
    }

    public bool Active => _handle != IntPtr.Zero;

    public void Dispose()
    {
        var h = Interlocked.Exchange(ref _handle, IntPtr.Zero);
        if (h == IntPtr.Zero) return;
        PowerClearRequest(h, SystemRequired); CloseHandle(h);
    }
}
