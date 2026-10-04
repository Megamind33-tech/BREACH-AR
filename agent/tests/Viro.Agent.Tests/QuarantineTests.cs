using System.Text.Json;
using Viro.Agent.Care;
using Xunit;

public class QuarantineTests
{
    static string Dir() { var d = Path.Combine(Path.GetTempPath(), "viro-q-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(d); return d; }
    static string JunkScript() => string.Join("\r\n", Enumerable.Range(0, 120).Select(i => "::: " + new string((char)('A' + i % 26), 150))) + "\r\n@echo off\r\npowershell -w hidden -enc SQBFAFgA\r\nstart \"\" \"%APPDATA%\\x\\run.exe\"\r\n";
    static void Wipe(string d) { foreach (var f in Directory.EnumerateFiles(d, "*", SearchOption.AllDirectories)) File.SetAttributes(f, FileAttributes.Normal); Directory.Delete(d, true); }
    static JsonElement J(object o) => JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(o));

    [Fact]
    public void A_script_padded_with_junk_shows_its_real_commands_and_is_flagged_for_the_padding()
    {
        var startup = Dir();
        try
        {
            File.WriteAllText(Path.Combine(startup, "nXafbDuNUEnONGHFquxrEnfktaHBjC.bat"), JunkScript());
            var f = J(StartupInspector.Inspect(null, [("u", startup)])).GetProperty("files")[0];
            var codes = f.GetProperty("indicators").EnumerateArray().Select(i => i.GetProperty("Code").GetString()).ToList();
            Assert.Contains("junk-padding", codes); Assert.Contains("encoded-powershell", codes); Assert.Contains("hidden-window", codes); Assert.Contains("random-name", codes);
            Assert.Equal(120, f.GetProperty("junkCommentLines").GetInt32()); Assert.Equal(3, f.GetProperty("commandLines").GetInt32());
            Assert.Contains("-enc", f.GetProperty("commands")[1].GetString());
        }
        finally { Directory.Delete(startup, true); }
    }

    [Fact]
    public void Quarantine_moves_the_file_without_deleting_it_verifies_the_hash_and_can_be_undone()
    {
        var startup = Dir(); var root = Dir();
        try
        {
            var file = Path.Combine(startup, "bad.bat"); File.WriteAllText(file, JunkScript()); var bytes = File.ReadAllBytes(file);
            var q = J(StartupQuarantine.Quarantine("bad.bat", "job-1", [("u", startup)], root));
            Assert.Equal(1, q.GetProperty("moved").GetArrayLength()); Assert.Equal(0, q.GetProperty("failed").GetArrayLength());
            var m = q.GetProperty("moved")[0]; Assert.True(m.GetProperty("verified").GetBoolean()); Assert.False(File.Exists(file), "it can no longer run from Startup");
            var kept = m.GetProperty("quarantinedTo").GetString()!; Assert.True(File.Exists(kept)); Assert.EndsWith(".quarantined", kept); Assert.Equal(bytes, File.ReadAllBytes(kept));      // evidence preserved
            Assert.Single(J(StartupQuarantine.List(root)).GetProperty("items").EnumerateArray());
            var r = J(StartupQuarantine.Restore(m.GetProperty("id").GetString()!, [("u", startup)], root)); Assert.True(r.GetProperty("restored").GetBoolean()); Assert.Equal(bytes, File.ReadAllBytes(file));
        }
        finally { Directory.Delete(startup, true); Wipe(root); }
    }

    [Fact]
    public void It_only_acts_on_a_file_name_inside_the_startup_folders_never_a_path_and_reports_when_nothing_is_there()
    {
        var startup = Dir(); var root = Dir(); var other = Dir();
        try
        {
            File.WriteAllText(Path.Combine(other, "precious.txt"), "keep");
            foreach (var bad in new[] { Path.Combine(other, "precious.txt"), "..\\" + Path.GetFileName(other) + "\\precious.txt", "C:evil.bat", "" }) Assert.Throws<ArgumentException>(() => StartupQuarantine.Quarantine(bad, null, [("u", startup)], root));
            Assert.True(File.Exists(Path.Combine(other, "precious.txt")));
            Assert.Equal(0, J(StartupQuarantine.Quarantine("not-there.bat", null, [("u", startup)], root)).GetProperty("moved").GetArrayLength());
        }
        finally { Directory.Delete(startup, true); Wipe(root); Directory.Delete(other, true); }
    }

    [Fact]
    public void Restore_refuses_to_overwrite_and_refuses_to_put_a_file_anywhere_but_a_startup_folder()
    {
        var startup = Dir(); var root = Dir(); var elsewhere = Dir();
        try
        {
            File.WriteAllText(Path.Combine(startup, "a.bat"), "echo a"); var id = J(StartupQuarantine.Quarantine("a.bat", null, [("u", startup)], root)).GetProperty("moved")[0].GetProperty("id").GetString()!;
            File.WriteAllText(Path.Combine(startup, "a.bat"), "something new");
            Assert.False(J(StartupQuarantine.Restore(id, [("u", startup)], root)).GetProperty("restored").GetBoolean());                                  // a file is already there
            File.Delete(Path.Combine(startup, "a.bat"));
            Assert.False(J(StartupQuarantine.Restore(id, [("u", elsewhere)], root)).GetProperty("restored").GetBoolean());                                // not a Startup folder
            Assert.Throws<ArgumentException>(() => StartupQuarantine.Restore("..\\..\\x", [("u", startup)], root));
        }
        finally { Directory.Delete(startup, true); Wipe(root); Directory.Delete(elsewhere, true); }
    }

    [Fact]
    public void The_hunt_explains_each_start_up_command_and_flags_the_sign_in_hooks_malware_uses()
    {
        Assert.Contains("runs an encoded command", PersistenceHunt.Reasons("powershell.exe -NoP -enc SQBFAFgA"));
        Assert.Contains("runs a script stored in a user-writable folder", PersistenceHunt.Reasons("cmd /c C:\\Users\\a\\AppData\\Roaming\\x.bat"));
        Assert.Empty(PersistenceHunt.Reasons("\"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe\" /background"));
        Assert.Empty(PersistenceHunt.CheckWinlogon("explorer.exe", "C:\\Windows\\system32\\userinit.exe,", null));
        var bad = PersistenceHunt.CheckWinlogon("explorer.exe, evil.exe", "C:\\Windows\\system32\\userinit.exe,C:\\x\\a.exe", "t.exe"); Assert.Equal(3, bad.Count); Assert.All(bad, f => Assert.Equal("high", f.Severity));
    }

    [Fact]
    public void The_hunt_finds_a_padded_randomly_named_script_in_a_user_folder_and_a_normal_one_is_left_alone()
    {
        var startup = Dir(); var drop = Dir();
        try
        {
            File.WriteAllText(Path.Combine(drop, "qWErTyUiOpAsDfGhJkLzXc.bat"), JunkScript()); File.WriteAllText(Path.Combine(drop, "deploy.bat"), "@echo off\r\necho hi\r\n");
            var f = PersistenceHunt.Run([("u", startup)], [drop]).Where(x => x.Category == "dropped-script").ToList();
            Assert.Single(f); Assert.Equal("qWErTyUiOpAsDfGhJkLzXc.bat", f[0].Name); Assert.Equal("high", f[0].Severity); Assert.Contains("padded", f[0].Evidence);
        }
        finally { Directory.Delete(startup, true); Directory.Delete(drop, true); }
    }
}
