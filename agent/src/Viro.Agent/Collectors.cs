using System.Management;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Viro.Agent;

/// <summary>Real telemetry only. A value that cannot be read is reported as null, never invented.</summary>
public static class Collectors
{
    public static string AgentVersion => typeof(Collectors).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    public static string MachineGuid()
    {
        using var k = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64).OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
        return k?.GetValue("MachineGuid") as string ?? throw new InvalidOperationException("MachineGuid unavailable");
    }

    static List<ManagementBaseObject> Query(string wql)
    {
        using var s = new ManagementObjectSearcher(wql);
        return [.. s.Get().Cast<ManagementBaseObject>()];
    }
    /// <summary>Memory slot count and the maximum capacity the firmware reports. Both come from SMBIOS and are not always accurate; null when absent.</summary>
    static object? MemoryArray()
    {
        try
        {
            var a = Query("SELECT MemoryDevices,MaxCapacity,MaxCapacityEx,Use FROM Win32_PhysicalMemoryArray").FirstOrDefault(x => x["Use"] is ushort u && u == 3) ?? Query("SELECT MemoryDevices,MaxCapacity,MaxCapacityEx FROM Win32_PhysicalMemoryArray").FirstOrDefault();
            if (a is null) return null;
            long? slots = a["MemoryDevices"] is ushort d ? d : null;
            long? maxKb = a["MaxCapacityEx"] is ulong ex && ex > 0 ? (long)ex : a["MaxCapacity"] is uint m && m > 0 && m != 0x80000000 ? m : null;   // both in KB
            return new { slots, maxCapacityBytes = maxKb is { } kb ? kb * 1024 : (long?)null, source = "SMBIOS (firmware-reported)" };
        }
        catch { return null; }
    }

    /// <summary>Physical disks with their bus type (NVMe, SATA...) from the Windows Storage subsystem.</summary>
    static object? StorageBus()
    {
        try
        {
            using var s = new ManagementObjectSearcher(@"root\Microsoft\Windows\Storage", "SELECT FriendlyName,MediaType,BusType,Size FROM MSFT_PhysicalDisk");
            return s.Get().Cast<ManagementBaseObject>().Select(d => new { name = Str(d, "FriendlyName"), busType = d["BusType"] is ushort b ? (int?)b : null, mediaType = d["MediaType"] is ushort m ? (int?)m : null, sizeBytes = d["Size"] is ulong z ? (long?)z : null }).ToList();
        }
        catch { return null; }
    }

    /// <summary>A WMI CIM_DATETIME as an ISO-8601 UTC string, or null when absent or unparseable.</summary>
    static string? CimDate(ManagementBaseObject? o, string p) { try { return o?[p] is string v && v.Length >= 14 ? ManagementDateTimeConverter.ToDateTime(v).ToUniversalTime().ToString("O") : null; } catch { return null; } }
    static string? Str(ManagementBaseObject? o, string p) => o?[p]?.ToString()?.Trim() is { Length: > 0 } v ? v : null;

    public static string? LocalIPv4() => NetworkInterface.GetAllNetworkInterfaces()
        .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
        .SelectMany(n => n.GetIPProperties().UnicastAddresses)
        .FirstOrDefault(a => a.Address.AddressFamily == AddressFamily.InterNetwork)?.Address.ToString();

    public sealed record OsInfo(string? Caption, string? Build, long? UptimeSeconds);
    public static OsInfo Os()
    {
        var o = Query("SELECT Caption,BuildNumber,LastBootUpTime FROM Win32_OperatingSystem").FirstOrDefault();
        if (o is null) return new(null, null, null);
        long? up = o["LastBootUpTime"] is string t ? (long)(DateTime.Now - ManagementDateTimeConverter.ToDateTime(t)).TotalSeconds : null;
        return new(Str(o, "Caption"), Str(o, "BuildNumber"), up);
    }

    /// <summary>What this PC is made of, in a few facts and without the slow full hardware inventory: for the line under the title in the PC-side window.</summary>
    public sealed record SystemSummary(string? Cpu, int? Cores, double? RamGb, string? Os, long? UptimeSeconds, string? Manufacturer, string? Model);
    public static SystemSummary Summary()
    {
        var cpu = Query("SELECT Name,NumberOfCores FROM Win32_Processor").FirstOrDefault();
        var cs = Query("SELECT Manufacturer,Model,TotalPhysicalMemory FROM Win32_ComputerSystem").FirstOrDefault();
        var os = Os();
        return new(Str(cpu, "Name"), cpu?["NumberOfCores"] is uint n ? (int)n : null, cs?["TotalPhysicalMemory"] is ulong r ? Math.Round(r / 1073741824.0, 1) : null,
                   os.Caption?.Replace("Microsoft ", ""), os.UptimeSeconds, Str(cs, "Manufacturer"), Str(cs, "Model"));
    }

    public static string? LoggedInUser() => Str(Query("SELECT UserName FROM Win32_ComputerSystem").FirstOrDefault(), "UserName");

    public static Dictionary<string, object?> Hardware()
    {
        var cpu = Query("SELECT Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed FROM Win32_Processor").FirstOrDefault();
        var cs = Query("SELECT Manufacturer,Model,TotalPhysicalMemory FROM Win32_ComputerSystem").FirstOrDefault();
        var bios = Query("SELECT SerialNumber,SMBIOSBIOSVersion,ReleaseDate FROM Win32_BIOS").FirstOrDefault();
        var os = Query("SELECT Caption,Version,BuildNumber,OSArchitecture,InstallDate FROM Win32_OperatingSystem").FirstOrDefault();
        var board = Query("SELECT Manufacturer,Product,SerialNumber FROM Win32_BaseBoard").FirstOrDefault();
        return new()
        {
            ["cpu"] = Str(cpu, "Name"),
            ["cpuCores"] = cpu?["NumberOfCores"],
            ["cpuLogicalProcessors"] = cpu?["NumberOfLogicalProcessors"],
            ["cpuMaxMhz"] = cpu?["MaxClockSpeed"],
            ["manufacturer"] = Str(cs, "Manufacturer"),
            ["model"] = Str(cs, "Model"),
            ["ramBytes"] = cs?["TotalPhysicalMemory"] is ulong r ? (long)r : null,
            ["serialNumber"] = Str(bios, "SerialNumber"),
            ["biosVersion"] = Str(bios, "SMBIOSBIOSVersion"),
            ["biosDate"] = CimDate(bios, "ReleaseDate"),
            ["osInstalledAt"] = CimDate(os, "InstallDate"),
            ["baseBoard"] = board is null ? null : new { manufacturer = Str(board, "Manufacturer"), product = Str(board, "Product"), serial = Str(board, "SerialNumber") },
            ["memoryArray"] = MemoryArray(),
            ["storageBus"] = StorageBus(),
            ["memoryModules"] = Query("SELECT Manufacturer,PartNumber,SerialNumber,Capacity,Speed,ConfiguredClockSpeed,SMBIOSMemoryType,FormFactor,DeviceLocator FROM Win32_PhysicalMemory")
                .Select(r => new { manufacturer = Str(r, "Manufacturer"), partNumber = Str(r, "PartNumber"), serial = Str(r, "SerialNumber"), capacityBytes = r["Capacity"] is ulong c ? (long?)c : null,
                                   speedMhz = r["ConfiguredClockSpeed"] is uint cs2 && cs2 > 0 ? (long?)cs2 : r["Speed"] is uint sp ? (long?)sp : null, memoryType = r["SMBIOSMemoryType"] is uint mt ? (long?)mt : null,
                                   formFactor = r["FormFactor"] is ushort ff ? (long?)ff : null, slot = Str(r, "DeviceLocator") }).ToList(),
            ["os"] = os is null ? null : new { caption = Str(os, "Caption"), version = Str(os, "Version"), build = Str(os, "BuildNumber"), architecture = Str(os, "OSArchitecture") },
            ["gpus"] = Query("SELECT Name,DriverVersion FROM Win32_VideoController")
                .Select(g => new { name = Str(g, "Name"), driverVersion = Str(g, "DriverVersion") }).ToList(),
            ["disks"] = Query("SELECT Model,Size,MediaType,InterfaceType,SerialNumber FROM Win32_DiskDrive")
                .Select(d => new { model = Str(d, "Model"), serial = Str(d, "SerialNumber"), sizeBytes = d["Size"] is ulong s ? (long?)s : null, mediaType = Str(d, "MediaType"), interfaceType = Str(d, "InterfaceType") }).ToList(),
            ["volumes"] = DriveInfo.GetDrives().Where(d => d.DriveType == DriveType.Fixed && d.IsReady)
                .Select(d => new { name = d.Name, totalBytes = d.TotalSize, freeBytes = d.AvailableFreeSpace, format = d.DriveFormat }).ToList(),
        };
    }

    /// <summary>One program from the Installed apps list. Key/Hive/Kind say how it can be removed; SizeBytes is what it registered or what its folder measures.</summary>
    public sealed record SoftwareItem(string Name, string? Version, string? Publisher, string? InstallDate, long? SizeBytes = null, string? Key = null, string? Hive = null, string? Kind = null, bool Hidden = false);
    public static List<SoftwareItem> Software()
    {
        var found = new Dictionary<string, Viro.Agent.Care.AppEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in Viro.Agent.Care.RegistryAppCatalog.All()) found.TryAdd(e.Name + "|" + e.Version, e);
        var sized = Viro.Agent.Care.AppSizer.Fill([.. found.Values], TimeSpan.FromSeconds(20), default);
        return [.. sized.OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase).Select(e => new SoftwareItem(e.Name, e.Version, e.Publisher, e.InstalledOn, e.SizeBytes, e.Key, e.Hive, e.Kind, e.Hidden))];
    }

    // ---- live metrics -------------------------------------------------------
    static ulong _lastIdle, _lastBusy;
    static bool _primed;

    /// <summary>System-wide CPU utilisation since the previous call; null on the priming call.</summary>
    public static double? CpuPercent()
    {
        if (!Native.GetSystemTimes(out var idle, out var kernel, out var user)) return null;
        var i = idle.Value; var b = kernel.Value + user.Value - i; // kernel time includes idle time
        var di = i - _lastIdle; var db = b - _lastBusy;
        var wasPrimed = _primed;
        _lastIdle = i; _lastBusy = b; _primed = true;
        if (!wasPrimed || di + db == 0) return null;
        return Math.Round(100.0 * db / (di + db), 1);
    }

    public static Dictionary<string, object?> Metrics()
    {
        var m = new Native.MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<Native.MEMORYSTATUSEX>() };
        double? ram = Native.GlobalMemoryStatusEx(ref m) ? m.dwMemoryLoad : null;
        var sys = new DriveInfo(Path.GetPathRoot(Environment.SystemDirectory)!);
        bool? onBattery = Native.GetSystemPowerStatus(out var p) && p.ACLineStatus != 255 ? p.ACLineStatus == 0 : null;
        return new()
        {
            ["cpuPercent"] = CpuPercent(),
            ["ramPercent"] = ram,
            ["systemDiskFreeBytes"] = sys.IsReady ? sys.AvailableFreeSpace : null,
            ["systemDiskTotalBytes"] = sys.IsReady ? sys.TotalSize : null,
            ["onBattery"] = onBattery,
            // GetLastInputInfo is session-scoped, so the Session-0 service cannot see user input.
            // Reported as null until the per-user helper (Phase 4) supplies it.
            ["userIdleSeconds"] = null,
        };
    }
}
