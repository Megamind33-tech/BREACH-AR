using System.Drawing;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace WorkCare.QuickCheck;

/// <summary>
/// One small window, three states: choose, connect a phone (shows the session code), inspect here. Read-only throughout. Closing the window stops the listener and removes this run's temporary folder.
/// </summary>
public sealed class MainForm : Form
{
    static readonly Color Bg = Color.FromArgb(8, 11, 10), Surface = Color.FromArgb(21, 27, 24), Green = Color.FromArgb(56, 224, 120), Ink = Color.FromArgb(243, 247, 244), Muted = Color.FromArgb(151, 163, 156), Amber = Color.FromArgb(233, 180, 76), Red = Color.FromArgb(242, 104, 92), Line = Color.FromArgb(40, 46, 43);
    readonly RulesEvaluator _rules; readonly string _sessionDir;
    SessionServer? _server; InspectionRunner? _runner; CancellationTokenSource? _cts; System.Windows.Forms.Timer? _tick;
    readonly Panel _body = new() { Dock = DockStyle.Fill, Padding = new Padding(28, 8, 28, 20), BackColor = Bg };

    public MainForm(RulesEvaluator rules, string sessionDir)
    {
        _rules = rules; _sessionDir = sessionDir;
        Text = "WorkCare QuickCheck"; BackColor = Bg; ForeColor = Ink; Font = new Font("Segoe UI", 10f); ClientSize = new Size(520, 700); MinimumSize = new Size(480, 560); StartPosition = FormStartPosition.CenterScreen;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        var head = new Panel { Dock = DockStyle.Top, Height = 74, BackColor = Bg, Padding = new Padding(28, 22, 28, 0) };
        head.Controls.Add(new Label { Text = "WORKCARE", ForeColor = Green, Font = new Font("Segoe UI Semibold", 8.5f), AutoSize = true, Location = new Point(28, 20) });
        head.Controls.Add(new Label { Text = "QuickCheck", ForeColor = Ink, Font = new Font("Segoe UI Semibold", 17f), AutoSize = true, Location = new Point(24, 34) });
        Controls.Add(_body); Controls.Add(head);
        FormClosing += (_, _) => Teardown();
        ShowStart();
    }

    // ------------------------------------------------------------------------------------------ pieces
    Label L(string t, float size = 10f, Color? c = null, bool bold = false, int top = 0) => new() { Text = t, ForeColor = c ?? Muted, Font = new Font(bold ? "Segoe UI Semibold" : "Segoe UI", size), AutoSize = true, MaximumSize = new Size(440, 0), Margin = new Padding(0, top, 0, 0) };
    Button B(string t, EventHandler onClick, bool primary = false)
    {
        var b = new Button { Text = t, Height = 46, Width = 440, FlatStyle = FlatStyle.Flat, ForeColor = primary ? Color.FromArgb(4, 20, 11) : Ink, BackColor = primary ? Green : Surface, Font = new Font("Segoe UI Semibold", 10.5f), Margin = new Padding(0, 10, 0, 0), Cursor = Cursors.Hand };
        b.FlatAppearance.BorderColor = primary ? Green : Line; b.Click += onClick; return b;
    }
    FlowLayoutPanel Column() => new() { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, BackColor = Bg };
    void Show(FlowLayoutPanel f) { _body.Controls.Clear(); _body.Controls.Add(f); }
    void UI(Action a) { if (IsHandleCreated && !IsDisposed) BeginInvoke(a); }

    // ------------------------------------------------------------------------------------------ start
    void ShowStart()
    {
        Teardown(false); var f = Column();
        f.Controls.Add(L("Check this computer.", 20f, Ink, true, 8));
        f.Controls.Add(L("QuickCheck reads this PC's hardware and condition. It is read-only: nothing is installed, changed or left behind.", 10.5f, Muted, false, 10));
        f.Controls.Add(B("Connect a phone", (_, _) => ShowConnect(), true));
        f.Controls.Add(B("Inspect this PC here", (_, _) => ShowLocal()));
        f.Controls.Add(L("What it does", 9f, Muted, true, 26)); f.Controls.Add(L("Reads processor, memory, storage health, battery, temperature, security and Windows details. Works without Internet and without an account.", 9.5f, Muted, false, 4));
        f.Controls.Add(L("What it never does", 9f, Muted, true, 18)); f.Controls.Add(L("It does not install a service, add a startup entry, schedule a task, run anything in the background, or change any setting. Everything it creates is deleted when you close this window.", 9.5f, Muted, false, 4));
        Show(f);
    }

