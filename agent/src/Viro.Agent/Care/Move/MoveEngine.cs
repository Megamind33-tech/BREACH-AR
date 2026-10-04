using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Viro.Agent.Care.Move;

/// <summary>How the engine talks to Viro. The Windows app uses the signed-in account; tests use an in-memory stand-in.</summary>
public interface IMoveApi
{
    Task<(int Status, JsonElement Body)> JsonAsync(HttpMethod method, string path, object? body, CancellationToken ct);
    Task<int> PutChunkAsync(string path, byte[] data, string sha256, CancellationToken ct);
    Task<(int Status, byte[] Data, string? Sha256)> GetChunkAsync(string path, CancellationToken ct);
}

public enum MovePhase { Idle, Scanning, Uploading, Downloading, Applying, Done, Failed, Cancelled }

/// <summary>Progress of the one backup or restore that is running. Read by the window every second or so.</summary>
public sealed class MoveJob
{
    public volatile MovePhase Phase = MovePhase.Idle; public volatile string Message = ""; public long BytesDone, BytesTotal; public int FilesDone, FilesTotal;
    public readonly List<string> Notes = []; public string? Error; public string Kind = ""; public CancellationTokenSource Cts = new();
    public bool Running => Phase is MovePhase.Scanning or MovePhase.Uploading or MovePhase.Downloading or MovePhase.Applying;
    public void Note(string s) { lock (Notes) { if (Notes.Count < 200) Notes.Add(s); } }
}

public sealed record MoveBackupOptions(string Label, IReadOnlyList<string> Folders, bool Settings, bool Wifi, bool Bookmarks, bool Apps);
public sealed record MoveRestoreOptions(IReadOnlyList<string> Folders, bool Settings, bool Wifi, IReadOnlyList<string> AppIds);
public sealed record MoveFolderSize(string Root, string Path, long Bytes, int Files);

public sealed class MoveEngine(IMoveHost host, IMoveApi api)
{
    public const int ChunkSize = 4 * 1024 * 1024;
    public const long MaxFileBytes = 4L * 1024 * 1024 * 1024;
    static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    internal IMoveApi Api => api;

    // ---- what there is to back up ---------------------------------------------------------------------------------------------------------------
    static bool Skip(FileInfo f)
    {
        var n = f.Name; var a = f.Attributes;
        if (n.Equals("desktop.ini", StringComparison.OrdinalIgnoreCase) || n.Equals("Thumbs.db", StringComparison.OrdinalIgnoreCase) || n.StartsWith("~$") || n.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) return true;
        if ((a & FileAttributes.ReparsePoint) != 0 || (a & FileAttributes.Offline) != 0 || ((int)a & 0x400000) != 0 || ((int)a & 0x40000) != 0) return true;      // links and OneDrive files that are not on this PC: never downloaded just to back them up
        return f.Length > MaxFileBytes;
    }

