using System.ComponentModel;
using System.Diagnostics;

namespace Viro.Agent.Care;

/// <summary>Installs Microsoft's Edge WebView2 runtime (what the Viro interface is drawn with) when a PC does not have it. Started by the person from the window; one Windows prompt.</summary>
public static class WebViewRuntime
{
    // Microsoft's official small installer (Evergreen bootstrapper). It downloads the runtime itself.
    const string Bootstrapper = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

    public static async Task<(bool Ok, string Message)> InstallAsync(CancellationToken ct)
    {
        var file = Path.Combine(Path.GetTempPath(), "MicrosoftEdgeWebview2Setup-" + Guid.NewGuid().ToString("N") + ".exe");
        try
        {
            using (var http = new HttpClient { Timeout = TimeSpan.FromMinutes(3) })
            await using (var o = File.Create(file)) await (await http.GetStreamAsync(Bootstrapper, ct)).CopyToAsync(o, ct);
            using var p = Process.Start(new ProcessStartInfo(file, "/silent /install") { UseShellExecute = true, Verb = "runas" })!;
            await p.WaitForExitAsync(ct);
            return p.ExitCode == 0 ? (true, "The Viro interface component is installed.") : (false, "The installer did not finish (code " + p.ExitCode + ").");
        }
        catch (Win32Exception e) when (e.NativeErrorCode == 1223) { return (false, "That needs your permission in the Windows prompt, and it was cancelled."); }
        catch (HttpRequestException) { return (false, "Viro could not download the component. Check the internet connection and try again."); }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { return (false, "The download took too long. Try again."); }
        finally { try { File.Delete(file); } catch { /* temp file only */ } }
    }
}
