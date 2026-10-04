using System.Management;
using System.Text.Json;
using System.Text.Json.Nodes;
using Viro.Agent;

namespace WorkCare.QuickCheck;

/// <summary>
/// Read-only inspection of this PC. Stages complete when the work behind them completes: progress is the share of stages actually finished, never an invented percentage.
/// Hardware facts come from the same read-only collector the WorkCare agent uses (HardwareDiagnostics, linked, not copied); findings come only from the shared rules.
/// Nothing is installed or changed, nothing is written outside this run's own temporary folder, and unreadable inputs are reported as not measured.
/// </summary>
public sealed class InspectionRunner(RulesEvaluator rules)
{
    public static readonly (string Id, string Label)[] StageList = [("identity", "Computer"), ("processor", "Processor"), ("memory", "Memory"), ("storage", "Storage"), ("battery", "Battery"), ("cooling", "Cooling"), ("security", "Security"), ("windows", "Windows")];
    public const string Disclaimer = "A quick check shows the state of this device now. It does not prove long-term reliability.";
    public event Action<JsonObject>? Progress;

    sealed class State { public string Id = ""; public string Label = ""; public string St = "waiting"; public string? Detail; }

    public static readonly (string Id, string Label)[] DeepStageList = [("encryption", "Encryption and boot"), ("updates", "Windows updates"), ("defender", "Protection freshness"), ("settings", "Settings and network"), ("reliability", "Last 30 days")];

