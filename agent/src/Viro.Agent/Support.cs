using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Viro.Agent.Repair;

namespace Viro.Agent;

public sealed record SessionOffer(string Id, string Kind, string Admin, string? Reason);
public sealed record Incoming(string? Text, byte[]? Binary);

/// <summary>A connected support channel (a WebSocket in production, an in-memory pair in tests).</summary>
public interface IMessageChannel : IAsyncDisposable
{
    Task SendJsonAsync(object message, CancellationToken ct);
    Task SendBinaryAsync(ReadOnlyMemory<byte> data, CancellationToken ct);
    IAsyncEnumerable<Incoming> ReceiveAsync(CancellationToken ct);
}

public sealed class WebSocketChannel(ClientWebSocket ws) : IMessageChannel
{
    readonly SemaphoreSlim _send = new(1, 1);
    public async Task SendJsonAsync(object m, CancellationToken ct) => await Send(JsonSerializer.SerializeToUtf8Bytes(m, new JsonSerializerOptions(JsonSerializerDefaults.Web)), WebSocketMessageType.Text, ct);
    public Task SendBinaryAsync(ReadOnlyMemory<byte> d, CancellationToken ct) => Send(d.ToArray(), WebSocketMessageType.Binary, ct);
    async Task Send(byte[] data, WebSocketMessageType type, CancellationToken ct)
    {
        await _send.WaitAsync(ct);
        try { if (ws.State == WebSocketState.Open) await ws.SendAsync(data, type, true, ct); } finally { _send.Release(); }
    }
    public async IAsyncEnumerable<Incoming> ReceiveAsync([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var buf = new byte[64 * 1024];
        while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            using var ms = new MemoryStream(); WebSocketReceiveResult r;
            do { try { r = await ws.ReceiveAsync(buf, ct); } catch (Exception e) when (e is WebSocketException or OperationCanceledException) { yield break; } if (r.MessageType == WebSocketMessageType.Close) yield break; ms.Write(buf, 0, r.Count); if (ms.Length > 8 * 1024 * 1024) yield break; } while (!r.EndOfMessage);
            yield return r.MessageType == WebSocketMessageType.Text ? new(Encoding.UTF8.GetString(ms.ToArray()), null) : new(null, ms.ToArray());
        }
    }
    public async ValueTask DisposeAsync() { try { if (ws.State == WebSocketState.Open) await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None); } catch { } ws.Dispose(); }
}

/// <summary>Which files a support session may touch. An administrator is trusted, but not with the device credential or the registry hives.</summary>
public sealed class FilePolicy(string dataDir, string windowsDir)
{
    public const long MaxTransferBytes = 100L * 1024 * 1024;

    /// <summary>Returns a normalized absolute path, or throws <see cref="UnauthorizedAccessException"/> with the reason.</summary>
    public string Resolve(string? path, bool write)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 400 || path.Contains('\0')) throw new UnauthorizedAccessException("invalid path");
        if (path.StartsWith(@"\\", StringComparison.Ordinal) || path.StartsWith("//", StringComparison.Ordinal)) throw new UnauthorizedAccessException("network and device paths are not allowed");
        if (!(path.Length >= 3 && char.IsAsciiLetter(path[0]) && path[1] == ':' && (path[2] == '\\' || path[2] == '/'))) throw new UnauthorizedAccessException("an absolute local path (C:\\...) is required");
        var full = Path.GetFullPath(path);
        bool Under(string root) => full.Equals(root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) || full.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
        if (Under(dataDir)) throw new UnauthorizedAccessException("the agent's own data folder (it holds the device credential) is off limits");
        if (Under(Path.Combine(windowsDir, "System32", "config"))) throw new UnauthorizedAccessException("registry hive files are off limits");
        return full;
    }
}

public interface ITerminal : IAsyncDisposable
{
    void Start(Action<string> onOutput, Action<int> onExit);
    Task WriteAsync(string text);
    void Kill();
}

