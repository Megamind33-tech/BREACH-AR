using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Management;
using System.Runtime.InteropServices;
using System.Xml.Linq;
using Microsoft.Win32.SafeHandles;

namespace Viro.Agent;

/// <summary>
/// Deep, read-only hardware diagnostics. Reports only what was actually read from the machine; anything that could not
/// be read is listed under "unavailable" with the reason (permission, unsupported hardware, driver) rather than guessed.
/// Interpretation (severity, thresholds) is done server-side.
/// </summary>
public static class HardwareDiagnostics
{
    public static Dictionary<string, object?> Run(CancellationToken ct = default)
    {
        var unavailable = new List<object>();
        T? Section<T>(string name, Func<T> f) where T : class
        {
            ct.ThrowIfCancellationRequested();
            try { return f(); }
            catch (OperationCanceledException) { throw; }
            catch (Exception e) { unavailable.Add(new { component = name, reason = Describe(e) }); return null; }
        }

        var storage = Section("Storage", () => Storage(unavailable, ct));
        return new()
        {
            ["collectedAt"] = DateTime.UtcNow.ToString("O"),
            ["storage"] = storage,
            ["memory"] = Section("Memory", Memory),
            ["cpu"] = Section("CPU", Cpu),
            ["thermal"] = Section("Thermal zones", () => Thermal(unavailable)),
            ["battery"] = Section("Battery", () => Battery(unavailable)),
            ["whea"] = Section("WHEA hardware error log", Whea),
            ["unavailable"] = unavailable,
        };
    }

    static string Describe(Exception e) => e switch
    {
        ManagementException m when m.ErrorCode == ManagementStatus.AccessDenied => "access denied (needs the agent service account, not a standard user)",
        ManagementException m when m.ErrorCode == ManagementStatus.NotSupported => "not supported by this hardware/driver",
        ManagementException m when m.ErrorCode == ManagementStatus.InvalidClass || m.ErrorCode == ManagementStatus.InvalidNamespace => "not available on this system",
        UnauthorizedAccessException => "access denied (needs the agent service account, not a standard user)",
        EventLogNotFoundException => "event log not found",
        _ => $"{e.GetType().Name}: {e.Message}",
    };

    static List<ManagementBaseObject> Wmi(string ns, string wql)
    {
        using var s = new ManagementObjectSearcher(new ManagementScope($@"\\.\{ns}"), new ObjectQuery(wql));
        return [.. s.Get().Cast<ManagementBaseObject>()];
    }
    static string? Str(ManagementBaseObject? o, string p) => o?[p]?.ToString()?.Trim() is { Length: > 0 } v ? v : null;
    static double? Dbl(ManagementBaseObject? o, string p) { try { return o?[p] is null ? null : Convert.ToDouble(o[p]); } catch { return null; } }

    // ---------------------------------------------------------------- storage
    static object Storage(List<object> unavailable, CancellationToken ct)
    {
        const string ns = @"root\Microsoft\Windows\Storage";
        var rel = new Dictionary<string, ManagementBaseObject>();
        try { foreach (var r in Wmi(ns, "SELECT DeviceId,Temperature,Wear,ReadErrorsUncorrected,WriteErrorsUncorrected,PowerOnHours FROM MSFT_StorageReliabilityCounter")) if (Str(r, "DeviceId") is { } id) rel[id] = r; }
        catch (Exception e) { unavailable.Add(new { component = "Storage reliability counters", reason = Describe(e) }); }