    /// <param name="deep">True when the phone asked for the deep audit (WorkCare Plus). The free scan never runs those checks and never claims anything about them.</param>
    public async Task<JsonObject> RunAsync(string scanId, CancellationToken ct, bool deep = false)
    {
        var stages = StageList.Concat(deep ? DeepStageList : []).Select(s => new State { Id = s.Id, Label = s.Label }).ToList();
        var unavailable = new List<string>();
        var inv = new JsonObject { ["schemaVersion"] = 1 };
        string deviceName = Environment.MachineName; string? model = null;
        void Emit(bool finished = false)
        {
            JsonArray arr;
            lock (stages) { arr = new JsonArray(); foreach (var s in stages) { var o = new JsonObject { ["id"] = s.Id, ["label"] = s.Label, ["state"] = s.St }; if (s.Detail is not null) o["detail"] = s.Detail; arr.Add(o); } }
            Progress?.Invoke(Envelope("quickcheck", new JsonObject { ["scanId"] = scanId, ["stages"] = arr, ["completedStages"] = stages.Count(s => s.St is "done" or "failed" or "skipped"), ["totalStages"] = stages.Count, ["finished"] = finished, ["device"] = new JsonObject { ["name"] = deviceName, ["model"] = model } }));
        }
        async Task Stage(string id, Func<Task> work)
        {
            var s = stages.First(x => x.Id == id); s.St = "running"; Emit();
            try { await work(); s.St = "done"; } catch (OperationCanceledException) { throw; }
            catch (Exception e) { s.St = "failed"; s.Detail = Short(e); unavailable.Add($"{s.Label}: {s.Detail}"); }
            Emit();
        }

        Emit();
        // The slow hardware collection (drive SMART, battery report) starts immediately and its stages finish when it does.
        var diagTask = Task.Run(() => JsonSerializer.SerializeToNode(HardwareDiagnostics.Run(ct)), ct);

        await Stage("identity", () => Task.Run(() => { var id = Identity(); inv["identity"] = id; deviceName = id["hostname"]?.GetValue<string>() ?? deviceName; model = JoinMaker(id["manufacturer"]?.GetValue<string>(), id["model"]?.GetValue<string>()); }, ct));
        JsonNode? diag = null;
        await Stage("processor", () => Task.Run(() => { inv["cpu"] = CpuInfo(); }, ct));
        await Stage("memory", () => Task.Run(async () => { diag = await diagTask; inv["memory"] = Memory(diag); }, ct));
        await Stage("storage", () => Task.Run(async () => { diag ??= await diagTask; inv["storage"] = Storage(diag); foreach (var u in Unavailable(diag, "Storage", "NVMe")) unavailable.Add(u); }, ct));
        await Stage("battery", () => Task.Run(async () => { diag ??= await diagTask; if (Battery(diag) is JsonObject b) inv["battery"] = b; foreach (var u in Unavailable(diag, "Battery")) unavailable.Add(u); }, ct));
        await Stage("cooling", async () => { await Cooling(inv, diag, ct); });
        await Stage("security", () => Task.Run(() => { inv["security"] = Security(); }, ct));
        await Stage("windows", () => Task.Run(() => { inv["windows"] = Windows(); }, ct));

        if (deep)
        {
            string? cur = null;
            void Mark(string id, string st) { lock (stages) stages.First(x => x.Id == id).St = st; Emit(); }
            void Next(string name) { if (cur is not null) Mark(cur, "done"); cur = name; Mark(name, "running"); }
            try { inv["deep"] = await Task.Run(() => DeepInspection.Run(ct, Next), ct); if (cur is not null) Mark(cur, "done"); }
            catch (OperationCanceledException) { throw; }
            catch (Exception e) { foreach (var d in DeepStageList) { try { Mark(d.Id, "failed"); } catch { } } unavailable.Add("Deep audit: " + Short(e)); }
        }
        var ev = rules.Evaluate(inv, includeDeep: deep);
        var findings = new JsonArray(); foreach (var f in ev.Findings) findings.Add(f);
        int passed = ev.Findings.Count(f => f["severity"]!.GetValue<string>() == "healthy"), attention = ev.Findings.Count(f => f["severity"]!.GetValue<string>() == "attention"), critical = ev.Findings.Count(f => f["severity"]!.GetValue<string>() == "critical");
        var notMeasured = new JsonArray(); foreach (var u in unavailable.Distinct().Take(20)) notMeasured.Add(u);
        foreach (var skippedRule in ev.Skipped.Select(RuleLabel).Distinct().Take(30)) if (!unavailable.Any(u => u.StartsWith(skippedRule))) notMeasured.Add(skippedRule.Contains(':') ? skippedRule : $"{skippedRule}: not reported by this PC");
        Emit(true);
        var factList = Facts(inv, diag);
        var result = Envelope("quickcheck", new JsonObject { ["facts"] = factList, ["scanId"] = scanId, ["device"] = new JsonObject { ["name"] = deviceName, ["model"] = model }, ["passed"] = passed, ["attention"] = attention, ["critical"] = critical, ["findings"] = findings, ["notMeasured"] = notMeasured, ["disclaimer"] = Disclaimer, ["depth"] = deep ? "deep" : "essential" });
        if (!deep) { var nr = new JsonArray(); foreach (var c in DeepInspection.Catalogue) nr.Add(new JsonObject { ["id"] = c.Id, ["title"] = c.Title, ["why"] = c.Why }); result["deepNotRun"] = nr; }
        Result = result; Inventory = inv;
        return result;
    }
    /// <summary>"HP ProBook 430 G7", not "HP HP ProBook 430 G7": many models already start with the maker.</summary>
    static string? JoinMaker(string? maker, string? model) { maker = maker?.Trim() ?? ""; model = model?.Trim() ?? ""; var t = model.StartsWith(maker, StringComparison.OrdinalIgnoreCase) ? model : (maker + " " + model).Trim(); return t.Length == 0 ? null : t; }
    /// <summary>Plain facts for the report. Everything here was read from the machine; nothing is estimated.</summary>
    static JsonArray Facts(JsonObject inv, JsonNode? diag)
    {
        var a = new JsonArray();
        void Add(string group, string label, string? value, string ev = "measured") { if (!string.IsNullOrWhiteSpace(value)) a.Add(new JsonObject { ["group"] = group, ["label"] = label, ["value"] = value, ["evidenceType"] = ev }); }
        var id = inv["identity"]; var cpu = inv["cpu"]; var mem = inv["memory"]; var win = inv["windows"];
        Add("Age", "BIOS release date", id?["biosDate"]?.GetValue<string>()); Add("Age", "Windows installed", id?["osInstalled"]?.GetValue<string>());
        if (inv["storage"] is JsonArray st) foreach (var d in st) { var poh = d?["powerOnHours"]?.GetValue<double?>(); var m = d?["model"]?.GetValue<string>(); if (poh is > 0 && d?["sizeBytes"] is not null && d?["freeBytes"] is null) Add("Age", "Drive powered on", $"{poh:N0} hours (about {poh / 8760.0:0.0} years of running time)"); }
        Add("Hardware", "Model", ((id?["manufacturer"]?.GetValue<string>() ?? "") + " " + (id?["model"]?.GetValue<string>() ?? "")).Trim()); Add("Hardware", "Processor", cpu?["name"]?.GetValue<string>()); if (cpu?["cores"]?.GetValue<double?>() is { } c) Add("Hardware", "Cores", c.ToString("0"));
        if (cpu?["maxClockMhz"]?.GetValue<double?>() is { } mhz) Add("Hardware", "Processor speed", $"{mhz / 1000:0.0} GHz"); Add("Hardware", "Graphics", cpu?["gpu"]?.GetValue<string>());
        if (mem?["totalBytes"]?.GetValue<double?>() is { } tb) Add("Hardware", "Memory", $"{tb / 1073741824:0.#} GB" + (mem?["type"]?.GetValue<string>() is { } t ? " " + t : "") + (mem?["speedMhz"]?.GetValue<double?>() is { } sp ? " " + sp.ToString("0") + " MHz" : "") + (mem?["slotsTotal"]?.GetValue<double?>() is { } sl ? $" ({mem?["slotsUsed"]?.GetValue<double?>()?.ToString("0") ?? "?"} of {sl:0} slots used)" : ""));
        if (inv["storage"] is JsonArray s2) foreach (var d in s2) if (d?["freeBytes"] is null && d?["sizeBytes"]?.GetValue<double?>() is { } sz) Add("Hardware", "Drive", $"{d?["model"]?.GetValue<string>()} · {sz / 1e9:0} GB" + (d?["mediaType"]?.GetValue<string>() is { } mt ? " " + mt : ""));
        if (inv["battery"] is JsonObject b && b["designWh"]?.GetValue<double?>() is { } dw) { Add("Hardware", "Battery design capacity", $"{dw:0.#} Wh"); if (b["fullChargeWh"]?.GetValue<double?>() is { } fw) Add("Hardware", "Battery holds now", $"{fw:0.#} Wh"); if (b["cycleCount"]?.GetValue<double?>() is { } cy) Add("Hardware", "Battery charge cycles", cy.ToString("0")); }
        Add("System", "Windows", win?["caption"]?.GetValue<string>()); Add("System", "Windows build", win?["build"]?.GetValue<string>());
        return a;
    }
    public JsonObject? Result { get; private set; }
    public JsonObject? Inventory { get; private set; }

