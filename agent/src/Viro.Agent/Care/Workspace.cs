using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Viro.Agent.Care;

/// <summary>A connection code from the admin console: "VIRO1-" and a base64url JSON with the server address and a one-time enrollment token.</summary>
public sealed record ConnectionCode(string Server, string Token)
{
    public static ConnectionCode Parse(string? text)
    {
        var t = new string((text ?? "").Where(c => !char.IsWhiteSpace(c)).ToArray());
        if (!t.StartsWith("VIRO1-", StringComparison.Ordinal)) throw new ArgumentException("That is not a Viro connection code. It starts with VIRO1-.");
        try
        {
            var b64 = t[6..].Replace('-', '+').Replace('_', '/'); b64 = b64.PadRight(b64.Length + (4 - b64.Length % 4) % 4, '=');
            using var d = JsonDocument.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(b64)));
            var u = d.RootElement.GetProperty("u").GetString() ?? ""; var tok = d.RootElement.GetProperty("t").GetString() ?? "";
            if (!Uri.TryCreate(u, UriKind.Absolute, out var uri) || !ControlClient.AllowsPlainHttp(uri) || uri.PathAndQuery != "/" || uri.UserInfo != "")
                throw new ArgumentException("The server address inside this code is not valid.");
            if (tok.Length < 10 || tok.Length > 200) throw new ArgumentException("The code is damaged.");
            return new(u.TrimEnd('/'), tok);
        }
        catch (Exception e) when (e is FormatException or JsonException or KeyNotFoundException or InvalidOperationException) { throw new ArgumentException("The code is damaged: copy it again in full."); }
    }
}

/// <summary>Joins this PC to a workspace. The look-up needs no rights; the join itself runs as administrator (one Windows prompt) because it registers the background service.</summary>
public sealed class WorkspaceActions(Func<string, ControlClient>? clientFactory = null)
{
    public async Task<EnrollCheck> CheckAsync(string code, CancellationToken ct)
    {
        var c = ConnectionCode.Parse(code);
        try { return await (clientFactory ?? (u => new ControlClient(u)))(c.Server).CheckEnrollmentAsync(c.Token, ct); }
        catch (AuthRejectedException) { throw new ArgumentException("This code is not valid, or it has expired or already been used. Ask your administrator for a new one."); }
        catch (HttpRequestException) { throw new ArgumentException("Viro could not reach the server in this code. Check the internet connection and try again."); }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { throw new ArgumentException("The server did not answer in time. Try again."); }
    }

    public async Task<(bool Ok, int Exit, string Message)> ConnectAsync(string code, bool move, CancellationToken ct)
    {
        ConnectionCode.Parse(code);     // refuse a bad code before asking for administrator rights
        var result = Path.Combine(Path.GetTempPath(), "viro-connect-" + Guid.NewGuid().ToString("N") + ".json");
        try
        {
            var args = $"connect --code \"{new string(code.Where(c => !char.IsWhiteSpace(c)).ToArray())}\" --result \"{result}\"" + (move ? " --move" : "");
            using var p = Process.Start(new ProcessStartInfo(Environment.ProcessPath!, args) { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden })!;
            await p.WaitForExitAsync(ct);
            if (File.Exists(result))
            {
                using var d = JsonDocument.Parse(await File.ReadAllTextAsync(result, ct));
                return (d.RootElement.GetProperty("exit").GetInt32() == 0, d.RootElement.GetProperty("exit").GetInt32(), d.RootElement.GetProperty("message").GetString() ?? "");
            }
            return (false, p.ExitCode, "Viro could not finish connecting this PC.");
        }
        catch (Win32Exception e) when (e.NativeErrorCode == 1223) { return (false, 1223, "Connecting needs your permission in the Windows prompt, and it was cancelled. Nothing was changed."); }
        finally { try { File.Delete(result); } catch { /* temp file only */ } }
    }
}
