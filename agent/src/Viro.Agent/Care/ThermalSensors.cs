using System.Management;

namespace Viro.Agent.Care;

/// <summary>Temperature readings from the firmware's thermal zones. Null means "not exposed by this PC", never a made-up number.</summary>
public static class ThermalSensors
{
/// <summary>Hottest CPU-ish thermal zone in °C, from the firmware thermal-zone counters; null if the machine exposes none.</summary>
public static double? CpuTempC()
{
    // Firmware thermal-zone queries are slow on some laptops (they call into the BIOS), so the reading is shared and refreshed at most every 15 seconds,
    // however many Viro components ask for it.
    lock (Gate) { if (DateTime.UtcNow - lastRead < CacheFor) return lastTemp; lastRead = DateTime.UtcNow; return lastTemp = ReadCpuTemp(); }
}
static readonly object Gate = new(); static DateTime lastRead = DateTime.MinValue; static double? lastTemp; static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(15);

static double? ReadCpuTemp()
{
    try
    {
        using var s = new ManagementObjectSearcher("SELECT Name,Temperature,HighPrecisionTemperature FROM Win32_PerfFormattedData_Counters_ThermalZoneInformation");
        var zones = s.Get().Cast<ManagementBaseObject>().Select(z => (name: z["Name"]?.ToString() ?? "", c: ToC(z))).Where(z => z.c is > 5 and < 130).ToList();
        if (zones.Count == 0) return null;
        return zones.FirstOrDefault(z => z.name.Contains("CPU", StringComparison.OrdinalIgnoreCase)).c ?? zones.Max(z => z.c);
    }
    catch { return null; }
    static double? ToC(ManagementBaseObject z) { var hp = z["HighPrecisionTemperature"] is null ? 0 : Convert.ToDouble(z["HighPrecisionTemperature"]); var k = z["Temperature"] is null ? 0 : Convert.ToDouble(z["Temperature"]); return hp > 0 ? hp / 10.0 - 273.15 : k > 0 ? k - 273.15 : null; }
}

/// <summary>The processor thermal zone's critical trip point from the firmware (ACPI), in °C; null when the firmware does not expose one.</summary>
public static double? CriticalTripC()
{
    // Off by default: the ACPI thermal query (MSAcpi_ThermalZoneTemperature) calls into the firmware and is known to stall some laptops. Thresholds are then derived from the policy limit.
    if (Environment.GetEnvironmentVariable("VIRO_ACPI_THERMAL") != "1") return null;
    try
    {
        using var s = new ManagementObjectSearcher(new ManagementScope(@"\\.\root\WMI"), new ObjectQuery("SELECT CriticalTripPoint FROM MSAcpi_ThermalZoneTemperature"));
        var v = s.Get().Cast<ManagementBaseObject>().Select(z => z["CriticalTripPoint"] is null ? 0 : Convert.ToDouble(z["CriticalTripPoint"]) / 10.0 - 273.15).Where(c => c is > 60 and < 125).ToList();
        return v.Count == 0 ? null : v.Min();
    }
    catch { return null; }
}

}
