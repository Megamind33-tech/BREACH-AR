using System.Diagnostics;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Viro.Agent.Care;

/// <summary>
/// The Viro window: a designed interface (HTML, CSS and a little script, embedded in the program and shown offline) hosted in Windows' own web view. It can only
/// talk to <see cref="LocalBridge"/>, cannot navigate away, open other windows or reach the network, and has no developer tools in normal use.
/// If the web view runtime is missing the caller falls back to the plain window.
/// </summary>
public sealed class LocalWebForm : Form
{
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    readonly WebView2 web = new() { DefaultBackgroundColor = Color.FromArgb(15, 17, 20), Dock = DockStyle.Fill };
    readonly LocalBridge bridge; readonly string? start; readonly CancellationTokenSource cts = new();

    public LocalWebForm(LocalBridge b, string? startPage)
    {
        bridge = b; start = startPage;
        var wa = Screen.PrimaryScreen!.WorkingArea;           // never taller or wider than the screen it opens on
        Text = "Viro WorkCare"; Width = Math.Min(1240, wa.Width - 40); Height = Math.Min(800, wa.Height - 40); MinimumSize = new Size(Math.Min(980, wa.Width - 40), Math.Min(640, wa.Height - 40)); StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(15, 17, 20);
        try { Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!); } catch { /* the default icon is fine */ }
        Controls.Add(web);
    }

    [System.ComponentModel.Browsable(false), System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    public bool NeedsPlainWindow { get; set; }

    /// <summary>True when the interface is showing. False means the web view runtime is missing and the plain window should be used.</summary>
    public async Task<bool> InitializeAsync()
    {
        if (Environment.GetEnvironmentVariable("VIRO_FORCE_PLAIN") == "1") { LastFailure = "the Microsoft Edge WebView2 component is not installed on this PC"; return false; }      // lets the plain window be reviewed on a PC that has the component
        try
        {
            // Each window gets its own profile folder named for its process, so a window that was killed can never leave a lock that blocks the next one.
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Viro", "webview");
            SweepStale(root); profile = Path.Combine(root, Environment.ProcessId.ToString());
            var env = await CoreWebView2Environment.CreateAsync(null, profile);
            var started = web.EnsureCoreWebView2Async(env);
            if (await Task.WhenAny(started, Task.Delay(TimeSpan.FromSeconds(30))) != started) { Log("web view did not start within 30 seconds"); LastFailure = "it did not start in time"; return false; }      // never leave a blank window: use the plain one
            await started;
        }
        catch (Exception e) when (e is WebView2RuntimeNotFoundException or InvalidOperationException or COMException or DllNotFoundException or BadImageFormatException) { Log("web view could not start: " + e); LastFailure = e is WebView2RuntimeNotFoundException ? "the Microsoft Edge WebView2 component is not installed on this PC" : e.GetType().Name; return false; }
        var s = web.CoreWebView2.Settings;
        s.AreDefaultContextMenusEnabled = false; s.AreDevToolsEnabled = Environment.GetEnvironmentVariable("VIRO_DEVTOOLS") == "1"; s.IsStatusBarEnabled = false; s.IsZoomControlEnabled = false; s.AreBrowserAcceleratorKeysEnabled = false; s.IsGeneralAutofillEnabled = false; s.IsPasswordAutosaveEnabled = false;
        web.CoreWebView2.NavigationStarting += (_, e) => { if (!e.Uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && e.Uri != "about:blank") e.Cancel = true; };      // the interface never leaves its own page
        web.CoreWebView2.NewWindowRequested += (_, e) => e.Handled = true;
        web.CoreWebView2.WebMessageReceived += async (_, e) =>
        {
            string req; try { req = e.TryGetWebMessageAsString(); } catch { return; }
            var resp = await bridge.RespondAsync(req, cts.Token);
            if (!IsDisposed) web.CoreWebView2.PostWebMessageAsString(resp);
        };
        await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync($"window.__start = {System.Text.Json.JsonSerializer.Serialize(start ?? "overview")};");
        using var res = Assembly.GetExecutingAssembly().GetManifestResourceStream("ui.html") ?? throw new InvalidOperationException("the interface is missing from this build");
        web.NavigateToString(new StreamReader(res, Encoding.UTF8).ReadToEnd());
        return true;
    }

    /// <summary>Why the web view could not start, when it could not (shown in the plain window).</summary>
    public static string? LastFailure { get; private set; }

    /// <summary>A short note in the user's profile saying why the plain window was used, so a missing runtime is a fact on disk and not a mystery.</summary>
    public static void Log(string line)
    {
        try { var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Viro"); Directory.CreateDirectory(dir); File.AppendAllText(Path.Combine(dir, "window.log"), $"{DateTime.Now:s} {line}{Environment.NewLine}"); } catch { /* a log is never worth failing for */ }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int on = 1, caption = 0x00140F0F;       // dark title bar, matching the interface (Windows 10 2004 and later; ignored elsewhere)
        try { DwmSetWindowAttribute(Handle, 20, ref on, sizeof(int)); DwmSetWindowAttribute(Handle, 35, ref caption, sizeof(int)); } catch { /* cosmetic */ }
    }

    string? profile;
    /// <summary>Removes profile folders left by windows that no longer exist (named by process id), so they do not pile up.</summary>
    static void SweepStale(string root)
    {
        try
        {
            if (!Directory.Exists(root)) return;
            foreach (var d in Directory.EnumerateDirectories(root))
            {
                if (!int.TryParse(Path.GetFileName(d), out var pid)) continue;
                try { using var p = Process.GetProcessById(pid); if (p.ProcessName.StartsWith("viro-agent", StringComparison.OrdinalIgnoreCase)) continue; } catch (ArgumentException) { /* that process is gone */ }
                try { Directory.Delete(d, true); } catch { /* still locked: tried again next time */ }
            }
        }
        catch { /* housekeeping only */ }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        cts.Cancel(); base.OnFormClosed(e);
        var p = profile; if (p is not null) _ = Task.Run(async () => { await Task.Delay(3000); try { Directory.Delete(p, true); } catch { /* the sweep removes it later */ } });
    }

    [DllImport("user32.dll")] static extern IntPtr FindWindow(string? cls, string title);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    /// <summary>Brings the already-open Viro window forward (it may still be starting up: then there is nothing to show yet and the first window will appear by itself).</summary>
    public static void BringExistingToFront() { try { var h = FindWindow(null, "Viro WorkCare"); if (h != IntPtr.Zero) { ShowWindow(h, 9); SetForegroundWindow(h); } } catch (Exception) { /* nothing to bring forward */ } }

    public static void Relaunch() { try { Process.Start(new ProcessStartInfo(Environment.ProcessPath!, "app --relaunch") { UseShellExecute = true, Verb = "runas" }); Environment.Exit(0); } catch { /* declined at the Windows prompt */ } }
}
