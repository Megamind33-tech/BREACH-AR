using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Viro.Compute;

/// <summary>An engine build published by the Viro operator. The hash comes inside the signed policy, so a tampered download is never run.</summary>
public sealed record EngineSpec(string Version, string Sha256, long Size);
public sealed record PoolSpec(string Host, int Port, bool Tls, string Address);

/// <summary>
/// The mining engine (XMRig) link. Design rules, all enforced in code:
///  * the engine binary comes only from Viro Control (published by the operator), and only runs when its SHA-256 matches the signed policy;
///  * the pool host, port and payout address come from the signed policy and are validated here; the address must be a PUBLIC Monero
///    address, so no wallet key or seed can ever exist on a PC;
///  * the process is started by the normal WorkloadHost (Job Object hard CPU cap, memory limit, idle priority, kill-on-close);
///  * it is never renamed, never hidden, never added to an antivirus exclusion, never installs a driver (MSR access is switched off) and
///    is never restarted by anything but the worker's own policy engine. If security software removes it, Viro reports that and stops.
/// </summary>
public static class MinerArgs
{
    static readonly Regex HostRx = new(@"^(?=.{3,120}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$", RegexOptions.Compiled);
    static readonly Regex AddressRx = new(@"^[48][0-9A-Za-z]{94}([0-9A-Za-z]{11})?$", RegexOptions.Compiled);
    static readonly Regex WorkerRx = new(@"^[A-Za-z0-9._-]{1,80}$", RegexOptions.Compiled);
    static readonly Regex TokenRx = new(@"^[A-Za-z0-9]{16,64}$", RegexOptions.Compiled);

    public static bool ValidPool(PoolSpec p) => HostRx.IsMatch(p.Host) && p.Port is >= 1 and <= 65535 && AddressRx.IsMatch(p.Address);

    /// <summary>Threads that fit the CPU cap: the Job Object enforces the cap regardless, this just avoids wasted spinning.</summary>
    public static int Threads(int cpuCapPercent, int cores) => Math.Clamp((int)Math.Round(cores * cpuCapPercent / 100.0), 1, Math.Max(1, cores));

    /// <summary>Fixed, validated arguments. Nothing user-supplied reaches a shell; each value has passed a strict pattern.</summary>
    public static string Build(PoolSpec pool, string workerId, int cpuCapPercent, int cores, int apiPort, string apiToken)
    {
        if (!ValidPool(pool)) throw new ArgumentException("the pool settings are not valid");
        if (!WorkerRx.IsMatch(workerId)) throw new ArgumentException("invalid worker id");
        if (apiPort is < 1024 or > 65535 || !TokenRx.IsMatch(apiToken)) throw new ArgumentException("invalid local API settings");
        return string.Join(' ',
            $"--url={pool.Host}:{pool.Port}", pool.Tls ? "--tls" : "", $"--user={pool.Address}", $"--pass={workerId}", $"--threads={Threads(cpuCapPercent, cores)}",
            "--randomx-mode=light",             // ~256 MB instead of ~2 GB: stays inside the memory limit
            "--randomx-no-rdmsr", "--randomx-wrmsr=-1",   // never touch model-specific registers, so no kernel driver is ever loaded
            "--no-color", "--print-time=60", $"--http-host=127.0.0.1 --http-port={apiPort} --http-access-token={apiToken}").Replace("  ", " ").Trim();
    }

    public static (int port, string token) NewApiEndpoint()
    {
        using var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0); l.Start(); var port = ((System.Net.IPEndPoint)l.LocalEndpoint).Port; l.Stop();
        var b = new byte[24]; RandomNumberGenerator.Fill(b);
        return (port, Convert.ToHexString(b).ToLowerInvariant());
    }

    /// <summary>Total hash rate (H/s, 10-second average) from XMRig's local API summary; null when it is not reported yet.</summary>
    public static double? ParseHashrate(string json)
    {
        try
        {
            using var d = JsonDocument.Parse(json);
            if (!d.RootElement.TryGetProperty("hashrate", out var h) || !h.TryGetProperty("total", out var t) || t.ValueKind != JsonValueKind.Array || t.GetArrayLength() == 0) return null;
            var v = t[0]; return v.ValueKind == JsonValueKind.Number && v.GetDouble() >= 0 ? Math.Round(v.GetDouble(), 1) : null;
        }
        catch { return null; }
    }

    /// <summary>The whole local API summary (hash rate, accepted/rejected shares, pool uptime); null when the engine does not answer.</summary>
    public static async Task<MinerSummary?> ReadSummaryAsync(int port, string token, CancellationToken ct)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            return MinerSummary.Parse(await http.GetStringAsync($"http://127.0.0.1:{port}/2/summary", ct));
        }
        catch { return null; }
    }

    public static async Task<double?> ReadHashrateAsync(int port, string token, CancellationToken ct)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            return ParseHashrate(await http.GetStringAsync($"http://127.0.0.1:{port}/2/summary", ct));
        }
        catch { return null; }
    }
}

/// <summary>Where verified engine builds live on this PC (inside the locked-down Viro data folder).</summary>
public sealed class EngineStore(string root)
{
    public string ExePath(EngineSpec e) => Path.Combine(root, "engine", Regex.Replace(e.Version, @"[^A-Za-z0-9._-]", "_"), "xmrig.exe");

    public static string Sha256Of(string path) { using var s = File.OpenRead(path); return Convert.ToHexString(SHA256.HashData(s)).ToLowerInvariant(); }

    /// <summary>Why the engine cannot run right now, or null when it is installed and its hash still matches.</summary>
    public string? NotReadyReason(EngineSpec e)
    {
        var p = ExePath(e);
        if (!File.Exists(p)) return "the mining engine is not installed on this PC (it is downloaded from Control, or it was removed, for example by security software; Viro does not work around that)";
        if (!string.Equals(Sha256Of(p), e.Sha256, StringComparison.OrdinalIgnoreCase)) return "the installed mining engine does not match the published one; it will not be run";
        return null;
    }

    /// <summary>Writes the download next to its final place, verifies size and SHA-256 against the signed policy, then moves it into position. A mismatch deletes it.</summary>
    public async Task<string?> InstallAsync(EngineSpec e, Func<Stream, Task> download)
    {
        var final = ExePath(e); Directory.CreateDirectory(Path.GetDirectoryName(final)!);
        var part = final + ".part";
        try
        {
            await using (var fs = File.Create(part)) await download(fs);
            var len = new FileInfo(part).Length;
            if (len != e.Size || len < 1024) return "the downloaded engine has the wrong size";
            using (var s = File.OpenRead(part)) { var mz = new byte[2]; if (s.Read(mz, 0, 2) != 2 || mz[0] != (byte)'M' || mz[1] != (byte)'Z') return "the downloaded engine is not a Windows program"; }
            if (!string.Equals(Sha256Of(part), e.Sha256, StringComparison.OrdinalIgnoreCase)) return "the downloaded engine does not match the published checksum";
            File.Move(part, final, true); return null;
        }
        catch (Exception ex) { return "could not download the engine: " + ex.Message; }
        finally { try { if (File.Exists(part)) File.Delete(part); } catch { } }
    }
}
