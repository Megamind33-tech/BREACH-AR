using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Extensions.Logging.Abstractions;
using Viro.Agent;
using Xunit;

/// <summary>An in-memory pair standing in for the WebSocket: the test plays the administrator.</summary>
sealed class MemChannel : IMessageChannel
{
    readonly Channel<Incoming> _toAgent = Channel.CreateUnbounded<Incoming>();
    public readonly Channel<string> FromAgent = Channel.CreateUnbounded<string>();
    public readonly List<byte[]> Binary = [];
    public Task SendJsonAsync(object m, CancellationToken ct) { FromAgent.Writer.TryWrite(JsonSerializer.Serialize(m, new JsonSerializerOptions(JsonSerializerDefaults.Web))); return Task.CompletedTask; }
    public Task SendBinaryAsync(ReadOnlyMemory<byte> d, CancellationToken ct) { lock (Binary) Binary.Add(d.ToArray()); return Task.CompletedTask; }
    public async IAsyncEnumerable<Incoming> ReceiveAsync([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct) { while (await _toAgent.Reader.WaitToReadAsync(ct).AsTask().ContinueWith(t => t.Result)) while (_toAgent.Reader.TryRead(out var m)) yield return m; }
    public void Admin(object m) => _toAgent.Writer.TryWrite(new(JsonSerializer.Serialize(m), null));
    public void Close() => _toAgent.Writer.TryComplete();
    public async Task<JsonElement> Next(string type, int ms = 5000)
    {
        using var cts = new CancellationTokenSource(ms);
        while (true) { var s = await FromAgent.Reader.ReadAsync(cts.Token); var e = JsonDocument.Parse(s).RootElement.Clone(); if (e.GetProperty("t").GetString() == type) return e; }
    }
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

sealed class Note : IUserNotifier { public readonly List<string> Shown = []; public int Notify(string t, string x, int s) { lock (Shown) Shown.Add(x); return 1; } }

public class FilePolicyTests
{
    static readonly FilePolicy P = new(@"C:\ProgramData\Viro\Agent", @"C:\Windows");
    [Theory] [InlineData(@"C:\Users\alice\Documents\a.txt")] [InlineData(@"D:\data")] [InlineData("C:/Users/x/y.txt")] [InlineData(@"C:\Users\alice\..\bob\file.txt")]
    public void Ordinary_absolute_local_paths_are_allowed(string p) => Assert.True(Path.IsPathRooted(P.Resolve(p, false)));
    [Theory]
    [InlineData(@"\\server\share\x")] [InlineData(@"\\?\C:\Windows")] [InlineData("//server/x")] [InlineData(@"relative\path")] [InlineData(@"\Users\x")] [InlineData("")] [InlineData("C:")] [InlineData("C:\\a\0b")]
    public void Network_device_relative_and_malformed_paths_are_refused(string p) => Assert.Throws<UnauthorizedAccessException>(() => P.Resolve(p, false));
    [Theory]
    [InlineData(@"C:\ProgramData\Viro\Agent\agent.json")] [InlineData(@"C:\ProgramData\Viro\Agent")] [InlineData(@"C:\ProgramData\Viro\Agent\logs\..\agent.json")] [InlineData(@"c:\programdata\viro\agent\update-state.json")]
    [InlineData(@"C:\Windows\System32\config\SAM")] [InlineData(@"C:\WINDOWS\system32\CONFIG\SYSTEM")] [InlineData(@"C:\Windows\System32\config")]
    public void The_device_credential_and_registry_hives_are_off_limits_however_the_path_is_spelled(string p) => Assert.Throws<UnauthorizedAccessException>(() => P.Resolve(p, false));
    [Fact] public void Look_alike_folders_are_not_blocked() { Assert.NotNull(P.Resolve(@"C:\ProgramData\Viro\AgentBackup\x.txt", false)); Assert.NotNull(P.Resolve(@"C:\Windows\System32\configuration\x", false)); }
}

public class SupportSessionTests : IDisposable
{
    readonly string _root = Path.Combine(Path.GetTempPath(), "viro-sup-" + Guid.NewGuid().ToString("N"));
    public SupportSessionTests() => Directory.CreateDirectory(_root);
    public void Dispose() { try { Directory.Delete(_root, true); } catch { } }
    static SessionOffer Offer(string kind) => new("11111111-1111-4111-8111-111111111111", kind, "admin@corp.test", "Ticket 4411: printer");
    SupportSessionRunner Runner(Note n, Func<ITerminal>? term = null, IDesktopSource? desktop = null) => new(n, new FilePolicy(Path.Combine(_root, "agentdata"), Path.Combine(_root, "win")), term ?? (() => new PowerShellTerminal()), NullLogger.Instance, desktop);

    [Fact]
    public async Task The_person_at_the_PC_is_told_before_and_after_and_the_session_announces_its_capabilities()
    {
        var n = new Note(); var ch = new MemChannel(); var run = Runner(n).RunAsync(Offer("files"), ch, default);
        var ready = await ch.Next("ready"); Assert.Equal("files", ready.GetProperty("kind").GetString());
        Assert.Contains("admin@corp.test started a remote files support session", n.Shown[0]); Assert.Contains("printer", n.Shown[0]);
        ch.Admin(new { t = "end" }); await run;
        Assert.Contains("has ended", n.Shown[^1]);
    }

    [Fact]
    public async Task A_real_PowerShell_terminal_runs_commands_and_streams_output_and_is_killed_when_the_session_ends()
    {
        var ch = new MemChannel(); var run = Runner(new Note()).RunAsync(Offer("terminal"), ch, default); await ch.Next("ready");
        ch.Admin(new { t = "term.start" }); ch.Admin(new { t = "term.in", d = "Write-Output ('viro-' + (6*7))\n" });
        ch.Admin(new { t = "term.in", d = "Write-Output ('caf' + [char]0xE9 + ' ' + [char]0x2713)\n" });   // non-ASCII must survive the round trip
        var sb = new System.Text.StringBuilder(); var deadline = DateTime.UtcNow.AddSeconds(40);
        while (!(sb.ToString().Contains("viro-42") && sb.ToString().Contains("café ✓")) && DateTime.UtcNow < deadline) { try { sb.Append((await ch.Next("term.out", 5000)).GetProperty("d").GetString()); } catch (OperationCanceledException) { } }
        var raw = new List<string>(); while (ch.FromAgent.Reader.TryRead(out var r)) raw.Add(r);
        Assert.True(sb.ToString().Contains("viro-42"), "terminal output was: [" + sb + "] other messages: " + string.Join(" | ", raw));
        ch.Admin(new { t = "term.in", d = "exit 7\n" });
        Assert.Equal(7, (await ch.Next("term.exit", 40000)).GetProperty("code").GetInt32());
        ch.Admin(new { t = "end" }); await run;
    }

    [Fact]
    public async Task Terminal_messages_are_ignored_in_a_files_session_and_file_messages_in_a_terminal_session()
    {
        var started = false; var ch = new MemChannel(); var run = Runner(new Note(), () => { started = true; return new PowerShellTerminal(); }).RunAsync(Offer("files"), ch, default); await ch.Next("ready");
        ch.Admin(new { t = "term.start" }); ch.Admin(new { t = "fs.ls", path = _root }); await ch.Next("fs.ls.r"); Assert.False(started);
        ch.Admin(new { t = "end" }); await run;
        var ch2 = new MemChannel(); var run2 = Runner(new Note()).RunAsync(Offer("terminal"), ch2, default); await ch2.Next("ready");
        File.WriteAllText(Path.Combine(_root, "secret.txt"), "x"); ch2.Admin(new { t = "fs.get", path = Path.Combine(_root, "secret.txt") }); ch2.Admin(new { t = "end" }); await run2;
        Assert.Empty(ch2.FromAgent.Reader.TryPeek(out var leftover) ? new[] { leftover } : []);
    }

    [Fact]
    public async Task Files_can_be_listed_downloaded_and_uploaded_and_uploads_are_atomic_and_refuse_overwrite_by_default()
    {
        var dir = Path.Combine(_root, "work"); Directory.CreateDirectory(dir); File.WriteAllBytes(Path.Combine(dir, "big.bin"), Enumerable.Range(0, 500_000).Select(i => (byte)(i % 251)).ToArray());
        var ch = new MemChannel(); var run = Runner(new Note()).RunAsync(Offer("files"), ch, default); await ch.Next("ready");
        ch.Admin(new { t = "fs.ls", path = dir }); var ls = await ch.Next("fs.ls.r"); Assert.Equal("big.bin", ls.GetProperty("entries")[0].GetProperty("name").GetString()); Assert.Equal(500_000, ls.GetProperty("entries")[0].GetProperty("size").GetInt64());
        ch.Admin(new { t = "fs.get", path = Path.Combine(dir, "big.bin") });
        var got = new MemoryStream(); JsonElement chunk; do { chunk = await ch.Next("fs.chunk"); got.Write(Convert.FromBase64String(chunk.GetProperty("d").GetString()!)); } while (!chunk.GetProperty("last").GetBoolean());
        Assert.Equal(File.ReadAllBytes(Path.Combine(dir, "big.bin")), got.ToArray());

        var up = Path.Combine(dir, "uploaded.txt"); var payload = System.Text.Encoding.UTF8.GetBytes("hello from support");
        ch.Admin(new { t = "fs.put", path = up, size = payload.Length }); ch.Admin(new { t = "fs.chunk", d = Convert.ToBase64String(payload), last = true });
        Assert.Equal(payload.Length, (await ch.Next("fs.put.ok")).GetProperty("bytes").GetInt64()); Assert.Equal(payload, File.ReadAllBytes(up)); Assert.False(File.Exists(up + ".viro-upload"));
        ch.Admin(new { t = "fs.put", path = up, size = 1 }); Assert.Contains("exists", (await ch.Next("fs.err")).GetProperty("message").GetString());
        ch.Admin(new { t = "fs.put", path = up, size = 3, overwrite = true }); ch.Admin(new { t = "fs.chunk", d = Convert.ToBase64String([1, 2, 3]), last = true }); await ch.Next("fs.put.ok"); Assert.Equal(new byte[] { 1, 2, 3 }, File.ReadAllBytes(up));
        ch.Admin(new { t = "end" }); await run;
    }

    [Fact]
    public async Task Forbidden_paths_oversize_uploads_and_bad_input_produce_errors_not_crashes()
    {
        var ch = new MemChannel(); var run = Runner(new Note()).RunAsync(Offer("files"), ch, default); await ch.Next("ready");
        ch.Admin(new { t = "fs.get", path = Path.Combine(_root, "agentdata", "agent.json") }); Assert.Contains("off limits", (await ch.Next("fs.err")).GetProperty("message").GetString());
        ch.Admin(new { t = "fs.ls", path = @"\\evil\share" }); Assert.Contains("not allowed", (await ch.Next("fs.err")).GetProperty("message").GetString());
        ch.Admin(new { t = "fs.get", path = Path.Combine(_root, "nope.txt") }); Assert.Contains("not found", (await ch.Next("fs.err")).GetProperty("message").GetString());
        var f = Path.Combine(_root, "limit.bin"); ch.Admin(new { t = "fs.put", path = f, size = 4 }); ch.Admin(new { t = "fs.chunk", d = Convert.ToBase64String(new byte[100]), last = true });
        Assert.Contains("larger than allowed", (await ch.Next("fs.err")).GetProperty("message").GetString()); Assert.False(File.Exists(f)); Assert.False(File.Exists(f + ".viro-upload"), "partial uploads are cleaned up");
        ch.Admin(new { t = "fs.chunk", d = "!!!not base64", last = false }); ch.Admin(new { t = "fs.ls", path = _root }); await ch.Next("fs.ls.r");   // the session is still alive
        ch.Admin(new { t = "end" }); await run;
    }

    [Fact]
    public async Task Remote_desktop_says_so_plainly_when_no_helper_is_available()
    {
        var ch = new MemChannel(); var run = Runner(new Note()).RunAsync(Offer("desktop"), ch, default); await ch.Next("ready");
        ch.Admin(new { t = "ds.start", fps = 5 }); Assert.Contains("helper", (await ch.Next("error")).GetProperty("message").GetString());
        ch.Admin(new { t = "end" }); await run;
    }

    sealed class RecordingDesktop : IDesktopSource
    {
        public readonly List<string> Calls = [];
        public Task StartAsync(int fps, int quality, Action<byte[]> onFrame, CancellationToken ct) { Calls.Add($"start {fps} {quality}"); return Task.CompletedTask; }
        public void Stop() => Calls.Add("stop");
        public void Mouse(double x, double y, string? button, string action, int wheel) => Calls.Add($"mouse {x:0.00},{y:0.00} {button} {action}");
        public void Key(int virtualKey, bool down) => Calls.Add($"key {virtualKey} {down}");
        public void Tune(int fps, int quality, int maxWidth) => Calls.Add($"tune {fps} {quality} {maxWidth}");
        public void TypeText(string text) => Calls.Add("text " + text);
    }

    [Fact]
    public async Task Remote_desktop_answers_delay_checks_and_passes_speed_typing_and_clicks_to_the_helper()
    {
        var d = new RecordingDesktop(); var ch = new MemChannel(); var run = Runner(new Note(), null, d).RunAsync(Offer("desktop"), ch, default); await ch.Next("ready");
        ch.Admin(new { t = "ds.ping", ts = 123.5 }); Assert.Equal(123.5, (await ch.Next("ds.pong")).GetProperty("ts").GetDouble());   // the console measures the real round trip
        ch.Admin(new { t = "ds.start", fps = 8, quality = 55 }); ch.Admin(new { t = "ds.tune", fps = 12, quality = 40, maxWidth = 960 });
        ch.Admin(new { t = "ds.mouse", x = 0.5, y = 0.25, btn = "left", act = "down" }); ch.Admin(new { t = "ds.mouse", x = 0.5, y = 0.25, btn = "left", act = "up" });
        ch.Admin(new { t = "ds.text", text = "Hello café" }); ch.Admin(new { t = "ds.text", text = new string('x', 2001) });          // too long: ignored
        ch.Admin(new { t = "end" }); await run;
        Assert.Equal(["start 8 55", "tune 12 40 960", "mouse 0.50,0.25 left down", "mouse 0.50,0.25 left up", "text Hello café", "stop"], d.Calls.Where(c => !c.StartsWith("stop") || c == "stop").Take(6).ToList());
    }

    [Fact]
    public async Task The_channel_closing_ends_the_session_and_stops_everything()
    {
        var killed = false; var term = new StubTerminal(() => killed = true);
        var ch = new MemChannel(); var run = Runner(new Note(), () => term).RunAsync(Offer("terminal"), ch, default); await ch.Next("ready");
        ch.Admin(new { t = "term.start" }); await Task.Delay(100); ch.Close(); await run.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(killed);
    }
    sealed class StubTerminal(Action onKill) : ITerminal { public void Start(Action<string> o, Action<int> e) { } public Task WriteAsync(string t) => Task.CompletedTask; public void Kill() => onKill(); public ValueTask DisposeAsync() => ValueTask.CompletedTask; }
}
