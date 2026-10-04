using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Management;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using Viro.Agent.Repair;

namespace Viro.Agent;

/// <summary>
/// The full anatomy of one computer: every part Windows and the firmware can name, with serial numbers, dates and measurements, read-only. Only what was actually read is reported; anything that could
/// not be read is listed under "unavailable" with the reason. Interpretation (age, risk, upgrades, costs) is done on the server, where it can be shown with its evidence.
/// </summary>
public static class Anatomy
{
    static bool Elevated() { try { using var id = System.Security.Principal.WindowsIdentity.GetCurrent(); return id.IsSystem || new System.Security.Principal.WindowsPrincipal(id).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator); } catch { return false; } }
    public const int Version = 1;

    public static Dictionary<string, object?> Collect(IProcessRunner? proc = null, CancellationToken ct = default)
    {
        var unavailable = new List<object>(); var runner = proc ?? new SystemProcessRunner(); var timings = new Dictionary<string, long>();
        T? Sec<T>(string name, Func<T> f) where T : class
        {
            ct.ThrowIfCancellationRequested(); var sw = Stopwatch.StartNew();
            try { return f(); }
            catch (OperationCanceledException) { throw; }
            catch (Exception e) { unavailable.Add(new { component = name, reason = Describe(e) }); return null; }
            finally { timings[name] = sw.ElapsedMilliseconds; if (Environment.GetEnvironmentVariable("VIRO_TRACE") == "1") Console.Error.WriteLine($"[anatomy] {name}: {sw.ElapsedMilliseconds} ms"); }
        }
        var wmiUsers = Sec("Windows users", Profiles);
        return new()
        {
            ["version"] = Version, ["collectedAt"] = DateTime.UtcNow.ToString("O"), ["collectedBy"] = Collectors.AgentVersion,
            ["system"] = Sec("System", Machine), ["bios"] = Sec("BIOS and firmware", Bios), ["board"] = Sec("Motherboard", Board), ["cpu"] = Sec("Processor", Cpu),
            ["memory"] = Sec("Memory", Memory), ["gpus"] = Sec("Graphics", Gpus), ["monitors"] = Sec("Displays", Monitors), ["network"] = Sec("Network adapters", Network),
            ["battery"] = Sec("Battery", Battery), ["drivers"] = Sec("Device drivers", Drivers), ["os"] = Sec("Windows", Os),
            ["evidence"] = Sec("Age evidence", () => Evidence(runner, unavailable, wmiUsers, ct)), ["maintenance"] = Sec("Maintenance history", () => Maintenance(runner)),
            ["diagnostics"] = Sec("Hardware diagnostics", () => HardwareDiagnostics.Run(ct)), ["unavailable"] = unavailable, ["timingsMs"] = timings,
        };
    }

    // ---------------------------------------------------------------- helpers
    static string Describe(Exception e) => e switch
    {
        ManagementException m when m.ErrorCode == ManagementStatus.AccessDenied => "access denied (needs the agent service account)",
        ManagementException m when m.ErrorCode is ManagementStatus.InvalidClass or ManagementStatus.InvalidNamespace => "not available on this system",
        ManagementException m when m.ErrorCode == ManagementStatus.NotSupported => "not supported by this hardware or driver",
        UnauthorizedAccessException => "access denied (needs the agent service account)",
        _ => $"{e.GetType().Name}: {e.Message}",
    };
    static List<ManagementBaseObject> Wmi(string ns, string wql) { using var s = new ManagementObjectSearcher(new ManagementScope($@"\\.\{ns}"), new ObjectQuery(wql)); return [.. s.Get().Cast<ManagementBaseObject>()]; }
    static List<ManagementBaseObject> Cim(string wql) => Wmi(@"root\cimv2", wql);
    static string? S(ManagementBaseObject? o, string p) { try { var v = o?[p]; var t = v is string[] a ? string.Join(", ", a) : v?.ToString(); t = t?.Trim(); return string.IsNullOrEmpty(t) || Regex.IsMatch(t, @"^(To be filled by O\.E\.M\.|Default string|None|Not Specified|System Product Name|System Manufacturer|0{4,}|N/A|Unknown|OEM)$", RegexOptions.IgnoreCase) ? null : t; } catch { return null; } }
    static double? D(ManagementBaseObject? o, string p) { try { return o?[p] is null ? null : Convert.ToDouble(o[p], CultureInfo.InvariantCulture); } catch { return null; } }
    static long? L(ManagementBaseObject? o, string p) { try { return o?[p] is null ? null : Convert.ToInt64(o[p], CultureInfo.InvariantCulture); } catch { return null; } }
    static string? Date(ManagementBaseObject? o, string p) { try { return o?[p] is string s && s.Length >= 14 ? ManagementDateTimeConverter.ToDateTime(s).ToUniversalTime().ToString("yyyy-MM-dd") : null; } catch { return null; } }
    static string? Reg(string path, string name, RegistryHive hive = RegistryHive.LocalMachine) { try { using var b = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64); using var k = b.OpenSubKey(path); return k?.GetValue(name)?.ToString(); } catch { return null; } }

    // ---------------------------------------------------------------- the machine
    static readonly Dictionary<int, string> Chassis = new() { [1] = "Other", [2] = "Unknown", [3] = "Desktop", [4] = "Low-profile desktop", [5] = "Pizza box", [6] = "Mini tower", [7] = "Tower", [8] = "Portable", [9] = "Laptop", [10] = "Notebook", [11] = "Handheld", [12] = "Docking station", [13] = "All-in-one", [14] = "Sub-notebook", [15] = "Space-saving", [16] = "Lunch box", [17] = "Main server chassis", [18] = "Expansion chassis", [19] = "Sub-chassis", [20] = "Bus expansion chassis", [21] = "Peripheral chassis", [22] = "RAID chassis", [23] = "Rack-mount", [24] = "Sealed-case PC", [30] = "Tablet", [31] = "Convertible", [32] = "Detachable", [33] = "IoT gateway", [34] = "Embedded PC", [35] = "Mini PC", [36] = "Stick PC" };

    static object Machine()
    {
        var cs = Cim("SELECT Manufacturer,Model,SystemFamily,SystemSKUNumber,SystemType,PCSystemType,TotalPhysicalMemory,NumberOfProcessors,Domain,PartOfDomain FROM Win32_ComputerSystem").FirstOrDefault();
        var prod = Cim("SELECT UUID,Version,IdentifyingNumber,Name,Vendor FROM Win32_ComputerSystemProduct").FirstOrDefault();
        var enc = Cim("SELECT ChassisTypes,SerialNumber,SMBIOSAssetTag,Manufacturer FROM Win32_SystemEnclosure").FirstOrDefault();
        var types = (enc?["ChassisTypes"] as ushort[] ?? []).Select(t => Chassis.GetValueOrDefault(t, "Type " + t)).ToList();
        return new { manufacturer = S(cs, "Manufacturer"), model = S(cs, "Model"), family = S(cs, "SystemFamily"), sku = S(cs, "SystemSKUNumber"), productName = S(prod, "Name"), version = S(prod, "Version"), serial = S(prod, "IdentifyingNumber") ?? S(enc, "SerialNumber"),
            uuid = S(prod, "UUID"), assetTag = S(enc, "SMBIOSAssetTag"), chassis = types, formFactor = FormFactor(types), systemType = S(cs, "SystemType"), joinedDomain = cs?["PartOfDomain"] as bool?, totalPhysicalMemoryBytes = L(cs, "TotalPhysicalMemory") };
    }
    static string FormFactor(List<string> t) => t.Any(x => Regex.IsMatch(x, "Laptop|Notebook|Portable|Sub-notebook|Convertible|Detachable|Tablet")) ? "laptop" : t.Any(x => x.Contains("All-in-one")) ? "all-in-one" : t.Any(x => Regex.IsMatch(x, "Desktop|tower|Mini PC|Space-saving|Sealed|Stick|Pizza|Lunch")) ? "desktop" : t.Any(x => x.Contains("server") || x.Contains("Rack")) ? "server" : "unknown";

    static object Bios()
    {
        var b = Cim("SELECT Manufacturer,SMBIOSBIOSVersion,ReleaseDate,SerialNumber,SMBIOSMajorVersion,SMBIOSMinorVersion FROM Win32_BIOS").FirstOrDefault();
        var fw = Reg(@"SYSTEM\CurrentControlSet\Control", "PEFirmwareType"); var sb = Reg(@"SYSTEM\CurrentControlSet\Control\SecureBoot\State", "UEFISecureBootEnabled");
        object? tpm = null;
        try { var t = Wmi(@"root\CIMV2\Security\MicrosoftTpm", "SELECT IsEnabled_InitialValue,IsActivated_InitialValue,SpecVersion,ManufacturerIdTxt,ManufacturerVersion FROM Win32_Tpm").FirstOrDefault(); if (t is not null) tpm = new { present = true, enabled = t["IsEnabled_InitialValue"] as bool?, version = S(t, "SpecVersion")?.Split(',')[0].Trim(), manufacturer = S(t, "ManufacturerIdTxt"), firmware = S(t, "ManufacturerVersion") }; }
        catch (ManagementException) { /* no TPM class: treated as not present below */ }
        return new { vendor = S(b, "Manufacturer"), version = S(b, "SMBIOSBIOSVersion"), releaseDate = Date(b, "ReleaseDate"), smbios = b is null ? null : $"{S(b, "SMBIOSMajorVersion")}.{S(b, "SMBIOSMinorVersion")}", mode = fw == "2" ? "UEFI" : fw == "1" ? "Legacy BIOS" : sb is not null ? "UEFI" : null,   // the Secure Boot state key exists only on UEFI firmware
             secureBoot = sb is null ? (bool?)null : sb == "1", tpm = tpm ?? (object?)(Elevated() ? new { present = false, enabled = (bool?)null, version = (string?)null, manufacturer = (string?)null, firmware = (string?)null } : null) };   // without administrator rights Windows hides the chip, so "absent" is only claimed when it could have been seen
    }

    static object Board()
    {
        var b = Cim("SELECT Manufacturer,Product,Version,SerialNumber FROM Win32_BaseBoard").FirstOrDefault();
        return new { manufacturer = S(b, "Manufacturer"), product = S(b, "Product"), version = S(b, "Version"), serial = S(b, "SerialNumber") };
    }

    static object Cpu()
    {
        var all = Cim("SELECT Name,Manufacturer,Description,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,SocketDesignation,L2CacheSize,L3CacheSize,Architecture,VirtualizationFirmwareEnabled,ProcessorId FROM Win32_Processor");
        var p = all.FirstOrDefault();
        return new { name = S(p, "Name"), manufacturer = S(p, "Manufacturer"), description = S(p, "Description"), sockets = all.Count, cores = D(p, "NumberOfCores"), logical = D(p, "NumberOfLogicalProcessors"), maxMhz = D(p, "MaxClockSpeed"), socket = S(p, "SocketDesignation"),
            l2Kb = D(p, "L2CacheSize"), l3Kb = D(p, "L3CacheSize"), architecture = D(p, "Architecture") switch { 0 => "x86", 9 => "x64", 12 => "ARM64", _ => null }, virtualization = p?["VirtualizationFirmwareEnabled"] as bool?, id = S(p, "ProcessorId") };
    }

    static readonly Dictionary<int, string> MemType = new() { [20] = "DDR", [21] = "DDR2", [24] = "DDR3", [26] = "DDR4", [34] = "DDR5", [35] = "LPDDR5", [29] = "LPDDR2", [30] = "LPDDR3", [31] = "LPDDR4" };
    static readonly Dictionary<int, string> MemForm = new() { [8] = "DIMM", [12] = "SODIMM", [13] = "SRIMM", [11] = "RIMM", [6] = "Proprietary", [9] = "RIMM", [0] = "Unknown" };
    static object Memory()
    {
        var arr = Cim("SELECT MemoryDevices,MaxCapacity,MaxCapacityEx,MemoryErrorCorrection FROM Win32_PhysicalMemoryArray");
        var slots = arr.Sum(a => (long)(D(a, "MemoryDevices") ?? 0)); long maxKb = arr.Sum(a => L(a, "MaxCapacityEx") ?? L(a, "MaxCapacity") ?? 0);
        var mods = Cim("SELECT BankLabel,DeviceLocator,Capacity,Speed,ConfiguredClockSpeed,Manufacturer,PartNumber,SerialNumber,SMBIOSMemoryType,FormFactor,DataWidth,TotalWidth,ConfiguredVoltage,MinVoltage FROM Win32_PhysicalMemory").Select(m => new
        {
            slot = S(m, "DeviceLocator") ?? S(m, "BankLabel"), bank = S(m, "BankLabel"), capacityBytes = L(m, "Capacity"), speedMhz = D(m, "Speed"), configuredMhz = D(m, "ConfiguredClockSpeed"), manufacturer = S(m, "Manufacturer"), partNumber = S(m, "PartNumber"), serial = S(m, "SerialNumber"),
            type = MemType.GetValueOrDefault((int)(D(m, "SMBIOSMemoryType") ?? 0), D(m, "SMBIOSMemoryType") is { } t and > 0 ? "type " + t : null), formFactor = MemForm.GetValueOrDefault((int)(D(m, "FormFactor") ?? 0)), ecc = D(m, "TotalWidth") is { } tw && D(m, "DataWidth") is { } dw && tw > dw, voltageMv = D(m, "ConfiguredVoltage"),
        }).ToList();
        return new { slotsTotal = slots, slotsUsed = mods.Count, maxCapacityBytes = maxKb > 0 ? maxKb * 1024 : (long?)null, ecc = arr.Any(a => (D(a, "MemoryErrorCorrection") ?? 0) is > 3), modules = mods };
    }

    static object Gpus() => Cim("SELECT Name,AdapterCompatibility,DriverVersion,DriverDate,AdapterRAM,VideoProcessor,PNPDeviceID,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate FROM Win32_VideoController")
        .Select(g => new { name = S(g, "Name"), vendor = S(g, "AdapterCompatibility"), driverVersion = S(g, "DriverVersion"), driverDate = Date(g, "DriverDate"), vramBytes = L(g, "AdapterRAM"), processor = S(g, "VideoProcessor"), pnp = S(g, "PNPDeviceID"), width = D(g, "CurrentHorizontalResolution"), height = D(g, "CurrentVerticalResolution"), hz = D(g, "CurrentRefreshRate") }).ToList();

    static string Decode(ManagementBaseObject o, string p) { try { return o[p] is ushort[] a ? new string(a.TakeWhile(c => c != 0).Select(c => (char)c).ToArray()).Trim() : ""; } catch { return ""; } }
    static object Monitors()
    {
        var sizes = Wmi("root\\wmi", "SELECT InstanceName,MaxHorizontalImageSize,MaxVerticalImageSize FROM WmiMonitorBasicDisplayParams").ToDictionary(x => S(x, "InstanceName") ?? "", x => x);
        return Wmi("root\\wmi", "SELECT InstanceName,ManufacturerName,ProductCodeID,SerialNumberID,UserFriendlyName,WeekOfManufacture,YearOfManufacture FROM WmiMonitorID").Select(m =>
        {
            var inst = S(m, "InstanceName") ?? ""; sizes.TryGetValue(inst, out var sz);
            var h = D(sz, "MaxHorizontalImageSize"); var v = D(sz, "MaxVerticalImageSize");
            double? inches = h is > 0 && v is > 0 ? Math.Round(Math.Sqrt(h.Value * h.Value + v.Value * v.Value) / 2.54, 1) : null;
            var year = D(m, "YearOfManufacture"); var week = D(m, "WeekOfManufacture");
            return new { name = Decode(m, "UserFriendlyName") is { Length: > 0 } n ? n : null, manufacturerCode = Decode(m, "ManufacturerName"), productCode = Decode(m, "ProductCodeID"), serial = Decode(m, "SerialNumberID") is { Length: > 0 } sn ? sn : null, year = year is > 1990 ? year : null, week = week is > 0 and < 54 ? week : null, sizeInches = inches, builtIn = inst.Contains("LGD") || inches is < 18 };
        }).ToList();
    }

    static object Network() => Cim("SELECT Name,MACAddress,Speed,NetConnectionID,Manufacturer,PNPDeviceID,AdapterType FROM Win32_NetworkAdapter WHERE PhysicalAdapter=TRUE")
        .Select(n => new { name = S(n, "Name"), mac = S(n, "MACAddress"), speedMbps = D(n, "Speed") is { } s and > 0 and < 1e12 ? Math.Round(s / 1e6) : (double?)null, connection = S(n, "NetConnectionID"), manufacturer = S(n, "Manufacturer"), pnp = S(n, "PNPDeviceID"), wireless = (S(n, "Name") ?? "").Contains("Wi-Fi", StringComparison.OrdinalIgnoreCase) || (S(n, "Name") ?? "").Contains("Wireless", StringComparison.OrdinalIgnoreCase) || (S(n, "NetConnectionID") ?? "").Contains("Wi-Fi", StringComparison.OrdinalIgnoreCase) }).ToList();

    static object? Battery()
    {
        if (Cim("SELECT Name FROM Win32_Battery").Count == 0) return null;
        var b = Cim("SELECT Name,DeviceID,Chemistry,DesignVoltage FROM Win32_Battery").FirstOrDefault();
        ManagementBaseObject? st = null; double? full = null, cycles = null;
        try { st = Wmi("root\\wmi", "SELECT DeviceName,ManufactureDate,ManufactureName,SerialNumber,Chemistry,DesignedCapacity FROM BatteryStaticData").FirstOrDefault(); } catch (ManagementException) { }
        try { full = D(Wmi("root\\wmi", "SELECT FullChargedCapacity FROM BatteryFullChargedCapacity").FirstOrDefault(), "FullChargedCapacity"); } catch (ManagementException) { }
        try { cycles = D(Wmi("root\\wmi", "SELECT CycleCount FROM BatteryCycleCount").FirstOrDefault(), "CycleCount"); } catch (ManagementException) { }
        var design = D(st, "DesignedCapacity"); string? mfd = null; try { if (st?["ManufactureDate"] is string md && md.Length >= 8) mfd = md.Length >= 14 ? ManagementDateTimeConverter.ToDateTime(md).ToString("yyyy-MM-dd") : null; } catch { }
        return new { name = S(st, "DeviceName") ?? S(b, "Name"), manufacturer = S(st, "ManufactureName"), serial = S(st, "SerialNumber"), chemistry = S(st, "Chemistry") ?? ((int?)D(b, "Chemistry")) switch { 1 => "Other", 3 => "Lead acid", 4 => "Nickel cadmium", 5 => "Nickel metal hydride", 6 => "Lithium-ion", 7 => "Zinc air", 8 => "Lithium polymer", _ => null }, manufactureDate = mfd, designMWh = design is > 0 ? design : null, fullChargeMWh = full is > 0 ? full : null, cycleCount = cycles is > 0 ? cycles : null,
            wearPercent = design is > 0 && full is > 0 ? Math.Round(Math.Max(0, (1 - full.Value / design.Value) * 100), 1) : (double?)null };
    }

    static object Drivers()
    {
        var classes = new[] { "NET", "MEDIA", "DISPLAY", "BLUETOOTH", "CAMERA", "IMAGE", "MONITOR", "BATTERY", "HIDCLASS", "SYSTEM", "USB", "SCSIADAPTER", "HDC", "DISKDRIVE", "PROCESSOR", "FIRMWARE" };
        var q = "SELECT DeviceName,Manufacturer,DriverVersion,DriverDate,DeviceClass,InfName,IsSigned FROM Win32_PnPSignedDriver WHERE " + string.Join(" OR ", classes.Select(c => $"DeviceClass='{c}'"));
        return Wmi(@"root\cimv2", q).Where(d => S(d, "DeviceName") is not null && S(d, "DriverVersion") is not null).Select(d => new { name = S(d, "DeviceName"), manufacturer = S(d, "Manufacturer"), version = S(d, "DriverVersion"), date = Date(d, "DriverDate"), cls = S(d, "DeviceClass"), inf = S(d, "InfName"), signed = d["IsSigned"] as bool? })
            .Where(d => !Regex.IsMatch(d.name!, @"^(Microsoft|Generic|Standard|Composite|USB Root|ACPI|Remote|Virtual|WAN|Plug and Play|UMBus|Legacy)", RegexOptions.IgnoreCase) || d.cls is "DISPLAY" or "NET" or "MEDIA" or "BLUETOOTH" or "CAMERA" or "BATTERY").Take(150).ToList();
    }

    static object Os()
    {
        var o = Cim("SELECT Caption,Version,BuildNumber,OSArchitecture,InstallDate,LastBootUpTime FROM Win32_OperatingSystem").FirstOrDefault();
        var cv = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        return new { caption = S(o, "Caption"), version = S(o, "Version"), build = S(o, "BuildNumber"), ubr = Reg(cv, "UBR"), displayVersion = Reg(cv, "DisplayVersion") ?? Reg(cv, "ReleaseId"), architecture = S(o, "OSArchitecture"), installedAt = Date(o, "InstallDate"), lastBoot = Date(o, "LastBootUpTime"), edition = Reg(cv, "EditionID") };
    }

    // ---------------------------------------------------------------- when was this computer first used, and what has been done to it
    static object Profiles()
    {
        var users = Path.Combine(Path.GetPathRoot(Environment.SystemDirectory)!, "Users"); var o = new List<object>();
        if (Directory.Exists(users)) foreach (var d in Directory.EnumerateDirectories(users)) { var n = Path.GetFileName(d); if (Regex.IsMatch(n, "^(Public|Default|All Users|Default User|defaultuser0)$", RegexOptions.IgnoreCase)) continue; try { o.Add(new { createdAt = Directory.GetCreationTimeUtc(d).ToString("yyyy-MM-dd") }); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { } }
        return o;
    }

    static object Evidence(IProcessRunner proc, List<object> unavailable, object? profiles, CancellationToken ct)
    {
        // Every earlier Windows install leaves a "Source OS (Updated on ...)" record: the oldest is the earliest evidence this computer was in use.
        var installs = new List<object>();
        try
        {
            using var b = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64); using var k = b.OpenSubKey(@"SYSTEM\Setup");
            foreach (var n in k?.GetSubKeyNames().Where(x => x.StartsWith("Source OS", StringComparison.OrdinalIgnoreCase)) ?? [])
            {
                var m = Regex.Match(n, @"Updated on (\d{1,2})/(\d{1,2})/(\d{4})"); using var s = k!.OpenSubKey(n);
                string? date = null; if (m.Success) { var a = int.Parse(m.Groups[1].Value); var c = int.Parse(m.Groups[2].Value); var y = int.Parse(m.Groups[3].Value); try { date = (a > 12 ? new DateTime(y, c, a) : new DateTime(y, a, c)).ToString("yyyy-MM-dd"); } catch (ArgumentOutOfRangeException) { } }
                var ts = s?.GetValue("InstallTime") is long ft && ft > 0 ? DateTime.FromFileTimeUtc(ft).ToString("yyyy-MM-dd") : null;
                installs.Add(new { date = ts ?? date, product = s?.GetValue("ProductName")?.ToString(), build = s?.GetValue("CurrentBuildNumber")?.ToString() });
            }
        }
        catch (Exception e) when (e is UnauthorizedAccessException or System.Security.SecurityException) { unavailable.Add(new { component = "Earlier Windows installs", reason = "access denied" }); }
        var currentInstall = Reg(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "InstallTime") is { } it && long.TryParse(it, out var ft2) ? DateTime.FromFileTimeUtc(ft2).ToString("yyyy-MM-dd") : null;
        string? setupApi = null;
        try { var f = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "INF", "setupapi.dev.log"); if (File.Exists(f)) { using var r = new StreamReader(File.Open(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)); for (var i = 0; i < 40 && r.ReadLine() is { } line; i++) { var m = Regex.Match(line, @"(\d{4})/(\d{2})/(\d{2}) \d{2}:\d{2}:\d{2}"); if (m.Success) { setupApi = $"{m.Groups[1].Value}-{m.Groups[2].Value}-{m.Groups[3].Value}"; break; } } } } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        // When Windows first saw each key part (a disk, the graphics chip, the battery, the screen): it is the first time that part was installed on this Windows.
        object? firstSeen = null;
        try
        {
            var script = "$ErrorActionPreference='SilentlyContinue'; $dev=Get-PnpDevice -PresentOnly -Class DiskDrive,Display,Monitor,Battery,Processor; $dev | Get-PnpDeviceProperty -KeyName 'DEVPKEY_Device_FirstInstallDate' | ForEach-Object { $i=$_.InstanceId; $m=$dev | Where-Object { $_.InstanceId -eq $i } | Select-Object -First 1; [pscustomobject]@{ n=$m.FriendlyName; c=$m.Class; d=if($_.Data){$_.Data.ToString('yyyy-MM-dd')}else{$null} } } | ConvertTo-Json -Compress";
            var r = proc.RunAsync("powershell.exe", $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"{script.Replace("\"", "\\\"")}\"", TimeSpan.FromSeconds(40), ct).GetAwaiter().GetResult();
            if (r.ExitCode == 0 && r.Output.Trim().Length > 0) { using var doc = JsonDocument.Parse(r.Output.Trim()); var items = doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement.EnumerateArray().ToList() : [doc.RootElement]; firstSeen = items.Select(x => new { name = x.TryGetProperty("n", out var n) ? n.GetString() : null, cls = x.TryGetProperty("c", out var c) ? c.GetString() : null, firstInstalled = x.TryGetProperty("d", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() : null }).Where(x => x.firstInstalled is not null).Take(60).ToList(); }
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or System.ComponentModel.Win32Exception) { unavailable.Add(new { component = "Device first-install dates", reason = e.Message }); }
        string? eventLogStart = null;
        try { using var r = new EventLogReader(new EventLogQuery("System", PathType.LogName)); var first = r.ReadEvent(); eventLogStart = first?.TimeCreated?.ToUniversalTime().ToString("yyyy-MM-dd"); first?.Dispose(); } catch (Exception e) when (e is UnauthorizedAccessException or EventLogException) { }
        return new { windowsInstalls = installs, currentWindowsInstall = currentInstall, profiles, setupApiLogStart = setupApi, systemLogStart = eventLogStart, deviceFirstInstalled = firstSeen };
    }

    static object Maintenance(IProcessRunner proc)
    {
        string? lastUpdate = null; try { lastUpdate = Cim("SELECT InstalledOn FROM Win32_QuickFixEngineering").Select(q => S(q, "InstalledOn")).Select(s => DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : (DateTime?)null).Where(d => d is not null).Max()?.ToString("yyyy-MM-dd"); } catch (ManagementException) { }
        string? quick = null, full = null, sigs = null;
        try { var s = Wmi(@"root\Microsoft\Windows\Defender", "SELECT QuickScanEndTime,FullScanEndTime,AntivirusSignatureLastUpdated FROM MSFT_MpComputerStatus").FirstOrDefault(); quick = Date(s, "QuickScanEndTime"); full = Date(s, "FullScanEndTime"); sigs = Date(s, "AntivirusSignatureLastUpdated"); } catch (ManagementException) { }
        string? memTest = null; string? chkdsk = null;
        try { using var r = new EventLogReader(new EventLogQuery("System", PathType.LogName, "*[System[Provider[@Name='Microsoft-Windows-MemoryDiagnostics-Results']]]") { ReverseDirection = true }); using var e = r.ReadEvent(); memTest = e?.TimeCreated?.ToUniversalTime().ToString("yyyy-MM-dd"); } catch (Exception e) when (e is UnauthorizedAccessException or EventLogException) { }
        try { using var r = new EventLogReader(new EventLogQuery("Application", PathType.LogName, "*[System[Provider[@Name='Microsoft-Windows-Wininit'] and EventID=1001]]") { ReverseDirection = true }); using var e = r.ReadEvent(); chkdsk = e?.TimeCreated?.ToUniversalTime().ToString("yyyy-MM-dd"); } catch (Exception e) when (e is UnauthorizedAccessException or EventLogException) { }
        double? stability = null;
        try { var r = Cim("SELECT SystemStabilityIndex,TimeGenerated FROM Win32_ReliabilityStabilityMetrics").OrderByDescending(x => S(x, "TimeGenerated")).Take(30).Select(x => D(x, "SystemStabilityIndex")).Where(x => x is not null).ToList(); if (r.Count > 0) stability = Math.Round(r.Average()!.Value, 1); } catch (ManagementException) { }
        return new { lastWindowsUpdateInstalled = lastUpdate, defenderQuickScan = quick, defenderFullScan = full, defenderSignaturesUpdated = sigs, lastMemoryTest = memTest, lastDiskCheck = chkdsk, reliabilityIndex30d = stability };
    }
}