        var disks = new List<object>();
        foreach (var p in Wmi(ns, "SELECT DeviceId,FriendlyName,SerialNumber,BusType,MediaType,HealthStatus,OperationalStatus,Size FROM MSFT_PhysicalDisk"))
        {
            ct.ThrowIfCancellationRequested();
            var id = Str(p, "DeviceId");
            var bus = Convert.ToInt32(p["BusType"] ?? 0);
            rel.TryGetValue(id ?? "", out var r);
            object? nvme = null; string? nvmeError = null;
            if (bus == 17 && int.TryParse(id, out var idx)) (nvme, nvmeError) = NvmeSmart.Read(idx);
            disks.Add(new
            {
                index = int.TryParse(id, out var i2) ? i2 : (int?)null,
                model = Str(p, "FriendlyName"),
                busType = bus switch { 17 => "NVMe", 11 => "SATA", 3 => "ATA", 7 => "USB", 8 => "RAID", 10 => "SAS", 1 => "SCSI", _ => $"other({bus})" },
                mediaType = Convert.ToInt32(p["MediaType"] ?? 0) switch { 3 => "HDD", 4 => "SSD", 5 => "SCM", _ => "Unspecified" },
                health = Convert.ToInt32(p["HealthStatus"] ?? 5) switch { 0 => "Healthy", 1 => "Warning", 2 => "Unhealthy", _ => (string?)null },
                sizeBytes = Dbl(p, "Size"),
                reliability = r is null ? null : new
                {
                    temperatureC = Dbl(r, "Temperature") is > 0 and var t ? t : (double?)null,
                    wearPercent = Dbl(r, "Wear"),
                    readErrorsUncorrected = Dbl(r, "ReadErrorsUncorrected"),
                    writeErrorsUncorrected = Dbl(r, "WriteErrorsUncorrected"),
                    powerOnHours = Dbl(r, "PowerOnHours"),
                },
                nvme,
                nvmeError,
            });
        }
        return new { disks, ataSmart = AtaSmart(unavailable), ioErrors = IoErrors(unavailable) };
    }

    /// <summary>SATA/ATA SMART through the storage driver's WMI failure-prediction classes (present on drives that expose SMART).</summary>
    static List<object> AtaSmart(List<object> unavailable)
    {
        var result = new List<object>();
        try
        {
            var status = Wmi(@"root\wmi", "SELECT InstanceName,PredictFailure FROM MSStorageDriver_FailurePredictStatus");
            var data = Wmi(@"root\wmi", "SELECT InstanceName,VendorSpecific FROM MSStorageDriver_FailurePredictData").ToDictionary(x => Str(x, "InstanceName") ?? "", x => x["VendorSpecific"] as byte[]);
            foreach (var s in status)
            {
                var inst = Str(s, "InstanceName") ?? "";
                var attrs = new List<object>();
                if (data.TryGetValue(inst, out var vs) && vs is { Length: >= 362 })
                    for (var k = 0; k < 30; k++)
                    {
                        var o = 2 + k * 12; var id = vs[o];
                        if (id == 0) continue;
                        long raw = 0; for (var b = 5; b >= 0; b--) raw = (raw << 8) | vs[o + 5 + b];
                        attrs.Add(new { id = (int)id, value = (int)vs[o + 3], worst = (int)vs[o + 4], raw });
                    }
                result.Add(new { instance = inst, predictFailure = s["PredictFailure"] as bool?, attributes = attrs });
            }
        }
        catch (Exception e) { unavailable.Add(new { component = "ATA SMART", reason = Describe(e) }); }
        return result;
    }

    static object IoErrors(List<object> unavailable)
    {
        var disk = new SortedDictionary<string, int>();
        var ntfs = 0;
        try
        {
            const string q = "*[System[((Provider[@Name='disk'] and (EventID=7 or EventID=11 or EventID=15 or EventID=51 or EventID=52 or EventID=153)) or ((Provider[@Name='Ntfs'] or Provider[@Name='Microsoft-Windows-Ntfs']) and EventID=55)) and TimeCreated[timediff(@SystemTime) <= 2592000000]]]";
            using var r = new EventLogReader(new EventLogQuery("System", PathType.LogName, q));
            for (var e = r.ReadEvent(); e != null; e = r.ReadEvent())
                using (e)
                {
                    if (string.Equals(e.ProviderName, "disk", StringComparison.OrdinalIgnoreCase)) disk[e.Id.ToString()] = disk.GetValueOrDefault(e.Id.ToString()) + 1;
                    else ntfs++;
                }
        }
        catch (Exception e) { unavailable.Add(new { component = "Disk I/O error events", reason = Describe(e) }); }
        return new { days = 30, disk, ntfsCorruption = ntfs };
    }

