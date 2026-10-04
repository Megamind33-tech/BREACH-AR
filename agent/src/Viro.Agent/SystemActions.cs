using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using Viro.Agent.Repair;

namespace Viro.Agent;

/// <summary>Sends a message box to every active user session (works on Windows Home, unlike msg.exe).</summary>
public interface IUserNotifier { int Notify(string title, string text, int seconds); }

public sealed class SessionNotifier : IUserNotifier
{
    [StructLayout(LayoutKind.Sequential)] struct WTS_SESSION_INFO { public int SessionId; [MarshalAs(UnmanagedType.LPWStr)] public string pWinStationName; public int State; }
    [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSEnumerateSessions(IntPtr h, int reserved, int version, out IntPtr info, out int count);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr p);
    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WTSSendMessage(IntPtr h, int session, string title, int titleLen, string msg, int msgLen, int style, int timeout, out int response, bool wait);

    public int Notify(string title, string text, int seconds)
    {
        var sent = 0;
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var info, out var count)) return 0;
        try
        {
            var size = Marshal.SizeOf<WTS_SESSION_INFO>();
            for (var i = 0; i < count; i++)
            {
                var s = Marshal.PtrToStructure<WTS_SESSION_INFO>(info + i * size);
                if (s.State != 0 /* WTSActive */ || s.SessionId == 0) continue;
                if (WTSSendMessage(IntPtr.Zero, s.SessionId, title, title.Length * 2, text, text.Length * 2, 0x40 /* MB_ICONINFORMATION */, seconds, out _, false)) sent++;
            }
        }
        finally { WTSFreeMemory(info); }
        return sent;
    }
}

public static partial class Sanitize
{
    /// <summary>User-visible text passes through a strict allowlist: no quotes, no shell metacharacters, bounded length.</summary>
    public static bool IsSafeText(string? s, int max = 300) => s is { Length: > 0 } && s.Length <= max && SafeText().IsMatch(s);
    [GeneratedRegex(@"^[\p{L}\p{N} .,:;!?()\-_/'+#%@\r\n]{1,300}$")] private static partial Regex SafeText();
}

/// <summary>message.send { text, seconds? }: tells the people using the PC something. Visible, never hidden.</summary>
public sealed class MessageSendHandler(IUserNotifier? notifier = null) : IJobHandler
{
    public string Type => "message.send";
    public Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var text = ctx.Job.Params.GetProperty("text").GetString();
        if (!Sanitize.IsSafeText(text)) return Task.FromResult(new JobOutcome(false, null, "message contains characters that are not allowed"));
        var seconds = ctx.Job.Params.TryGetProperty("seconds", out var s) && s.ValueKind == JsonValueKind.Number ? Math.Clamp(s.GetInt32(), 5, 3600) : 300;
        var n = (notifier ?? new SessionNotifier()).Notify("Message from your IT team", text!, seconds);
        return Task.FromResult(n > 0 ? new JobOutcome(true, new { deliveredToSessions = n }) : new JobOutcome(false, new { deliveredToSessions = 0 }, "no user is signed in to receive the message"));
    }
}

/// <summary>system.reboot { delaySeconds, message? }: restarts with a visible countdown so users can save work. system.reboot-cancel aborts it.</summary>
public sealed class RebootHandler(IProcessRunner? proc = null) : IJobHandler
{
    public string Type => "system.reboot";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var p = ctx.Job.Params;
        var delay = Math.Clamp(p.TryGetProperty("delaySeconds", out var d) && d.ValueKind == JsonValueKind.Number ? d.GetInt32() : 300, 30, 3600);
        var msg = p.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString()! : "Your IT team is restarting this PC to finish updates. Please save your work.";
        if (!Sanitize.IsSafeText(msg, 200)) return new(false, null, "message contains characters that are not allowed");
        var r = await (proc ?? new SystemProcessRunner()).RunAsync("shutdown.exe", $"/r /t {delay} /c \"{msg.Replace("\r", " ").Replace("\n", " ")}\"", TimeSpan.FromSeconds(30), ct);
        return r.ExitCode == 0 ? new(true, new { restartInSeconds = delay }) : new(false, new { exitCode = r.ExitCode }, r.ExitCode == 1190 ? "a restart is already scheduled" : "shutdown failed: " + r.Output.Trim());
    }
}

/// <summary>system.shutdown { delaySeconds, message? }: switches the PC off after a visible countdown so users can save work. system.reboot-cancel aborts it. The PC stays off until someone powers it on.</summary>
public sealed class ShutdownHandler(IProcessRunner? proc = null) : IJobHandler
{
    public string Type => "system.shutdown";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var p = ctx.Job.Params;
        var delay = Math.Clamp(p.TryGetProperty("delaySeconds", out var d) && d.ValueKind == JsonValueKind.Number ? d.GetInt32() : 60, 30, 3600);
        var msg = p.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString()! : "Your IT team is switching off this PC. Please save your work.";
        if (!Sanitize.IsSafeText(msg, 200)) return new(false, null, "message contains characters that are not allowed");
        var r = await (proc ?? new SystemProcessRunner()).RunAsync("shutdown.exe", $"/s /t {delay} /c \"{msg.Replace("\r", " ").Replace("\n", " ")}\"", TimeSpan.FromSeconds(30), ct);
        return r.ExitCode == 0 ? new(true, new { shutdownInSeconds = delay }) : new(false, new { exitCode = r.ExitCode }, r.ExitCode == 1190 ? "a restart or shut-down is already scheduled" : "shutdown failed: " + r.Output.Trim());
    }
}

public sealed class RebootCancelHandler(IProcessRunner? proc = null) : IJobHandler
{
    public string Type => "system.reboot-cancel";
    public async Task<JobOutcome> RunAsync(JobContext ctx, CancellationToken ct)
    {
        var r = await (proc ?? new SystemProcessRunner()).RunAsync("shutdown.exe", "/a", TimeSpan.FromSeconds(30), ct);
        return r.ExitCode == 0 ? new(true, new { cancelled = true }) : new(false, null, r.ExitCode == 1116 ? "no restart was pending" : "could not cancel: " + r.Output.Trim());
    }
}
