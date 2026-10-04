using System.Security.Principal;
using System.Text.Json;
using Viro.Agent.Repair;

namespace Viro.Agent.Care;

/// <summary>
/// The only things the window's interface can ask for. Every command maps onto <see cref="LocalActions"/>, which uses the same engines and safety rules as the
/// service; there is no command that runs arbitrary code or reads files. The only network traffic is to the Viro account service (sign-in and plan) and, for program updates, winget. Results are plain JSON for the interface to draw.
/// </summary>
public sealed class LocalBridge(LocalActions act, Func<bool>? isAdmin = null, Action? relaunchElevated = null, WorkspaceActions? workspace = null, AccountService? accounts = null, Action<string>? openUrl = null, Func<Task<bool>>? isManaged = null, Viro.Agent.Care.Move.MoveEngine? moveEngine = null)
{
    static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
    static object Shape(AccountState a) => new { signedIn = a.SignedIn, email = a.Email, plan = a.Plan, planName = a.PlanName, active = a.Active, validUntil = a.ValidUntil, features = a.Features, managed = a.Managed, stale = a.Stale, checkedAt = a.CheckedAt, free = AccountService.FreeFeatures, titles = FeatureGate.Titles };
    readonly Func<bool> admin = isAdmin ?? (() => new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator));

    readonly AccountService account = accounts ?? new AccountService(new DpapiAccountStore());
    Viro.Agent.Care.Move.MoveEngine? engine = moveEngine; Viro.Agent.Care.Move.MoveJob? moveJob; Viro.Agent.Care.Move.MoveEngine.Opened? moveOpened;
    Viro.Agent.Care.Move.MoveEngine Move => engine ??= new Viro.Agent.Care.Move.MoveEngine(new Viro.Agent.Care.Move.WindowsMoveHost(), new Viro.Agent.Care.Move.AccountMoveApi(account));
    static object JobView(Viro.Agent.Care.Move.MoveJob? j) => j is null ? new { idle = true } : new { idle = false, kind = j.Kind, phase = j.Phase.ToString(), running = j.Running, message = j.Message, bytesDone = Interlocked.Read(ref j.BytesDone), bytesTotal = j.BytesTotal, filesDone = j.FilesDone, filesTotal = j.FilesTotal, error = j.Error, notes = j.Notes.ToArray() };

    /// <summary>True when an organization manages this PC through the Viro service: its administrators set what is included, so the window does not lock anything.</summary>
    async Task<bool> ManagedAsync(CancellationToken ct) { if (isManaged is not null) return await isManaged(); try { return await act.SelfAsync(ct) is not null; } catch (Exception) { return false; } }

    public async Task<object?> HandleAsync(string cmd, JsonElement args, CancellationToken ct)
    {
        if (FeatureGate.Required(cmd, args) is { } need && !account.Has(need, await ManagedAsync(ct)))
            return new { locked = true, feature = need, title = FeatureGate.Titles.GetValueOrDefault(need, need) };
        switch (cmd)
        {
            case "account.status": { var m = await ManagedAsync(ct); return Shape(account.State(m)); }
            case "account.refresh": { await account.RefreshAsync(ct); return Shape(account.State(await ManagedAsync(ct))); }
            case "account.signin": { var r = await account.SignInAsync(Str(args, "email"), Str(args, "password"), args.TryGetProperty("code", out var cd) && cd.ValueKind == JsonValueKind.String ? cd.GetString() : null, ct); return new { ok = r.Ok, message = r.Message, needsCode = r.NeedsCode, state = Shape(account.State(await ManagedAsync(ct))) }; }
            case "account.signout": account.SignOut(); return Shape(account.State(await ManagedAsync(ct)));
            case "pc.report":      // read this PC in full, have Viro work out what it means, and show it; nothing is stored on the server
            {
                var reading = await Task.Run(() => Anatomy.Collect(new SystemProcessRunner(), ct), ct);
                string? cost = args.TryGetProperty("purchaseCost", out var pc) && pc.ValueKind == JsonValueKind.Number ? pc.GetDecimal().ToString(System.Globalization.CultureInfo.InvariantCulture) : null;
                var payload = cost is null ? (object)new { anatomy = reading } : new { anatomy = reading, purchaseCost = decimal.Parse(cost, System.Globalization.CultureInfo.InvariantCulture) };
                var (status, body) = await account.SendAsync(HttpMethod.Post, "/api/v1/my-pc/report", payload, ct);
                var ok = status is >= 200 and < 300;
                return new { ok, report = ok ? (object)body.Clone() : null, message = ok ? null : body.TryGetProperty("error", out var e) ? e.GetString() : "Could not read your PC report.", signedOut = status == 401 };
            }
            case "move.status": return JobView(moveJob);
            case "move.preview": return new { folders = (await Move.PreviewAsync(ct)).Select(x => new { root = x.Root, path = x.Path, bytes = x.Bytes, files = x.Files }).ToList() };
            case "move.list":
            {
                var (st, body) = await account.SendAsync(HttpMethod.Get, "/api/v1/move/snapshots", null, ct);
                return new { ok = st is >= 200 and < 300, signedOut = st == 401, snapshots = st is >= 200 and < 300 && body.TryGetProperty("snapshots", out var sn) ? (object)sn.Clone() : Array.Empty<object>(), usedBytes = body.TryGetProperty("usedBytes", out var ub) && ub.ValueKind == JsonValueKind.Number ? ub.GetInt64() : 0, quotaBytes = body.TryGetProperty("quotaBytes", out var qb) && qb.ValueKind == JsonValueKind.Number ? qb.GetInt64() : 0 };
            }
            case "move.backup":
            {
                if (moveJob is { Running: true }) return new { ok = false, message = "A backup or restore is already running." };
                var pass = Str(args, "passphrase"); if (pass.Length < 10) return new { ok = false, message = "Choose a passphrase of at least 10 characters. It protects your backup, and Viro cannot recover it for you." };
                var o = new Viro.Agent.Care.Move.MoveBackupOptions(Str(args, "label") is { Length: > 0 } l ? l : Environment.MachineName, Strings(args, "folders"), Flag(args, "settings"), Flag(args, "wifi"), Flag(args, "bookmarks"), Flag(args, "apps"));
                var job = moveJob = new Viro.Agent.Care.Move.MoveJob(); _ = Task.Run(() => Move.BackupAsync(o, pass, job, job.Cts.Token));
                return new { ok = true, message = "Backup started." };
            }
            case "move.open":
            {
                try
                {
                    moveOpened = await Move.OpenAsync(Str(args, "id"), Str(args, "passphrase"), ct); var m = moveOpened.Manifest;
                    return new { ok = true, label = moveOpened.Label, machine = m.Machine, createdAt = m.CreatedAt, os = m.Os, folders = m.Files.Where(f => f.Mtime != -1 && f.Root is not ("Settings" or "Bookmarks")).GroupBy(f => f.Root).Select(g => new { root = g.Key, files = g.Count(), bytes = g.Sum(x => x.Size) }).ToList(), settings = m.Settings.Count, hasWallpaper = m.Files.Any(f => f.Root == "Settings"), bookmarks = m.Files.Any(f => f.Root == "Bookmarks"), wifi = m.Wifi.Select(w => w.Name).ToList(), apps = m.Apps.Select(a => new { name = a.Name, version = a.Version, publisher = a.Publisher, wingetId = a.WingetId }).ToList() };
                }
                catch (Viro.Agent.Care.Move.MoveException e) { moveOpened = null; return new { ok = false, message = e.Message }; }
            }
            case "move.restore":
            {
                if (moveOpened is null) return new { ok = false, message = "Open the backup with its passphrase first." };
                if (moveJob is { Running: true }) return new { ok = false, message = "A backup or restore is already running." };
                var opened = moveOpened; var o = new Viro.Agent.Care.Move.MoveRestoreOptions(Strings(args, "folders"), Flag(args, "settings"), Flag(args, "wifi"), Strings(args, "appIds"));
                var job = moveJob = new Viro.Agent.Care.Move.MoveJob(); _ = Task.Run(() => Move.RestoreAsync(opened, o, job, job.Cts.Token));
                return new { ok = true, message = "Restore started." };
            }
            case "move.cancel": moveJob?.Cts.Cancel(); return JobView(moveJob);
            case "move.delete": { var (st, _) = await account.SendAsync(HttpMethod.Delete, "/api/v1/move/snapshots/" + Uri.EscapeDataString(Str(args, "id")), null, ct); return new { ok = st is >= 200 and < 300 }; }
            case "help.request":
            {
                object? details = null;
                if (args.TryGetProperty("includeDetails", out var inc) && inc.ValueKind == JsonValueKind.True)
                {
                    var sys = await Task.Run(Collectors.Summary, ct); var d = new DriveInfo(Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows))!);
                    var issues = new List<string>();
                    try { if (await act.SelfAsync(ct) is { } v && v.TryGetProperty("health", out var h) && h.TryGetProperty("findings", out var fs)) foreach (var x in fs.EnumerateArray().Take(8)) if (x.TryGetProperty("reason", out var rs) && rs.GetString() is { Length: > 0 } t) issues.Add(t.Length > 190 ? t[..190] : t); } catch (Exception) { }
                    details = new { machine = $"{sys.Manufacturer} {sys.Model}".Trim(), windows = sys.Os, freeGb = Math.Round(d.AvailableFreeSpace / 1073741824.0, 1), memoryPercent = Math.Round(act.MemoryNow().UsedPercent, 0), issues };
                }
                var (status, body) = await account.SendAsync(HttpMethod.Post, "/api/v1/help/requests", new { subject = Str(args, "subject"), message = Str(args, "message"), contact = Str(args, "contact") is { Length: > 0 } c ? c : null, details }, ct);
                var ok = status is >= 200 and < 300;
                return new { ok, message = body.TryGetProperty(ok ? "message" : "error", out var m) ? m.GetString() : (ok ? "Sent." : "Could not send your request."), signedOut = status == 401 };
            }
            case "help.list":
            {
                var (status, body) = await account.SendAsync(HttpMethod.Get, "/api/v1/help/requests", null, ct);
                return new { ok = status is >= 200 and < 300, requests = status is >= 200 and < 300 && body.TryGetProperty("requests", out var rq) ? (object)rq.Clone() : Array.Empty<object>(), signedOut = status == 401 };
            }
            case "account.manage": openUrl?.Invoke(account.ManageUrl); return new { opened = openUrl is not null, url = account.ManageUrl };

            case "env": return new { admin = admin(), user = Environment.UserName, machine = Environment.MachineName, version = Collectors.AgentVersion };
            case "sys":      // the facts for the line under every page title; the first reading of CPU use is taken here so the live figures are ready by the time they are asked for
            {
                _ = Collectors.CpuPercent();
                try { var s = await Task.Run(Collectors.Summary, ct); return new { cpu = s.Cpu, cores = s.Cores, ramGb = s.RamGb, os = s.Os, uptimeSeconds = s.UptimeSeconds, manufacturer = s.Manufacturer, model = s.Model }; }
                catch (Exception) { return new { cpu = (string?)null, cores = (int?)null, ramGb = (double?)null, os = (string?)null, uptimeSeconds = (long?)null, manufacturer = (string?)null, model = (string?)null }; }      // a PC that will not answer WMI just shows less
            }
            case "live":     // processor, memory and system-drive figures for the Overview, read every few seconds
            {
                var m = Collectors.Metrics();
                return new { cpuPercent = m["cpuPercent"], ramPercent = m["ramPercent"], diskFreeBytes = m["systemDiskFreeBytes"], diskTotalBytes = m["systemDiskTotalBytes"], onBattery = m["onBattery"] };
            }
            case "self": { var v = await act.SelfAsync(ct); return new { available = v is not null, view = v }; }

            case "apps.list":
            {
                var reg = AppInventory.Registered(); var store = await AppInventory.StoreAppsAsync(new SystemProcessRunner(), admin(), ct); var all = reg.Concat(store).ToList();
                var crashes = await Task.Run(() => AppInventory.Crashes(all), ct);
                return new { apps = all.Select(a => new { a.Name, a.Version, a.Publisher, a.Kind, a.Id }).ToList(), crashes = crashes.Select(x => new { x.Exe, x.Crashes, x.Hangs, at = x.LastAt, app = x.MatchedApp }).ToList() };
            }
            case "apps.repair":
            {
                var o = JsonSerializer.Serialize(new { kind = Str(args, "kind"), id = Str(args, "id") }, Web);
                var r = await act.RunRecipeAsync("app.repair", ct, o);
                return new { verified = r.Verified == true, applied = r.Applied, needed = r.Needed, r.Summary, rebootRequired = r.RebootRequired, needsAdmin = r.Summary.Contains("administrator", StringComparison.OrdinalIgnoreCase), repairId = r.RepairId };
            }
            case "apps.inventory":
            {
                var reg = await Task.Run(() => AppSizer.Fill(RegistryAppCatalog.All(), TimeSpan.FromSeconds(25), ct), ct);
                var store = await AppInventory.StoreAppsAsync(new SystemProcessRunner(), admin(), ct);
                var rows = reg.Select(a => new { id = a.Key, hive = a.Hive, a.Name, a.Version, a.Publisher, kind = a.Kind, sizeBytes = a.SizeBytes, installedOn = a.InstalledOn, hidden = a.Hidden, hiddenReason = a.HiddenReason, protectedReason = AppGuard.Protected(a, act.Env) })
                    .Concat(store.Select(a => new { id = a.Id!, hive = "", a.Name, a.Version, a.Publisher, kind = "appx", sizeBytes = (long?)null, installedOn = (string?)null, hidden = false, hiddenReason = (string?)null, protectedReason = (string?)null })).ToList();
                return new { apps = rows.OrderByDescending(r => r.sizeBytes ?? -1).ThenBy(r => r.Name, StringComparer.OrdinalIgnoreCase).ToList(), totalBytes = rows.Sum(r => r.sizeBytes ?? 0), admin = admin() };
            }
            case "apps.uninstall":
            {
                var o = JsonSerializer.Serialize(new { kind = Str(args, "kind"), id = Str(args, "id"), hive = Str(args, "hive"), forced = args.TryGetProperty("forced", out var fv) && fv.ValueKind == JsonValueKind.True }, Web);
                var r = await act.RunRecipeAsync("app.uninstall", ct, o);
                return new { verified = r.Verified == true, applied = r.Applied, needed = r.Needed, r.Summary, rebootRequired = r.RebootRequired, needsAdmin = r.Summary.Contains("administrator", StringComparison.OrdinalIgnoreCase), canForce = r.Applied == false && r.Needed && !r.Summary.Contains("protected", StringComparison.OrdinalIgnoreCase), repairId = r.RepairId, undoable = r.RollbackAvailable };
            }
            case "fix.all":      // one pass through every safe fix, measured before and after, so the person sees what actually changed
            {
                var r = await FixAll.RunAsync(act, ct);
                return new { before = new { freeBytes = r.Before.FreeBytes, memoryPercent = r.Before.MemoryPercent, startupItems = r.Before.StartupItems }, after = new { freeBytes = r.After.FreeBytes, memoryPercent = r.After.MemoryPercent, startupItems = r.After.StartupItems },
                    steps = r.Steps.Select(x => new { recipe = x.Recipe, title = x.Title, needed = x.Needed, applied = x.Applied, verified = x.Verified, summary = x.Summary, undoId = x.UndoId, needsAdmin = x.NeedsAdmin }).ToList() };
            }
            case "backup.check":
            {
                DateTime? lastMove = null;
                var (st, body) = await account.SendAsync(HttpMethod.Get, "/api/v1/move/snapshots", null, ct);
                if (st is >= 200 and < 300 && body.TryGetProperty("snapshots", out var sn)) foreach (var x in sn.EnumerateArray()) if (x.TryGetProperty("status", out var ss) && ss.GetString() == "complete" && x.TryGetProperty("created_at", out var ca) && DateTime.TryParse(ca.GetString(), null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var d) && (lastMove is null || d > lastMove)) lastMove = d;
                var v = await Task.Run(() => BackupCheck.Evaluate(BackupCheck.Read(lastMove)), ct);
                return new { state = v.State, headline = v.Headline, items = v.Items.Select(i => new { name = i.Name, state = i.State, detail = i.Detail }).ToList(), advice = v.Advice, limits = v.Limits };
            }
            case "apps.leftovers":
            {
                var items = await Task.Run(() => LeftoverScan.Find(Str(args, "name"), Str(args, "publisher"), act.Env), ct);
                return new { items = items.Select(l => new { id = l.Id, kind = l.Kind, path = l.Path, bytes = l.Bytes }).ToList() };
            }
            case "apps.leftovers.clean":
            {
                var o = JsonSerializer.Serialize(new { name = Str(args, "name"), publisher = Str(args, "publisher"), ids = Strings(args, "ids") }, Web);
                var r = await act.RunRecipeAsync("app.leftovers", ct, o);
                return new { verified = r.Verified == true, applied = r.Applied, r.Summary, undoable = r.RollbackAvailable, repairId = r.RepairId };
            }
            case "schedule.status": { var st = await new CareSchedule(new SystemProcessRunner(), Environment.ProcessPath ?? "").StatusAsync(ct); return new { enabled = st.Enabled, nextRun = st.NextRun }; }
            case "schedule.enable": { var ok = await new CareSchedule(new SystemProcessRunner(), Environment.ProcessPath ?? "").EnableAsync(ct); return new { ok, message = ok ? "Weekly care is on. It runs on Sundays at 11:00 while you are signed in to Windows." : "Windows would not create the task." }; }
            case "schedule.disable": { var ok = await new CareSchedule(new SystemProcessRunner(), Environment.ProcessPath ?? "").DisableAsync(ct); return new { ok }; }
            case "schedule.run": { var r = await Maintenance.RunAsync(act, account, ct); return new { ok = r.Ok, message = r.Message }; }
            case "slow.analyze":
            {
                var shut = await Task.Run(() => ShutdownHistory.Read(), ct); var boot = await Task.Run(() => BootHistory.Read(), ct); var env = act.Env;
                return new
                {
                    readable = shut is not null || boot is not null, admin = admin(),
                    boots = boot?.Boots.Take(8).Select(x => new { at = x.At, seconds = x.BootSeconds }).ToList(), startupCulprits = boot?.Degrading.Take(8).Select(x => new { x.Name, seconds = x.DegradationSeconds }).ToList(),
                    shutdowns = shut?.Shutdowns.Take(8).Select(x => new { at = x.At, seconds = x.Seconds }).ToList(), shutdownCulprits = shut?.Culprits.Select(x => new { x.Name, x.Kind, x.Seconds, x.Times }).ToList(), slowServices = shut?.SlowServices.Take(8).Select(x => new { x.Name, x.Seconds, x.Times }).ToList(),
                    raised = env.ReadShutdownSettings().Where(s => s.Current is { } v && v > s.Default).Select(s => new { s.Name, current = s.Current, normal = s.Default, s.Why }).ToList(), pageFileWipe = env.ClearsPageFileAtShutdown(),
                };
            }
            case "stability.analyze":
            {
                var e = await Task.Run(() => StabilityReader.Collect(30), ct); var causes = StabilityReader.Analyse(e, 30);
                var hung = await Task.Run(() => HungApps.List(), ct);
                return new { blueScreens = e.BlueScreens, restarts = e.UnexpectedRestarts, freezes = e.Freezes, diskErrors = e.DiskErrors, hardwareErrors = e.HardwareErrors, shellCrashes = e.ShellCrashes, lastBlueScreen = e.LastBlueScreen,
                    codes = e.BugCheckCodes.Select(c => new { c.code, c.times, meaning = StabilityReader.Describe(c.code) }).ToList(),
                    causes = causes.Select(c => new { c.Code, c.Title, c.Detail, c.Confidence, c.Recipe, c.RecipeLabel }).ToList(),
                    hung = hung.Select(h => new { h.Pid, h.Name, h.Title }).ToList() };
            }
            case "hung.end":
            {
                var pids = args.TryGetProperty("pids", out var pp) && pp.ValueKind == JsonValueKind.Array ? pp.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.Number).Select(x => x.GetInt32()).ToList() : [];
                var r = await act.RunRecipeAsync("apps.end-hung", ct, JsonSerializer.Serialize(new { pids }, Web));
                return new { verified = r.Verified == true, r.Summary };
            }
            case "updates.apps":
            {
                var list = await AppUpdates.ListAsync(new SystemProcessRunner(), ct);
                return new { available = list is not null, items = (list ?? []).Select(u => new { u.Name, u.Id, u.Version, u.Available, u.Source }).ToList() };
            }
            case "updates.app":
            {
                var r = await act.RunRecipeAsync("app.update", ct, JsonSerializer.Serialize(new { id = Str(args, "id") }, Web));
                return new { verified = r.Verified == true, applied = r.Applied, needed = r.Needed, r.Summary, rebootRequired = r.RebootRequired, needsAdmin = r.Summary.Contains("administrator", StringComparison.OrdinalIgnoreCase) };
            }
            case "disk": { var d = new DriveInfo(Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows))!); return new { drive = d.Name.TrimEnd('\\'), freeBytes = d.AvailableFreeSpace, totalBytes = d.TotalSize }; }
            case "space.preview": return (await act.PreviewCleanupAsync(ct)).Select(c => new { c.Id, c.Title, c.Class, c.BytesFound, c.FilesFound, c.RecentBytes, c.RecentFiles, c.Note }).ToList();
            case "space.clean":
            {
                var ids = Strings(args, "ids"); if (ids.Count == 0) throw new ArgumentException("nothing selected");
                var r = await act.CleanAsync(ids, ct); var review = ids.Any(i => Cleanup.Catalog.Any(c => c.Id == i && c.Class == CleanClass.Review));
                return new { freedBytes = r.Sum(x => x.BytesFreed), filesRemoved = r.Sum(x => x.FilesRemoved), skipped = r.Sum(x => x.Skipped), summary = LocalActions.Describe(r, review), tooNewBytes = r.Where(x => x.Id != "recent-temp").Sum(x => x.RecentBytes) };
            }

            case "startup.list": return act.StartupPrograms().Select(a => new { location = a.Item.Location, name = a.Item.Name, command = a.Item.Command, enabled = a.Item.Enabled, cls = a.Class.ToString(), reason = a.Reason }).ToList();
            case "startup.set":
            {
                var enable = args.TryGetProperty("enable", out var e) && e.ValueKind == JsonValueKind.True;
                var want = args.GetProperty("entries").EnumerateArray().Select(x => (loc: x.GetProperty("location").GetString() ?? "", name: x.GetProperty("name").GetString() ?? "")).ToList();
                var current = StartupOptimizeRecipe.Items(act.Env);
                var items = want.Select(w => current.FirstOrDefault(i => i.Location == w.loc && i.Name == w.name)).Where(i => i is not null).Select(i => i!).ToList();    // only entries that really exist are touched
                if (items.Count == 0) throw new ArgumentException("those start-up programs were not found");
                var r = await act.SetStartupAsync(items, enable, ct);
                return new { verified = r.Verified == true, r.Summary, needsAdmin = r.Summary.Contains("administrator", StringComparison.OrdinalIgnoreCase) || r.Summary.Contains("denied", StringComparison.OrdinalIgnoreCase), repairId = r.RepairId };
            }

            case "memory.now": { var m = await Task.Run(() => act.MemoryNow(), ct); return new { m.UsedPercent, m.CommitPercent, m.TotalGb, top = m.TopConsumers.Select(t => new { t.Name, t.PrivateMb, t.WorkingSetMb, t.Category }).ToList() }; }
            case "memory.trim": { var r = await act.TrimMemoryAsync(ct); return new { r.BeforePercent, r.AfterPercent, r.ReclaimedMb, r.TargetReached, trimmed = r.Trimmed.Select(t => new { t.Name, t.Mb }).ToList(), failed = (r.Failures ?? []).Count }; }

            case "history": return act.History().Select(h => new { h.Id, h.Title, h.Summary, at = h.CreatedAt }).ToList();
            case "undo": { var r = await act.UndoAsync(args.GetProperty("id").GetString() ?? "", ct); return new { r.RolledBack, r.Summary }; }

            case "recipe.run":
            {
                var recipe = args.GetProperty("recipe").GetString() ?? "";
                var r = await act.RunRecipeAsync(recipe, ct);
                return new { verified = r.Verified == true, applied = r.Applied, needed = r.Needed, r.Summary, needsAdmin = r.Summary.Contains("denied", StringComparison.OrdinalIgnoreCase) || r.Summary.Contains("administrator", StringComparison.OrdinalIgnoreCase), repairId = r.RepairId };
            }

            case "workspace.check": { var c = await (workspace ?? new WorkspaceActions()).CheckAsync(Str(args, "code"), ct); return new { organizationId = c.OrganizationId, organization = c.OrganizationName, site = c.SiteName, department = c.DepartmentName }; }
            case "workspace.connect": { var r = await (workspace ?? new WorkspaceActions()).ConnectAsync(Str(args, "code"), args.TryGetProperty("move", out var mv) && mv.ValueKind == JsonValueKind.True, ct); return new { ok = r.Ok, exit = r.Exit, message = r.Message }; }

            case "elevate": relaunchElevated?.Invoke(); return new { started = relaunchElevated is not null };
            default: throw new ArgumentException("unknown request");
        }
    }

    static bool Flag(JsonElement a, string name) => a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
    static string Str(JsonElement a, string name) => a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
    static List<string> Strings(JsonElement a, string name) => a.ValueKind == JsonValueKind.Object && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array ? [.. v.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0)] : [];

    /// <summary>One request from the interface: {id, cmd, args}. Always answers with {id, ok, data|error}; an exception becomes a plain message, never a crash.</summary>
    public async Task<string> RespondAsync(string requestJson, CancellationToken ct)
    {
        string id = "";
        try
        {
            using var d = JsonDocument.Parse(requestJson); var r = d.RootElement; id = r.TryGetProperty("id", out var i) ? i.ToString() : "";
            var cmd = r.GetProperty("cmd").GetString() ?? ""; var args = r.TryGetProperty("args", out var a) ? a.Clone() : JsonDocument.Parse("{}").RootElement;
            return JsonSerializer.Serialize(new { id, ok = true, data = await HandleAsync(cmd, args, ct) }, Web);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            return JsonSerializer.Serialize(new { id, ok = false, error = e is InvalidOperationException or ArgumentException or JsonException or KeyNotFoundException ? e.Message : "That did not work: " + e.Message }, Web);
        }
    }
}
