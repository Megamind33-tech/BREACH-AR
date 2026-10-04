using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using Microsoft.Win32;

namespace Viro.Agent;

/// <summary>Facts about the agent's own installation, reported to Control so it can detect tampering. Control judges; the agent only reports.</summary>
public static class Integrity
{
    static (long len, DateTime mtime, string sha)? _cache;

    public static string Sha256Of(string path)
    {
        var fi = new FileInfo(path);
        if (_cache is { } c && c.len == fi.Length && c.mtime == fi.LastWriteTimeUtc) return c.sha;   // hash only when the file changed
        using var s = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var sha = Convert.ToHexString(SHA256.HashData(s)).ToLowerInvariant();
        _cache = (fi.Length, fi.LastWriteTimeUtc, sha);
        return sha;
    }

    public static (bool signed, bool trusted, string? signer) Signature(string path)
    {
        try
        {
            using var cert = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
            using var chain = new X509Chain { ChainPolicy = { RevocationMode = X509RevocationMode.NoCheck, VerificationFlags = X509VerificationFlags.NoFlag } };
            chain.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.3")); // code signing
            return (true, chain.Build(cert), cert.Subject);
        }
        catch (CryptographicException) { return (false, false, null); }
    }

    /// <summary>Compares the registered service with what the installer creates. Returns null when it matches.</summary>
    public static string? ServiceIssue(int? startType, string? objectName, string? imagePath, string expectedExe)
    {
        if (imagePath is null) return "the service is not registered";
        if (!string.Equals(imagePath.Trim('"'), expectedExe, StringComparison.OrdinalIgnoreCase)) return $"it runs {imagePath} instead of {expectedExe}";
        if (startType != 2) return "the start type is not automatic";   // 2 = automatic (delayed-auto is Start=2 plus a separate flag)
        if (!string.Equals(objectName, "LocalSystem", StringComparison.OrdinalIgnoreCase)) return $"it runs as {objectName} instead of LocalSystem";
        return null;
    }

    public static string? CurrentServiceIssue(string serviceName, string expectedExe)
    {
        using var k = Registry.LocalMachine.OpenSubKey($@"SYSTEM\CurrentControlSet\Services\{serviceName}");
        return k is null ? "the service is not registered" : ServiceIssue(k.GetValue("Start") as int?, k.GetValue("ObjectName") as string, k.GetValue("ImagePath") as string, expectedExe);
    }

    /// <summary>True when only SYSTEM and Administrators can access the folder (it holds the device credential).</summary>
    public static bool? DataDirProtected(string dir)
    {
        try
        {
            var rules = new DirectoryInfo(dir).GetAccessControl().GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>();
            var ok = new HashSet<string> { "S-1-5-18", "S-1-5-32-544" };
            return rules.Where(r => r.AccessControlType == AccessControlType.Allow).All(r => ok.Contains(r.IdentityReference.Value));
        }
        catch { return null; }
    }

    public static object Collect(string serviceName, bool isInstalledService)
    {
        var exe = Environment.ProcessPath!;
        var sig = Signature(exe);
        var issue = isInstalledService ? CurrentServiceIssue(serviceName, exe) : null;
        return new
        {
            exeSha256 = Sha256Of(exe), signed = sig.signed, signatureTrusted = sig.trusted, signer = sig.signer, installedPath = exe,
            serviceOk = isInstalledService ? issue is null : (bool?)null, serviceIssue = issue,
            dataDirProtected = isInstalledService ? DataDirProtected(AgentConfig.DataDir) : null,
        };
    }
}
