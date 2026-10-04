using System.Diagnostics;
using System.Drawing;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace Viro.Agent.Care;

public sealed record WindowInfo(int Pid, bool Visible, bool Foreground, bool Minimized);
public sealed record NoticeButton(string Id, string Text);
/// <param name="Severity">"info" | "warning" | "critical" (colours only; nothing is hidden or made to look like a system dialog)</param>
public sealed record Notice(string Id, string Title, string Body, IReadOnlyList<string> Lines, IReadOnlyList<NoticeButton> Buttons, int TimeoutSeconds, string Severity = "warning");

/// <summary>What the signed-in user can see and be asked. Unavailable when nobody is signed in: nothing is then shown, and callers record that honestly.</summary>
public interface IUserUi
{
    Task<IReadOnlyList<WindowInfo>?> WindowsAsync(CancellationToken ct);
    /// <summary>Shows a notice with buttons. Returns the clicked button id, or null if it timed out, was dismissed, or could not be shown.</summary>
    Task<string?> NotifyAsync(Notice notice, CancellationToken ct);
}

/// <summary>Service side of the user-session helper. The helper is started on demand in the active user's session and stopped again when idle.</summary>
public sealed class UserUiBridge(ILogger log, Func<string, Process?>? launcher = null) : IUserUi, IDisposable
{
    NamedPipeServerStream? _pipe; Process? _proc; CancellationTokenSource? _cts; DateTime _lastUse;
    readonly SemaphoreSlim _send = new(1, 1), _start = new(1, 1);
    readonly Dictionary<string, TaskCompletionSource<JsonElement>> _pending = [];
    static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    Timer? _idle; DateTime _failedUntil = DateTime.MinValue;
    public static readonly TimeSpan RetryAfterFailure = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan IdleShutdown = TimeSpan.FromMinutes(30);

    bool Connected => _pipe is { IsConnected: true } && _proc is { HasExited: false };

