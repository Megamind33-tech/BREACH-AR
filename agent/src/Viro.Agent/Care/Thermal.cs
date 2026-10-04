namespace Viro.Compute;

/// <summary>
/// How hot is too hot for compute. Four levels, each with a different action:
///   Normal   run
///   Warm     run at half the CPU limit (THROTTLE)
///   Warning  stop (PAUSE)
///   Critical stop and stay stopped until the PC has clearly cooled down (BLOCK)
/// Thresholds are hardware-aware where the firmware says what the processor's critical temperature is, instead of one number for every PC.
/// The current level is remembered between readings so the worker never flaps around a threshold, and an unreadable temperature never
/// clears a hot state.
/// </summary>
public enum ThermalLevel { Normal, Warm, Warning, Critical }

public sealed record ThermalThresholds(double Throttle, double Warning, double Critical, double Recovery)
{
    public const double ReleaseMarginC = 5;     // leaving Warning or Warm needs this much margin below the threshold
}

public static class Thermal
{
    /// <param name="policyWarningC">the organization's limit (MaxTempC)</param>
    /// <param name="criticalTripC">the critical trip point the firmware reports for the processor thermal zone, if it reports one</param>
    public static ThermalThresholds Derive(int policyWarningC, double? criticalTripC)
    {
        // Stay 5 °C below the firmware's own shutdown temperature, and never let the policy limit sit within 10 °C of it.
        var critical = criticalTripC is { } c && c is > 60 and < 125 ? Math.Clamp(c - 5, 60, 105) : Math.Min(policyWarningC + 10, 100);
        var warning = Math.Min(policyWarningC, critical - 10);
        return new(Throttle: warning - 8, Warning: warning, Critical: critical, Recovery: warning - 10);
    }

    public static ThermalLevel Evaluate(double? tempC, ThermalThresholds t, ThermalLevel previous)
    {
        if (tempC is not { } x) return previous;                      // no reading is not a cool reading
        if (x >= t.Critical) return ThermalLevel.Critical;
        if (previous == ThermalLevel.Critical && x > t.Recovery) return ThermalLevel.Critical;      // blocked until the recovery temperature
        if (x >= t.Warning) return ThermalLevel.Warning;
        if (previous == ThermalLevel.Warning && x >= t.Warning - ThermalThresholds.ReleaseMarginC) return ThermalLevel.Warning;
        if (x >= t.Throttle) return ThermalLevel.Warm;
        if (previous is ThermalLevel.Warm or ThermalLevel.Warning or ThermalLevel.Critical && x >= t.Throttle - 3) return ThermalLevel.Warm;
        return ThermalLevel.Normal;
    }

    public static string Gate(ThermalLevel l) => l switch { ThermalLevel.Warm => "THROTTLE", ThermalLevel.Warning => "PAUSE", ThermalLevel.Critical => "BLOCK", _ => "ALLOW" };
}