    // ------------------------------------------------------------------------------------------ connect a phone
    void ShowConnect()
    {
        Teardown(false);
        var code = Wcp1.NewCode(); _runner = new InspectionRunner(_rules);
        _server = new SessionServer(code, (id, deep, ct) => _runner.RunAsync(id, ct, deep));
        _runner.Progress += p => _server?.Report(p);
        var f = Column(); var codeLbl = L(code, 34f, Ink, true, 6); codeLbl.Font = new Font("Consolas", 34f, FontStyle.Bold); var status = L("Waiting for the phone...", 11f, Green, true, 8); var detail = L("", 9.5f, Muted, false, 6);
        var stages = new Label { Text = "", ForeColor = Ink, Font = new Font("Consolas", 10f), AutoSize = true, MaximumSize = new Size(440, 0), Margin = new Padding(0, 14, 0, 0) };
        var expiry = L("", 9.5f, Muted, false, 4);
        f.Controls.Add(L("Connect a phone", 20f, Ink, true, 8)); f.Controls.Add(L("On the phone open WorkCare, choose Check, then A computer, and enter this code.", 10.5f, Muted, false, 8));
        f.Controls.Add(codeLbl); f.Controls.Add(expiry); f.Controls.Add(status); f.Controls.Add(detail); f.Controls.Add(stages);
        var adv = L("", 9f, Muted, false, 14); adv.Visible = false; f.Controls.Add(B("Advanced: show network address", (_, _) => { adv.Text = "Address " + string.Join(", ", LocalAddresses().Select(a => $"{a}:{SessionServer.HttpPort}")) + "\r\nUse this only if the phone cannot find the computer by itself."; adv.Visible = !adv.Visible; })); f.Controls.Add(adv);
        f.Controls.Add(B("New code", (_, _) => ShowConnect())); f.Controls.Add(B("Close session", (_, _) => ShowStart()));
        Show(f);
        try { _server.Start(); } catch (Exception e) { status.Text = "Could not start listening: " + e.Message; status.ForeColor = Red; return; }
        _server.StateChanged += () => UI(() => { if (_server is null) return; if (_server.PhoneConnected) { status.Text = "Phone connected"; detail.Text = $"Check that the phone shows the same number: {_server.Sas![..3]} {_server.Sas[3..]}\r\nThe session is encrypted and can only inspect. If the numbers differ, close the session."; } });
        _server.ScanProgress += p => UI(() => { status.Text = p["finished"]!.GetValue<bool>() ? "Inspection finished" : "Inspecting..."; stages.Text = StageText(p); });
        _server.ScanResult += r => UI(() => { detail.Text = $"{r["passed"]} passed, {r["attention"]} need attention, {r["critical"]} critical. The full report is on the phone."; });
        _tick = new System.Windows.Forms.Timer { Interval = 1000 }; _tick.Tick += (_, _) => { var left = _server is null ? 0 : _server.ExpiresAt - DateTimeOffset.UtcNow.ToUnixTimeSeconds(); expiry.Text = _server?.PhoneConnected == true ? "" : left > 0 ? $"Code valid for {left / 60}:{left % 60:00}" : "This code has expired. Choose New code."; }; _tick.Start();
    }
    static string StageText(JsonObject p) => string.Join("\r\n", p["stages"]!.AsArray().Select(s => $"{(s!["state"]!.GetValue<string>() switch { "done" => "[x]", "running" => "[~]", "failed" => "[!]", "skipped" => "[-]", _ => "[ ]" })} {s["label"]!.GetValue<string>()}{(s["detail"] is JsonNode d ? "  (" + d.GetValue<string>() + ")" : "")}"));
    static IEnumerable<string> LocalAddresses() => System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces().Where(n => n.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up && n.NetworkInterfaceType != System.Net.NetworkInformation.NetworkInterfaceType.Loopback).SelectMany(n => n.GetIPProperties().UnicastAddresses).Where(a => a.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork).Select(a => a.Address.ToString());