    async Task<bool> EnsureAsync(CancellationToken ct)
    {
        await _start.WaitAsync(ct);
        try
        {
            if (Connected) return true;
            if (DateTime.UtcNow < _failedUntil) return false;      // nobody is signed in (or the helper failed): do not try again every cycle
            // A lock held open counts as in use for as long as it is pending, however long that is, so the idle timer never pulls the helper out from under an open lock screen.
            _idle ??= new Timer(_ => { bool pending; lock (_pending) pending = _pending.Count > 0; if (_pipe is not null && !pending && DateTime.UtcNow - _lastUse > IdleShutdown) Stop(); }, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
            Stop();
            var name = "viro-ui-" + Guid.NewGuid().ToString("N");
            var sec = new PipeSecurity();
            sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            sec.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User!, PipeAccessRights.ReadWrite, AccessControlType.Allow));
            if (UserSessionLauncher.ActiveUserSid() is { } sid) sec.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.ReadWrite, AccessControlType.Allow));
            _pipe = NamedPipeServerStreamAcl.Create(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, sec);
            _proc = (launcher ?? (n => UserSessionLauncher.Launch(Environment.ProcessPath!, $"ui-helper --pipe {n}", log)))(name);
            if (_proc is null) { Stop(); _failedUntil = DateTime.UtcNow + RetryAfterFailure; return false; }
            _cts = new CancellationTokenSource();
            // the helper is a large single-file program the first time it runs in a session, and security software scans it, so allow time
            using (var connect = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token, ct)) { connect.CancelAfter(45_000); await _pipe.WaitForConnectionAsync(connect.Token); }
            var pipe = _pipe; var token = _cts.Token;
            _ = Task.Run(async () =>
            {
                try
                {
                    while (await PipeFrames.ReadAsync(pipe, token) is { } m)
                        if (m.type == PipeFrames.Ui) { using var d = JsonDocument.Parse(m.payload); var r = d.RootElement.Clone(); var id = r.GetProperty("id").GetString()!; lock (_pending) { if (_pending.Remove(id, out var tcs)) tcs.TrySetResult(r); } }
                }
                catch { /* pipe closed */ }
                finally { lock (_pending) foreach (var t in _pending.Values) t.TrySetCanceled(); _pending.Clear(); }
            }, token);
            return true;
        }
        catch (Exception e) when (e is OperationCanceledException or IOException or InvalidOperationException) { log.LogInformation("The user-session helper could not be started ({Msg}); nothing will be shown to the user", e.Message); Stop(); _failedUntil = DateTime.UtcNow + RetryAfterFailure; return false; }
        finally { _start.Release(); }
    }

    async Task<JsonElement?> RequestAsync(object body, string id, TimeSpan timeout, CancellationToken ct)
    {
        if (!await EnsureAsync(ct)) return null;
        _lastUse = DateTime.UtcNow;
        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously); lock (_pending) _pending[id] = tcs;
        await _send.WaitAsync(ct);
        try { await PipeFrames.WriteAsync(_pipe!, PipeFrames.Ui, JsonSerializer.SerializeToUtf8Bytes(body, Web), ct); } catch { lock (_pending) _pending.Remove(id); return null; } finally { _send.Release(); }
        using var t = CancellationTokenSource.CreateLinkedTokenSource(ct); t.CancelAfter(timeout);
        try { return await tcs.Task.WaitAsync(t.Token); } catch (Exception e) when (e is OperationCanceledException or TaskCanceledException) { lock (_pending) _pending.Remove(id); _lastUse = DateTime.UtcNow; return null; }
    }

    public async Task<IReadOnlyList<WindowInfo>?> WindowsAsync(CancellationToken ct)
    {
        var id = Guid.NewGuid().ToString("N");
        var r = await RequestAsync(new { k = "windows", id }, id, TimeSpan.FromSeconds(25), ct);
        if (r is not { } el || !el.TryGetProperty("items", out var items)) return null;
        return [.. items.EnumerateArray().Select(i => new WindowInfo(i.GetProperty("pid").GetInt32(), i.GetProperty("visible").GetBoolean(), i.GetProperty("foreground").GetBoolean(), i.GetProperty("minimized").GetBoolean()))];
    }

    /// <summary>Shows the lost-mode lock on the signed-in session and does not return until it unlocks, however long that takes.</summary>
    public async Task<bool> LockAsync(string saltB64, string hashB64, int iterations, CancellationToken ct)
    {
        var id = Guid.NewGuid().ToString("N");
        var r = await RequestAsync(new { k = "lock", id, saltB64, hashB64, iterations }, id, TimeSpan.FromDays(3650), ct);
        return r is { } el && el.TryGetProperty("unlocked", out var u) && u.ValueKind == JsonValueKind.True;
    }

    /// <summary>The server says this PC is no longer lost: close an open lock window without needing the passphrase. Best effort; nothing to do if no session is connected.</summary>
    public async Task TellUnlockedAsync(CancellationToken ct)
    {
        if (!Connected) return;
        await _send.WaitAsync(ct);
        try { await PipeFrames.WriteAsync(_pipe!, PipeFrames.Ui, JsonSerializer.SerializeToUtf8Bytes(new { k = "unlock_remote", id = Guid.NewGuid().ToString("N") }, Web), ct); }
        catch { /* nothing open to tell */ } finally { _send.Release(); }
    }

    public async Task<string?> NotifyAsync(Notice n, CancellationToken ct)
    {
        var id = Guid.NewGuid().ToString("N");
        var r = await RequestAsync(new { k = "notify", id, title = n.Title, body = n.Body, lines = n.Lines, buttons = n.Buttons, timeoutSec = n.TimeoutSeconds, severity = n.Severity }, id, TimeSpan.FromSeconds(n.TimeoutSeconds + 10), ct);
        return r is { } el && el.TryGetProperty("choice", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
    }

    public void Stop()
    {
        try { if (_pipe is { IsConnected: true }) PipeFrames.WriteAsync(_pipe, PipeFrames.Ui, JsonSerializer.SerializeToUtf8Bytes(new { k = "quit", id = "quit" }), default).Wait(500); } catch { }
        try { _cts?.Cancel(); } catch { }
        try { _pipe?.Dispose(); } catch { }
        try { if (_proc is { HasExited: false }) { _proc.WaitForExit(1500); if (!_proc.HasExited) _proc.Kill(); } } catch { }
        _pipe = null; _proc = null; _cts = null;
    }
    public void Dispose() { _idle?.Dispose(); Stop(); }
}