    // ---------------------------------------------------------------- memory
    static object Memory()
    {
        var modules = Wmi(@"root\cimv2", "SELECT BankLabel,DeviceLocator,Capacity,Speed,ConfiguredClockSpeed,Manufacturer,PartNumber,SMBIOSMemoryType FROM Win32_PhysicalMemory")
            .Select(m => new { slot = Str(m, "DeviceLocator") ?? Str(m, "BankLabel"), capacityBytes = Dbl(m, "Capacity"), speedMhz = Dbl(m, "Speed"), configuredMhz = Dbl(m, "ConfiguredClockSpeed"), manufacturer = Str(m, "Manufacturer"), partNumber = Str(m, "PartNumber") }).ToList();

        // Windows Memory Diagnostic outcomes exist only if the user/IT ran the test; we interpret the message text, not the id.
        var results = new List<object>();
        try
        {
            using var r = new EventLogReader(new EventLogQuery("System", PathType.LogName, "*[System[Provider[@Name='Microsoft-Windows-MemoryDiagnostics-Results']]]") { ReverseDirection = true });
            for (var e = r.ReadEvent(); e != null && results.Count < 3; e = r.ReadEvent())
                using (e)
                {
                    string? msg = null; try { msg = e.FormatDescription(); } catch { /* message DLL missing */ }
                    bool? passed = msg is null ? null : msg.Contains("no errors", StringComparison.OrdinalIgnoreCase) ? true : msg.Contains("error", StringComparison.OrdinalIgnoreCase) ? false : (bool?)null;
                    results.Add(new { at = e.TimeCreated?.ToUniversalTime().ToString("O"), passed });
                }
        }
        catch { /* log/provider absent: the test was never run */ }
        return new { modules, diagnosticResults = results };
    }

    // ---------------------------------------------------------------- cpu / thermal
    static object Cpu()
    {
        var p = Wmi(@"root\cimv2", "SELECT Name,NumberOfCores,NumberOfLogicalProcessors,CurrentClockSpeed,MaxClockSpeed FROM Win32_Processor").FirstOrDefault();
        int? throttle = null;
        try
        {
            using var r = new EventLogReader(new EventLogQuery("System", PathType.LogName, "*[System[Provider[@Name='Microsoft-Windows-Kernel-Processor-Power'] and EventID=37 and TimeCreated[timediff(@SystemTime) <= 604800000]]]"));
            var n = 0; for (var e = r.ReadEvent(); e != null; e = r.ReadEvent()) { using (e) n++; }
            throttle = n;
        }
        catch { /* leave null: not measured */ }
        return new { name = Str(p, "Name"), cores = Dbl(p, "NumberOfCores"), logical = Dbl(p, "NumberOfLogicalProcessors"), currentMhz = Dbl(p, "CurrentClockSpeed"), maxMhz = Dbl(p, "MaxClockSpeed"), thermalThrottleEvents7d = throttle };
    }

    static object Thermal(List<object> unavailable)
    {
        var zones = new List<object>();
        try
        {
            foreach (var z in Wmi(@"root\cimv2", "SELECT Name,Temperature,HighPrecisionTemperature FROM Win32_PerfFormattedData_Counters_ThermalZoneInformation"))
            {
                var tenthsK = Dbl(z, "HighPrecisionTemperature"); var k = Dbl(z, "Temperature");
                double? c = tenthsK is > 0 ? tenthsK / 10.0 - 273.15 : k is > 0 ? k - 273.15 : null;
                if (c is > 5 and < 130) zones.Add(new { name = Str(z, "Name"), tempC = Math.Round(c.Value, 1) }); // ~0°C readings are "no sensor", skipped
            }
        }
        catch (Exception e) { unavailable.Add(new { component = "Thermal zone counters", reason = Describe(e) }); }
        if (zones.Count == 0)
        {
            try
            {
                foreach (var z in Wmi(@"root\wmi", "SELECT InstanceName,CurrentTemperature FROM MSAcpi_ThermalZoneTemperature"))
                    if (Dbl(z, "CurrentTemperature") is { } t && t / 10.0 - 273.15 is > 5 and < 130 and var c) zones.Add(new { name = Str(z, "InstanceName"), tempC = Math.Round(c, 1) });
            }
            catch (Exception e) { unavailable.Add(new { component = "ACPI thermal zones", reason = Describe(e) }); }
        }
        return new { zones, note = "Point-in-time readings from firmware thermal zones; zone names are vendor-defined." };
    }

