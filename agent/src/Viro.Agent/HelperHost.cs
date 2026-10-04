using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace Viro.Agent;

/// <summary>
/// Service-side half of remote desktop. Starts the helper in the active console user's session (as SYSTEM: WTSQueryUserToken +
/// CreateProcessAsUser) or, when not running as SYSTEM (development), as a child in the current session, and speaks to it over a
/// randomly named pipe that only SYSTEM and that user can open.
/// </summary>
public sealed class HelperDesktopSource(ILogger log, Func<string, Process?>? launcher = null) : IDesktopSource
{
    NamedPipeServerStream? _pipe; Process? _proc; CancellationTokenSource? _cts; readonly SemaphoreSlim _send = new(1, 1);
    public int IdleSeconds { get; private set; } = -1;
    public (int width, int height)? ScreenSize { get; private set; }

    public async Task StartAsync(int fps, int quality, Action<byte[]> onFrame, CancellationToken ct)
    {
        Stop();
        var name = "viro-helper-" + Guid.NewGuid().ToString("N");
        var sec = new PipeSecurity();
        sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        sec.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User!, PipeAccessRights.ReadWrite, AccessControlType.Allow));    // SYSTEM's own or the dev user's SID
        if (UserSessionLauncher.ActiveUserSid() is { } sid) sec.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.ReadWrite, AccessControlType.Allow));         // the signed-in user the helper runs as
        _pipe = NamedPipeServerStreamAcl.Create(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, sec);
        _proc = (launcher ?? DefaultLaunch)(name) ?? throw new InvalidOperationException("no signed-in user session to show (or the helper could not be started)");
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        using (var connect = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token)) { connect.CancelAfter(15_000); await _pipe.WaitForConnectionAsync(connect.Token); }
        _ = Task.Run(async () =>
        {
            try
            {
                while (await PipeFrames.ReadAsync(_pipe, _cts.Token) is { } m)
                {
                    if (m.type == PipeFrames.Frame) onFrame(m.payload);
                    else if (m.type == PipeFrames.Idle) IdleSeconds = BitConverter.ToInt32(m.payload);
                    else if (m.type == PipeFrames.Info) { using var d = JsonDocument.Parse(m.payload); ScreenSize = (d.RootElement.GetProperty("width").GetInt32(), d.RootElement.GetProperty("height").GetInt32()); }
                }
            }
            catch { /* pipe closed */ }
        }, _cts.Token);
        await Control(new { k = "start", fps, quality, maxWidth = 1280 });
    }

    public void Stop()
    {
        try { if (_pipe is { IsConnected: true }) _ = Control(new { k = "quit" }); } catch { }
        try { _cts?.Cancel(); } catch { }
        try { _pipe?.Dispose(); } catch { }
        try { if (_proc is { HasExited: false }) { _proc.WaitForExit(1500); if (!_proc.HasExited) _proc.Kill(); } } catch { }
        _pipe = null; _proc = null; _cts = null; ScreenSize = null;
    }

    public void Tune(int fps, int quality, int maxWidth) => _ = Control(new { k = "start", fps, quality, maxWidth });
    public void TypeText(string text) => _ = Post(PipeFrames.Input, new { k = "text", s = text });
    public void Mouse(double x, double y, string? button, string action, int wheel) => _ = Post(PipeFrames.Input, new { k = "mouse", x, y, btn = button ?? "left", act = action, wheel });
    public void Key(int virtualKey, bool down) => _ = Post(PipeFrames.Input, new { k = "key", code = virtualKey, down });
    Task Control(object m) => Post(PipeFrames.Control, m);
    async Task Post(byte type, object m)
    {
        if (_pipe is not { IsConnected: true }) return;
        await _send.WaitAsync();
        try { await PipeFrames.WriteAsync(_pipe, type, JsonSerializer.SerializeToUtf8Bytes(m), _cts?.Token ?? default); } catch { } finally { _send.Release(); }
    }

    Process? DefaultLaunch(string pipeName)
    {
        if (!UserSessionLauncher.IsSystem()) log.LogInformation("Not running as SYSTEM: starting the desktop helper in the current session (development mode)");
        return UserSessionLauncher.Launch(Environment.ProcessPath!, $"desktop-helper --pipe {pipeName}", log);
    }
}