// ---------------------------------------------------------------------------------------------------------------------
/// <summary>Runs in the signed-in user's session: lists windows and shows notices. It obeys only the pipe it was started with (ACL: SYSTEM and this user).</summary>
public static class UserUiHelper
{
    static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p); delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, DWMWA_CLOAKED = 14;

    /// <summary>Top-level windows a person would recognise as an open application (not tool windows, not cloaked/hidden UWP shells).</summary>
    public static List<WindowInfo> EnumerateWindows()
    {
        var fg = GetForegroundWindow(); GetWindowThreadProcessId(fg, out var fgPid);
        var seen = new Dictionary<int, WindowInfo>();
        EnumWindows((h, _) =>
        {
            if (!IsWindowVisible(h) && !IsIconic(h)) return true;
            if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0 || GetWindowTextLength(h) == 0) return true;
            if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out var cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
            if (!IsIconic(h) && GetWindowRect(h, out var r) && (r.R - r.L < 50 || r.B - r.T < 50)) return true;
            GetWindowThreadProcessId(h, out var pid);
            var minimized = IsIconic(h);
            var cur = seen.GetValueOrDefault((int)pid);
            seen[(int)pid] = new((int)pid, true, pid == fgPid && !minimized || cur?.Foreground == true, (cur?.Minimized ?? true) && minimized);
            return true;
        }, IntPtr.Zero);
        return [.. seen.Values];
    }

    public static async Task<int> RunAsync(string pipeName, CancellationToken ct)
    {
        await using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(10_000, ct);
        var send = new SemaphoreSlim(1, 1); var shown = new SemaphoreSlim(1, 1);
        async Task Reply(object o) { await send.WaitAsync(ct); try { await PipeFrames.WriteAsync(pipe, PipeFrames.Ui, JsonSerializer.SerializeToUtf8Bytes(o, Web), ct); } finally { send.Release(); } }
        while (await PipeFrames.ReadAsync(pipe, ct) is { } m)
        {
            if (m.type != PipeFrames.Ui) continue;
            using var doc = JsonDocument.Parse(m.payload); var r = doc.RootElement.Clone(); var k = r.GetProperty("k").GetString(); var id = r.GetProperty("id").GetString()!;
            if (k == "quit") break;
            if (k == "windows") await Reply(new { id, items = EnumerateWindows() });
            else if (k == "lock")
                _ = Task.Run(async () =>
                {
                    var ok = await LostLockWindow.ShowAsync(r.GetProperty("saltB64").GetString()!, r.GetProperty("hashB64").GetString()!, r.GetProperty("iterations").GetInt32());
                    await Reply(new { id, unlocked = ok });
                }, ct);
            else if (k == "unlock_remote") LostLockWindow.CloseRemotely();
            else if (k == "notify")
                _ = Task.Run(async () =>
                {
                    await shown.WaitAsync(ct);        // one notice at a time
                    try
                    {
                        var buttons = r.GetProperty("buttons").EnumerateArray().Select(b => new NoticeButton(b.GetProperty("id").GetString()!, b.GetProperty("text").GetString()!)).ToList();
                        var lines = r.TryGetProperty("lines", out var l) ? l.EnumerateArray().Select(x => x.GetString() ?? "").ToList() : [];
                        var choice = NoticeWindow.ShowModeless(r.GetProperty("title").GetString() ?? "", r.GetProperty("body").GetString() ?? "", lines, buttons, r.TryGetProperty("timeoutSec", out var t) ? t.GetInt32() : 60, r.TryGetProperty("severity", out var s) ? s.GetString() ?? "warning" : "warning");
                        await Reply(new { id, choice });
                    }
                    finally { shown.Release(); }
                }, ct);
        }
        return 0;
    }
}

/// <summary>A small always-on-top notice in the bottom-right corner. It never takes keyboard focus, so it cannot swallow what the person is typing.</summary>
static class NoticeWindow
{
    public static string? ShowModeless(string title, string body, IReadOnlyList<string> lines, IReadOnlyList<NoticeButton> buttons, int timeoutSec, string severity)
    {
        string? choice = null;
        var t = new Thread(() =>
        {
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            var accent = severity switch { "critical" => Color.FromArgb(196, 43, 28), "warning" => Color.FromArgb(214, 138, 20), _ => Color.FromArgb(8, 64, 44) };
            var form = new NoticeForm { FormBorderStyle = FormBorderStyle.None, TopMost = true, ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, BackColor = Color.FromArgb(32, 33, 36), Width = 420 };
            var bar = new Panel { Dock = DockStyle.Left, Width = 6, BackColor = accent };
            var head = new Label { Text = title, ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 11.5f), AutoSize = false, Left = 20, Top = 14, Width = 380, Height = 26 };
            var text = new Label { Text = body, ForeColor = Color.FromArgb(220, 220, 224), Font = new Font("Segoe UI", 9.5f), AutoSize = false, Left = 20, Top = 44, Width = 380, Height = 62 };
            form.Controls.AddRange([bar, head, text]);
            var y = 108;
            foreach (var line in lines.Take(6)) { form.Controls.Add(new Label { Text = "• " + line, ForeColor = Color.FromArgb(200, 200, 205), Font = new Font("Segoe UI", 9f), AutoSize = false, Left = 24, Top = y, Width = 376, Height = 20 }); y += 20; }
            y += 10; var x = 20;
            foreach (var b in buttons)
            {
                var id = b.Id; var btn = new Button { Text = b.Text, Left = x, Top = y, Height = 32, AutoSize = true, FlatStyle = FlatStyle.Flat, ForeColor = Color.White, BackColor = buttons[0] == b ? accent : Color.FromArgb(60, 62, 68), Font = new Font("Segoe UI", 9f), Padding = new Padding(8, 0, 8, 0), TabStop = false };
                btn.FlatAppearance.BorderSize = 0; btn.Click += (_, _) => { choice = id; form.Close(); };
                form.Controls.Add(btn); btn.PerformLayout(); x += btn.Width + 8;
            }
            form.Height = y + 52;
            var wa = Screen.PrimaryScreen!.WorkingArea; form.Location = new Point(wa.Right - form.Width - 16, wa.Bottom - form.Height - 16);
            var timer = new System.Windows.Forms.Timer { Interval = Math.Max(5, timeoutSec) * 1000 }; timer.Tick += (_, _) => { timer.Stop(); form.Close(); }; timer.Start();
            Application.Run(form); timer.Dispose();
        });
        t.SetApartmentState(ApartmentState.STA); t.IsBackground = true; t.Start(); t.Join();
        return choice;
    }
    sealed class NoticeForm : Form
    {
        protected override bool ShowWithoutActivation => true;
        protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80; return p; } }    // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
    }
}