    // ---------------------------------------------------------------- battery
    static object? Battery(List<object> unavailable)
    {
        if (Wmi(@"root\cimv2", "SELECT Name FROM Win32_Battery").Count == 0) return null; // desktop: no battery, nothing to report

        double? full = null, design = null, cycles = null; string source = "wmi";
        try { full = Dbl(Wmi(@"root\wmi", "SELECT FullChargedCapacity FROM BatteryFullChargedCapacity").FirstOrDefault(), "FullChargedCapacity"); } catch { }
        try { design = Dbl(Wmi(@"root\wmi", "SELECT DesignedCapacity FROM BatteryStaticData").FirstOrDefault(), "DesignedCapacity"); } catch { }
        try { cycles = Dbl(Wmi(@"root\wmi", "SELECT CycleCount FROM BatteryCycleCount").FirstOrDefault(), "CycleCount"); } catch { }
        if (design is null or 0 || full is null or 0)
        {
            // Documented fallback: Windows' own battery report (powercfg) carries design and full-charge capacity.
            var rep = PowercfgBatteryReport();
            if (rep is not null) { design ??= rep.Value.design; full ??= rep.Value.full; cycles ??= rep.Value.cycles; source = "powercfg"; }
            else unavailable.Add(new { component = "Battery design capacity", reason = "neither WMI nor powercfg exposed the design capacity" });
        }
        return new { designCapacityMWh = design is > 0 ? design : null, fullChargeCapacityMWh = full is > 0 ? full : null, cycleCount = cycles is > 0 ? cycles : null, source };
    }

    static (double? design, double? full, double? cycles)? PowercfgBatteryReport()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"viro-battery-{Guid.NewGuid():N}.xml");
        try
        {
            var psi = new ProcessStartInfo("powercfg.exe", $"/batteryreport /xml /output \"{tmp}\"") { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            using var p = Process.Start(psi)!;
            if (!p.WaitForExit(30_000)) { try { p.Kill(); } catch { } return null; }
            if (!File.Exists(tmp)) return null;
            var doc = XDocument.Load(tmp);
            double? Get(string n) => doc.Descendants().Where(x => x.Name.LocalName == n).Select(x => double.TryParse(x.Value, out var v) ? v : (double?)null).FirstOrDefault(v => v is > 0);
            return (Get("DesignCapacity"), Get("FullChargeCapacity"), Get("CycleCount"));
        }
        catch { return null; }
        finally { try { File.Delete(tmp); } catch { } }
    }

    // ---------------------------------------------------------------- WHEA
    static object Whea()
    {
        var byId = new SortedDictionary<string, int>(); var samples = new List<object>(); var total = 0;
        using var r = new EventLogReader(new EventLogQuery("System", PathType.LogName, "*[System[Provider[@Name='Microsoft-Windows-WHEA-Logger'] and TimeCreated[timediff(@SystemTime) <= 2592000000]]]") { ReverseDirection = true });
        for (var e = r.ReadEvent(); e != null; e = r.ReadEvent())
            using (e)
            {
                total++; byId[e.Id.ToString()] = byId.GetValueOrDefault(e.Id.ToString()) + 1;
                if (samples.Count < 5) { string? m = null; try { m = e.FormatDescription()?.Split('\n')[0].Trim(); } catch { } samples.Add(new { id = e.Id, at = e.TimeCreated?.ToUniversalTime().ToString("O"), message = m ?? $"WHEA event {e.Id}" }); }
            }
        return new { events30d = total, byId, samples };
    }
}

