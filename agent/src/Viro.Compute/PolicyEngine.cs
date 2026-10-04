using System.Text.Json;
using System.Text.RegularExpressions;

namespace Viro.Compute;

public sealed record TimeWindow(int[] Days, string Start, string End);

/// <summary>
/// Compute sponsorship policy as issued (signed) by Control. Every value is re-validated and clamped here, so a malformed or hostile
/// policy can never make the worker use more than the hard limits below.
/// </summary>
public sealed record ComputePolicy(
    bool Enabled, int Version, int MaxCpuPercent, int StartAfterIdleMinutes, TimeWindow[]? Windows, bool AllowOnBattery, int MaxTempC, int MaxMemoryPercent,
    bool PauseOnFullscreen, int UtcOffsetMinutes, string Fallback, string? WorkerId, DateTime? ValidUntil, EngineSpec? Engine = null, PoolSpec? Pool = null)
{
    public const int HardMaxCpu = 90, HardMinCpu = 5;
    public static readonly ComputePolicy Disabled = new(false, 0, 5, 10, null, false, 70, 15, true, 0, "none", null, null);

    static readonly Regex Hhmm = new(@"^([01]\d|2[0-3]):[0-5]\d$");

    static readonly Regex Sha = new("^[0-9a-fA-F]{64}$");
    static readonly Regex Ver = new(@"^[A-Za-z0-9._-]{1,40}$");

    /// <summary>The engine build Control has published for this organization. Anything malformed is treated as "no engine".</summary>
    static EngineSpec? ParseEngine(JsonElement r)
    {
        if (!r.TryGetProperty("engine", out var e) || e.ValueKind != JsonValueKind.Object) return null;
        var v = e.TryGetProperty("version", out var vv) ? vv.GetString() : null; var h = e.TryGetProperty("sha256", out var hh) ? hh.GetString() : null;
        if (v is null || h is null || !Ver.IsMatch(v) || !Sha.IsMatch(h) || !e.TryGetProperty("size", out var sz) || sz.ValueKind != JsonValueKind.Number) return null;
        var size = sz.GetInt64(); return size is > 1024 and < 200_000_000 ? new(v, h.ToLowerInvariant(), size) : null;
    }

    /// <summary>The first configured pool endpoint plus the public payout address; both must pass the strict patterns or there is no pool.</summary>
    static PoolSpec? ParsePool(JsonElement r)
    {
        if (!r.TryGetProperty("pool", out var p) || p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("endpoints", out var eps) || eps.ValueKind != JsonValueKind.Array || eps.GetArrayLength() == 0) return null;
        var ep = eps[0]; var addr = p.TryGetProperty("payoutAddress", out var a) ? a.GetString() : null;
        if (addr is null || !ep.TryGetProperty("host", out var h) || !ep.TryGetProperty("port", out var pt) || pt.ValueKind != JsonValueKind.Number) return null;
        var spec = new PoolSpec(h.GetString() ?? "", pt.GetInt32(), !ep.TryGetProperty("tls", out var t) || t.ValueKind != JsonValueKind.False, addr);
        return MinerArgs.ValidPool(spec) ? spec : null;
    }

    public static ComputePolicy Parse(string json)
    {
        using var d = JsonDocument.Parse(json); var r = d.RootElement;
        int I(string n, int def, int lo, int hi) => r.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Number ? Math.Clamp(v.GetInt32(), lo, hi) : def;
        bool B(string n, bool def) => r.TryGetProperty(n, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : def;
        TimeWindow[]? wins = null;
        if (r.TryGetProperty("windows", out var w) && w.ValueKind == JsonValueKind.Array)
            wins = [.. w.EnumerateArray().Select(x => new TimeWindow([.. x.GetProperty("days").EnumerateArray().Select(y => y.GetInt32()).Where(y => y is >= 0 and <= 6)], x.GetProperty("start").GetString() ?? "", x.GetProperty("end").GetString() ?? ""))
                .Where(x => x.Days.Length > 0 && Hhmm.IsMatch(x.Start) && Hhmm.IsMatch(x.End))];
        var fb = r.TryGetProperty("fallback", out var f) ? f.GetString() : "none";
        DateTime? until = r.TryGetProperty("validUntil", out var vu) && vu.ValueKind == JsonValueKind.String && DateTime.TryParse(vu.GetString(), null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var t) ? t : null;
        return new(B("enabled", false), I("version", 0, 0, int.MaxValue), I("maxCpuPercent", 30, HardMinCpu, HardMaxCpu), I("startAfterIdleMinutes", 10, 1, 240), wins, B("allowOnBattery", false),
            I("maxTempC", 70, 40, 95), I("maxMemoryPercent", 15, 5, 50), B("pauseOnFullscreen", true), I("utcOffsetMinutes", 0, -720, 840), fb is "selftest" or "xmrig" ? fb : "none",
            r.TryGetProperty("workerId", out var wid) ? wid.GetString() : null, until, ParseEngine(r), ParsePool(r));
    }
}

/// <summary>What the worker knows about the machine right now. Null means "could not be determined", which never counts as permission to run.</summary>
public sealed record Signals(double? IdleSeconds, bool? OnBattery, double? CpuTempC, double MemoryUsedPercent, string? BusyReason, bool MaintenanceProcessRunning, bool Fullscreen, bool WorkAvailable, double? CriticalTripC = null, int? BatteryPercent = null);

public sealed record Decision(bool Run, string State, string Reason, int CpuCapPercent, ThermalLevel Thermal = ThermalLevel.Normal);

/// <summary>The Health Engine's instruction for this PC: ALLOW, THROTTLE, PAUSE or BLOCK. The machine's health always wins over compute.</summary>
public sealed record HealthGate(string State, string Reason);

/// <summary>
/// The priority rule of the platform: the person at the PC, then security, health and maintenance come first. Compute is the lowest
/// priority and must yield instantly. Every stop condition from the product brief is enforced here, in one pure function.
/// </summary>
public static class PolicyEngine
{
    public const double UserActiveSeconds = 3;           // while running: any input in the last 3 s stops compute
    public const double MemoryPressurePercent = 90;      // stop when the whole PC is this short of RAM...
    public const double MemoryRecoveryPercent = 80;      // ...and only start again once it has recovered to here (no flapping at the threshold)
    public const int MinBatteryPercentWhenAllowed = 50;    // even where an organization allows compute on battery, it stops below half charge
    public const double TempHysteresisC = 5;             // restart only once the PC has cooled this far below the limit

    public static Decision Decide(ComputePolicy p, Signals s, bool running, DateTime nowUtc, DateTime? policyFetchedUtc = null, HealthGate? gate = null, ThermalLevel previousThermal = ThermalLevel.Normal)
    {
        var thr = Thermal.Derive(p.MaxTempC, s.CriticalTripC);
        var heat = Thermal.Evaluate(s.CpuTempC, thr, previousThermal);
        Decision No(string state, string reason) => new(false, state, reason, p.MaxCpuPercent, heat);
        if (!p.Enabled) return No("disabled", "compute sponsorship is not enabled for this PC");
        if (p.ValidUntil is { } vu && nowUtc > vu) return No("disabled", "the last policy from Control has expired (no fresh policy received)");
        if (gate?.State == "BLOCK") return No("health-blocked", gate.Reason);
        if (gate?.State == "PAUSE") return No("health-paused", gate.Reason);
        // Heat comes before everything else that is about the person or the schedule: hardware safety outranks politeness.
        if (heat == ThermalLevel.Critical) return No("thermal-blocked", $"CPU temperature reached {s.CpuTempC:0}°C (critical {thr.Critical:0}°C); compute stays off until it cools below {thr.Recovery:0}°C");
        if (heat == ThermalLevel.Warning) return No("hot", $"CPU temperature is {s.CpuTempC:0}°C (limit {thr.Warning:0}°C)");
        if (s.BusyReason is { } busy) return No("busy", $"higher-priority work is running: {busy}");
        if (s.MaintenanceProcessRunning) return No("busy", "Windows maintenance or a security scan is running");

        // user activity: unknown idle time never permits running (fail safe)
        if (s.IdleSeconds is not { } idle) return No("idle-unknown", "user activity cannot be observed (no session probe)");
        if (running ? idle < UserActiveSeconds : idle < p.StartAfterIdleMinutes * 60) return No("user-active", running ? "the user became active" : $"waiting for {p.StartAfterIdleMinutes} minutes of inactivity");

        if (!p.AllowOnBattery && s.OnBattery == true) return No("on-battery", "the PC is running on battery");
        if (s.OnBattery == true && s.BatteryPercent is { } bp && bp < MinBatteryPercentWhenAllowed) return No("battery-low", $"the battery is at {bp}% (compute stops below {MinBatteryPercentWhenAllowed}% even when allowed on battery)");
        if (s.MemoryUsedPercent >= (running ? MemoryPressurePercent : MemoryRecoveryPercent)) return No("low-memory", $"the PC is short of memory ({s.MemoryUsedPercent:0}% in use)");
        if (p.PauseOnFullscreen && s.Fullscreen) return No("fullscreen", "a full-screen application or presentation is active");
        if (p.Windows is { Length: > 0 } && !InAnyWindow(nowUtc, p.UtcOffsetMinutes, p.Windows)) return No("outside-window", "outside the allowed schedule");
        if (!s.WorkAvailable) return No("no-work", "no compute workload is configured for this PC");
        if (heat == ThermalLevel.Warm) return new(true, "running", $"idle and within policy; reduced because the CPU is warm ({s.CpuTempC:0}°C)", Math.Max(ComputePolicy.HardMinCpu, p.MaxCpuPercent / 2), heat);
        if (gate?.State == "THROTTLE") return new(true, "running", "idle and within policy; reduced because " + gate.Reason.TrimEnd('.').ToLowerInvariant(), Math.Max(ComputePolicy.HardMinCpu, p.MaxCpuPercent / 2), heat);
        return new(true, "running", s.CpuTempC is null ? "idle and within policy (CPU temperature is not readable on this PC)" : "idle and within policy", p.MaxCpuPercent, heat);
    }

    public static bool InAnyWindow(DateTime nowUtc, int offsetMinutes, TimeWindow[] windows)
    {
        var t = nowUtc.AddMinutes(offsetMinutes); var day = (int)t.DayOfWeek; var m = t.Hour * 60 + t.Minute;
        static int Min(string hhmm) => int.Parse(hhmm[..2]) * 60 + int.Parse(hhmm[3..]);
        foreach (var w in windows)
        {
            int s = Min(w.Start), e = Min(w.End);
            if (s == e) { if (w.Days.Contains(day)) return true; }
            else if (s < e) { if (w.Days.Contains(day) && m >= s && m < e) return true; }
            else if ((w.Days.Contains(day) && m >= s) || (w.Days.Contains((day + 6) % 7) && m < e)) return true;   // wraps past midnight
        }
        return false;
    }
}