/// <summary>An interactive PowerShell process with redirected stdio (its prompt and output stream back as text). Runs as the agent identity (SYSTEM when installed), which is exactly why it is admin-only and audited.</summary>
public sealed class PowerShellTerminal(string? powershellPath = null) : ITerminal
{
    Process? _p;
    public void Start(Action<string> onOutput, Action<int> onExit)
    {
        var exe = powershellPath ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        var psi = new ProcessStartInfo(exe, "-NoLogo -NoProfile -ExecutionPolicy Bypass")
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false) };   // no BOM: a byte-order mark would corrupt the first command
        _p = Process.Start(psi) ?? throw new InvalidOperationException("could not start PowerShell");
        _p.EnableRaisingEvents = true;
        _ = Pump(_p.StandardOutput, onOutput); _ = Pump(_p.StandardError, onOutput);
        _p.Exited += (_, _) => { try { onExit(_p.ExitCode); } catch { } };
        // Two separate lines: UTF-8 *without* a BOM (the BOM-emitting [Text.Encoding]::UTF8 garbles non-ASCII output), and no progress bars in the stream.
        _p.StandardInput.WriteLine("[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false");
        _p.StandardInput.WriteLine("$ProgressPreference = 'SilentlyContinue'");
    }
    static async Task Pump(StreamReader r, Action<string> sink) { var buf = new char[4096]; int n; try { while ((n = await r.ReadAsync(buf)) > 0) sink(new string(buf, 0, n)); } catch { } }
    public async Task WriteAsync(string text) { if (_p is { HasExited: false }) { await _p.StandardInput.WriteAsync(text); await _p.StandardInput.FlushAsync(); } }
    public void Kill() { try { if (_p is { HasExited: false }) _p.Kill(true); } catch { } }
    public ValueTask DisposeAsync() { Kill(); _p?.Dispose(); return ValueTask.CompletedTask; }
}

