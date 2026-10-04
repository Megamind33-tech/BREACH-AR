using System.Text.RegularExpressions;

namespace Viro.Agent.Care;

[System.Text.Json.Serialization.JsonConverter(typeof(System.Text.Json.Serialization.JsonStringEnumConverter))]
public enum CloseRisk { SAFE, ASK_USER, HIGH_RISK, SYSTEM_CRITICAL, UNKNOWN }

/// <summary>What is known about one running program. HasVisibleWindow / IsForeground are null when the signed-in user's session could not be inspected.</summary>
public sealed record ProcInfo(int Pid, string Name, string? Path, int SessionId, bool IsService, double CpuPercent, long WorkingSetBytes, bool? HasVisibleWindow, bool? IsForeground, long PrivateBytes = 0);

public sealed record ProcessCloseAssessment(int ProcessId, string ApplicationName, double CpuUsage, double MemoryUsageMb, string BackgroundState, string UserInteractionState,
    CloseRisk CloseRisk, string Category, string Recommendation);

/// <summary>
/// Decides what may be done about a program that is using memory or CPU. The rule of the engine: Viro never closes something because it is merely big
/// or busy. Only a short, explicitly approved list of background helpers (updaters, tray launchers with no user data, no window, not in use) can ever
/// be SAFE. Anything with a window, anything unknown, and anything that can hold unsaved work or a live call is left for the person to decide.
/// </summary>
public static partial class ProcessClassifier
{
    // Windows itself, the shell, input and audio: never touched.
    static readonly HashSet<string> Critical = new(StringComparer.OrdinalIgnoreCase)
    { "system", "idle", "registry", "smss", "csrss", "wininit", "services", "lsass", "lsaiso", "winlogon", "svchost", "dwm", "explorer", "fontdrvhost", "ctfmon", "sihost", "taskhostw", "runtimebroker", "searchhost", "searchindexer",
      "startmenuexperiencehost", "shellexperiencehost", "textinputhost", "conhost", "audiodg", "spoolsv", "dllhost", "wmiprvse", "lockapp", "logonui", "securityhealthsystray", "securityhealthservice", "msmpeng", "nissrv", "mpdefendercoreservice",
      "memory compression", "vmmem", "wudfhost", "dashost", "backgroundtaskhost", "applicationframehost", "systemsettings", "taskmgr", "powershell", "pwsh", "cmd", "windowsterminal", "mstsc", "msiexec", "trustedinstaller", "tiworker" };
    // Endpoint-security and remote-management products, and Viro itself.
    [GeneratedRegex(@"^(viro|avg|avast|kaspersky|avp|mcafee|mfe|norton|symantec|bitdefender|bdservicehost|eset|ekrn|sophos|malwarebytes|mbam|crowdstrike|csfalcon|sentinel|cylance|carbonblack|trend|tmbmsrv|webroot|teamviewer|anydesk|rustdesk|screenconnect|connectwise|splashtop|vpn|openvpn|wireguard|nordvpn|forticlient|globalprotect|cisco)", RegexOptions.IgnoreCase)]
    private static partial Regex ProtectedName();

    // Programs that hold unsaved work, data entry or a live call/recording.
    static readonly HashSet<string> HoldsWork = new(StringComparer.OrdinalIgnoreCase)
    { "winword", "excel", "powerpnt", "outlook", "onenote", "msaccess", "mspub", "visio", "winproj", "code", "devenv", "idea64", "pycharm64", "webstorm64", "rider64", "clion64", "studio64", "notepad", "notepad++", "sublime_text", "atom", "wordpad",
      "photoshop", "illustrator", "indesign", "premiere pro", "afterfx", "acad", "sqlservr", "ssms", "datagrip64", "postman", "figma", "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "iexplore",
      "teams", "ms-teams", "zoom", "slack", "discord", "skype", "webex", "webexmta", "obs64", "obs32", "obs", "camtasia", "vlc", "wmplayer", "spotify", "itunes", "onedrive", "dropbox", "googledrivefs", "qbittorrent", "utorrent", "filezilla", "winscp", "putty" };

