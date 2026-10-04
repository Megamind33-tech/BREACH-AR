using System.Drawing;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

namespace Viro.Agent.Care;

/// <summary>
/// The lock shown on a PC reported lost or stolen: one borderless window over every monitor, Viro branded, asking for the passphrase the owner chose.
/// The entry is checked here, on the PC, against a salted PBKDF2 hash (never the passphrase itself); nothing is sent anywhere to check it.
/// This is a visible deterrent within Windows, not a boot-time lock: Safe Mode, another drive, or an administrator who removes the agent can get past it,
/// the same way they could get past any other software. What it does is make the PC obviously unusable and clearly marked as reported, to put off
/// casual use and resale, and it reappears if the window is closed while the computer is still supposed to be locked.
/// </summary>
static class LostLockWindow
{
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    static LockForm? _open;

    /// <summary>Shows the lock and does not return until it is unlocked, either by the right passphrase entered here or by <see cref="CloseRemotely"/>.</summary>
    public static Task<bool> ShowAsync(string saltB64, string hashB64, int iterations)
    {
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var t = new Thread(() =>
        {
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            var salt = Convert.FromBase64String(saltB64); var want = Convert.FromBase64String(hashB64);
            bool Check(string entered) { var got = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(entered.Normalize(NormalizationForm.FormKC)), salt, iterations, HashAlgorithmName.SHA256, want.Length); return CryptographicOperations.FixedTimeEquals(got, want); }
            var form = new LockForm(Check);
            _open = form;
            form.FormClosed += (_, _) => tcs.TrySetResult(form.Unlocked);
            Application.Run(form);
            if (_open == form) _open = null;
        });
        t.SetApartmentState(ApartmentState.STA); t.IsBackground = true; t.Start();
        return tcs.Task;
    }

    /// <summary>Called when the server says this PC was recovered, so the window closes without needing the passphrase typed on this PC.</summary>
    public static void CloseRemotely() { try { _open?.BeginInvoke(() => _open?.CloseRemotely()); } catch { /* no window open right now */ } }

    sealed class LockForm : Form
    {
        readonly Func<string, bool> check;
        readonly TextBox entry; readonly Label message; readonly System.Windows.Forms.Timer keepOnTop;
        public bool Unlocked { get; private set; }

        public LockForm(Func<string, bool> check)
        {
            this.check = check;
            var area = SystemInformation.VirtualScreen;             // every monitor, not just the primary one
            FormBorderStyle = FormBorderStyle.None; WindowState = FormWindowState.Normal; StartPosition = FormStartPosition.Manual;
            Bounds = area; TopMost = true; ShowInTaskbar = false; BackColor = Color.FromArgb(8, 15, 13); ControlBox = false;
            KeyPreview = true;

            var card = new Panel { Width = 460, Height = 300, BackColor = Color.FromArgb(17, 23, 20), Anchor = AnchorStyles.None };
            card.Location = new Point(area.Width / 2 - card.Width / 2, area.Height / 2 - card.Height / 2);
            var title = new Label { Text = "This PC was reported lost or stolen", ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 15f), AutoSize = false, Left = 28, Top = 26, Width = 404, Height = 56 };
            var sub = new Label { Text = "Enter the passphrase the owner set to unlock it. If you found this PC, please return it to its owner.", ForeColor = Color.FromArgb(170, 182, 176), Font = new Font("Segoe UI", 9.5f), AutoSize = false, Left = 28, Top = 86, Width = 404, Height = 48 };
            entry = new TextBox { Left = 28, Top = 142, Width = 404, Height = 32, Font = new Font("Segoe UI", 12f), UseSystemPasswordChar = true, BorderStyle = BorderStyle.FixedSingle, BackColor = Color.FromArgb(25, 32, 28), ForeColor = Color.White };
            message = new Label { Text = "", ForeColor = Color.FromArgb(248, 129, 118), Font = new Font("Segoe UI", 9f), AutoSize = false, Left = 28, Top = 180, Width = 404, Height = 20 };
            var unlock = new Button { Text = "Unlock", Left = 28, Top = 210, Width = 404, Height = 38, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(31, 157, 107), ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 10f) };
            unlock.FlatAppearance.BorderSize = 0;
            unlock.Click += (_, _) => TryUnlock();
            entry.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; TryUnlock(); } };
            card.Controls.AddRange([title, sub, entry, message, unlock]);
            Controls.Add(card);

            // Re-take the foreground if something else steals it (Explorer, Task Manager); this is a deterrent, not a guarantee.
            keepOnTop = new System.Windows.Forms.Timer { Interval = 800 };
            keepOnTop.Tick += (_, _) => { try { if (!IsDisposed) { TopMost = false; TopMost = true; SetForegroundWindow(Handle); } } catch { } };
            Shown += (_, _) => { keepOnTop.Start(); entry.Focus(); };
        }

        void TryUnlock()
        {
            if (check(entry.Text))
            {
                Unlocked = true; keepOnTop.Stop(); Close();
            }
            else { message.Text = "That is not the passphrase. Try again."; entry.SelectAll(); entry.Focus(); }
        }

        /// <summary>The server confirmed this PC is no longer lost: close without the passphrase.</summary>
        public void CloseRemotely() { Unlocked = true; keepOnTop.Stop(); Close(); }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            // Alt+F4 does not close this window; everything else behaves normally (Ctrl+Alt+Del and the Windows key are the user's own, and are not and cannot be blocked here).
            if (keyData == (Keys.Alt | Keys.F4)) return true;
            return base.ProcessCmdKey(ref msg, keyData);
        }
        protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x00040000 /* WS_EX_APPWINDOW */; return p; } }
    }
}
