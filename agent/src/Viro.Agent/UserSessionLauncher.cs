using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Viro.Agent;

/// <summary>
/// Starts a process inside the signed-in user's session. As SYSTEM this uses WTSQueryUserToken + CreateProcessAsUser (the documented way
/// for a service to show something in the user's session). When not SYSTEM (development), it simply starts a child in the current session.
/// </summary>
public static class UserSessionLauncher
{
    public static bool IsSystem() { using var id = WindowsIdentity.GetCurrent(); return id.IsSystem; }

    public static SecurityIdentifier? ActiveUserSid()
    {
        if (!IsSystem()) return null;
        var sess = WTSGetActiveConsoleSessionId(); if (sess == 0xFFFFFFFF || !WTSQueryUserToken(sess, out var tok)) return null;
        try { using var id = new WindowsIdentity(tok); return id.User; } finally { CloseHandle(tok); }
    }

    public static Process? Launch(string exe, string args, ILogger log)
    {
        if (!IsSystem()) return Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true });
        var sess = WTSGetActiveConsoleSessionId();
        if (sess == 0xFFFFFFFF) { log.LogWarning("No active console session"); return null; }
        if (!WTSQueryUserToken(sess, out var userToken)) { log.LogWarning("WTSQueryUserToken failed: {E}", new Win32Exception(Marshal.GetLastWin32Error()).Message); return null; }
        IntPtr primary = IntPtr.Zero, env = IntPtr.Zero;
        try
        {
            if (!DuplicateTokenEx(userToken, 0xF01FF /* TOKEN_ALL_ACCESS */, IntPtr.Zero, 2 /* SecurityImpersonation */, 1 /* TokenPrimary */, out primary)) return null;
            CreateEnvironmentBlock(out env, primary, false);
            var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), lpDesktop = @"winsta0\default" };
            if (!CreateProcessAsUser(primary, null, $"\"{exe}\" {args}", IntPtr.Zero, IntPtr.Zero, false, 0x400 /* CREATE_UNICODE_ENVIRONMENT */ | 0x08000000 /* CREATE_NO_WINDOW */, env, Path.GetDirectoryName(exe), ref si, out var pi))
            { log.LogWarning("CreateProcessAsUser failed: {E}", new Win32Exception(Marshal.GetLastWin32Error()).Message); return null; }
            CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
            return Process.GetProcessById(pi.dwProcessId);
        }
        finally { if (env != IntPtr.Zero) DestroyEnvironmentBlock(env); if (primary != IntPtr.Zero) CloseHandle(primary); CloseHandle(userToken); }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string? lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attrs, int impersonationLevel, int tokenType, out IntPtr newToken);
    [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
    [DllImport("userenv.dll")] static extern bool DestroyEnvironmentBlock(IntPtr env);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr token, string? app, string cmd, IntPtr procAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string? cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
}

/// <summary>
/// "The PC is doing higher-priority work" signal from the agent to other Viro services. The agent holds a lease while it runs security scans,
/// updates, repairs, cleanup, driver work or a support session; the compute worker refuses to run while a lease is valid.
/// Priority order (highest first): user, security, health, maintenance, paid compute, internal compute, fallback.
/// </summary>
public static class BusyLease
{
    public static readonly HashSet<string> BusyJobTypes =
    [
        "security.scan", "security.remediate", "security.update-signatures", "updates.install", "driver.install", "driver.rollback", "repair.run", "repair.fix-safe", "repair.rollback",
        "cleanup.run", "software.install", "software.update", "software.uninstall", "hardware.diagnose", "updates.scan", "system.reboot",
    ];
    public static string PathFor(string dataDir) => System.IO.Path.Combine(dataDir, "busy.json");

    public sealed class Hold : IDisposable
    {
        readonly string _path, _reason; readonly Timer _t;
        public Hold(string dataDir, string reason) { _path = PathFor(dataDir); _reason = reason; Write(); _t = new Timer(_ => Write(), null, TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10)); }
        void Write() { try { Directory.CreateDirectory(System.IO.Path.GetDirectoryName(_path)!); File.WriteAllText(_path, System.Text.Json.JsonSerializer.Serialize(new { reason = _reason, until = DateTime.UtcNow.AddSeconds(30) })); } catch { } }
        public void Dispose() { _t.Dispose(); try { File.Delete(_path); } catch { } }
    }

    /// <summary>The current reason, or null when nothing important is running. A stale lease (agent crashed) expires by itself.</summary>
    public static string? Read(string dataDir, DateTime? now = null)
    {
        try
        {
            using var d = System.Text.Json.JsonDocument.Parse(File.ReadAllText(PathFor(dataDir)));
            return d.RootElement.GetProperty("until").GetDateTime().ToUniversalTime() > (now ?? DateTime.UtcNow) ? d.RootElement.GetProperty("reason").GetString() : null;
        }
        catch { return null; }
    }
}
