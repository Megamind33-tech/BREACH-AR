using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

namespace Viro.Agent;

/// <summary>Length-prefixed messages on the helper pipe: [type:1][length:4][payload].</summary>
public static class PipeFrames
{
    public const byte Frame = 1, Idle = 2, Info = 3, Control = 5, Input = 6, Ui = 7;
    public static async Task WriteAsync(Stream s, byte type, ReadOnlyMemory<byte> payload, CancellationToken ct)
    {
        var head = new byte[5]; head[0] = type; BitConverter.TryWriteBytes(head.AsSpan(1), payload.Length);
        await s.WriteAsync(head, ct); if (payload.Length > 0) await s.WriteAsync(payload, ct); await s.FlushAsync(ct);
    }
    public static async Task<(byte type, byte[] payload)?> ReadAsync(Stream s, CancellationToken ct)
    {
        var head = new byte[5]; if (!await Fill(s, head, ct)) return null;
        var len = BitConverter.ToInt32(head, 1); if (len < 0 || len > 16 * 1024 * 1024) return null;
        var buf = new byte[len]; if (len > 0 && !await Fill(s, buf, ct)) return null;
        return (head[0], buf);
    }
    static async Task<bool> Fill(Stream s, byte[] b, CancellationToken ct) { var o = 0; while (o < b.Length) { var n = await s.ReadAsync(b.AsMemory(o), ct); if (n == 0) return false; o += n; } return true; }
}

/// <summary>Native input injection and screen facts (user session only).</summary>
static class Win
{
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO p);
    [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
    [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, uint step, IntPtr brush, uint flags);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
    [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public POINT pt; }
    [StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public int xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll")] public static extern uint GetTickCount();
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize, dwTime; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
    public const uint MOUSE = 0, KEYBOARD = 1, MOVE = 0x1, LDOWN = 0x2, LUP = 0x4, RDOWN = 0x8, RUP = 0x10, MDOWN = 0x20, MUP = 0x40, WHEEL = 0x800, ABSOLUTE = 0x8000, KEYUP = 0x2, EXTENDED = 0x1;

    public static double IdleSeconds() { var i = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() }; return GetLastInputInfo(ref i) ? (GetTickCount() - i.dwTime) / 1000.0 : -1; }
}

/// <summary>
/// Runs inside the signed-in user's session (started by the service, or directly for development). Captures the primary screen as JPEG
/// frames and injects the administrator's mouse/keyboard input. It only obeys the pipe it was started with, which is ACL'd to SYSTEM and this user.
/// Limits: the UAC secure desktop and the lock screen cannot be captured or controlled from a normal user session.
/// </summary>
public static class DesktopHelper
{
    public static async Task<int> RunAsync(string pipeName, CancellationToken ct)
    {
        try { Win.SetProcessDPIAware(); } catch { }
        await using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(10_000, ct);
        var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        CancellationTokenSource? capture = null;
        var sendLock = new SemaphoreSlim(1, 1);
        async Task Send(byte type, ReadOnlyMemory<byte> p) { await sendLock.WaitAsync(cts.Token); try { await PipeFrames.WriteAsync(pipe, type, p, cts.Token); } finally { sendLock.Release(); } }

        var w = Win.GetSystemMetrics(0); var h = Win.GetSystemMetrics(1);
        await Send(PipeFrames.Info, JsonSerializer.SerializeToUtf8Bytes(new { width = w, height = h }));
        _ = Task.Run(async () => { while (!cts.IsCancellationRequested) { try { await Send(PipeFrames.Idle, BitConverter.GetBytes((int)Math.Max(0, Win.IdleSeconds()))); await Task.Delay(5000, cts.Token); } catch { break; } } });

        while (await PipeFrames.ReadAsync(pipe, cts.Token) is { } m)
        {
            using var doc = JsonDocument.Parse(m.payload); var r = doc.RootElement; var k = r.GetProperty("k").GetString();
            if (m.type == PipeFrames.Control)
            {
                if (k == "quit") break;
                if (k == "stop") { capture?.Cancel(); capture = null; }
                if (k == "start")
                {
                    capture?.Cancel(); capture = CancellationTokenSource.CreateLinkedTokenSource(cts.Token);
                    int fps = Math.Clamp(r.TryGetProperty("fps", out var f) ? f.GetInt32() : 5, 1, 15), q = Math.Clamp(r.TryGetProperty("quality", out var qq) ? qq.GetInt32() : 50, 20, 90), mw = Math.Clamp(r.TryGetProperty("maxWidth", out var x) ? x.GetInt32() : 1280, 320, 3840);
                    var token = capture.Token; _ = Task.Run(() => CaptureLoop(fps, q, mw, jpg => Send(PipeFrames.Frame, jpg), token));
                }
            }
            else if (m.type == PipeFrames.Input) { try { Inject(r); } catch { /* an input the OS refuses (secure desktop) is simply ignored */ } }
        }
        capture?.Cancel(); cts.Cancel();
        return 0;
    }

