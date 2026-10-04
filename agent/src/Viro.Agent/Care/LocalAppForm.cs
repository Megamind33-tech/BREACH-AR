using System.Diagnostics;
using System.Text.Json;
using System.Drawing;
using System.Security.Principal;
using System.Windows.Forms;
using Viro.Agent.Repair;

namespace Viro.Agent.Care;

/// <summary>
/// Viro on the PC itself: a window for the person using the computer, so nothing ever needs a terminal. It shows what Viro can do (free space, start-up
/// programs, memory) and lets them undo anything it did. Plain language, no jargon, no hidden actions: every change is listed and reversible here.
/// </summary>
public sealed class LocalAppForm : Form
{
    static readonly Color Bg = Color.FromArgb(32, 33, 36), Panel2 = Color.FromArgb(44, 45, 50), Accent = Color.FromArgb(8, 64, 44), AccentLight = Color.FromArgb(34, 139, 94), Text1 = Color.White, Text2 = Color.FromArgb(200, 200, 205);
    readonly LocalActions act; readonly Panel content = new() { Dock = DockStyle.Fill, BackColor = Bg, Padding = new Padding(24, 16, 24, 16) };
    readonly Label status = new() { Dock = DockStyle.Bottom, Height = 34, ForeColor = Text2, Padding = new Padding(24, 8, 0, 0), BackColor = Color.FromArgb(26, 27, 30) };
    readonly Dictionary<string, Control> pages = [];
    CancellationTokenSource? busy;

    public LocalAppForm(LocalActions actions)
    {
        act = actions; Text = "Viro WorkCare"; Width = 980; Height = 680; MinimumSize = new Size(820, 560); BackColor = Bg; ForeColor = Text1; Font = new Font("Segoe UI", 10f); StartPosition = FormStartPosition.CenterScreen;
        var nav = new Panel { Dock = DockStyle.Left, Width = 200, BackColor = Color.FromArgb(26, 27, 30), Padding = new Padding(12, 20, 12, 12) };
        var title = new Label { Text = "Viro", Dock = DockStyle.Top, Height = 46, Font = new Font("Segoe UI Semibold", 18f), ForeColor = Text1 };
        buttons = [];
        foreach (var (id, label) in new[] { ("overview", "Overview"), ("security", "Security"), ("care", "Heat, battery and start-up"), ("updates", "Updates and drivers"), ("space", "Free space"), ("startup", "Start-up programs"), ("memory", "Memory"), ("workspace", "Workspace"), ("activity", "What Viro did"), ("history", "Undo changes") })
        {
            var b = new Button { Text = label, Dock = DockStyle.Top, Height = 42, FlatStyle = FlatStyle.Flat, ForeColor = Text1, BackColor = Color.FromArgb(26, 27, 30), TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(12, 0, 0, 0), Tag = id, Cursor = Cursors.Hand };
            b.FlatAppearance.BorderSize = 0; b.Click += (_, _) => { Show(id); foreach (var x in buttons) x.BackColor = x == b ? Accent : Color.FromArgb(26, 27, 30); }; buttons.Add(b);
        }
        for (var i = buttons.Count - 1; i >= 0; i--) nav.Controls.Add(buttons[i]);
        nav.Controls.Add(title);      // added last so it docks at the very top
        pages["overview"] = BuildOverview(); pages["workspace"] = BuildWorkspace(); pages["security"] = BuildSecurity(); pages["care"] = BuildCare(); pages["updates"] = BuildUpdates(); pages["activity"] = BuildActivity(); pages["space"] = BuildSpace(); pages["startup"] = BuildStartup(); pages["memory"] = BuildMemory(); pages["history"] = BuildHistory();
        Controls.Add(content); Controls.Add(banner); Controls.Add(status); Controls.Add(nav);
        var admin = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
        if (!admin)
        {
            var up = Btn("Run as administrator", false); up.Dock = DockStyle.Bottom; up.Height = 38; up.Margin = new Padding(0);
            up.Click += (_, _) => { try { Process.Start(new ProcessStartInfo(Environment.ProcessPath!, "app --relaunch") { UseShellExecute = true, Verb = "runas" }); Close(); } catch { /* declined at the Windows prompt */ } };
            nav.Controls.Add(up);
        }
    }

