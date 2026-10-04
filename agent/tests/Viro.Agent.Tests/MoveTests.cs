using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Viro.Agent.Care.Move;
using Xunit;

/// <summary>An in-memory Viro: the same rules as the server (checksums, sealed snapshots) so the engine is tested end to end without a network.</summary>
sealed class FakeMoveApi(long quota = long.MaxValue) : IMoveApi
{
    public sealed class Snap { public string Id = Guid.NewGuid().ToString(); public JsonElement Kdf; public string KeyCheck = ""; public string? Manifest; public SortedDictionary<int, byte[]> Chunks = []; public bool Done; public string Label = ""; }
    public readonly Dictionary<string, Snap> Snaps = [];
    static JsonElement J(object o) => JsonSerializer.SerializeToElement(o);
    public Task<(int, JsonElement)> JsonAsync(HttpMethod m, string path, object? body, CancellationToken ct)
    {
        var b = body is null ? default : JsonSerializer.SerializeToElement(body, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        if (path == "/api/v1/move/snapshots" && m == HttpMethod.Get) return Task.FromResult((200, J(new { snapshots = Array.Empty<object>(), usedBytes = Snaps.Values.Sum(s => s.Chunks.Values.Sum(c => (long)c.Length)), quotaBytes = quota })));
        if (path == "/api/v1/move/snapshots" && m == HttpMethod.Post) { var s = new Snap { Kdf = b.GetProperty("kdf").Clone(), KeyCheck = b.GetProperty("keyCheck").GetString()!, Label = b.GetProperty("label").GetString()! }; Snaps[s.Id] = s; return Task.FromResult((201, J(new { id = s.Id }))); }
        var parts = path.Split('/'); var snap = Snaps[parts[5]];
        if (parts.Length == 7 && parts[6] == "finish") { snap.Manifest = b.GetProperty("manifest").GetString(); snap.Done = true; return Task.FromResult((200, J(new { ok = true }))); }
        if (parts.Length == 6) return Task.FromResult((200, J(new { id = snap.Id, label = snap.Label, machine = "OLD-PC", kdf = snap.Kdf, keyCheck = snap.KeyCheck, manifest = snap.Manifest, chunks = snap.Chunks.Count })));
        return Task.FromResult((404, J(new { error = "no" })));
    }
    public Task<int> PutChunkAsync(string path, byte[] data, string sha, CancellationToken ct)
    {
        if (!string.Equals(sha, Convert.ToHexString(SHA256.HashData(data)), StringComparison.OrdinalIgnoreCase)) return Task.FromResult(400);
        var p = path.Split('/'); Snaps[p[5]].Chunks[int.Parse(p[7])] = data; return Task.FromResult(200);
    }
    public Task<(int, byte[], string?)> GetChunkAsync(string path, CancellationToken ct)
    { var p = path.Split('/'); var d = Snaps[p[5]].Chunks[int.Parse(p[7])]; return Task.FromResult((200, d, Convert.ToHexString(SHA256.HashData(d)).ToLowerInvariant())); }
}

sealed class FakeMoveHost(string root, string name = "PC") : IMoveHost
{
    public string MachineName => name; public string OsName => "Windows 11";
    public IReadOnlyDictionary<string, string> Roots { get; } = new Dictionary<string, string> { ["Documents"] = Path.Combine(root, "Documents"), ["Pictures"] = Path.Combine(root, "Pictures") };
    public string RestoredSettingsFolder => Path.Combine(root, "Pictures", "Viro Move"); public string RestoredBookmarksFolder => Path.Combine(root, "Documents", "Viro Move");
    public List<MoveSetting> Settings = [new(@"Control Panel\Desktop", "WallpaperStyle", "String", "10"), new(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", "DWord", "0"), new(@"Software\Microsoft\Windows\CurrentVersion\Run", "Evil", "String", "calc.exe")];
    public List<MoveSetting> Written = []; public string? Wallpaper; public string? Applied; public List<MoveWifi> Wifi = [new("Home", "<WLANProfile><name>Home</name></WLANProfile>")]; public List<MoveWifi> WifiAdded = [];
    public List<MoveApp> Apps = [new("7-Zip", "24.0", "Igor Pavlov", "7zip.7zip"), new("Some Old Tool", "1.0", "Old Co", null)]; public List<string> Installed = [];
    public IReadOnlyList<MoveSetting> ReadSettings() => Settings; public void WriteSetting(MoveSetting s) { if (MoveSettingsCatalog.IsAllowed(s)) Written.Add(s); }
    public string? WallpaperPath() => Wallpaper; public void ApplyWallpaper(string path) => Applied = path;
    public Task<IReadOnlyList<MoveWifi>> ExportWifiAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<MoveWifi>>(Wifi); public Task ImportWifiAsync(MoveWifi w, CancellationToken ct) { WifiAdded.Add(w); return Task.CompletedTask; }
    public string? BookmarksHtml() => "<DL><DT><A HREF=\"https://example.com\">Example</A></DL>";
    public Task<IReadOnlyList<MoveApp>> InstalledAppsAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<MoveApp>>(Apps);
    public Task<(bool, string)> InstallAppAsync(string id, CancellationToken ct) { Installed.Add(id); return Task.FromResult((true, "installed")); }
}

public class MoveTests
{
    static string Make(string root, string rel, byte[] data) { var p = Path.Combine(root, rel.Replace('/', '\\')); Directory.CreateDirectory(Path.GetDirectoryName(p)!); File.WriteAllBytes(p, data); return p; }
    static byte[] Rand(int n) => RandomNumberGenerator.GetBytes(n);
    static readonly MoveBackupOptions All = new("Old laptop", ["Documents", "Pictures"], true, true, true, true);
    static async Task<MoveJob> Back(MoveEngine e, MoveBackupOptions o, string pass) { var j = new MoveJob(); await e.BackupAsync(o, pass, j, default); return j; }

    [Fact]
    public void EncryptionRoundTripsAndRefusesTamperingWrongKeysAndMovedChunks()
    {
        var salt = MoveCrypto.NewSalt(); var key = MoveCrypto.DeriveKey("correct horse", salt, 100_000); var other = MoveCrypto.DeriveKey("wrong", salt, 100_000);
        var sealedData = MoveCrypto.Seal(key, Encoding.UTF8.GetBytes("secret text"), "a|chunk|0");
        Assert.Equal("secret text", Encoding.UTF8.GetString(MoveCrypto.Open(key, sealedData, "a|chunk|0")));
        Assert.ThrowsAny<CryptographicException>(() => MoveCrypto.Open(other, sealedData, "a|chunk|0"));
        Assert.ThrowsAny<CryptographicException>(() => MoveCrypto.Open(key, sealedData, "a|chunk|1"));            // a chunk moved to another position
        var tampered = (byte[])sealedData.Clone(); tampered[20] ^= 1; Assert.ThrowsAny<CryptographicException>(() => MoveCrypto.Open(key, tampered, "a|chunk|0"));
        var check = MoveCrypto.MakeKeyCheck(key); Assert.True(MoveCrypto.KeyMatches(key, check)); Assert.False(MoveCrypto.KeyMatches(other, check)); Assert.False(MoveCrypto.KeyMatches(key, "not base64!"));
        Assert.NotEqual(sealedData, MoveCrypto.Seal(key, Encoding.UTF8.GetBytes("secret text"), "a|chunk|0"));      // a fresh nonce every time
    }

    [Fact]
    public async Task EverythingComesBackIntactOnANewPcAndViroOnlyHoldsCiphertext()
    {
        using var oldPc = new Sandbox(); using var newPc = new Sandbox(); var api = new FakeMoveApi();
        var big = Rand(MoveEngine.ChunkSize * 2 + 12345);                                  // spans three chunks
        Make(oldPc.Root, "Documents/report.docx", Encoding.UTF8.GetBytes("TOP-SECRET-PLAINTEXT-MARKER")); Make(oldPc.Root, "Documents/Work/big.bin", big); Make(oldPc.Root, "Documents/Work/empty.txt", []);
        Make(oldPc.Root, "Pictures/holiday photo (1).jpg", Rand(5000)); Make(oldPc.Root, "Documents/Ünïcode/файл.txt", Encoding.UTF8.GetBytes("hello"));
        var wp = Make(oldPc.Root, "wall.jpg", Rand(3000));
        var oldHost = new FakeMoveHost(oldPc.Root) { Wallpaper = wp };
        var job = await Back(new MoveEngine(oldHost, api), All, "my passphrase");
        Assert.Equal(MovePhase.Done, job.Phase); Assert.Null(job.Error);

        var snap = api.Snaps.Values.Single(); Assert.True(snap.Done);
        foreach (var c in snap.Chunks.Values) Assert.False(Encoding.UTF8.GetString(c).Contains("TOP-SECRET-PLAINTEXT-MARKER"));     // the server cannot read it
        Assert.DoesNotContain("report.docx", snap.Manifest); Assert.DoesNotContain("Home", snap.Manifest);

        var newHost = new FakeMoveHost(newPc.Root); var eng = new MoveEngine(newHost, api);
        var opened = await eng.OpenAsync(snap.Id, "my passphrase", default);
        Assert.Equal(2, opened.Manifest.Apps.Count); Assert.Equal("7zip.7zip", opened.Manifest.Apps[0].WingetId); Assert.Single(opened.Manifest.Wifi);
        Assert.DoesNotContain(opened.Manifest.Settings, s => s.Name == "Evil");                          // only allowed settings are ever captured
        var rj = new MoveJob(); await eng.RestoreAsync(opened, new MoveRestoreOptions(["Documents", "Pictures"], true, true, ["7zip.7zip"]), rj, default);
        Assert.Equal(MovePhase.Done, rj.Phase); Assert.Null(rj.Error);

        Assert.Equal(big, File.ReadAllBytes(Path.Combine(newPc.Root, @"Documents\Work\big.bin")));
        Assert.Equal("TOP-SECRET-PLAINTEXT-MARKER", File.ReadAllText(Path.Combine(newPc.Root, @"Documents\report.docx")));
        Assert.True(File.Exists(Path.Combine(newPc.Root, @"Documents\Work\empty.txt")) && new FileInfo(Path.Combine(newPc.Root, @"Documents\Work\empty.txt")).Length == 0);
        Assert.Equal("hello", File.ReadAllText(Path.Combine(newPc.Root, @"Documents\Ünïcode\файл.txt")));
        Assert.True(File.Exists(Path.Combine(newPc.Root, @"Pictures\holiday photo (1).jpg")));
        Assert.True(File.Exists(Path.Combine(newPc.Root, @"Documents\Viro Move\bookmarks.html")));
        Assert.Equal(2, newHost.Written.Count); Assert.DoesNotContain(newHost.Written, s => s.Name == "Evil"); Assert.NotNull(newHost.Applied); Assert.Equal(File.ReadAllBytes(wp), File.ReadAllBytes(newHost.Applied!));
        Assert.Single(newHost.WifiAdded); Assert.Equal(["7zip.7zip"], newHost.Installed);                  // only the programs the person chose
    }

    [Fact]
    public async Task AWrongPassphraseATamperedChunkAndAnUnsafePathAreAllRefused()
    {
        using var oldPc = new Sandbox(); using var newPc = new Sandbox(); var api = new FakeMoveApi();
        Make(oldPc.Root, "Documents/a.txt", Encoding.UTF8.GetBytes("data")); await Back(new MoveEngine(new FakeMoveHost(oldPc.Root), api), new("L", ["Documents"], false, false, false, false), "right");
        var id = api.Snaps.Keys.Single(); var eng = new MoveEngine(new FakeMoveHost(newPc.Root), api);
        var wrong = await Assert.ThrowsAsync<MoveException>(() => eng.OpenAsync(id, "wrong", default)); Assert.Contains("not the passphrase", wrong.Message);

        var opened = await eng.OpenAsync(id, "right", default); var chunk = api.Snaps[id].Chunks[0]; chunk[chunk.Length / 2] ^= 0xFF;
        var job = new MoveJob(); await eng.RestoreAsync(opened, new(["Documents"], false, false, []), job, default);
        Assert.Equal(MovePhase.Failed, job.Phase); Assert.Contains("changed or damaged", job.Error); Assert.False(File.Exists(Path.Combine(newPc.Root, @"Documents\a.txt")));

        Assert.Null(eng.TargetFor(new("Documents", "../../Windows/evil.dll", 1, 0, 0))); Assert.Null(eng.TargetFor(new("Documents", "C:/Windows/evil.dll", 1, 0, 0)));
        Assert.Null(eng.TargetFor(new("Documents", "a/../../b.txt", 1, 0, 0))); Assert.Null(eng.TargetFor(new("System32", "x.txt", 1, 0, 0))); Assert.NotNull(eng.TargetFor(new("Documents", "ok/file.txt", 1, 0, 0)));
        Assert.False(MoveSettingsCatalog.IsAllowed(new(@"Software\Microsoft\Windows\CurrentVersion\Run", "Evil", "String", "x")));
    }

    [Fact]
    public async Task ExistingFilesAreNeverOverwrittenAndTooBigABackupIsStoppedBeforeUploading()
    {
        using var oldPc = new Sandbox(); using var newPc = new Sandbox(); var api = new FakeMoveApi();
        Make(oldPc.Root, "Documents/notes.txt", Encoding.UTF8.GetBytes("from the old pc")); Make(oldPc.Root, "Documents/same.txt", Encoding.UTF8.GetBytes("identical"));
        await Back(new MoveEngine(new FakeMoveHost(oldPc.Root), api), new("L", ["Documents"], false, false, false, false), "p");
        Make(newPc.Root, "Documents/notes.txt", Encoding.UTF8.GetBytes("a different file already here")); Make(newPc.Root, "Documents/same.txt", Encoding.UTF8.GetBytes("identical"));
        var eng = new MoveEngine(new FakeMoveHost(newPc.Root), api); var opened = await eng.OpenAsync(api.Snaps.Keys.Single(), "p", default);
        await eng.RestoreAsync(opened, new(["Documents"], false, false, []), new MoveJob(), default);
        Assert.Equal("a different file already here", File.ReadAllText(Path.Combine(newPc.Root, @"Documents\notes.txt")));
        Assert.Equal("from the old pc", File.ReadAllText(Path.Combine(newPc.Root, @"Documents\notes (from old PC).txt")));
        Assert.Single(Directory.GetFiles(Path.Combine(newPc.Root, "Documents"), "same*"));

        var tiny = new FakeMoveApi(quota: 10); var j = await Back(new MoveEngine(new FakeMoveHost(oldPc.Root), tiny), new("L", ["Documents"], false, false, false, false), "p");
        Assert.Equal(MovePhase.Failed, j.Phase); Assert.Contains("left", j.Error); Assert.Empty(tiny.Snaps);                    // nothing was started
    }

    [Fact]
    public void WingetListIsReadIntoProgramNamesAndIds()
    {
        const string t = "Name                 Id                 Version  Available Source\n-----------------------------------------------------------------\n7-Zip                7zip.7zip          24.07    24.09     winget\nSome Old Tool        SomeOldTool        1.0\nGoogle Chrome        Google.Chrome      130.0.1            winget\n";
        var m = Viro.Agent.Winget.ParseInstalled(t);
        Assert.Equal("7zip.7zip", m["7-Zip"]); Assert.Equal("Google.Chrome", m["Google Chrome"]); Assert.False(m.ContainsKey("Some Old Tool"));
    }
}
