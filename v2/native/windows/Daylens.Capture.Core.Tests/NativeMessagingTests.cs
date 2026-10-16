using System.Text;
using System.Text.Json.Nodes;
using Daylens.Capture.Core;
using static Daylens.Capture.Core.Tests.TestSupport;

namespace Daylens.Capture.Core.Tests;

public class NativeMessagingTests
{
    static readonly AppInfo Chrome = new(@"C:\Program Files\Google\Chrome\Application\chrome.exe", "Google Chrome",
        @"C:\Program Files\Google\Chrome\Application\chrome.exe", 9120, true, IdentityState.Ok, null);
    static readonly AppInfo Firefox = Chrome with { AppId = @"C:\Program Files\Mozilla Firefox\firefox.exe", Name = "Firefox", Path = @"C:\Program Files\Mozilla Firefox\firefox.exe", Pid = 4410 };

    static JsonObject Encode(string message, AppInfo browser, string extension, long seq)
    {
        var m = Assert.IsType<ExtensionMessage.TabMsg>(ExtensionMessage.Parse(Encoding.UTF8.GetBytes(message)));
        return AssertSingleValidLine(Envelope.Line("run-0002", seq, "boot-0001", Time, "windows", "browser_ext", "tab", TabObs.Tab(m.Report, browser, extension)));
    }

    [Fact]
    public void TabLinesMatchGoldenFixtures()
    {
        var page = Encode("""{"t":"tab","state":"page","trigger":"updated","window":"2","tab":"7","url":"https://docs.example.com/d/1AbC/edit","title":"Plan"}""",
            Chrome, "abcdefghijklmnopabcdefghijklmnop", 0);
        Assert.True(JsonNode.DeepEquals(page, Fixtures()["host_win_tab_page"]), page.ToJsonString());
        var unknown = Encode("""{"t":"tab","state":"unknown","trigger":"focus","reason":"not_normal"}""", Firefox, "browser@daylens.app", 1);
        Assert.True(JsonNode.DeepEquals(unknown, Fixtures()["host_win_tab_unknown_firefox"]), unknown.ToJsonString());
    }

    [Fact]
    public void LaunchDetection()
    {
        Assert.Equal(new HostLaunch(false, "dgidcofcmgnlicmmepgomalcdcbgjjjg"), HostLaunch.Detect(["chrome-extension://dgidcofcmgnlicmmepgomalcdcbgjjjg/", "--parent-window=1234"]));
        Assert.Equal(new HostLaunch(true, "browser@daylens.app"), HostLaunch.Detect([@"C:\Users\a\AppData\Local\Daylens\app.daylens.browser.json", "browser@daylens.app"]));
        Assert.Null(HostLaunch.Detect([]));
        Assert.Null(HostLaunch.Detect(["--heartbeat-s", "15"]));
        Assert.Null(HostLaunch.Detect(["chrome-extension://zzz/"]));
        Assert.Null(HostLaunch.Detect(["a.json", "two@@ats"]));
        Assert.Contains("dgidcofcmgnlicmmepgomalcdcbgjjjg", HostLaunch.Allowed);
        Assert.DoesNotContain("abcdefghijklmnopabcdefghijklmnop", HostLaunch.Allowed);
    }

    [Fact]
    public void FramesSplitAcrossReadsAndOversizedFramesAreSkippedInStep()
    {
        var a = NativeFrame.Encode("""{"t":"status"}"""u8)!;
        var big = new byte[4 + NativeFrame.MaxInbound + 10];
        BitConverter.TryWriteBytes(big, NativeFrame.MaxInbound + 10);
        var b = NativeFrame.Encode("""{"t":"open"}"""u8)!;
        var stream = a.Concat(big).Concat(b).ToArray();
        var r = new FrameReader();
        var items = new List<FrameReader.Item>();
        for (var i = 0; i < stream.Length; i += 7001) items.AddRange(r.Feed(stream.AsSpan(i, Math.Min(7001, stream.Length - i))));
        Assert.Equal(3, items.Count);
        Assert.Equal("""{"t":"status"}""", Encoding.UTF8.GetString(items[0].Message!));
        Assert.Equal(NativeFrame.MaxInbound + 10, items[1].Oversized);
        Assert.Equal("""{"t":"open"}""", Encoding.UTF8.GetString(items[2].Message!));
    }

