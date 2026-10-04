using System.Reflection;

namespace WorkCare.QuickCheck;

static class Program
{
    [STAThread]
    static void Main()
    {
        // One window at a time. The mutex disappears with the process: nothing is registered anywhere.
        using var mutex = new Mutex(true, @"Local\WorkCareQuickCheck", out var first);
        if (!first) return;
        // Everything this run writes (including the Windows battery report) goes into one folder that is deleted on exit.
        var dir = Path.Combine(Path.GetTempPath(), "WorkCareQuickCheck-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        Environment.SetEnvironmentVariable("TMP", dir); Environment.SetEnvironmentVariable("TEMP", dir);
        try
        {
            using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("rules.json")!; using var r = new StreamReader(s);
            ApplicationConfiguration.Initialize();
            Application.Run(new MainForm(new RulesEvaluator(r.ReadToEnd()), dir));
        }
        finally { try { Directory.Delete(dir, true); } catch { /* best effort: it is a temp folder */ } }
    }
}