    static async Task CaptureLoop(int fps, int quality, int maxWidth, Func<byte[], Task> sink, CancellationToken ct)
    {
        var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
        var ep = new EncoderParameters(1); ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
        byte[]? lastHash = null; var delay = TimeSpan.FromMilliseconds(1000.0 / fps);
        while (!ct.IsCancellationRequested)
        {
            var t0 = DateTime.UtcNow;
            try
            {
                var jpg = Grab(codec, ep, maxWidth);
                var hash = SHA256.HashData(jpg);
                if (lastHash is null || !hash.AsSpan().SequenceEqual(lastHash)) { lastHash = hash; await sink(jpg); }   // unchanged screens cost nothing
            }
            catch (OperationCanceledException) { return; }
            catch (Exception) { /* transient GDI failure (e.g. desktop switch): try again next tick */ }
            var wait = delay - (DateTime.UtcNow - t0); if (wait > TimeSpan.Zero) try { await Task.Delay(wait, ct); } catch (OperationCanceledException) { return; }
        }
    }

    public static byte[] Grab(ImageCodecInfo codec, EncoderParameters ep, int maxWidth)
    {
        var w = Win.GetSystemMetrics(0); var h = Win.GetSystemMetrics(1);
        using var full = new Bitmap(w, h, PixelFormat.Format32bppRgb);
        using (var g = Graphics.FromImage(full)) { g.CopyFromScreen(0, 0, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy); DrawCursor(g); }
        Bitmap send = full; Bitmap? scaled = null;
        if (w > maxWidth) { scaled = new Bitmap(maxWidth, h * maxWidth / w, PixelFormat.Format32bppRgb); using var g = Graphics.FromImage(scaled); g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(full, 0, 0, scaled.Width, scaled.Height); send = scaled; }
        using var ms = new MemoryStream(); send.Save(ms, codec, ep); scaled?.Dispose(); return ms.ToArray();
    }

    /// <summary>The screen grab leaves the mouse pointer out, so it is drawn in: the person controlling sees where the PC's pointer really is.</summary>
    static void DrawCursor(Graphics g)
    {
        try
        {
            var ci = new Win.CURSORINFO { cbSize = Marshal.SizeOf<Win.CURSORINFO>() };
            if (!Win.GetCursorInfo(ref ci) || (ci.flags & 1) == 0 || ci.hCursor == IntPtr.Zero) return;
            int hx = 0, hy = 0;
            if (Win.GetIconInfo(ci.hCursor, out var ii)) { hx = ii.xHotspot; hy = ii.yHotspot; if (ii.hbmMask != IntPtr.Zero) Win.DeleteObject(ii.hbmMask); if (ii.hbmColor != IntPtr.Zero) Win.DeleteObject(ii.hbmColor); }
            var hdc = g.GetHdc(); try { Win.DrawIconEx(hdc, ci.pt.X - hx, ci.pt.Y - hy, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3); } finally { g.ReleaseHdc(hdc); }
        }
        catch (Exception) { /* a missing pointer is cosmetic */ }
    }

