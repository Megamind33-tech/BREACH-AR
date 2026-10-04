using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace Viro.Agent.Care;

/// <summary>
/// Lets the window on the PC read this computer's whole picture without ever seeing the device's credentials. The service (which holds them) fetches the
/// view from Control and serves it, read-only, over a local pipe that any signed-in user may open. The pipe answers exactly one question ("self") and
/// cannot start a job, change a setting or return anything about another computer.
/// </summary>
public sealed class LocalViewServer(ILogger<LocalViewServer> log) : BackgroundService
{
    public const string PipeName = "viro-local-view";
    static readonly TimeSpan Fresh = TimeSpan.FromSeconds(45);
    string? cached; DateTime cachedAt = DateTime.MinValue; readonly SemaphoreSlim fetch = new(1, 1);

    public static PipeSecurity Security()
    {
        var s = new PipeSecurity();
        s.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        s.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        s.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        return s;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var cfg = AgentConfig.Load(); while (!cfg.IsEnrolled) { try { await Task.Delay(TimeSpan.FromSeconds(15), ct); } catch (OperationCanceledException) { return; } cfg = AgentConfig.Load(); }
        var client = new ControlClient(cfg.ServerUrl); client.UseDevice(cfg.DeviceId, cfg.DeviceSecret);
        log.LogInformation("Local view ready (pipe {Name})", PipeName);
        await ListenAsync(PipeName, c => ViewAsync(client, c), Security(), log, ct);
    }

    /// <summary>Serves the read-only "self" question on a pipe until cancelled. The source returns the view JSON, or null when it is not available.</summary>
    public static async Task ListenAsync(string pipeName, Func<CancellationToken, Task<string?>> source, PipeSecurity security, ILogger log, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            NamedPipeServerStream? pipe = null;
            try
            {
                pipe = NamedPipeServerStreamAcl.Create(pipeName, PipeDirection.InOut, 8, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, security);
                await pipe.WaitForConnectionAsync(ct);
                var p = pipe; pipe = null; _ = Task.Run(() => Serve(p, source, ct), ct);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception e) { log.LogWarning("Local view listener: {Msg}", e.Message); try { await Task.Delay(2000, ct); } catch { break; } }
            finally { pipe?.Dispose(); }
        }
    }

    static async Task Serve(NamedPipeServerStream pipe, Func<CancellationToken, Task<string?>> source, CancellationToken ct)
    {
        await using var _ = pipe;
        try
        {
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct); limit.CancelAfter(TimeSpan.FromSeconds(30));
            if (await PipeFrames.ReadAsync(pipe, limit.Token) is not { type: PipeFrames.Ui } m) return;
            using var req = JsonDocument.Parse(m.payload);
            object reply;
            if (req.RootElement.TryGetProperty("k", out var k) && k.GetString() == "self")
            {
                var json = await source(limit.Token);
                reply = json is null ? new { ok = false, error = "Viro could not reach its service right now." } : new { ok = true, view = JsonDocument.Parse(json).RootElement };
            }
            else reply = new { ok = false, error = "unsupported request" };       // read-only: nothing else is ever answered
            await PipeFrames.WriteAsync(pipe, PipeFrames.Ui, JsonSerializer.SerializeToUtf8Bytes(reply), limit.Token);
        }
        catch (Exception e) when (e is OperationCanceledException or IOException or JsonException) { /* the window went away or sent nonsense */ }
    }

    async Task<string?> ViewAsync(ControlClient client, CancellationToken ct)
    {
        await fetch.WaitAsync(ct);
        try
        {
            if (cached is not null && DateTime.UtcNow - cachedAt < Fresh) return cached;
            try { using var d = await client.CallAsync(HttpMethod.Get, "agent/v1/self", null, ct); if (d is not null) { cached = d.RootElement.GetRawText(); cachedAt = DateTime.UtcNow; } }
            catch (Exception e) when (!ct.IsCancellationRequested) { log.LogInformation("Could not refresh the local view ({Msg})", e.Message); }
            return cached;        // the last good copy when Control is unreachable
        }
        finally { fetch.Release(); }
    }

    /// <summary>The window's side: ask the service for the view. Null when the service is not running or not yet connected to Control.</summary>
    public static async Task<JsonElement?> ReadAsync(CancellationToken ct, string? pipeName = null)
    {
        try
        {
            await using var c = new NamedPipeClientStream(".", pipeName ?? PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            await c.ConnectAsync(3000, ct);
            await PipeFrames.WriteAsync(c, PipeFrames.Ui, JsonSerializer.SerializeToUtf8Bytes(new { k = "self" }), ct);
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct); limit.CancelAfter(TimeSpan.FromSeconds(40));
            if (await PipeFrames.ReadAsync(c, limit.Token) is not { type: PipeFrames.Ui } r) return null;
            using var d = JsonDocument.Parse(r.payload);
            return d.RootElement.TryGetProperty("ok", out var ok) && ok.GetBoolean() && d.RootElement.TryGetProperty("view", out var v) ? v.Clone() : null;
        }
        catch (Exception e) when (e is TimeoutException or IOException or OperationCanceledException or JsonException or UnauthorizedAccessException) { return null; }
    }
}
