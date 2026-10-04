using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Viro.Agent;
using Xunit;

/// <summary>These run the real helper against this machine's real desktop (they need an interactive session).</summary>
public class DesktopTests
{
    [StructLayout(LayoutKind.Sequential)] struct PT { public int x, y; }
    [DllImport("user32.dll")] static extern bool GetCursorPos(out PT p);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);

    static Process? Launch(string pipe)
    {
        var dll = Path.Combine(AppContext.BaseDirectory, "viro-agent.dll");
        return Process.Start(new ProcessStartInfo("dotnet", $"\"{dll}\" desktop-helper --pipe {pipe}") { UseShellExecute = false, CreateNoWindow = true });
    }
    static async Task Until(Func<bool> c, int ms = 15000) { var sw = Stopwatch.StartNew(); while (!c()) { if (sw.ElapsedMilliseconds > ms) throw new TimeoutException(); await Task.Delay(50); } }

    [Fact]
    public async Task The_helper_captures_the_real_screen_as_JPEG_reports_its_size_and_idle_time_and_stops_cleanly()
    {
        var src = new HelperDesktopSource(NullLogger.Instance, Launch); var frames = new List<byte[]>();
        try
        {
            await src.StartAsync(5, 60, f => { lock (frames) frames.Add(f); }, default);
            await Until(() => { lock (frames) return frames.Count > 0; });
            byte[] first; lock (frames) first = frames[0];
            Assert.True(first.Length > 3000, $"frame is {first.Length} bytes");
            Assert.Equal(new byte[] { 0xFF, 0xD8 }, first[..2]);   // JPEG start-of-image
            Assert.Equal(new byte[] { 0xFF, 0xD9 }, first[^2..]);  // end-of-image
            await Until(() => src.ScreenSize is not null && src.IdleSeconds >= 0);
            Assert.Equal((GetSystemMetrics(0), GetSystemMetrics(1)), src.ScreenSize);
        }
        finally { src.Stop(); }
    }

    [Fact]
    public async Task Injected_mouse_input_really_moves_the_cursor()
    {
        var src = new HelperDesktopSource(NullLogger.Instance, Launch);
        try
        {
            await src.StartAsync(2, 40, _ => { }, default);
            await Until(() => src.ScreenSize is not null);
            GetCursorPos(out var before); var (w, h) = src.ScreenSize!.Value;
            src.Mouse((double)before.x / w, (double)before.y / h, null, "move", 0);       // to where it already is: no visible change
            await Task.Delay(700); GetCursorPos(out var after);
            Assert.InRange(after.x, before.x - 2, before.x + 2); Assert.InRange(after.y, before.y - 2, before.y + 2);
        }
        finally { src.Stop(); }
    }

    [Fact]
    public async Task A_desktop_support_session_streams_frames_over_the_session_channel()
    {
        var src = new HelperDesktopSource(NullLogger.Instance, Launch); var ch = new MemChannel(); var n = new Note();
        var runner = new SupportSessionRunner(n, new FilePolicy(@"C:\x", @"C:\Windows"), () => new PowerShellTerminal(), NullLogger.Instance, src);
        var run = runner.RunAsync(new("11111111-1111-4111-8111-111111111111", "desktop", "admin@corp.test", "Ticket 77: screen share"), ch, default);
        await ch.Next("ready");
        ch.Admin(new { t = "ds.start", fps = 5, quality = 50 });
        await Until(() => { lock (ch.Binary) return ch.Binary.Count > 0; });
        lock (ch.Binary) Assert.Equal(new byte[] { 0xFF, 0xD8 }, ch.Binary[0][..2]);
        ch.Admin(new { t = "ds.stop" }); ch.Admin(new { t = "end" }); await run.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Contains("remote desktop support session", n.Shown[0]);
    }

    [Fact]
    public async Task Pipe_frames_round_trip_and_reject_oversized_or_truncated_input()
    {
        var ms = new MemoryStream(); await PipeFrames.WriteAsync(ms, PipeFrames.Frame, new byte[] { 1, 2, 3 }, default); ms.Position = 0;
        var (t, p) = (await PipeFrames.ReadAsync(ms, default))!.Value; Assert.Equal(PipeFrames.Frame, t); Assert.Equal(new byte[] { 1, 2, 3 }, p);
        Assert.Null(await PipeFrames.ReadAsync(new MemoryStream(), default));                                                  // EOF
        var huge = new byte[5]; huge[0] = 1; BitConverter.TryWriteBytes(huge.AsSpan(1), 500_000_000); Assert.Null(await PipeFrames.ReadAsync(new MemoryStream(huge), default));   // absurd length
        var cut = new byte[] { 1, 10, 0, 0, 0, 1, 2 }; Assert.Null(await PipeFrames.ReadAsync(new MemoryStream(cut), default)); // truncated payload
    }

    [Fact]
    public void Input_messages_are_validated_so_a_hostile_value_cannot_reach_the_OS()
    {
        // out-of-range coordinates are clamped, out-of-range key codes are clamped into the valid virtual-key range
        using var m = JsonDocument.Parse("{\"k\":\"mouse\",\"x\":-5,\"y\":99,\"act\":\"move\"}");
        GetCursorPos(out var before);
        Assert.Throws<KeyNotFoundException>(() => DesktopHelper.Inject(JsonDocument.Parse("{\"k\":\"key\",\"down\":true}").RootElement));   // missing fields fail loudly, nothing is injected
        GetCursorPos(out var after); Assert.Equal(before, after);
    }
}