    // ------------------------------------------------------------------------------------------ inspect here (no phone, no network)
    void ShowLocal()
    {
        Teardown(false); _runner = new InspectionRunner(_rules); _cts = new CancellationTokenSource();
        var f = Column(); var status = L("Starting...", 11f, Green, true, 8); var stages = new Label { ForeColor = Ink, Font = new Font("Consolas", 10f), AutoSize = true, Margin = new Padding(0, 12, 0, 0) };
        f.Controls.Add(L("Inspecting this PC", 20f, Ink, true, 8)); f.Controls.Add(status); f.Controls.Add(stages);
        Show(f);
        _runner.Progress += p => UI(() => { stages.Text = StageText(p); status.Text = $"{p["completedStages"]} of {p["totalStages"]} checks finished"; });
        _ = Task.Run(async () =>
        {
            try { var r = await _runner.RunAsync(Guid.NewGuid().ToString("N")[..12], _cts.Token); UI(() => ShowResult(r)); }
            catch (OperationCanceledException) { } catch (Exception e) { UI(() => { status.Text = "The inspection could not finish: " + e.Message; status.ForeColor = Red; f.Controls.Add(B("Back", (_, _) => ShowStart())); }); }
        });
    }
    void ShowResult(JsonObject r)
    {
        var f = Column(); f.Controls.Add(L("Check complete", 20f, Ink, true, 8));
        var d = r["device"]!; f.Controls.Add(L($"{d["name"]}" + (d["model"] is JsonNode m ? $"  ·  {m}" : ""), 10.5f, Muted, false, 4));
        f.Controls.Add(L($"{r["passed"]} passed    {r["attention"]} need attention    {r["critical"]} critical", 12f, Ink, true, 12));
        foreach (var sev in new[] { "critical", "attention", "healthy" })
        {
            var items = r["findings"]!.AsArray().Where(x => x!["severity"]!.GetValue<string>() == sev).ToList(); if (items.Count == 0) continue;
            f.Controls.Add(L(sev == "healthy" ? "GOOD" : sev.ToUpperInvariant(), 9f, sev == "critical" ? Red : sev == "attention" ? Amber : Green, true, 18));
            foreach (var x in items) { f.Controls.Add(L(x!["title"]!.GetValue<string>(), 10.5f, Ink, true, 8)); f.Controls.Add(L(x["summary"]!.GetValue<string>() + "  [" + x["evidenceType"]!.GetValue<string>().ToUpperInvariant() + "]", 9.5f, Muted, false, 1)); if (x["recommendedAction"] is JsonNode a && sev != "healthy") f.Controls.Add(L(a.GetValue<string>(), 9.5f, Ink, false, 1)); }
        }
        var nm = r["notMeasured"]!.AsArray(); if (nm.Count > 0) { f.Controls.Add(L("NOT MEASURED", 9f, Muted, true, 18)); foreach (var x in nm) f.Controls.Add(L(x!.GetValue<string>(), 9.5f, Muted, false, 2)); }
        f.Controls.Add(L(r["disclaimer"]!.GetValue<string>(), 9f, Muted, false, 18));
        f.Controls.Add(B("Save report...", (_, _) => { using var dlg = new SaveFileDialog { Filter = "JSON report|*.json", FileName = "workcare-quickcheck.json" }; if (dlg.ShowDialog(this) == DialogResult.OK) File.WriteAllText(dlg.FileName, r.ToJsonString(new JsonSerializerOptions { WriteIndented = true })); }));
        f.Controls.Add(B("Done", (_, _) => ShowStart(), true));
        Show(f);
    }

    // ------------------------------------------------------------------------------------------ cleanup
    void Teardown(bool final = true)
    {
        try { _tick?.Stop(); _tick?.Dispose(); } catch { } _tick = null;
        try { _cts?.Cancel(); } catch { } _cts = null;
        try { _server?.Dispose(); } catch { } _server = null; _runner = null;
        if (final) try { foreach (var x in Directory.GetFiles(_sessionDir)) File.Delete(x); } catch { }
    }
}