    static readonly Dictionary<string, string> DeepLabels = new()
    {
        ["deep.bitlocker"] = "Drive encryption: needs administrator rights to read (run QuickCheck as administrator)", ["deep.tpm"] = "Security chip (TPM): needs administrator rights to read", ["deep.secure_boot"] = "Secure Boot: not reported by this PC",
        ["deep.update_age"] = "Windows update history: not readable on this PC", ["deep.os_support"] = "Windows support status: this edition or build is not in the support table, so nothing is claimed", ["deep.defender_signatures"] = "Defender freshness: not reported by this PC",
        ["deep.defender_scan"] = "Defender last scan: not reported by this PC", ["deep.smb1"] = "SMBv1 setting: not set on this PC, so nothing is claimed", ["deep.rdp"] = "Remote Desktop setting: not readable", ["deep.guest"] = "Guest account: not readable",
        ["deep.bluescreens"] = "Crash history: the event log was not readable", ["deep.disk_errors"] = "Disk error history: the event log was not readable", ["deep.unexpected_shutdowns"] = "Shutdown history: the event log was not readable", ["deep.app_crashes"] = "Program crash history: the event log was not readable",
        ["deep.wifi_security"] = "Wi-Fi security: not connected to Wi-Fi, or Windows is not in English so it cannot be read safely", ["deep.startup"] = "Start-up programs: not readable", ["deep.pending_reboot"] = "Pending restart: not readable", ["deep.uac"] = "User Account Control: not readable", ["deep.autologon"] = "Automatic sign-in: not readable",
    };
    static string RuleLabel(string id) => DeepLabels.TryGetValue(id, out var d) ? d : id switch { "cpu.throttling" => "Processor throttling", "security.defender" => "Antivirus", "security.firewall" => "Firewall", _ => id.Split('.')[0] switch { "battery" => "Battery capacity", "storage" => "Storage", "cpu" => "Processor temperature", "memory" => "Memory", "security" => "Security", _ => id } };
    static string Short(Exception e) => e.Message.Length > 120 ? e.Message[..117] + "..." : e.Message;
    public static JsonObject Envelope(string source, JsonObject body) { body["schemaVersion"] = 1; body["deviceId"] = Environment.MachineName; body["timestamp"] = DateTime.UtcNow.ToString("O"); body["source"] = source; return body; }

