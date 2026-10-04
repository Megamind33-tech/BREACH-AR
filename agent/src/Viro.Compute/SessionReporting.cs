using System.Text.Json;

namespace Viro.Compute;

/// <summary>What XMRig's local API summary says about the pool connection. Every field is null when the engine did not report it.</summary>
public sealed record MinerSummary(double? Hashrate, long? Accepted, long? Rejected, double? PoolUptimeSeconds)
{
    public bool? PoolConnected => PoolUptimeSeconds is null ? null : PoolUptimeSeconds > 0;

    /// <summary>Parses the body of <c>/2/summary</c>. Anything malformed or negative reads as "not reported", never as a guess.</summary>
    public static MinerSummary Parse(string json)
    {
        try
        {
            using var d = JsonDocument.Parse(json);
            var r = d.RootElement;
            double? rate = null;
            if (r.TryGetProperty("hashrate", out var h) && h.TryGetProperty("total", out var t) && t.ValueKind == JsonValueKind.Array && t.GetArrayLength() > 0
                && t[0].ValueKind == JsonValueKind.Number && t[0].GetDouble() >= 0) rate = Math.Round(t[0].GetDouble(), 1);
            long? acc = null, rej = null; double? up = null;
            if (r.TryGetProperty("connection", out var c) && c.ValueKind == JsonValueKind.Object)
            {
                acc = Count(c, "accepted"); rej = Count(c, "rejected");
                if (c.TryGetProperty("uptime", out var u) && u.ValueKind == JsonValueKind.Number && u.GetDouble() >= 0) up = u.GetDouble();
            }
            return new(rate, acc, rej, up);
        }
        catch { return new(null, null, null, null); }
    }

    static long? Count(JsonElement o, string name) => o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) && n >= 0 ? n : null;
}

/// <summary>Everything the worker knows at one moment that is worth a telemetry sample (all optional: the server accepts null for each).</summary>
public sealed record SessionSample(double? CpuUsagePercent, double? CpuTempC, double? MemoryPercent);

/// <summary>
/// Follows one run of the mining engine from start to stop: runtime, average and peak hash rate, cumulative accepted and rejected shares.
/// The report it produces is what Control records as a session; a new GUID per run makes retries idempotent. Pure logic with an injected clock.
/// </summary>
public sealed class SessionTracker
{
    public bool Active { get; private set; }
    public Guid SessionId { get; private set; }
    DateTime _start; string? _engine, _worker;
    double _rateSum; int _rateN; double _peak; double? _lastRate;
    long _accepted, _rejected, _lastAcc, _lastRej; DateTime? _lastShare;
    bool _poolSeen; bool? _connected;

    public void Start(DateTime nowUtc, string? engineVersion, string? workerVersion)
    {
        Active = true; SessionId = Guid.NewGuid(); _start = nowUtc; _engine = engineVersion; _worker = workerVersion;
        _rateSum = 0; _rateN = 0; _peak = 0; _lastRate = null; _accepted = _rejected = _lastAcc = _lastRej = 0; _lastShare = null; _poolSeen = false; _connected = null;
    }

    /// <summary>Takes one reading. Share counters from the engine restart at zero whenever it reconnects, so a drop is treated as a restart and the session total keeps counting.</summary>
    public void Observe(DateTime nowUtc, MinerSummary s)
    {
        if (!Active) return;
        if (s.Hashrate is { } h) { _rateSum += h; _rateN++; _peak = Math.Max(_peak, h); _lastRate = h; }
        if (s.Accepted is { } a) { var d = a >= _lastAcc ? a - _lastAcc : a; if (d > 0) { _accepted += d; _lastShare = nowUtc; } _lastAcc = a; }
        if (s.Rejected is { } r) { _rejected += r >= _lastRej ? r - _lastRej : r; _lastRej = r; }
        if (s.PoolConnected is { } c) { _connected = c; _poolSeen = true; }
    }

    public long Accepted => _accepted;
    public long Rejected => _rejected;
    public double? AverageHashrate => _rateN == 0 ? null : Math.Round(_rateSum / _rateN, 1);
    public double? PeakHashrate => _rateN == 0 ? null : Math.Round(_peak, 1);

    /// <summary>The wire shape of POST agent/v1/compute/session. Absent values are sent as explicit nulls.</summary>
    public object Report(DateTime nowUtc, SessionSample? sample, DateTime? stoppedUtc = null, string? stopReason = null) => new
    {
        sessionId = SessionId, startedAt = _start.ToString("O"), stoppedAt = stoppedUtc?.ToString("O"),
        runtimeSeconds = Math.Round(Math.Max(0, ((stoppedUtc ?? nowUtc) - _start).TotalSeconds), 1),
        averageHashrate = AverageHashrate, peakHashrate = PeakHashrate, acceptedShares = _accepted, rejectedShares = _rejected,
        stopReason = stoppedUtc is null ? null : (string.IsNullOrWhiteSpace(stopReason) ? "stopped" : Trim(stopReason)),
        engineVersion = _engine, workerVersion = _worker,
        sample = sample is null ? null : new
        {
            hashrate = _lastRate, cpuUsagePercent = sample.CpuUsagePercent, cpuTempC = sample.CpuTempC, memoryPercent = sample.MemoryPercent,
            poolConnected = _poolSeen ? _connected : null, lastShareAt = _lastShare?.ToString("O"),
        },
    };

    /// <summary>Ends the run and returns its final report. The tracker is idle afterwards.</summary>
    public object Stop(DateTime nowUtc, string? reason)
    {
        var rep = Report(nowUtc, null, nowUtc, reason);
        Active = false;
        return rep;
    }

    static string Trim(string s) => s.Length <= 300 ? s : s[..300];
}

/// <summary>
/// A stop report that could not be delivered is kept on disk and retried, so the server learns the real stop time and reason even if
/// the network was down at that moment. Only a stop is stored: a progress report is superseded by the next one anyway.
/// </summary>
public sealed class SessionOutbox(string dir)
{
    string PathOf => Path.Combine(dir, "session-outbox.json");
    public void Save(object report) { try { Directory.CreateDirectory(dir); File.WriteAllText(PathOf + ".part", JsonSerializer.Serialize(report, new JsonSerializerOptions(JsonSerializerDefaults.Web))); File.Move(PathOf + ".part", PathOf, true); } catch { /* best effort */ } }
    public string? Load() { try { return File.Exists(PathOf) ? File.ReadAllText(PathOf) : null; } catch { return null; } }
    public void Clear() { try { File.Delete(PathOf); } catch { } }
}
