using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Viro.Agent;

/// <summary>Persistent agent identity. The device secret is DPAPI (machine scope) protected at rest.</summary>
public sealed class AgentConfig
{
    public string ServerUrl { get; set; } = "";
    public string DeviceId { get; set; } = "";
    public string ProtectedSecret { get; set; } = "";
    public int HeartbeatIntervalSeconds { get; set; } = 30;
    /// <summary>Server job-signing public key (SPKI, base64), pinned at enrollment. Jobs not signed by it are never executed.</summary>
    public string JobSigningPublicKey { get; set; } = "";
    public string OrganizationId { get; set; } = "";

    public static string DataDir { get; } = Environment.GetEnvironmentVariable("VIRO_DATA_DIR")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Viro", "Agent");
    public static string ConfigPath => Path.Combine(DataDir, "agent.json");

    [System.Text.Json.Serialization.JsonIgnore] public bool IsEnrolled => ServerUrl != "" && DeviceId != "" && ProtectedSecret != "";

    [System.Text.Json.Serialization.JsonIgnore] public string DeviceSecret => Encoding.UTF8.GetString(
        ProtectedData.Unprotect(Convert.FromBase64String(ProtectedSecret), null, DataProtectionScope.LocalMachine));

    public void SetSecret(string secret) => ProtectedSecret = Convert.ToBase64String(
        ProtectedData.Protect(Encoding.UTF8.GetBytes(secret), null, DataProtectionScope.LocalMachine));

    public static AgentConfig Load()
    {
        try { return JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(ConfigPath)) ?? new(); }
        catch (FileNotFoundException) { return new(); }
        catch (DirectoryNotFoundException) { return new(); }
    }

    public void Save()
    {
        Directory.CreateDirectory(DataDir);
        var tmp = ConfigPath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(tmp, ConfigPath, overwrite: true);
    }
}