    static IEnumerable<string> Unavailable(JsonNode? diag, params string[] mentions) =>
        (diag?["unavailable"] as JsonArray ?? []).Select(u => (c: u?["component"]?.GetValue<string>() ?? "", r: u?["reason"]?.GetValue<string>() ?? "")).Where(x => mentions.Any(m => x.c.Contains(m, StringComparison.OrdinalIgnoreCase))).Select(x => $"{x.c}: {x.r}");

    // ------------------------------------------------------------------------------------------ collectors
    static List<ManagementBaseObject> Wmi(string ns, string wql) { using var s = new ManagementObjectSearcher(new ManagementScope($@"\\.\{ns}"), new ObjectQuery(wql)); return [.. s.Get().Cast<ManagementBaseObject>()]; }
    static string? Str(ManagementBaseObject? o, string p) { try { return o?[p]?.ToString()?.Trim() is { Length: > 0 } v ? v : null; } catch { return null; } }
    static double? Dbl(ManagementBaseObject? o, string p) { try { return o?[p] is null ? null : Convert.ToDouble(o[p]); } catch { return null; } }

    static JsonObject Identity()
    {
        var cs = Wmi("root/cimv2", "SELECT Name,Manufacturer,Model FROM Win32_ComputerSystem").FirstOrDefault(); var bios = Wmi("root/cimv2", "SELECT SMBIOSBIOSVersion,SerialNumber FROM Win32_BIOS").FirstOrDefault(); var bb = Wmi("root/cimv2", "SELECT Product FROM Win32_BaseBoard").FirstOrDefault();
        var o = new JsonObject { ["hostname"] = Str(cs, "Name") ?? Environment.MachineName, ["manufacturer"] = Str(cs, "Manufacturer"), ["model"] = Str(cs, "Model"), ["biosVersion"] = Str(bios, "SMBIOSBIOSVersion"), ["boardModel"] = Str(bb, "Product"), ["biosDate"] = WmiDate(Wmi("root/cimv2", "SELECT ReleaseDate FROM Win32_BIOS").FirstOrDefault(), "ReleaseDate"), ["osInstalled"] = WmiDate(Wmi("root/cimv2", "SELECT InstallDate FROM Win32_OperatingSystem").FirstOrDefault(), "InstallDate") };
        var serial = Str(bios, "SerialNumber"); if (serial is not null && !serial.Contains("O.E.M", StringComparison.OrdinalIgnoreCase) && !serial.Equals("Default string", StringComparison.OrdinalIgnoreCase)) o["serial"] = serial;
        return o;
    }
    static string? WmiDate(ManagementBaseObject? o, string p) { try { return o?[p] is string s && s.Length >= 8 ? ManagementDateTimeConverter.ToDateTime(s).ToString("yyyy-MM-dd") : null; } catch { return null; } }
    static JsonObject CpuInfo() { var p = Wmi("root/cimv2", "SELECT Name,NumberOfCores,MaxClockSpeed FROM Win32_Processor").FirstOrDefault(); string? gpu = null; try { gpu = Str(Wmi("root/cimv2", "SELECT Name FROM Win32_VideoController").FirstOrDefault(), "Name"); } catch { } return new JsonObject { ["name"] = Str(p, "Name"), ["cores"] = (int?)Dbl(p, "NumberOfCores"), ["maxClockMhz"] = Dbl(p, "MaxClockSpeed"), ["gpu"] = gpu }; }
    static JsonObject Memory(JsonNode? diag)
    {
        var mods = diag?["memory"]?["modules"] as JsonArray ?? []; double total = mods.Sum(m => m?["capacityBytes"]?.GetValue<double?>() ?? 0);
        var arr = Wmi("root/cimv2", "SELECT MemoryDevices FROM Win32_PhysicalMemoryArray").FirstOrDefault();
        var o = new JsonObject { ["slotsUsed"] = mods.Count > 0 ? mods.Count : null, ["slotsTotal"] = (int?)Dbl(arr, "MemoryDevices") };
        if (total > 0) o["totalBytes"] = total; else if (Wmi("root/cimv2", "SELECT TotalPhysicalMemory FROM Win32_ComputerSystem").FirstOrDefault() is { } cs && Dbl(cs, "TotalPhysicalMemory") is { } t) o["totalBytes"] = t;
        if (mods.Count > 0) { o["speedMhz"] = mods[0]?["speedMhz"]?.GetValue<double?>(); var type = Wmi("root/cimv2", "SELECT SMBIOSMemoryType FROM Win32_PhysicalMemory").FirstOrDefault(); o["type"] = (int?)Dbl(type, "SMBIOSMemoryType") switch { 26 => "DDR4", 34 => "DDR5", 24 => "DDR3", 20 => "DDR", 21 => "DDR2", _ => null }; }
        return o;
    }
    static JsonArray Storage(JsonNode? diag)
    {
        var list = new JsonArray();
        foreach (var d in diag?["storage"]?["disks"] as JsonArray ?? [])
        {
            var nv = d?["nvme"]; var e = new JsonObject { ["model"] = d?["model"]?.GetValue<string>(), ["sizeBytes"] = d?["sizeBytes"]?.GetValue<double?>(), ["mediaType"] = d?["mediaType"]?.GetValue<string>(), ["health"] = d?["health"]?.GetValue<string>(), ["powerOnHours"] = d?["nvme"]?["powerOnHours"]?.GetValue<double?>() ?? d?["reliability"]?["powerOnHours"]?.GetValue<double?>() };
            if (nv is JsonObject n) e["nvme"] = new JsonObject { ["percentageUsed"] = n["percentageUsed"]?.GetValue<double?>(), ["availableSparePercent"] = n["availableSparePercent"]?.GetValue<double?>(), ["criticalWarning"] = n["criticalWarning"]?.GetValue<double?>(), ["mediaErrors"] = n["mediaErrors"]?.GetValue<double?>(), ["unsafeShutdowns"] = n["unsafeShutdowns"]?.GetValue<double?>(), ["temperatureC"] = n["temperatureC"]?.GetValue<double?>() };
            list.Add(e);
        }
        var sys = Path.GetPathRoot(Environment.SystemDirectory);
        foreach (var v in DriveInfo.GetDrives().Where(x => x.DriveType == DriveType.Fixed && x.IsReady)) list.Add(new JsonObject { ["model"] = v.Name.TrimEnd('\\'), ["sizeBytes"] = (double)v.TotalSize, ["freeBytes"] = (double)v.AvailableFreeSpace, ["isSystem"] = string.Equals(v.Name, sys, StringComparison.OrdinalIgnoreCase) });
        return list;
    }
    static JsonObject? Battery(JsonNode? diag)
    {
        var b = diag?["battery"]; if (b is null) return null;       // a desktop has no battery: nothing to report
        var design = b["designCapacityMWh"]?.GetValue<double?>(); var full = b["fullChargeCapacityMWh"]?.GetValue<double?>(); var o = new JsonObject();
        if (design is > 0) o["designWh"] = Math.Round(design.Value / 1000.0, 2); if (full is > 0) o["fullChargeWh"] = Math.Round(full.Value / 1000.0, 2); if (b["cycleCount"]?.GetValue<double?>() is { } c) o["cycleCount"] = c;
        return o;
    }
    /// <summary>Samples the firmware thermal zones for a few seconds; the highest reading is the "peak". Throttling is only inferred when firmware throttle events AND a hot reading both exist.</summary>
    static async Task Cooling(JsonObject inv, JsonNode? diag, CancellationToken ct)
    {
        double? peak = null; var loads = new List<double>();
        void Take(double? c) { if (c is > 0) peak = Math.Max(peak ?? 0, c.Value); }
        foreach (var z in diag?["thermal"]?["zones"] as JsonArray ?? []) Take(z?["tempC"]?.GetValue<double?>());
        for (var i = 0; i < 3; i++)
        {
            ct.ThrowIfCancellationRequested(); await Task.Delay(1000, ct);
            try { foreach (var z in Wmi("root/cimv2", "SELECT HighPrecisionTemperature,Temperature FROM Win32_PerfFormattedData_Counters_ThermalZoneInformation")) { var t = Dbl(z, "HighPrecisionTemperature") is > 0 and var tk ? tk / 10.0 - 273.15 : Dbl(z, "Temperature") is > 0 and var k ? k - 273.15 : (double?)null; if (t is > 5 and < 130) Take(Math.Round(t.Value, 1)); } } catch { }
            try { if (Dbl(Wmi("root/cimv2", "SELECT PercentProcessorTime FROM Win32_PerfFormattedData_PerfOS_Processor WHERE Name='_Total'").FirstOrDefault(), "PercentProcessorTime") is { } l) loads.Add(l); } catch { }
        }
        var cpu = inv["cpu"] as JsonObject ?? new JsonObject(); inv["cpu"] = cpu;
        if (peak is not null) cpu["peakTempC"] = peak; if (loads.Count > 0) cpu["usagePercent"] = Math.Round(loads.Average(), 0);
        var events = diag?["cpu"]?["thermalThrottleEvents7d"]?.GetValue<double?>();
        if (events is > 0 && peak is >= 85) cpu["throttled"] = true;          // firmware limited the speed AND it was hot: a cooling problem is plausible
        else if (events == 0 && peak is not null) cpu["throttled"] = false;
        if (peak is null) throw new InvalidOperationException("this PC exposes no thermal sensor to Windows");
    }
    static JsonObject Security()
    {
        bool? rtp = null; bool? other = null; bool? fw = null; var o = new JsonObject();
        try { var s = Wmi(@"root/Microsoft/Windows/Defender", "SELECT RealTimeProtectionEnabled,AMServiceEnabled FROM MSFT_MpComputerStatus").FirstOrDefault(); if (s is not null) rtp = Convert.ToBoolean(s["RealTimeProtectionEnabled"] ?? false) && Convert.ToBoolean(s["AMServiceEnabled"] ?? false); } catch { }
        try { other = Wmi("root/SecurityCenter2", "SELECT displayName,productState FROM AntiVirusProduct").Any(p => !(Str(p, "displayName") ?? "").Contains("Defender", StringComparison.OrdinalIgnoreCase) && (Convert.ToInt32(p["productState"] ?? 0) & 0x1000) != 0); } catch { }
        try { var profiles = Wmi("root/StandardCimv2", "SELECT Enabled FROM MSFT_NetFirewallProfile"); if (profiles.Count > 0) fw = profiles.All(p => Convert.ToInt32(p["Enabled"] ?? 0) == 1); } catch { }
        // Defender being off is only a problem if nothing else protects the PC; if another product is active, the question is not answerable from here.
        if (rtp == true) o["defenderEnabled"] = true; else if (rtp == false && other != true) o["defenderEnabled"] = false;
        if (fw is not null) o["firewallEnabled"] = fw;
        return o;
    }
    static JsonObject Windows() { var os = Wmi("root/cimv2", "SELECT Caption,BuildNumber FROM Win32_OperatingSystem").FirstOrDefault(); return new JsonObject { ["caption"] = Str(os, "Caption"), ["build"] = Str(os, "BuildNumber") }; }
}

static class StringExt { public static string? NullIfEmpty(this string s) => s.Length == 0 ? null : s; }