    // Background helpers and updaters that store no user data and come back on their own if needed. Only these can be SAFE, and only without a window.
    static readonly HashSet<string> SafeHelpers = new(StringComparer.OrdinalIgnoreCase)
    { "adobearm", "acrotray", "adobecollabsync", "adobeipcbroker", "ccxprocess", "creative cloud helper", "adobe desktop service", "jusched", "jucheck", "googleupdate", "googlecrashhandler", "googlecrashhandler64", "microsoftedgeupdate",
      "yourphone", "yourphoneserver", "phoneexperiencehost", "gamebar", "gamebarftserver", "gamebarpresencewriter", "widgets", "widgetservice", "steamwebhelper", "epicwebhelper", "epicgameslauncher", "origin", "eadesktop", "battle.net",
      "hpsystemeventutility", "hpsupportassistant", "hptouchpointanalyticsservice", "dell.techhub", "supportassistagent", "lenovovantage", "asusosd", "razer synapse", "logioptionsplus_agent", "lghub", "nvidia share", "nvcontainer", "nvbackend",
      "officeclicktorun", "officebackgroundtaskhandler", "msteamsupdate", "onedrivestandaloneupdater", "skypebackgroundhost", "cortana", "searchapp", "useroobebroker", "teamsupdate" };

    public static bool IsProtected(string name) => Critical.Contains(name) || ProtectedName().IsMatch(name);

    public static ProcessCloseAssessment Assess(ProcInfo p, string? windowsDir = null)
    {
        var mb = Math.Round(p.WorkingSetBytes / 1048576.0, 0);
        var win = windowsDir ?? Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var bg = p.IsForeground == true ? "in use right now (foreground)" : p.HasVisibleWindow == true ? "has a window open" : p.HasVisibleWindow == false ? "background, no window" : "state not observable";
        var inter = p.IsForeground == true ? "the person is working in it" : p.HasVisibleWindow == true ? "a window is open" : p.HasVisibleWindow == false ? "no window, no direct interaction" : "unknown";
        ProcessCloseAssessment R(CloseRisk risk, string cat, string rec) => new(p.Pid, p.Name, p.CpuPercent, mb, bg, inter, risk, cat, rec);

        if (IsProtected(p.Name) || p.SessionId == 0 || p.IsService || (p.Path is { } path && path.StartsWith(win, StringComparison.OrdinalIgnoreCase)))
            return R(CloseRisk.SYSTEM_CRITICAL, "SYSTEM_CRITICAL", "Part of Windows, security or remote management. Viro never closes or alters it.");
        if (HoldsWork.Contains(p.Name))
            return R(CloseRisk.HIGH_RISK, "NEVER_AUTOCLOSE", p.IsForeground == true ? "You are using this application right now." : "This application can hold unsaved work or a live call. Please close it yourself when you are finished.");
        if (p.IsForeground == true) return R(CloseRisk.ASK_USER, "ASK_USER", "You are using this application right now.");
        if (SafeHelpers.Contains(p.Name))
            return p.HasVisibleWindow == false ? R(CloseRisk.SAFE, "SAFE_TO_SUGGEST_CLOSE", "A background helper with no window. It stores no documents and starts again by itself when needed.")
                 : R(CloseRisk.ASK_USER, "ASK_USER", p.HasVisibleWindow == true ? "It has a window open, so it may be in use." : "Viro cannot tell whether it is in use, so it will not be closed automatically.");
        if (p.HasVisibleWindow == true) return R(CloseRisk.ASK_USER, "ASK_USER", "An application with a window open. Close it yourself if you are not using it.");
        return R(CloseRisk.UNKNOWN, "UNKNOWN", "Viro does not recognise this program, so it will not be closed automatically. Ask the user or IT.");
    }
}
