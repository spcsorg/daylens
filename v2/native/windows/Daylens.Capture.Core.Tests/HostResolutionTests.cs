using Daylens.Capture.Core;
using static Daylens.Capture.Core.Tests.TestSupport;

namespace Daylens.Capture.Core.Tests;

public class HostResolutionTests
{
    const string FrameHost = @"C:\Windows\System32\ApplicationFrameHost.exe";
    const string CoreWindow = "Windows.UI.Core.CoreWindow";
    const int FramePid = 7712;

    static IEnumerable<ChildWindow> NoChildren() => [];

    [Fact]
    public void OrdinaryProcessIsNotAHostAndChildrenAreNeverEnumerated()
    {
        var enumerated = false;
        var r = StoreApps.ResolveHost(@"C:\Program Files\Mozilla Firefox\firefox.exe", 4000, () => { enumerated = true; return []; });
        Assert.Equal(new HostResolution(HostKind.NotAHost, 4000), r);
        Assert.False(enumerated);
    }

    [Fact]
    public void HostWithContentResolvesToTheContentProcess()
    {
        ChildWindow[] children = [new(1, FramePid, "ApplicationFrameTitleBarWindow"), new(2, 9120, CoreWindow)];
        Assert.Equal(new HostResolution(HostKind.Content, 9120), StoreApps.ResolveHost(FrameHost, FramePid, () => children));
    }

    // Child resolution fails: the hosted app is a browser (its CoreWindow's owner could not be read, pid 0)
    // or an excluded app that is suspended (its CoreWindow is detached, only the frame's own windows remain).
    public static TheoryData<string, ChildWindow[]> FailedChildResolution() => new()
    {
        { "hosted browser, owner unreadable", [new(1, FramePid, "ApplicationFrameTitleBarWindow"), new(2, 0, CoreWindow)] },
        { "suspended excluded app, content detached", [new(1, FramePid, "ApplicationFrameTitleBarWindow"), new(2, FramePid, "ApplicationFrameInputSinkWindow")] },
        { "no children at all", [] },
    };

    [Theory]
    [MemberData(nameof(FailedChildResolution))]
    public void HostWithoutResolvableContentIsUnresolvedWithNoIdentity(string scenario, ChildWindow[] children)
    {
        var r = StoreApps.ResolveHost(FrameHost, FramePid, () => children);
        Assert.True(r.Kind == HostKind.Unresolved, scenario);

        var app = r.UnresolvedApp();
        Assert.Equal(IdentityState.Unresolved, app.IdentityState);
        Assert.Null(app.AppId);
        Assert.Null(app.Name);
        Assert.Null(app.Path);
        Assert.Null(app.Store);
        Assert.False(app.RegisteredBrowser);
        Assert.Equal(FramePid, app.Pid);
    }

    // The window still reports its title; shared code withholds it because identity_state is not ok.
    [Fact]
    public void UnresolvedHostLineCarriesNoIdentityForTheTitle()
    {
        var app = StoreApps.ResolveHost(FrameHost, FramePid, NoChildren).UnresolvedApp();
        var obj = AssertSingleValidLine(FocusLine(app, WindowInfo.Read("0x3C4D", "Online banking - InPrivate")));
        var a = obj["obs"]!["app"]!;
        Assert.Equal("unresolved", a["identity_state"]!.GetValue<string>());
        foreach (var key in new[] { "app_id", "name", "path", "store" }) Assert.Null(a[key]);
        Assert.False(a["registered_browser"]!.GetValue<bool>());
    }

    [Fact]
    public void UnresolvedHostMatchesTheGoldenFixtureIdentity()
    {
        var golden = Fixtures()["win_focus_unresolved_host"]["obs"]!["app"]!;
        var app = StoreApps.ResolveHost(FrameHost, golden["pid"]!.GetValue<int>(), NoChildren).UnresolvedApp();
        var ours = AssertSingleValidLine(FocusLine(app, WindowInfo.Read("0x3C4D", "Some hosted window")))["obs"]!["app"]!;
        Assert.True(System.Text.Json.Nodes.JsonNode.DeepEquals(golden, ours), ours.ToJsonString());
    }
}