    readonly Panel banner = new() { Dock = DockStyle.Top, Height = 0, Visible = false, BackColor = Color.FromArgb(70, 52, 14), Padding = new Padding(24, 10, 24, 10) };
    string? fallbackReason;
    /// <summary>Set when this basic window is showing because the full interface could not start. Shows why and a button that fixes it.</summary>
    [System.ComponentModel.Browsable(false), System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    public string? FallbackReason
    {
        get => fallbackReason;
        init
        {
            fallbackReason = value; if (value is null) return;
            var get = Btn("Get the full interface"); get.Dock = DockStyle.Right;
            get.Click += async (_, _) =>
            {
                get.Enabled = false; Say("Installing the interface component (about a minute)...");
                var (ok, msg) = await WebViewRuntime.InstallAsync(CancellationToken.None);
                if (ok) { try { Process.Start(new ProcessStartInfo(Environment.ProcessPath!, "app") { UseShellExecute = true }); } catch { /* the person can open it from Start */ } Close(); }
                else { get.Enabled = true; Say(msg); MessageBox.Show(this, msg, "Viro", MessageBoxButtons.OK, MessageBoxIcon.Information); }
            };
            banner.Controls.Add(new Label { Text = "This is the basic window because " + value + ". The full Viro interface needs one small Microsoft component.", Dock = DockStyle.Fill, ForeColor = Color.White, AutoSize = false });
            banner.Controls.Add(get); banner.Height = 58; banner.Visible = true;
        }
    }

    List<Button> buttons = [];
    [System.ComponentModel.Browsable(false), System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    public string? StartPage { get; init; }
    protected override void OnShown(EventArgs e) { base.OnShown(e); (buttons.FirstOrDefault(b => (string?)b.Tag == StartPage) ?? buttons[0]).PerformClick(); }      // a button cannot be clicked before the window is on screen

    // ---- helpers ------------------------------------------------------------------------------------------------
    static Button Btn(string text, bool primary = true) { var b = new Button { Text = text, AutoSize = true, Height = 36, Padding = new Padding(14, 0, 14, 0), FlatStyle = FlatStyle.Flat, ForeColor = Text1, BackColor = primary ? Accent : Color.FromArgb(60, 62, 68), Cursor = Cursors.Hand, Margin = new Padding(0, 0, 10, 0) }; b.FlatAppearance.BorderSize = 0; return b; }
    static Label H(string text) => new() { Text = text, Dock = DockStyle.Top, Height = 40, Font = new Font("Segoe UI Semibold", 15f), ForeColor = Text1 };
    static Label P(string text) => new() { Text = text, Dock = DockStyle.Top, Height = 54, ForeColor = Text2, AutoSize = false };
    static ListView List(params (string name, int width)[] cols)
    {
        var l = new ListView { Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, BackColor = Panel2, ForeColor = Text1, BorderStyle = BorderStyle.None, HideSelection = false, CheckBoxes = true };
        foreach (var (n, w) in cols) l.Columns.Add(n, w); return l;
    }
    static FlowLayoutPanel Row(params Control[] c) { var f = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 52, Padding = new Padding(0, 10, 0, 0), BackColor = Bg }; f.Controls.AddRange(c); return f; }
    void Show(string id) { content.Controls.Clear(); content.Controls.Add(pages[id]); if (pages[id].Tag is Action load) load(); }
    void Say(string s) => status.Text = s;

    async Task Guard(string working, Func<CancellationToken, Task> body)
    {
        if (busy is not null) { Say("Please wait for the current task to finish."); return; }
        busy = new CancellationTokenSource(); Cursor = Cursors.WaitCursor; Say(working);
        try { await body(busy.Token); }
        catch (OperationCanceledException) { Say("Cancelled."); }
        catch (Exception e) { Say("That did not work: " + e.Message); MessageBox.Show(this, e.Message, "Viro", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        finally { busy.Dispose(); busy = null; Cursor = Cursors.Default; }
    }

    // ---- the whole picture (read from the service) ------------------------------------------------------------
    JsonElement? view;
    async Task<JsonElement?> Self(CancellationToken ct, bool force = false) { if (view is null || force) view = await act.SelfAsync(ct); return view; }
    static string Str(JsonElement e, string name, string fallback = "") => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null ? (v.ValueKind == JsonValueKind.String ? v.GetString() ?? fallback : v.ToString()) : fallback;
    static JsonElement? Get(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null ? v : null;
    const string NoService = "Viro cannot reach its background service right now, so health details are not available. Free space, start-up programs, memory and undo still work on this PC. If this keeps happening, ask your IT administrator.";

    Control BuildOverview()
    {
        var p = new Panel { Dock = DockStyle.Fill }; var big = new Label { Dock = DockStyle.Top, Height = 70, Font = new Font("Segoe UI Semibold", 22f), ForeColor = Text1 };
        var sub = new Label { Dock = DockStyle.Top, Height = 44, ForeColor = Text2, AutoSize = false };
        var list = List(("How much it matters", 150), ("What Viro found", 420), ("What happens", 220)); list.CheckBoxes = false;
        var detail = new Label { Dock = DockStyle.Bottom, Height = 90, ForeColor = Text2, AutoSize = false }; var fix = Btn("Fix this now"); var refresh = Btn("Refresh", false); fix.Enabled = false;
        async Task Load(bool force) => await Guard("Reading this PC's health...", async ct =>
        {
            var v = await Self(ct, force); list.Items.Clear(); fix.Enabled = false; detail.Text = "";
            if (v is not { } w || !(Get(w, "health") is { } h)) { big.Text = "Health not available"; sub.Text = NoService; Say("Ready."); return; }
            var overall = h.TryGetProperty("overall", out var o) ? o.GetInt32() : 0; var status = Str(h, "status");
            big.Text = $"Health {overall} / 100  ·  " + (status == "healthy" ? "Good" : status == "attention" ? "Needs attention" : "Needs action"); big.ForeColor = status == "healthy" ? Color.FromArgb(120, 220, 160) : status == "attention" ? Color.FromArgb(240, 180, 60) : Color.FromArgb(240, 100, 90);
            sub.Text = $"{Str(w, "hostname")}  ·  " + Str(w, "autopilotLevel") switch { "OBSERVE" => "Viro only watches and reports", "SAFE" => "Viro fixes only the safest things automatically", "BALANCED" => "Viro fixes safe things automatically and checks each result", "AGGRESSIVE" => "Viro fixes most problems automatically and checks each result", var x => x };
            foreach (var f in h.GetProperty("findings").EnumerateArray())
            {
                var recipe = Get(f, "fix") is { } fx ? Str(fx, "recipe") : null; var local = LocalActions.CanFixHere(recipe);
                var it = new ListViewItem(Str(f, "impact") switch { "high" => "High", "medium" => "Medium", _ => "Low" }) { Tag = (f.Clone(), recipe, local) };
                it.SubItems.Add(Str(f, "reason")); it.SubItems.Add(local ? "You can fix it here" : Str(f, "remedy") switch { "safe-fix" => "Viro fixes it automatically", "hardware" => "Needs a hardware repair", "manual" => "Needs your action", _ => "Ask your IT administrator" });
                list.Items.Add(it);
            }
            if (list.Items.Count == 0) detail.Text = "Nothing needs attention. Viro keeps checking in the background.";
            Say("Ready.");
        });
        list.SelectedIndexChanged += (_, _) =>
        {
            if (list.SelectedItems.Count == 0) { fix.Enabled = false; return; }
            var (f, recipe, local) = ((JsonElement, string?, bool))list.SelectedItems[0].Tag!;
            detail.Text = Str(f, "reason") + "\n" + (Str(f, "recommendation") is { Length: > 0 } rec ? "What to do: " + rec : ""); fix.Enabled = local; fix.Tag = recipe;
        };
        fix.Click += async (_, _) =>
        {
            if (fix.Tag is not string recipe) return;
            if (recipe == "cleanup.safe") { Show("space"); return; }
            await Guard("Fixing...", async ct => { var r = await act.RunRecipeAsync(recipe, ct); detail.Text = r.Summary; view = null; Say("Done."); });
        };
        refresh.Click += async (_, _) => await Load(true);
        p.Controls.Add(list); p.Controls.Add(detail); p.Controls.Add(Row(fix, refresh)); p.Controls.Add(sub); p.Controls.Add(big); p.Controls.Add(H("Overview"));
        p.Tag = (Action)(async () => await Load(false)); return p;
    }

    Control BuildSecurity()
    {
        var p = new Panel { Dock = DockStyle.Fill }; var head = new Label { Dock = DockStyle.Top, Height = 80, ForeColor = Text2, AutoSize = false, Font = new Font("Segoe UI", 10.5f) };
        var list = List(("Protection", 430), ("State", 200), ("Why it matters", 250)); list.CheckBoxes = false;
        var on = Btn("Turn on selected"); var msg = new Label { Dock = DockStyle.Bottom, Height = 60, ForeColor = Text2, AutoSize = false };
        async Task Load() => await Guard("Reading security...", async ct =>
        {
            var v = await Self(ct); list.Items.Clear();
            if (v is not { } w) { head.Text = NoService; Say("Ready."); return; }
            var sh = Get(w, "shield"); head.Text = sh is { } s ? $"Viro Shield: {Str(s, "state") switch { "protected" => "protected", "attention" => "needs attention", "at-risk" => "at risk", _ => "not measured" }}. Engine: {Str(s, "engine", "none detected")}. " + string.Join(" ", s.TryGetProperty("reasons", out var rs) ? rs.EnumerateArray().Select(x => x.GetString()).Where(x => x is not null).Take(3) : []) : "";
            if (Get(w, "securityIncidents") is { ValueKind: JsonValueKind.Array } inc && inc.GetArrayLength() > 0) head.Text += "  Threat records: " + string.Join("; ", inc.EnumerateArray().Take(3).Select(i => $"{Str(i, "threat_name")} ({Str(i, "status").ToLowerInvariant().Replace('_', ' ')})"));
            if (Get(w, "protection") is { } pr) foreach (var c in pr.GetProperty("controls").EnumerateArray())
            {
                var st = Str(c, "state"); var it = new ListViewItem(Str(c, "title")) { Tag = c.Clone() };
                it.SubItems.Add(st switch { "on" => "On", "off" => "Off", "na" => "Managed by another product", _ => "Not measured" }); it.SubItems.Add(Str(c, "why"));
                if (st == "off") it.ForeColor = Color.FromArgb(240, 180, 60); list.Items.Add(it);
            }
            msg.Text = "These are Windows and Microsoft Defender protections. Turning some on needs administrator rights (use \"Run as administrator\"); your administrator can also do it for you."; Say("Ready.");
        });
        on.Click += async (_, _) =>
        {
            if (list.SelectedItems.Count == 0) { Say("Select a protection that is off."); return; }
            var c = (JsonElement)list.SelectedItems[0].Tag!; if (Str(c, "state") != "off" || Str(c, "recipe") is not { Length: > 0 } recipe) { Say("That one is not off, or Viro cannot change it for you."); return; }
            if (MessageBox.Show(this, Str(c, "title") + "\n\n" + Str(c, "why") + "\n\nViro will change it, check that it worked, and let you undo it under \"Undo changes\". Continue?", "Viro", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            await Guard("Turning it on...", async ct => { var r = await act.RunRecipeAsync(recipe, ct); msg.Text = r.Verified == true ? "Done and checked." : r.Summary.Contains("denied", StringComparison.OrdinalIgnoreCase) || r.Summary.Contains("administrator", StringComparison.OrdinalIgnoreCase) ? "Windows needs administrator rights for this. Use \"Run as administrator\" at the bottom left." : r.Summary; view = null; Say("Done."); await Load(); });
        };
        p.Controls.Add(list); p.Controls.Add(msg); p.Controls.Add(Row(on)); p.Controls.Add(head); p.Controls.Add(H("Security"));
        p.Tag = (Action)(async () => await Load()); return p;
    }

    Control BuildCare()
    {
        var p = new Panel { Dock = DockStyle.Fill }; var box = new RichTextBox { Dock = DockStyle.Fill, BackColor = Panel2, ForeColor = Text1, BorderStyle = BorderStyle.None, ReadOnly = true, Font = new Font("Segoe UI", 10.5f) };
        async Task Load() => await Guard("Reading heat, battery and start-up...", async ct =>
        {
            var v = await Self(ct); box.Clear();
            if (v is not { } w || Get(w, "care") is not { } c) { box.Text = NoService; Say("Ready."); return; }
            var sb = new System.Text.StringBuilder();
            if (Get(c, "thermal") is { } t && Str(t, "available") != "False") sb.AppendLine($"HEAT\n  Now: {Str(t, "level", "normal")}" + (Str(t, "cpuTempC") is { Length: > 0 } temp ? $", CPU {double.Parse(temp):0}°C" : "") + $"\n  Heat events in the last 30 days: {Str(c, "heatEvents30d", "0")}" + (Str(t, "coolingSuspected") == "True" ? "\n  Viro suspects a cooling problem (it stays hot while idle). A technician should clean the vents and check the fan." : "") + "\n");
            else sb.AppendLine("HEAT\n  This PC does not report a temperature, so Viro cannot say how hot it gets.\n");
            if (Get(c, "battery") is { } b) sb.AppendLine($"BATTERY\n  Charge {Str(b, "percent")}%  ·  health {Str(b, "healthPercent", "unknown")}%" + (Get(b, "runtime") is { } rt ? $"\n  Measured runtime about {int.Parse(Str(rt, "typicalMinutes")) / 60} h {int.Parse(Str(rt, "typicalMinutes")) % 60} m from a full charge" : "\n  Runtime is measured once enough battery use has been recorded") + "\n"); else sb.AppendLine("BATTERY\n  No battery readings (a desktop PC, or none recorded yet).\n");
            if (Get(c, "boot") is { } bt) { sb.AppendLine($"START-UP TIME\n  Last start-up: {(Str(bt, "last") is { Length: > 0 } l ? $"{double.Parse(l):0} seconds" : "unknown")}"); if (Get(bt, "comparison") is { } cmp && Str(cmp, "afterSeconds") is { Length: > 0 } after) sb.AppendLine($"  After Viro's change: {double.Parse(after):0} seconds (was {double.Parse(Str(cmp, "beforeSeconds")):0}; {Str(cmp, "improvementPercent")}% faster)"); if (Get(bt, "slowest") is { ValueKind: JsonValueKind.Array } sl && sl.GetArrayLength() > 0) sb.AppendLine("  Slowest to start (measured by Windows): " + string.Join(", ", sl.EnumerateArray().Take(5).Select(x => $"{Str(x, "name")} +{double.Parse(Str(x, "seconds")):0}s")) + "\n  Turn programs off under \"Start-up programs\".\n"); }
            if (Get(c, "memory") is { } m) sb.AppendLine($"MEMORY\n  {Str(m, "usedPercent")}% in use (target {Str(m, "targetPercent", "50")}%)" + (Str(m, "idleTrimmableMb") is { Length: > 0 } idle && idle != "0" ? $"\n  Idle programs hold about {double.Parse(idle) / 1024:0.0} GB that can be given back (see \"Memory\")" : ""));
            box.Text = sb.ToString(); Say("Ready.");
        });
        p.Controls.Add(box); p.Controls.Add(H("Heat, battery and start-up")); p.Tag = (Action)(async () => await Load()); return p;
    }

    Control BuildUpdates()
    {
        var p = new Panel { Dock = DockStyle.Fill }; var box = new RichTextBox { Dock = DockStyle.Fill, BackColor = Panel2, ForeColor = Text1, BorderStyle = BorderStyle.None, ReadOnly = true, Font = new Font("Segoe UI", 10.5f) };
        async Task Load() => await Guard("Reading updates...", async ct =>
        {
            var v = await Self(ct); if (v is not { } w || Get(w, "updates") is not { } u) { box.Text = NoService; Say("Ready."); return; }
            string N(string k) => Str(u, k, "not measured");
            box.Text = $"WINDOWS UPDATES\n  Waiting to install: {N("pending")}  ·  security or critical: {N("critical")}\n  Restart needed to finish updates: {(Str(u, "rebootRequired") == "True" ? "yes" : Str(u, "rebootRequired") == "False" ? "no" : "unknown")}\n\nDRIVERS\n  Devices reporting a driver problem: {N("driverErrors")}\n\nViro installs security updates for your organization during its maintenance window and checks the result. Driver updates are rolled out to one computer first and rolled back automatically if they cause trouble.";
            Say("Ready.");
        });
        p.Controls.Add(box); p.Controls.Add(H("Updates and drivers")); p.Tag = (Action)(async () => await Load()); return p;
    }

    // ---- workspace: which organization looks after this PC -------------------------------------------------------
    Control BuildWorkspace()
    {
        var p = new Panel { Dock = DockStyle.Fill }; var who = new Label { Dock = DockStyle.Top, Height = 70, Font = new Font("Segoe UI Semibold", 16f), ForeColor = Text1 };
        var code = new TextBox { Dock = DockStyle.Top, Height = 80, Multiline = true, BackColor = Panel2, ForeColor = Text1, BorderStyle = BorderStyle.FixedSingle, Font = new Font("Consolas", 10f) };
        var hint = P("Your administrator gives you a connection code that starts with VIRO1-. Paste it here and press Connect. You will see the workspace name before anything changes."); var go = Btn("Connect");
        string? current = null;
        p.Tag = new Action(() => _ = Guard("Checking this PC's workspace...", async ct =>
        {
            var v = await Self(ct, true); current = v is { } w && Get(w, "workspace") is { } ws ? Str(ws, "organization") : null;
            who.Text = v is null ? "Not connected to a workspace" : "Connected to " + (current is { Length: > 0 } ? current : "a workspace"); Say("Ready.");
        }));
        go.Click += async (_, _) => await Guard("Checking the code...", async ct =>
        {
            var w = new WorkspaceActions(); EnrollCheck c;
            try { c = await w.CheckAsync(code.Text, ct); } catch (ArgumentException e) { MessageBox.Show(this, e.Message, "Viro", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            var where = c.OrganizationName + (c.SiteName is { } s ? " / " + s : "") + (c.DepartmentName is { } d ? " / " + d : "");
            var move = current is { Length: > 0 } && current != c.OrganizationName;
            var ask = move ? $"This PC currently belongs to {current}. It will leave it and join {where}. Continue?" : $"This PC will join {where}. Its administrators will see its health and can send it approved fixes. Continue?";
            if (MessageBox.Show(this, ask, move ? "Move this PC?" : "Connect this PC?", MessageBoxButtons.YesNo, move ? MessageBoxIcon.Warning : MessageBoxIcon.Question) != DialogResult.Yes) return;
            Say("Windows will ask for permission. Choose Yes.");
            var r = await w.ConnectAsync(code.Text, move, ct);
            MessageBox.Show(this, r.Message, "Viro", MessageBoxButtons.OK, r.Ok ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            if (r.Ok) { view = null; who.Text = "Connected to " + c.OrganizationName; current = c.OrganizationName; code.Clear(); }
        });
        p.Controls.Add(Row(go)); p.Controls.Add(hint); p.Controls.Add(code); p.Controls.Add(new Label { Dock = DockStyle.Top, Height = 8 }); p.Controls.Add(who); p.Controls.Add(H("Workspace"));
        return p;
    }

    Control BuildActivity()
    {
        var p = new Panel { Dock = DockStyle.Fill }; var list = List(("When", 130), ("What Viro did", 430), ("Detail", 330)); list.CheckBoxes = false;
        async Task Load() => await Guard("Reading activity...", async ct =>
        {
            var v = await Self(ct); list.Items.Clear();
            if (v is not { } w || Get(w, "recent") is not { ValueKind: JsonValueKind.Array } rec) { Say(NoService); return; }
            foreach (var i in rec.EnumerateArray()) { DateTime.TryParse(Str(i, "at"), out var at); var it = new ListViewItem(at.ToLocalTime().ToString("d MMM HH:mm")); it.SubItems.Add(Str(i, "title")); it.SubItems.Add(Str(i, "detail")); list.Items.Add(it); }
            if (list.Items.Count == 0) { var it = new ListViewItem(""); it.SubItems.Add("Nothing yet. Viro lists every verified repair, cleanup and warning here."); list.Items.Add(it); }
            Say("Ready.");
        });
        p.Controls.Add(list); p.Controls.Add(P("Everything Viro did on this PC in the last 30 days. Only verified results are listed.")); p.Controls.Add(H("What Viro did")); p.Tag = (Action)(async () => await Load()); return p;
    }

    // ---- free space ---------------------------------------------------------------------------------------------
    Control BuildSpace()
    {
        var p = new Panel { Dock = DockStyle.Fill }; var list = List(("What", 300), ("Found", 90), ("Too new to delete safely", 170), ("Note", 280));
        var scan = Btn("Scan again", false); var clean = Btn("Free the selected space");
        var msg = new Label { Dock = DockStyle.Bottom, Height = 70, ForeColor = Text2, AutoSize = false };
        scan.Click += async (_, _) => await Load();
        async Task Load() => await Guard("Looking for files that can be removed...", async ct =>
        {
            var r = await act.PreviewCleanupAsync(ct); list.Items.Clear();
            foreach (var c in r.OrderBy(x => x.Class).ThenByDescending(x => x.BytesFound))
            {
                var it = new ListViewItem(c.Title) { Tag = c, Checked = c.Class == "SAFE" && c.BytesFound > 0 }; it.SubItems.Add(LocalActions.Gb(c.BytesFound)); it.SubItems.Add(c.Id == "recent-temp" || c.RecentBytes == 0 ? "" : LocalActions.Gb(c.RecentBytes));
                it.SubItems.Add(c.Class == "REVIEW" ? "Needs your OK: " + Short(c.Id) : (c.Note ?? "")); list.Items.Add(it);
            }
            var total = r.Where(x => x.Class == "SAFE").Sum(x => x.BytesFound); var tooNew = r.Where(x => x.Id != "recent-temp").Sum(x => x.RecentBytes);
            msg.Text = $"{LocalActions.Gb(total)} can be removed safely now." + (tooNew > 50 * 1048576L ? $" Another {LocalActions.Gb(tooNew)} of temporary files is too new to delete automatically; tick \"Recent temporary files\" to include it." : "");
            Say("Ready.");
        });
        clean.Click += async (_, _) =>
        {
            var chosen = list.CheckedItems.Cast<ListViewItem>().Select(i => (CategoryResult)i.Tag!).ToList(); if (chosen.Count == 0) { Say("Tick what you want to remove first."); return; }
            var review = chosen.Where(c => c.Class == "REVIEW").ToList();
            if (review.Count > 0 && MessageBox.Show(this, "These are not removed automatically because you may still want them:\n\n" + string.Join("\n", review.Select(c => $"• {c.Title} ({LocalActions.Gb(c.BytesFound)})")) + "\n\nTemporary files that a program is using, or that changed in the last hour, are never touched. Nothing in Documents, Desktop, Downloads, Pictures, Videos or OneDrive is ever touched.\n\nContinue?", "Viro", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            await Guard("Removing files...", async ct => { var r = await act.CleanAsync(chosen.Select(c => c.Id), ct); msg.Text = LocalActions.Describe(r, review.Count > 0); Say("Done."); await Load(); });
        };
        p.Controls.Add(list); p.Controls.Add(msg); p.Controls.Add(Row(clean, scan)); p.Controls.Add(P("Temporary files, caches and old logs that Windows and your programs recreate when needed. Your own files are never listed here.")); p.Controls.Add(H("Free space"));
        p.Tag = (Action)(async () => { if (list.Items.Count == 0) await Load(); });
        return p;
    }
    static string Short(string id) => id == "recent-temp" ? "files from the last two days" : id == "recycle-bin" ? "emptied permanently" : "";

    // ---- start-up -----------------------------------------------------------------------------------------------
    Control BuildStartup()
    {
        var p = new Panel { Dock = DockStyle.Fill }; var list = List(("Program", 320), ("Viro's advice", 200), ("Starts with Windows", 150));
        var safe = Btn("Tick the safe ones", false); var off = Btn("Stop selected from starting"); var on = Btn("Let selected start again", false); var msg = new Label { Dock = DockStyle.Bottom, Height = 56, ForeColor = Text2, AutoSize = false };
        void Load()
        {
            list.Items.Clear();
            foreach (var a in act.StartupPrograms())
            {
                var it = new ListViewItem(a.Item.Name) { Tag = a }; it.SubItems.Add(a.Class switch { StartupClass.SAFE_TO_DISABLE => "Safe to stop", StartupClass.KEEP => "Keep (security, hardware, sync)", _ => "Your decision" }); it.SubItems.Add(a.Item.Enabled ? "Yes" : "No"); list.Items.Add(it);
            }
            msg.Text = $"{list.Items.Cast<ListViewItem>().Count(i => i.SubItems[2].Text == "Yes")} of {list.Items.Count} programs start with Windows. Nothing is uninstalled, and every change can be undone here.";
        }
        safe.Click += (_, _) => { foreach (ListViewItem i in list.Items) i.Checked = ((StartupAssessment)i.Tag!).Class == StartupClass.SAFE_TO_DISABLE && ((StartupAssessment)i.Tag!).Item.Enabled; };
        async Task Apply(bool enable)
        {
            var items = list.CheckedItems.Cast<ListViewItem>().Select(i => ((StartupAssessment)i.Tag!).Item).Where(i => i.Enabled != enable).ToList();
            if (items.Count == 0) { Say(enable ? "Tick programs that are turned off." : "Tick programs that start with Windows."); return; }
            await Guard(enable ? "Turning programs back on..." : "Stopping programs from starting...", async ct =>
            {
                var r = await act.SetStartupAsync(items, enable, ct);
                msg.Text = r.Verified == true ? $"{(enable ? "They will start with Windows again" : "Done. They will no longer start with Windows")}. Undo any time under \"What Viro changed\"." : r.Summary.Contains("administrator", StringComparison.OrdinalIgnoreCase) || r.Summary.Contains("denied", StringComparison.OrdinalIgnoreCase) ? "Windows needs administrator rights to change that program. Use \"Run as administrator\" at the bottom left." : r.Summary;
                Load(); Say("Done.");
            });
        }
        off.Click += async (_, _) => await Apply(false); on.Click += async (_, _) => await Apply(true);
        p.Controls.Add(list); p.Controls.Add(msg); p.Controls.Add(Row(off, on, safe)); p.Controls.Add(P("Programs that start when you sign in make the PC slower to start. Stop the ones you do not need; they still open normally when you start them yourself.")); p.Controls.Add(H("Start-up programs"));
        p.Tag = (Action)Load; return p;
    }

    // ---- memory -------------------------------------------------------------------------------------------------
    Control BuildMemory()
    {
        var p = new Panel { Dock = DockStyle.Fill }; var big = new Label { Dock = DockStyle.Top, Height = 64, Font = new Font("Segoe UI Semibold", 20f), ForeColor = Text1 };
        var list = List(("Program holding the most memory", 340), ("Promised to it", 130), ("In use now", 130), ("Viro's view", 200)); list.CheckBoxes = false;
        var trim = Btn("Give back memory from idle programs"); var refresh = Btn("Refresh", false); var msg = new Label { Dock = DockStyle.Bottom, Height = 70, ForeColor = Text2, AutoSize = false };
        async Task Load() => await Guard("Reading memory...", async ct =>
        {
            var m = await Task.Run(() => act.MemoryNow(), ct); big.Text = $"{m.UsedPercent:0}% of {m.TotalGb:0.#} GB in use" + (m.CommitPercent is { } c ? $"   ·   {c:0}% promised to programs" : "");
            list.Items.Clear(); foreach (var t in m.TopConsumers) { var it = new ListViewItem(t.Name); it.SubItems.Add($"{t.PrivateMb / 1024:0.0} GB"); it.SubItems.Add($"{t.WorkingSetMb / 1024:0.0} GB"); it.SubItems.Add(t.Category == "SYSTEM_CRITICAL" ? "Windows or security: never touched" : t.Category == "NEVER_AUTOCLOSE" ? "May hold your work: Viro never closes it" : "Close it yourself if you are not using it"); list.Items.Add(it); }
            Say("Ready.");
        });
        trim.Click += async (_, _) => await Guard("Giving memory back...", async ct =>
        {
            var r = await act.TrimMemoryAsync(ct);
            msg.Text = r.ReclaimedMb > 0 ? $"Memory use went from {r.BeforePercent:0.#}% to {r.AfterPercent:0.#}% ({r.ReclaimedMb:0} MB given back). Nothing was closed." + (r.TargetReached ? "" : " The rest is used by programs you are working in.") : r.Failures is { Count: > 0 } ? "Windows did not allow it for some programs (they may need administrator rights)." : "Nothing idle was holding enough memory to give back right now.";
            await Load();
        });
        refresh.Click += async (_, _) => await Load();
        p.Controls.Add(list); p.Controls.Add(msg); p.Controls.Add(Row(trim, refresh)); p.Controls.Add(big); p.Controls.Add(P("Idle programs can hold on to memory and slow everything else down. Viro lets Windows take that memory back without closing anything.")); p.Controls.Add(H("Memory"));
        p.Tag = (Action)(async () => await Load()); return p;
    }

    // ---- history / undo -----------------------------------------------------------------------------------------
    Control BuildHistory()
    {
        var p = new Panel { Dock = DockStyle.Fill }; var list = List(("When", 190), ("What changed", 380), ("Detail", 200)); list.CheckBoxes = false;
        var undo = Btn("Undo the selected change"); var msg = new Label { Dock = DockStyle.Bottom, Height = 50, ForeColor = Text2, AutoSize = false };
        void Load() { list.Items.Clear(); foreach (var h in act.History()) { var it = new ListViewItem(h.CreatedAt.ToString("g")) { Tag = h }; it.SubItems.Add(h.Title); it.SubItems.Add(h.Summary); list.Items.Add(it); } msg.Text = list.Items.Count == 0 ? "Viro has not changed anything on this PC yet." : "Select a change and choose Undo to put things back exactly as they were."; }
        undo.Click += async (_, _) =>
        {
            if (list.SelectedItems.Count == 0) { Say("Select a change first."); return; }
            var h = (UndoEntry)list.SelectedItems[0].Tag!;
            await Guard("Undoing...", async ct => { var r = await act.UndoAsync(h.Id, ct); msg.Text = r.RolledBack ? $"Undone: {h.Title}." : r.Summary; Load(); Say("Done."); });
        };
        p.Controls.Add(list); p.Controls.Add(msg); p.Controls.Add(Row(undo)); p.Controls.Add(P("Everything Viro changes on this PC is recorded here, and can be reversed.")); p.Controls.Add(H("What Viro changed"));
        p.Tag = (Action)Load; return p;
    }
}