    public IEnumerable<(string Root, string Rel, FileInfo File)> Files(IEnumerable<string> roots, Action<string>? skipped = null)
    {
        foreach (var root in roots)
        {
            if (!host.Roots.TryGetValue(root, out var dir) || !Directory.Exists(dir)) continue;
            var opt = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint | FileAttributes.System };
            foreach (var f in new DirectoryInfo(dir).EnumerateFiles("*", opt))
            {
                if (Skip(f)) { skipped?.Invoke(f.FullName); continue; }
                yield return (root, Path.GetRelativePath(dir, f.FullName).Replace('\\', '/'), f);
            }
        }
    }

    public Task<IReadOnlyList<MoveFolderSize>> PreviewAsync(CancellationToken ct) => Task.Run<IReadOnlyList<MoveFolderSize>>(() =>
    {
        var o = new List<MoveFolderSize>();
        foreach (var (root, dir) in host.Roots) { long b = 0; var n = 0; foreach (var f in Files([root])) { ct.ThrowIfCancellationRequested(); b += f.File.Length; n++; } o.Add(new(root, dir, b, n)); }
        return o;
    }, ct);

    // ---- back up ----------------------------------------------------------------------------------------------------------------------------------
    sealed class ChunkSink(MoveEngine eng, string id, byte[] key, MoveJob job, CancellationToken ct)
    {
        readonly byte[] buf = new byte[ChunkSize]; int len; public int Count; public long Written;
        public async Task AppendAsync(ReadOnlyMemory<byte> data)
        {
            while (data.Length > 0)
            {
                var take = Math.Min(data.Length, ChunkSize - len); data.Span[..take].CopyTo(buf.AsSpan(len)); len += take; data = data[take..]; Written += take;
                if (len == ChunkSize) await FlushAsync();
            }
        }
        public async Task FlushAsync()
        {
            if (len == 0) return;
            var sealedChunk = MoveCrypto.Seal(key, buf.AsSpan(0, len), MoveCrypto.ChunkAad(id, Count)); var sha = Convert.ToHexString(SHA256.HashData(sealedChunk)).ToLowerInvariant();
            for (var attempt = 1; ; attempt++)
            {
                var status = await eng.Api.PutChunkAsync($"/api/v1/move/snapshots/{id}/chunks/{Count}", sealedChunk, sha, ct);
                if (status is >= 200 and < 300) break;
                if (status == 413) throw new MoveException("This would go over your storage allowance. Choose less to back up, or ask about a larger plan.");
                if (status is 401 or 402 or 403 or 404) throw new MoveException(status == 401 ? "You were signed out. Sign in again." : "Viro refused this backup.");
                if (attempt >= 4) throw new MoveException("Could not upload to Viro. Check your internet connection and try again.");
                await Task.Delay(TimeSpan.FromSeconds(attempt * 2), ct);
            }
            Count++; len = 0;
        }
    }

    public async Task BackupAsync(MoveBackupOptions o, string passphrase, MoveJob job, CancellationToken ct)
    {
        try
        {
            job.Kind = "backup"; job.Phase = MovePhase.Scanning; job.Message = "Looking at what to back up…";
            var manifestFiles = new List<MoveFile>(); var plan = await Task.Run(() => Files(o.Folders, p => job.Note("Skipped (not on this PC or too large): " + Path.GetFileName(p))).ToList(), ct);
            long total = plan.Sum(x => x.File.Length); job.BytesTotal = total; job.FilesTotal = plan.Count;

            var (qs, qb) = await api.JsonAsync(HttpMethod.Get, "/api/v1/move/snapshots", null, ct);
            if (qs is 401) throw new MoveException("Sign in to your Viro account first."); if (qs == 402) throw new MoveException("Viro Move is part of a paid plan.");
            long quota = qb.TryGetProperty("quotaBytes", out var q) ? q.GetInt64() : 0, usedNow = qb.TryGetProperty("usedBytes", out var u) ? u.GetInt64() : 0;
            if (total + (total / 500) > quota - usedNow) throw new MoveException($"This backup is about {total / 1048576} MB but you have {(quota - usedNow) / 1048576} MB left. Choose fewer folders, or delete an older backup.");

            var salt = MoveCrypto.NewSalt(); var key = MoveCrypto.DeriveKey(passphrase, salt);
            var (cs, cb) = await api.JsonAsync(HttpMethod.Post, "/api/v1/move/snapshots", new { label = o.Label, machine = host.MachineName, kdf = new { alg = "pbkdf2-sha256", iterations = MoveCrypto.Iterations, salt = Convert.ToBase64String(salt) }, keyCheck = MoveCrypto.MakeKeyCheck(key) }, ct);
            if (cs is < 200 or >= 300) throw new MoveException(cb.TryGetProperty("error", out var e) ? e.GetString()! : "Could not start the backup.");
            var id = cb.GetProperty("id").GetString()!; var sink = new ChunkSink(this, id, key, job, ct);
            job.Phase = MovePhase.Uploading; job.Message = "Encrypting and uploading…";

            async Task AddBytes(string root, string rel, byte[] data) { var off = sink.Written; await sink.AppendAsync(data); manifestFiles.Add(new(root, rel, data.Length, DateTime.UtcNow.Ticks, off)); }
            var settings = o.Settings ? host.ReadSettings().Where(MoveSettingsCatalog.IsAllowed).ToList() : [];
            if (o.Settings && host.WallpaperPath() is { } wp) { try { await AddBytes("Settings", "wallpaper" + (Path.GetExtension(wp).Length is > 0 and < 8 ? Path.GetExtension(wp) : ".jpg"), await File.ReadAllBytesAsync(wp, ct)); } catch (IOException) { job.Note("Wallpaper could not be read."); } }
            if (o.Bookmarks && host.BookmarksHtml() is { } html) await AddBytes("Bookmarks", "bookmarks.html", Encoding.UTF8.GetBytes(html));
            var wifi = o.Wifi ? await host.ExportWifiAsync(ct) : [];
            var apps = o.Apps ? await host.InstalledAppsAsync(ct) : [];

            var rbuf = new byte[1024 * 1024];
            foreach (var (root, rel, f) in plan)
            {
                ct.ThrowIfCancellationRequested(); var off = sink.Written; long got = 0; var partial = false;
                try
                {
                    await using var fs = new FileStream(f.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1, FileOptions.SequentialScan);
                    int n; while ((n = await fs.ReadAsync(rbuf, ct)) > 0) { await sink.AppendAsync(rbuf.AsMemory(0, n)); got += n; job.BytesDone += n; }
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { partial = true; job.Note("Changed while backing up, not restored: " + f.Name); }
                manifestFiles.Add(new(root, rel, got, partial ? -1 : f.LastWriteTimeUtc.Ticks, off)); job.FilesDone++;
            }
            await sink.FlushAsync();

            var manifest = new MoveManifest(1, DateTime.UtcNow.ToString("O"), host.MachineName, host.OsName, settings, apps, wifi, manifestFiles, sink.Written);
            var sealedManifest = Convert.ToBase64String(MoveCrypto.Seal(key, JsonSerializer.SerializeToUtf8Bytes(manifest, Web), MoveCrypto.ManifestAad(id)));
            var (fs2, fb) = await api.JsonAsync(HttpMethod.Post, $"/api/v1/move/snapshots/{id}/finish", new { manifest = sealedManifest, chunks = sink.Count }, ct);
            if (fs2 is < 200 or >= 300) throw new MoveException(fb.TryGetProperty("error", out var fe) ? fe.GetString()! : "Could not finish the backup.");
            job.Phase = MovePhase.Done; job.Message = $"Backed up {manifestFiles.Count(x => x.Mtime != -1)} files, {settings.Count} settings, {apps.Count} programs and {wifi.Count} Wi-Fi networks.";
        }
        catch (OperationCanceledException) { job.Phase = MovePhase.Cancelled; job.Message = "Cancelled. The unfinished backup is removed by Viro after two days."; }
        catch (MoveException e) { job.Phase = MovePhase.Failed; job.Error = e.Message; job.Message = e.Message; }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or HttpRequestException) { job.Phase = MovePhase.Failed; job.Error = e.Message; job.Message = "The backup stopped: " + e.Message; }
    }

    // ---- take it back --------------------------------------------------------------------------------------------------------------------------
    public sealed record Opened(string Id, string Label, string Machine, byte[] Key, MoveManifest Manifest, int Chunks);

    /// <summary>Checks the passphrase and reads the list of what is in a snapshot; nothing is written to this PC.</summary>
    public async Task<Opened> OpenAsync(string id, string passphrase, CancellationToken ct)
    {
        var (s, b) = await api.JsonAsync(HttpMethod.Get, $"/api/v1/move/snapshots/{id}", null, ct);
        if (s == 401) throw new MoveException("Sign in to your Viro account first."); if (s != 200) throw new MoveException("That backup was not found.");
        var salt = Convert.FromBase64String(b.GetProperty("kdf").GetProperty("salt").GetString()!); var iters = b.GetProperty("kdf").GetProperty("iterations").GetInt32();
        if (iters < 100_000) throw new MoveException("This backup uses weak protection and was refused.");
        var key = await Task.Run(() => MoveCrypto.DeriveKey(passphrase, salt, iters), ct);
        if (!MoveCrypto.KeyMatches(key, b.GetProperty("keyCheck").GetString()!)) throw new MoveException("That is not the passphrase for this backup.");
        MoveManifest m;
        try { m = JsonSerializer.Deserialize<MoveManifest>(MoveCrypto.Open(key, Convert.FromBase64String(b.GetProperty("manifest").GetString()!), MoveCrypto.ManifestAad(id)), Web)!; }
        catch (Exception e) when (e is CryptographicException or JsonException or FormatException) { throw new MoveException("This backup is damaged or has been changed, so it was not restored."); }
        return new(id, b.GetProperty("label").GetString() ?? "", b.TryGetProperty("machine", out var mc) ? mc.GetString() ?? "" : "", key, m, b.GetProperty("chunks").GetInt32());
    }

    /// <summary>Where a file from the snapshot goes on this PC, or null when its path is not safe. Nothing outside the person's own folders is ever written.</summary>
    public string? TargetFor(MoveFile f)
    {
        var rel = f.Path.Replace('/', '\\');
        if (rel.Length == 0 || Path.IsPathRooted(rel) || rel.Contains(':') || rel.Split('\\').Any(p => p is ".." or "." or "")) return null;
        string root = f.Root switch { "Settings" => host.RestoredSettingsFolder, "Bookmarks" => host.RestoredBookmarksFolder, _ => host.Roots.TryGetValue(f.Root, out var r) ? r : "" };
        if (root.Length == 0) return null;
        var full = Path.GetFullPath(Path.Combine(root, rel)); var rootFull = Path.GetFullPath(root).TrimEnd('\\') + "\\";
        return full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase) ? full : null;
    }

    static string Free(string path, long size)
    {
        if (!File.Exists(path)) return path;
        if (new FileInfo(path).Length == size) return "";                    // the same file is already there
        var dir = Path.GetDirectoryName(path)!; var name = Path.GetFileNameWithoutExtension(path); var ext = Path.GetExtension(path);
        for (var i = 1; ; i++) { var p = Path.Combine(dir, $"{name} (from old PC{(i > 1 ? " " + i : "")}){ext}"); if (!File.Exists(p)) return p; }
    }

    public async Task RestoreAsync(Opened o, MoveRestoreOptions opt, MoveJob job, CancellationToken ct)
    {
        try
        {
            job.Kind = "restore"; var m = o.Manifest; job.BytesTotal = m.StreamLength; job.Phase = MovePhase.Downloading; job.Message = "Downloading and decrypting…";
            var files = m.Files.OrderBy(f => f.Offset).ToList(); bool want(MoveFile f) => f.Mtime != -1 && (f.Root is "Settings" ? opt.Settings : f.Root is "Bookmarks" ? true : opt.Folders.Contains(f.Root));
            job.FilesTotal = files.Count(want); FileStream? cur = null; string? curPath = null; MoveFile? entry = null; long left = 0; var idx = 0; long pos = 0; var skippedExisting = 0;

            void Begin(MoveFile f)
            {
                entry = f; left = f.Size; cur = null; curPath = null;
                if (!want(f)) return;
                var target = TargetFor(f); if (target is null) { job.Note("Skipped an unsafe path in the backup."); return; }
                var free = Free(target, f.Size); if (free.Length == 0) { skippedExisting++; return; }
                Directory.CreateDirectory(Path.GetDirectoryName(free)!); cur = new FileStream(free, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16, true);
                curPath = free;
            }
            async Task Finish() { if (cur is not null) { var t = cur; cur = null; await t.DisposeAsync(); job.FilesDone++; if (entry is { Mtime: > 0 } e && curPath is not null) { try { File.SetLastWriteTimeUtc(curPath, new DateTime(e.Mtime, DateTimeKind.Utc)); } catch (ArgumentOutOfRangeException) { } } } entry = null; }
            async Task Feed(ReadOnlyMemory<byte> seg)
            {
                while (true)
                {
                    while (entry is null || left == 0)
                    {
                        if (entry is not null) await Finish();
                        if (idx >= files.Count) return;
                        Begin(files[idx++]); if (left == 0) await Finish();
                    }
                    if (seg.Length == 0) return;
                    var take = (int)Math.Min(seg.Length, left);
                    if (cur is not null) await cur.WriteAsync(seg[..take], ct);
                    seg = seg[take..]; left -= take; pos += take; job.BytesDone = pos;
                }
            }

            for (var c = 0; c < o.Chunks; c++)
            {
                ct.ThrowIfCancellationRequested();
                var (st, data, sha) = await api.GetChunkAsync($"/api/v1/move/snapshots/{o.Id}/chunks/{c}", ct);
                if (st != 200) throw new MoveException("Could not download the backup. Check your internet connection and try again.");
                if (sha is not null && !string.Equals(sha, Convert.ToHexString(SHA256.HashData(data)), StringComparison.OrdinalIgnoreCase)) throw new MoveException("A piece of the backup was damaged in transit. Try again.");
                byte[] plain; try { plain = MoveCrypto.Open(o.Key, data, MoveCrypto.ChunkAad(o.Id, c)); } catch (CryptographicException) { throw new MoveException("The backup has been changed or damaged, so it was stopped."); }
                await Feed(plain);
            }
            await Feed(ReadOnlyMemory<byte>.Empty);
            if (entry is not null && left > 0) throw new MoveException("The backup is incomplete, so the last file was not restored.");

            job.Phase = MovePhase.Applying; job.Message = "Putting settings back…";
            if (opt.Settings)
            {
                var applied = 0; foreach (var s in m.Settings.Where(MoveSettingsCatalog.IsAllowed)) { host.WriteSetting(s); applied++; }
                var wp = files.FirstOrDefault(f => f.Root == "Settings"); if (wp is not null && TargetFor(wp) is { } wpt) { var written = Directory.Exists(Path.GetDirectoryName(wpt)) ? Directory.GetFiles(Path.GetDirectoryName(wpt)!, "wallpaper*").OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault() : null; if (written is not null) host.ApplyWallpaper(written); }
                job.Note($"{applied} settings restored. Taskbar changes appear after you sign out and in again.");
            }
            if (opt.Wifi) { foreach (var w in m.Wifi) { await host.ImportWifiAsync(w, ct); } job.Note($"{m.Wifi.Count} Wi-Fi networks added."); }
            if (opt.AppIds.Count > 0)
            {
                job.Phase = MovePhase.Applying; var done = 0;
                foreach (var appId in opt.AppIds)
                {
                    ct.ThrowIfCancellationRequested(); job.Message = $"Installing programs ({done + 1} of {opt.AppIds.Count})…";
                    var name = m.Apps.FirstOrDefault(a => a.WingetId == appId)?.Name ?? appId; var (ok, detail) = await host.InstallAppAsync(appId, ct);
                    job.Note(ok ? $"Installed {name}" : $"Could not install {name}: {detail}"); done++;
                }
            }
            if (skippedExisting > 0) job.Note($"{skippedExisting} files were already on this PC and were left alone.");
            job.Phase = MovePhase.Done; job.Message = "Restored.";
        }
        catch (OperationCanceledException) { job.Phase = MovePhase.Cancelled; job.Message = "Cancelled. What was already restored stays."; }
        catch (MoveException e) { job.Phase = MovePhase.Failed; job.Error = e.Message; job.Message = e.Message; }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or HttpRequestException) { job.Phase = MovePhase.Failed; job.Error = e.Message; job.Message = "The restore stopped: " + e.Message; }
    }
}

public sealed class MoveException(string message) : Exception(message);