/// <summary>Runs one support session: announces it to the user, then serves the messages its kind allows until either side ends it.</summary>
public sealed class SupportSessionRunner(IUserNotifier notifier, FilePolicy files, Func<ITerminal> terminalFactory, ILogger log, IDesktopSource? desktop = null)
{
    public async Task RunAsync(SessionOffer offer, IMessageChannel ch, CancellationToken ct)
    {
        var shown = notifier.Notify("IT support session", $"{offer.Admin} started a remote {offer.Kind} support session on this PC.{(string.IsNullOrEmpty(offer.Reason) ? "" : " Reason: " + Sanitize(offer.Reason))}", 30);
        log.LogInformation("Support session {Id} ({Kind}) by {Admin}; shown to {N} user session(s)", offer.Id, offer.Kind, offer.Admin, shown);
        using var lease = new BusyLease.Hold(AgentConfig.DataDir, "support session");
        ITerminal? term = null; FileStream? upload = null; string? uploadFinal = null, uploadTemp = null; long uploadBytes = 0, uploadLimit = 0;
        try
        {
            await ch.SendJsonAsync(new { t = "ready", kind = offer.Kind, caps = Caps(offer.Kind) }, ct);
            await foreach (var m in ch.ReceiveAsync(ct))
            {
                if (m.Text is null) continue;
                using var doc = JsonDocument.Parse(m.Text); var root = doc.RootElement; var t = root.GetProperty("t").GetString();
                try
                {
                    switch (t)
                    {
                        case "term.start" when offer.Kind == "terminal":
                            term?.Kill(); term = terminalFactory();
                            term.Start(o => _ = ch.SendJsonAsync(new { t = "term.out", d = o }, ct), code => _ = ch.SendJsonAsync(new { t = "term.exit", code }, ct));
                            break;
                        case "term.in" when offer.Kind == "terminal" && term is not null: await term.WriteAsync(root.GetProperty("d").GetString() ?? ""); break;
                        case "term.stop": term?.Kill(); break;
                        case "fs.ls" when offer.Kind == "files": await List(ch, root.GetProperty("path").GetString(), ct); break;
                        case "fs.get" when offer.Kind == "files": await Send(ch, root.GetProperty("path").GetString(), ct); break;
                        case "fs.put" when offer.Kind == "files":
                            upload?.Dispose(); uploadFinal = files.Resolve(root.GetProperty("path").GetString(), write: true);
                            uploadLimit = Math.Min(root.TryGetProperty("size", out var sz) ? sz.GetInt64() : FilePolicy.MaxTransferBytes, FilePolicy.MaxTransferBytes);
                            if (File.Exists(uploadFinal) && !(root.TryGetProperty("overwrite", out var ow) && ow.ValueKind == JsonValueKind.True)) throw new IOException("the file exists; send overwrite:true to replace it");
                            Directory.CreateDirectory(Path.GetDirectoryName(uploadFinal)!);
                            uploadTemp = uploadFinal + ".viro-upload"; upload = new FileStream(uploadTemp, FileMode.Create, FileAccess.Write, FileShare.None); uploadBytes = 0; break;
                        case "fs.chunk" when offer.Kind == "files" && upload is not null:
                            var bytes = Convert.FromBase64String(root.GetProperty("d").GetString()!); uploadBytes += bytes.Length;
                            if (uploadBytes > uploadLimit) throw new IOException("upload is larger than allowed");
                            await upload.WriteAsync(bytes, ct);
                            if (root.TryGetProperty("last", out var last) && last.GetBoolean())
                            {
                                await upload.DisposeAsync(); upload = null; File.Move(uploadTemp!, uploadFinal!, true);
                                await ch.SendJsonAsync(new { t = "fs.put.ok", path = uploadFinal, bytes = uploadBytes }, ct);
                            }
                            break;
                        case "ds.start" when offer.Kind == "desktop":
                            if (desktop is null) { await ch.SendJsonAsync(new { t = "error", message = "remote desktop needs the per-user helper, which is not available on this PC (no signed-in user session or helper not installed)" }, ct); break; }
                            await desktop.StartAsync(root.TryGetProperty("fps", out var fps) ? fps.GetInt32() : 5, root.TryGetProperty("quality", out var q) ? q.GetInt32() : 50, f => _ = ch.SendBinaryAsync(f, ct), ct); break;
                        case "ds.stop": desktop?.Stop(); break;
                        case "ds.ping" when offer.Kind == "desktop": await ch.SendJsonAsync(new { t = "ds.pong", ts = root.GetProperty("ts").GetDouble() }, ct); break;      // lets the console show the real round-trip delay
                        case "ds.tune" when offer.Kind == "desktop": desktop?.Tune(root.TryGetProperty("fps", out var tf) ? tf.GetInt32() : 8, root.TryGetProperty("quality", out var tq) ? tq.GetInt32() : 55, root.TryGetProperty("maxWidth", out var tw) ? tw.GetInt32() : 1280); break;
                        case "ds.text" when offer.Kind == "desktop": if (root.TryGetProperty("text", out var tt) && tt.GetString() is { Length: > 0 and <= 2000 } txt) desktop?.TypeText(txt); break;
                        case "ds.mouse" when offer.Kind == "desktop": desktop?.Mouse(root.GetProperty("x").GetDouble(), root.GetProperty("y").GetDouble(), root.TryGetProperty("btn", out var b) ? b.GetString() : null, root.TryGetProperty("act", out var a) ? a.GetString() : "move", root.TryGetProperty("wheel", out var w) ? w.GetInt32() : 0); break;
                        case "ds.key" when offer.Kind == "desktop": desktop?.Key(root.GetProperty("code").GetInt32(), root.GetProperty("down").GetBoolean()); break;
                        case "end": return;
                    }
                }
                catch (Exception e) when (e is UnauthorizedAccessException or IOException or FormatException or KeyNotFoundException or InvalidOperationException or JsonException)
                { upload?.Dispose(); upload = null; if (uploadTemp is not null && File.Exists(uploadTemp)) try { File.Delete(uploadTemp); } catch { } await ch.SendJsonAsync(new { t = "fs.err", message = e.Message }, ct); }
            }
        }
        finally
        {
            upload?.Dispose(); if (uploadTemp is not null && File.Exists(uploadTemp)) try { File.Delete(uploadTemp); } catch { }
            term?.Kill(); desktop?.Stop();
            notifier.Notify("IT support session", "The remote support session has ended.", 10);
            log.LogInformation("Support session {Id} ended", offer.Id);
        }
    }