    /// <summary>Applies one input message. Coordinates are fractions (0..1) of the primary screen.</summary>
    public static void Inject(JsonElement r)
    {
        var kind = r.GetProperty("k").GetString();
        if (kind == "mouse")
        {
            var w = Win.GetSystemMetrics(0); var h = Win.GetSystemMetrics(1);
            var x = (int)Math.Round(Math.Clamp(r.GetProperty("x").GetDouble(), 0, 1) * 65535); var y = (int)Math.Round(Math.Clamp(r.GetProperty("y").GetDouble(), 0, 1) * 65535);
            var act = r.TryGetProperty("act", out var a) ? a.GetString() : "move"; var btn = r.TryGetProperty("btn", out var b) ? b.GetString() : "left"; var wheel = r.TryGetProperty("wheel", out var wl) ? wl.GetInt32() : 0;
            (uint down, uint up) = btn switch { "right" => (Win.RDOWN, Win.RUP), "middle" => (Win.MDOWN, Win.MUP), _ => (Win.LDOWN, Win.LUP) };
            var list = new List<Win.INPUT> { Mouse(Win.MOVE | Win.ABSOLUTE, x, y, 0) };
            if (act is "down" or "click" or "dblclick") list.Add(Mouse(down | Win.ABSOLUTE, x, y, 0));
            if (act is "up" or "click" or "dblclick") list.Add(Mouse(up | Win.ABSOLUTE, x, y, 0));
            if (act == "dblclick") { list.Add(Mouse(down | Win.ABSOLUTE, x, y, 0)); list.Add(Mouse(up | Win.ABSOLUTE, x, y, 0)); }
            if (wheel != 0) list.Add(Mouse(Win.WHEEL, 0, 0, (uint)(wheel * 120)));
            _ = w; _ = h; Win.SendInput((uint)list.Count, [.. list], Marshal.SizeOf<Win.INPUT>());
        }
        else if (kind == "text")
        {
            // Typed as Unicode characters, so any language and symbol arrives as written.
            var s = r.GetProperty("s").GetString() ?? ""; var list = new List<Win.INPUT>();
            foreach (var ch in s.Take(2000)) { list.Add(new Win.INPUT { type = Win.KEYBOARD, u = new() { ki = new() { wScan = ch, dwFlags = 0x4 } } }); list.Add(new Win.INPUT { type = Win.KEYBOARD, u = new() { ki = new() { wScan = ch, dwFlags = 0x4 | Win.KEYUP } } }); }
            if (list.Count > 0) Win.SendInput((uint)list.Count, [.. list], Marshal.SizeOf<Win.INPUT>());
        }
        else if (kind == "key")
        {
            var vk = (ushort)Math.Clamp(r.GetProperty("code").GetInt32(), 1, 254); var down = r.GetProperty("down").GetBoolean();
            var ext = vk is 0x21 or 0x22 or 0x23 or 0x24 or 0x25 or 0x26 or 0x27 or 0x28 or 0x2D or 0x2E or 0x5B or 0x5C ? Win.EXTENDED : 0;   // arrows, Home/End/PgUp/PgDn/Ins/Del, Win keys
            var i = new Win.INPUT { type = Win.KEYBOARD, u = new() { ki = new() { wVk = vk, dwFlags = (down ? 0u : Win.KEYUP) | ext } } };
            Win.SendInput(1, [i], Marshal.SizeOf<Win.INPUT>());
        }
    }
    static Win.INPUT Mouse(uint flags, int x, int y, uint data) => new() { type = Win.MOUSE, u = new() { mi = new() { dx = x, dy = y, dwFlags = flags, mouseData = data } } };
}