/// <summary>Reads the NVMe SMART / Health Information log page (log id 0x02) straight from the drive via IOCTL_STORAGE_QUERY_PROPERTY.</summary>
static class NvmeSmart
{
    const uint IOCTL_STORAGE_QUERY_PROPERTY = 0x002D1400;
    const int StorageDeviceProtocolSpecificProperty = 50, PropertyStandardQuery = 0;
    const int ProtocolTypeNvme = 3, NVMeDataTypeLogPage = 2, NVME_LOG_PAGE_HEALTH_INFO = 2;
    const int SpsdSize = 40, QueryHeader = 8, LogSize = 512;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle h, uint code, byte[] inBuf, int inSize, byte[] outBuf, int outSize, out int returned, IntPtr overlapped);

    public static (object? data, string? error) Read(int driveIndex)
    {
        var path = $@"\\.\PhysicalDrive{driveIndex}";
        var buf = new byte[QueryHeader + SpsdSize + LogSize];
        BitConverter.GetBytes(StorageDeviceProtocolSpecificProperty).CopyTo(buf, 0);
        BitConverter.GetBytes(PropertyStandardQuery).CopyTo(buf, 4);
        var o = QueryHeader;
        BitConverter.GetBytes(ProtocolTypeNvme).CopyTo(buf, o);
        BitConverter.GetBytes(NVMeDataTypeLogPage).CopyTo(buf, o + 4);
        BitConverter.GetBytes(NVME_LOG_PAGE_HEALTH_INFO).CopyTo(buf, o + 8);   // ProtocolDataRequestValue
        BitConverter.GetBytes(0).CopyTo(buf, o + 12);                          // ProtocolDataRequestSubValue
        BitConverter.GetBytes(SpsdSize).CopyTo(buf, o + 16);                   // ProtocolDataOffset
        BitConverter.GetBytes(LogSize).CopyTo(buf, o + 20);                    // ProtocolDataLength

        int lastError = 0; int returned = 0; var ok = false;
        // Query access first (works without elevation on some systems), then read/write (what most tools need; requires admin/SYSTEM).
        foreach (var access in new uint[] { 0, 0xC0000000 })
        {
            using var h = CreateFile(path, access, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (h.IsInvalid) { lastError = Marshal.GetLastWin32Error(); continue; }
            var work = (byte[])buf.Clone();
            ok = DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, work, work.Length, work, work.Length, out returned, IntPtr.Zero);
            if (ok) { buf = work; break; }
            lastError = Marshal.GetLastWin32Error();
        }
        if (!ok) return (null, lastError == 5 ? "access denied (NVMe SMART needs the agent service running as SYSTEM/administrator)" : $"NVMe health log query failed (Win32 error {lastError})");

        var dataOffset = QueryHeader + BitConverter.ToInt32(buf, QueryHeader + 16);
        var dataLen = BitConverter.ToInt32(buf, QueryHeader + 20);
        if (dataLen < 200 || dataOffset + LogSize > buf.Length) return (null, "drive returned a short/invalid NVMe health log");
        var d = buf.AsSpan(dataOffset, LogSize).ToArray();
        ulong U64(int off) => BitConverter.ToUInt64(d, off); // low 64 bits of the 128-bit counters
        var tempK = BitConverter.ToUInt16(d, 1);
        return (new
        {
            criticalWarning = (int)d[0],
            temperatureC = tempK > 0 ? tempK - 273 : (int?)null,
            availableSparePercent = (int)d[3],
            availableSpareThresholdPercent = (int)d[4],
            percentageUsed = (int)d[5],
            dataUnitsReadBytes = U64(32) * 512000UL,
            dataUnitsWrittenBytes = U64(48) * 512000UL,
            powerCycles = U64(112),
            powerOnHours = U64(128),
            unsafeShutdowns = U64(144),
            mediaErrors = U64(160),
            errorLogEntries = U64(176),
        }, null);
    }
}