    [Fact]
    public void OnlyWellFormedMessagesPass()
    {
        static ExtensionMessage? P(string s) => ExtensionMessage.Parse(Encoding.UTF8.GetBytes(s));
        Assert.Equal(new ExtensionMessage.Pause("hour"), P("""{"t":"pause","for":"hour"}"""));
        Assert.Null(P("""{"t":"pause","for":"forever"}"""));
        Assert.Null(P("""{"t":"tab","state":"page","trigger":"focus","window":"1"}"""));
        Assert.Null(P("""{"t":"tab","state":"unknown","trigger":"focus","reason":"private_window"}"""));
        Assert.Null(P("""{"t":"tab","state":"page","trigger":"keylogger","window":"1","url":"https://x"}"""));
        Assert.Null(P("{\"t\":\"tab\",\"state\":\"page\",\"trigger\":\"focus\",\"window\":\"1\",\"url\":\"https://x/" + new string('a', 2048) + "\"}"));
        Assert.Null(P("not json"));
        Assert.Null(P("""{"t":"exec"}"""));
        var leak = Assert.IsType<ExtensionMessage.TabMsg>(P("""{"t":"tab","state":"unknown","trigger":"focus","reason":"no_tab","url":"https://leak","title":"leak"}"""));
        Assert.Null(leak.Report.Url);
        Assert.Null(leak.Report.Title);
        var longTitle = Assert.IsType<ExtensionMessage.TabMsg>(P("{\"t\":\"tab\",\"state\":\"page\",\"trigger\":\"focus\",\"window\":\"1\",\"url\":\"https://x\",\"title\":\"" + new string('a', 1023) + "🌘🌘\"}"));
        Assert.Equal(1023, longTitle.Report.Title!.Length);
    }

    [Fact]
    public void ServiceLinesBecomeExtensionStatus()
    {
        Assert.Equal("""{"t":"status","daylens":"connected","capture":"paused","until_wall_ms":1792130412345}""",
            Encoding.UTF8.GetString(HostReply.FromService("""{"op":"status","capture":"paused","until_wall_ms":1792130412345}"""u8)!));
        Assert.Equal("""{"t":"snapshot"}""", Encoding.UTF8.GetString(HostReply.FromService("""{"op":"snapshot"}"""u8)!));
        Assert.Null(HostReply.FromService("""{"op":"status","capture":"exfiltrate"}"""u8));
        Assert.Null(HostReply.FromService("garbage"u8));
        Assert.Equal("{\"op\":\"pause\",\"for\":\"until_resumed\"}\n", Encoding.UTF8.GetString(HostReply.Control(new ExtensionMessage.Pause("until_resumed"))!));
    }

    [Fact]
    public void TheBrowserIsTheParentOrTheParentOfCmd()
    {
        var procs = new Dictionary<int, ProcessEntry>
        {
            [10] = new(10, 1, @"C:\Program Files\Google\Chrome\Application\chrome.exe", 100),
            [20] = new(20, 10, @"C:\Windows\System32\cmd.exe", 200),
            [30] = new(30, 20, @"C:\x\daylens-capture-windows.exe", 300),
            [40] = new(40, 50, @"C:\Program Files\Mozilla Firefox\firefox.exe", 100),
            [41] = new(41, 40, @"C:\x\daylens-capture-windows.exe", 300),
            [60] = new(60, 1, @"C:\evil\reused.exe", 900),
            [61] = new(61, 60, @"C:\x\daylens-capture-windows.exe", 300),
        };
        ProcessEntry? Look(int pid) => procs.TryGetValue(pid, out var e) ? e : null;
        Assert.Equal(10, LaunchChain.BrowserPid(30, Look));
        Assert.Equal(40, LaunchChain.BrowserPid(41, Look));
        Assert.Null(LaunchChain.BrowserPid(61, Look));
        Assert.Null(LaunchChain.BrowserPid(99, Look));
    }
}
