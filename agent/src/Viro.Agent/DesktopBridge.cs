namespace Viro.Agent;

/// <summary>Creates the remote-desktop source. The helper is started on demand (only when an administrator opens a desktop session).</summary>
public static class DesktopBridge
{
    public static IDesktopSource? TryCreate(ILogger log) => new HelperDesktopSource(log);
}