    static string[] Caps(string kind) => kind switch { "terminal" => ["term"], "files" => ["ls", "get", "put"], "desktop" => ["screen", "mouse", "keyboard"], _ => [] };
    static string Sanitize(string s) => new(s.Where(c => char.IsLetterOrDigit(c) || " .,:;!?()-_/#".Contains(c)).Take(150).ToArray());

    async Task List(IMessageChannel ch, string? path, CancellationToken ct)
    {
        var dir = files.Resolve(path, write: false);
        var di = new DirectoryInfo(dir); if (!di.Exists) throw new IOException("folder not found");
        var entries = di.EnumerateFileSystemInfos().Take(2000).Select(e => { var d = e is DirectoryInfo; return new { name = e.Name, isDir = d, size = d ? 0 : ((FileInfo)e).Length, modified = e.LastWriteTimeUtc.ToString("O") }; }).ToList();
        await ch.SendJsonAsync(new { t = "fs.ls.r", path = dir, entries }, ct);
    }

    async Task Send(IMessageChannel ch, string? path, CancellationToken ct)
    {
        var file = files.Resolve(path, write: false); var fi = new FileInfo(file);
        if (!fi.Exists) throw new IOException("file not found");
        if (fi.Length > FilePolicy.MaxTransferBytes) throw new IOException($"file is larger than the {FilePolicy.MaxTransferBytes / 1048576} MB transfer limit");
        await using var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var buf = new byte[192 * 1024]; int n; var seq = 0;
        while ((n = await fs.ReadAsync(buf, ct)) > 0) await ch.SendJsonAsync(new { t = "fs.chunk", name = fi.Name, seq = seq++, d = Convert.ToBase64String(buf, 0, n), last = fs.Position >= fs.Length }, ct);
        if (fi.Length == 0) await ch.SendJsonAsync(new { t = "fs.chunk", name = fi.Name, seq = 0, d = "", last = true }, ct);
    }
}

/// <summary>Screen capture and input injection performed in the signed-in user's session (see DesktopHelper).</summary>
public interface IDesktopSource
{
    Task StartAsync(int fps, int quality, Action<byte[]> onFrame, CancellationToken ct);
    void Stop();
    void Mouse(double x, double y, string? button, string action, int wheel);
    void Key(int virtualKey, bool down);
    /// <summary>Changes the picture speed and quality while the session runs.</summary>
    void Tune(int fps, int quality, int maxWidth) { }
    /// <summary>Types text into whatever window is active on the PC.</summary>
    void TypeText(string text) { }
}

/// <summary>Tracks which support sessions are running and starts new ones offered by the heartbeat.</summary>
public sealed class SupportManager(ControlClient client, SupportSessionRunner Runner, ILogger log)
{
    readonly HashSet<string> _running = [];
    readonly object _gate = new();

    public void Offer(IEnumerable<SessionOffer> offers, CancellationToken ct)
    {
        foreach (var o in offers)
        {
            lock (_gate) if (!_running.Add(o.Id)) continue;
            _ = Task.Run(async () =>
            {
                try { await using var ch = await client.ConnectSessionAsync(o.Id, ct); await Runner.RunAsync(o, ch, ct); }
                catch (Exception e) when (!ct.IsCancellationRequested) { log.LogWarning("Support session {Id} failed: {Msg}", o.Id, e.Message); }
                finally { lock (_gate) _running.Remove(o.Id); }
            }, ct);
        }
    }
}
