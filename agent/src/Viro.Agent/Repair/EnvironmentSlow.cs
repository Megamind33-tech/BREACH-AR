using Microsoft.Win32;

namespace Viro.Agent.Repair;

/// <summary>A Windows setting that, when raised, makes the PC wait longer before it switches off. Current is null when the value is not set (Windows uses its own default).</summary>
public sealed record ShutdownSetting(string Where, string Name, int? Current, int Default, string Why);

/// <summary>An automatic Windows service as registered, so slow ones can be started a little after sign-in instead of during it.</summary>
public sealed record AutoServiceEntry(string Name, string Display, string ImagePath, int Start, int DelayedAutostart, int Type);

public partial class RepairEnv
{
    const string ControlKey = @"SYSTEM\CurrentControlSet\Control";
    const string ServicesKey = @"SYSTEM\CurrentControlSet\Services";

    /// <summary>The shutdown timeouts that decide how long Windows waits for services and programs to close, machine-wide and for each real user.</summary>
    public virtual IReadOnlyList<ShutdownSetting> ReadShutdownSettings()
    {
        var list = new List<ShutdownSetting>();
        using (var k = Registry.LocalMachine.OpenSubKey(ControlKey))
            list.Add(new(@"HKLM\" + ControlKey, "WaitToKillServiceTimeout", Num(k?.GetValue("WaitToKillServiceTimeout")), 5000, "How long Windows waits for background services to stop"));
        foreach (var sid in Registry.Users.GetSubKeyNames().Where(n => System.Text.RegularExpressions.Regex.IsMatch(n, @"^S-1-5-21-[\d-]+$")))
        {
            using var d = Registry.Users.OpenSubKey(sid + @"\Control Panel\Desktop");
            list.Add(new($@"HKU\{sid}\Control Panel\Desktop", "WaitToKillAppTimeout", Num(d?.GetValue("WaitToKillAppTimeout")), 20000, "How long Windows waits for each open program to close"));
            list.Add(new($@"HKU\{sid}\Control Panel\Desktop", "HungAppTimeout", Num(d?.GetValue("HungAppTimeout")), 5000, "How long Windows waits for a frozen program"));
        }
        return list;
    }

    /// <summary>Whether Windows is set to wipe the paging file at every shutdown (a security setting that makes shutdown take minutes on a big file).</summary>
    public virtual bool ClearsPageFileAtShutdown() { using var k = Registry.LocalMachine.OpenSubKey(ControlKey + @"\Session Manager\Memory Management"); return Num(k?.GetValue("ClearPageFileAtShutdown")) == 1; }

    /// <summary>Writes one of the timeouts (as text, which is how Windows stores them). A null value removes the entry so Windows uses its default.</summary>
    public virtual void WriteShutdownSetting(string where, string name, int? value)
    {
        var (root, path) = SplitHive(where);
        using var k = root.OpenSubKey(path, true) ?? throw new InvalidOperationException($"cannot open {where} (administrator rights are required)");
        if (value is null) k.DeleteValue(name, false); else k.SetValue(name, value.Value.ToString(), RegistryValueKind.String);
    }

    public virtual IReadOnlyList<AutoServiceEntry> ServiceEntries()
    {
        var o = new List<AutoServiceEntry>();
        using var all = Registry.LocalMachine.OpenSubKey(ServicesKey); if (all is null) return o;
        foreach (var n in all.GetSubKeyNames())
        {
            using var k = all.OpenSubKey(n); if (k is null) continue;
            var start = Num(k.GetValue("Start")); var type = Num(k.GetValue("Type")) ?? 0;
            if (start != 2 || (type & 0x30) == 0) continue;      // automatic, and a real Windows service (not a driver)
            o.Add(new(n, k.GetValue("DisplayName") as string ?? n, k.GetValue("ImagePath") as string ?? "", 2, Num(k.GetValue("DelayedAutostart")) ?? 0, type));
        }
        return o;
    }

    /// <summary>Marks a service "Automatic (Delayed Start)" (1) or back to plain Automatic (0). Same switch as the Services console.</summary>
    public virtual void SetDelayedStart(string service, int value)
    {
        using var k = Registry.LocalMachine.OpenSubKey($@"{ServicesKey}\{service}", true) ?? throw new InvalidOperationException($"cannot open service {service} (administrator rights are required)");
        k.SetValue("DelayedAutostart", value, RegistryValueKind.DWord);
    }

    static int? Num(object? v) => v switch { int i => i, string s when int.TryParse(s, out var n) => n, _ => null };
    static (RegistryKey root, string path) SplitHive(string where)
    {
        var i = where.IndexOf('\\'); var hive = where[..i]; var path = where[(i + 1)..];
        return hive == "HKLM" ? (Registry.LocalMachine, path) : hive == "HKU" ? (Registry.Users, path) : throw new ArgumentException("unsupported location");
    }
}

public partial class RepairEnv
{
    const string PowerKey = @"SYSTEM\CurrentControlSet\Control\Session Manager\Power";
    /// <summary>Whether Fast Startup (hybrid shut-down) is on; null when this PC does not have the setting.</summary>
    public virtual bool? FastStartupEnabled() { using var k = Registry.LocalMachine.OpenSubKey(PowerKey); return k?.GetValue("HiberbootEnabled") is int v ? v == 1 : null; }
    public virtual void SetFastStartup(bool on)
    {
        using var k = Registry.LocalMachine.OpenSubKey(PowerKey, true) ?? throw new InvalidOperationException("cannot open the power settings (administrator rights are required)");
        k.SetValue("HiberbootEnabled", on ? 1 : 0, RegistryValueKind.DWord);
    }
}
