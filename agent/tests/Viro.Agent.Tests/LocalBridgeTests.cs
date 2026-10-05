using System.Reflection;
using System.Text.Json;
using Viro.Agent.Care;
using Xunit;

namespace Viro.Agent.Tests;

public class LocalBridgeTests
{
    static LocalBridge Bridge(Action? relaunch = null) =>
        new(new LocalActions(new UserRepairEnv(Path.Combine(Path.GetTempPath(), "viro-bridge-" + Guid.NewGuid().ToString("N")))), () => false, relaunch);

    static JsonElement Parse(string s) => JsonDocument.Parse(s).RootElement.Clone();

    [Fact]
    public async Task Env_reports_admin_state_from_the_supplied_probe()
    {
        var r = Parse(await Bridge().RespondAsync("""{"id":"1","cmd":"env"}""", default));
        Assert.True(r.GetProperty("ok").GetBoolean());
        Assert.Equal("1", r.GetProperty("id").GetString());
        Assert.False(r.GetProperty("data").GetProperty("admin").GetBoolean());
    }

    [Fact]
    public async Task Live_reports_processor_memory_and_drive_figures_in_range()
    {
        var bridge = Bridge(); await bridge.RespondAsync("""{"id":"a","cmd":"sys"}""", default);        // primes the processor reading
        await Task.Delay(300);
        var d = Parse(await bridge.RespondAsync("""{"id":"3","cmd":"live"}""", default)).GetProperty("data");
        Assert.InRange(d.GetProperty("ramPercent").GetDouble(), 1, 100);
        Assert.True(d.GetProperty("diskTotalBytes").GetInt64() > 0 && d.GetProperty("diskFreeBytes").GetInt64() >= 0);
        if (d.GetProperty("cpuPercent").ValueKind == JsonValueKind.Number) Assert.InRange(d.GetProperty("cpuPercent").GetDouble(), 0, 100);
    }

    [Fact]
    public async Task Sys_answers_with_the_facts_for_the_title_strip_and_never_throws()
    {
        var r = Parse(await Bridge().RespondAsync("""{"id":"4","cmd":"sys"}""", default));
        Assert.True(r.GetProperty("ok").GetBoolean());
        var d = r.GetProperty("data");
        foreach (var p in new[] { "cpu", "cores", "ramGb", "os", "uptimeSeconds", "manufacturer", "model" }) Assert.True(d.TryGetProperty(p, out _), "missing " + p);
        if (d.GetProperty("ramGb").ValueKind == JsonValueKind.Number) Assert.True(d.GetProperty("ramGb").GetDouble() > 0.5);
    }

    [Fact]
    public void Interface_has_the_page_structure_every_tool_page_relies_on_and_no_leftover_colour_chips()
    {
        using var s = typeof(LocalBridge).Assembly.GetManifestResourceStream("ui.html"); var html = new StreamReader(s!).ReadToEnd();
        foreach (var must in new[] { "id=\"strip\"", "const sum =", "const panel =", "const actionbar =", "call('live')", "call('sys')" }) Assert.Contains(must, html);
        foreach (var page in new[] { "overview", "security", "updates", "swupdates", "stability", "performance", "slow", "apps", "space", "startup", "memory", "workspace", "activity", "undo" }) Assert.Contains("RENDER." + page + " = async", html);
        Assert.DoesNotContain("--c1:", html);   // the old rainbow icon chips are gone
    }

    [Fact]
    public void The_first_run_tour_only_points_at_pages_that_exist_and_only_starts_on_a_normal_un_deep_linked_open()
    {
        using var s = typeof(LocalBridge).Assembly.GetManifestResourceStream("ui.html"); var html = new StreamReader(s!).ReadToEnd();
        Assert.Contains("const TOUR = [", html); Assert.Contains("function runTutorial", html);
        Assert.Contains("if (S.env.firstRun && start === 'overview') runTutorial();", html);
        Assert.Contains("call('tutorial.seen')", html);
        var tour = html[html.IndexOf("const TOUR = [")..html.IndexOf("];", html.IndexOf("const TOUR = ["))];
        foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(tour, "page: '([a-z]+)'"))
            Assert.Contains("RENDER." + m.Groups[1].Value + " = async", html);
    }

    [Fact]
    public async Task The_first_run_tour_shows_once_per_Windows_user_and_env_reflects_it()
    {
        var file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Viro", "tutorial-seen");
        try { File.Delete(file); } catch (IOException) { }
        Assert.False(TutorialState.Seen);
        var bridge = Bridge();
        Assert.True(Parse(await bridge.RespondAsync("""{"id":"1","cmd":"env"}""", default)).GetProperty("data").GetProperty("firstRun").GetBoolean());
        var r = Parse(await bridge.RespondAsync("""{"id":"2","cmd":"tutorial.seen"}""", default));
        Assert.True(r.GetProperty("ok").GetBoolean()); Assert.True(r.GetProperty("data").GetProperty("ok").GetBoolean());
        Assert.True(TutorialState.Seen);
        Assert.False(Parse(await bridge.RespondAsync("""{"id":"3","cmd":"env"}""", default)).GetProperty("data").GetProperty("firstRun").GetBoolean());
        File.Delete(file);   // leave this developer machine as it was found
    }

    [Fact]
    public async Task Unknown_command_is_a_plain_error_not_a_crash()
    {
        var r = Parse(await Bridge().RespondAsync("""{"id":"2","cmd":"format-disk"}""", default));
        Assert.False(r.GetProperty("ok").GetBoolean());
        Assert.Equal("unknown request", r.GetProperty("error").GetString());
    }

    [Fact]
    public async Task Malformed_request_is_answered_not_thrown()
    {
        var r = Parse(await Bridge().RespondAsync("not json", default));
        Assert.False(r.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task Cleaning_with_nothing_selected_is_refused()
    {
        var r = Parse(await Bridge().RespondAsync("""{"id":"3","cmd":"space.clean","args":{"ids":[]}}""", default));
        Assert.False(r.GetProperty("ok").GetBoolean());
        Assert.Contains("nothing selected", r.GetProperty("error").GetString());
    }

    [Fact]
    public async Task Startup_set_ignores_entries_that_do_not_exist()
    {
        var r = Parse(await Bridge().RespondAsync("""{"id":"4","cmd":"startup.set","args":{"enable":false,"entries":[{"location":"HKCU\\Run","name":"definitely-not-a-real-entry-7f3a"}]}}""", default));
        Assert.False(r.GetProperty("ok").GetBoolean());
        Assert.Contains("not found", r.GetProperty("error").GetString());
    }

    [Fact]
    public async Task Elevate_invokes_the_relaunch_hook()
    {
        var called = false;
        var r = Parse(await Bridge(() => called = true).RespondAsync("""{"id":"5","cmd":"elevate"}""", default));
        Assert.True(called);
        Assert.True(r.GetProperty("data").GetProperty("started").GetBoolean());
    }

    [Fact]
    public void Interface_is_embedded_and_only_talks_to_the_bridge()
    {
        using var s = typeof(LocalBridge).Assembly.GetManifestResourceStream("ui.html");
        Assert.NotNull(s);
        var html = new StreamReader(s!).ReadToEnd();
        Assert.Contains("chrome.webview.postMessage", html);
        Assert.DoesNotContain("http://", html.Replace("http://www.w3.org", ""));
        Assert.DoesNotContain("https://", html);
    }
}
