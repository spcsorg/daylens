using System.Text.Json;
using System.Text.Json.Nodes;
using Daylens.Capture.Core;
using static Daylens.Capture.Core.Tests.TestSupport;

namespace Daylens.Capture.Core.Tests;

public class GoldenFixtureTests
{
    const string UnicodeTitle = "Ünïcödé \"quoted\" \\ path ⠋ 日本語";

    // Obs for every win_* fixture, built the way Program.cs builds them where Core has the classifier.
    static readonly Dictionary<string, Action<Utf8JsonWriter>> Builders = new()
    {
        ["win_hello"] = Obs.Hello("daylens-capture-windows", "2.0.0-dev", 7000, "Windows 10.0.26100", 15, 120, 60),
        ["win_heartbeat"] = Obs.Heartbeat(612_345_678_901, new Registrations(true, true, true), ChannelState.Ok, 0, 3),
        ["win_heartbeat_session_unregistered"] = Obs.Heartbeat(612_345_678_901, new Registrations(Focus: true, Session: false, Power: true), ChannelState.Ok, 0, 0),
        ["win_focus_store"] = Obs.Focus(FocusTrigger.AppChanged, Calculator, WindowInfo.Read("0x1A2B3C", "Calculator")),
        ["win_focus_access_denied"] = Obs.Focus(FocusTrigger.AppChanged, AppInfo.Unknown(4, IdentityState.AccessDenied), WindowInfo.Read("0x2B", "Administrator: Task Manager")),
        ["win_focus_unicode"] = Obs.Focus(FocusTrigger.TitleChanged, Calculator, WindowInfo.Read("0x1A2B3C", UnicodeTitle)),
        ["win_power_resume"] = Obs.Power(Power.Classify(Power.PBT_APMRESUMEAUTOMATIC)!),
        ["win_power_resume_user"] = Obs.Power(Power.Classify(Power.PBT_APMRESUMESUSPEND)!),
        ["win_session_snapshot"] = Obs.Session(Sessions.FromSessionFlags(1), true),
        ["win_input_active"] = Obs.Input(false, 1_792_130_412_000, 120, true),
        ["win_focus_unresolved_host"] = Obs.Focus(FocusTrigger.AppChanged, AppInfo.Unknown(7712, IdentityState.Unresolved), WindowInfo.Read("0x3C4D", "Some hosted window")),
        ["win_loss"] = Obs.Loss(12, 1_792_130_410_000, 1_792_130_412_000),
    };

    public static TheoryData<string> WindowsFixtureNames()
    {
        var data = new TheoryData<string>();
        foreach (var name in Fixtures().Keys.Where(n => n.StartsWith("win_", StringComparison.Ordinal))) data.Add(name);
        return data;
    }

    static JsonObject Encode(string name, JsonObject golden)
    {
        var t = golden["t"]!;
        var time = new EventTime(t["wall_ms"]!.GetValue<long>(), t["mono_us"]!.GetValue<long>(), t["tz"]!.GetValue<string>(), t["tz_offset_min"]!.GetValue<int>());
        var line = Envelope.Line("run-0001", golden["seq"]!.GetValue<long>(), "boot-0001", time, "windows",
            golden["source"]!.GetValue<string>(), golden["kind"]!.GetValue<string>(), Builders[name]);
        return AssertSingleValidLine(line);
    }

    [Theory]
    [MemberData(nameof(WindowsFixtureNames))]
    public void EncoderMatchesGoldenFixture(string name)
    {
        var golden = Fixtures()[name];
        Assert.True(Builders.ContainsKey(name), $"no C# builder for fixture {name}; add one");
        var ours = Encode(name, golden);
        Assert.True(JsonNode.DeepEquals(ours, golden), $"{name}\nours:   {ours.ToJsonString()}\ngolden: {golden.ToJsonString()}");
    }

    [Fact]
    public void EveryWindowsFixtureHasABuilderAndViceVersa()
    {
        var fixtureNames = Fixtures().Keys.Where(n => n.StartsWith("win_", StringComparison.Ordinal)).Order().ToArray();
        Assert.NotEmpty(fixtureNames);
        Assert.Equal(fixtureNames, Builders.Keys.Order().ToArray());
    }

    [Fact]
    public void UnicodeQuoteBackslashTitleRoundTrips()
    {
        var golden = Fixtures()["win_focus_unicode"];
        Assert.Equal(UnicodeTitle, golden["obs"]!["window"]!["title"]!.GetValue<string>());
        var ours = Encode("win_focus_unicode", golden);
        Assert.Equal(UnicodeTitle, ours["obs"]!["window"]!["title"]!.GetValue<string>());
    }
}

public class EncoderRobustnessTests
{
    public static TheoryData<string> WellFormedHostileTitles() => new()
    {
        U(Enumerable.Range(0, 32).Append(0x7F).ToArray()),
        U(0),
        "\r\n",
        "\r",
        "\n",
        "a" + U(0x2028) + "b" + U(0x2029) + "c" + U(0x0085) + "d",
        "quote \" backslash \\ newline \n tab \t nul " + U(0) + " sep " + U(0x2028) + " emoji " + U(0xD83C, 0xDF18) + " 日本語",
        "\"},\"kind\":\"bye\",\"obs\":{\"reason\":\"",
        "</script><script>alert(1)</script>",
        U(0xFEFF, 0xFFFE, 0xFFFF),
        new string('\\', 1024),
        new string('\0', 1024),
        string.Concat(Enumerable.Repeat(U(0xD83D, 0xDE00), 600)),
    };

    [Theory]
    [MemberData(nameof(WellFormedHostileTitles))]
    public void HostileTitleIsOneValidLineAndRoundTrips(string title)
    {
        var window = WindowInfo.Read("0x1", title);
        var obj = AssertSingleValidLine(FocusLine(Calculator, window));
        Assert.Equal("focus", obj["kind"]!.GetValue<string>());
        var expected = title.Length <= WindowInfo.MaxTitleUtf16 ? title : title[..window.Title!.Length];
        Assert.Equal(expected, obj["obs"]!["window"]!["title"]!.GetValue<string>());
    }

    // Lone surrogates cannot be encoded as UTF-8. The writer replaces each with U+FFFD instead of throwing;
    // a throw here would escape Resolver.Loop and kill the helper.
    public static TheoryData<string, string> MalformedTitles() => new()
    {
        { "a" + U(0xD800) + "b", "a" + U(0xFFFD) + "b" },
        { "a" + U(0xDC00), "a" + U(0xFFFD) },
        { U(0xD800), U(0xFFFD) },
        { U(0xDC00, 0xD800), U(0xFFFD, 0xFFFD) },
        { "end" + U(0xD83D), "end" + U(0xFFFD) },
        { U(0xD83D, 0xDE00, 0xDE00), U(0xD83D, 0xDE00, 0xFFFD) },
    };

    [Theory]
    [MemberData(nameof(MalformedTitles))]
    public void LoneSurrogatesBecomeReplacementCharacters(string title, string expected)
    {
        var obj = AssertSingleValidLine(FocusLine(Calculator, WindowInfo.Read("0x1", title)));
        Assert.Equal(expected, obj["obs"]!["window"]!["title"]!.GetValue<string>());
    }

    [Fact]
    public void HostileValuesInEveryStringFieldStayOnOneLine()
    {
        var evil = "x\n\r" + U(0, 0x2028, 0xD800) + "\"\\";
        var app = new AppInfo(evil, evil, evil, 1, true, IdentityState.Ok, new StoreIdentity(evil, evil));
        var line = Envelope.Line("run-0001", 0, "boot-0001", Time with { Tz = evil }, "windows", "win_event", "focus",
            Obs.Focus(FocusTrigger.AppChanged, app, WindowInfo.Read(evil, evil)));
        AssertSingleValidLine(line);
        foreach (var obs in new[] { Obs.Bye(evil), Obs.Session(evil, false), Obs.Power(evil), Obs.Clock(evil),
                     Obs.Hello(evil, evil, 1, evil, 1, 1, 1) })
            AssertSingleValidLine(Envelope.Line("run-0001", 0, "boot-0001", Time, "windows", "helper", "bye", obs));
    }

    // The TS validator rejects lines over 16 KiB. Worst case title (1024 escaped NULs, 6 bytes each) plus
    // maximum-size name (validator cap 512), a MAX_PATH path of backslashes in both app_id and path, and
    // maximum AUMID / package lengths must still fit.
    [Fact]
    public void WorstCaseRealisticFocusLineFitsInSixteenKiB()
    {
        var path = @"C:\" + new string('\\', 257);
        var app = new AppInfo(path, new string((char)1, 512), path, int.MaxValue, true, IdentityState.Ok,
            new StoreIdentity(new string('a', 130), new string('b', 127)));
        var window = WindowInfo.Read("0x" + long.MaxValue.ToString("X"), new string('\0', 4096));
        var line = FocusLine(app, window, long.MaxValue);
        AssertSingleValidLine(line);
    }

    [Fact]
    public void LineHasExactlyTheEnvelopeFields()
    {
        var obj = AssertSingleValidLine(Envelope.Line("r", 42, "b", Time, "windows", "power", "power", Obs.Power("sleep")));
        Assert.Equal(new[] { "v", "run", "seq", "boot", "t", "platform", "source", "kind", "obs" }, obj.Select(p => p.Key).ToArray());
        Assert.Equal(1, obj["v"]!.GetValue<int>());
        Assert.Equal(42, obj["seq"]!.GetValue<long>());
        Assert.Equal(new[] { "wall_ms", "mono_us", "tz", "tz_offset_min" }, obj["t"]!.AsObject().Select(p => p.Key).ToArray());
    }

    [Fact]
    public void NullIdentityFieldsAreWrittenAsJsonNull()
    {
        var obj = AssertSingleValidLine(FocusLine(AppInfo.NoneInFront, WindowInfo.Read(null, null)));
        var app = obj["obs"]!["app"]!.AsObject();
        foreach (var key in new[] { "app_id", "name", "path", "pid", "store" })
        {
            Assert.True(app.ContainsKey(key), key);
            Assert.Null(app[key]);
        }
        Assert.Equal("none", app["identity_state"]!.GetValue<string>());
        var window = obj["obs"]!["window"]!.AsObject();
        Assert.True(window.ContainsKey("title"));
        Assert.Null(window["title"]);
        Assert.Equal("unavailable", window["title_state"]!.GetValue<string>());
    }

    // The validator's rule: title is present exactly when title_state is ok. It must hold however a WindowInfo is built.
    [Theory]
    [InlineData(TitleState.Ok, null)]
    [InlineData(TitleState.Ok, "")]
    [InlineData(TitleState.Ok, "t")]
    [InlineData(TitleState.Empty, "t")]
    [InlineData(TitleState.Empty, null)]
    [InlineData(TitleState.NoPermission, "t")]
    [InlineData(TitleState.Timeout, "t")]
    [InlineData(TitleState.Unavailable, "t")]
    [InlineData(TitleState.Unavailable, null)]
    public void TitlePresentExactlyWhenStateIsOk(TitleState state, string? title)
    {
        var obj = AssertSingleValidLine(FocusLine(Calculator, new WindowInfo("0x1", title, state)));
        var window = obj["obs"]!["window"]!;
        var titleValue = window["title"]?.GetValue<string>();
        var ok = window["title_state"]!.GetValue<string>() == "ok";
        Assert.Equal(ok, titleValue is not null);
        if (ok) Assert.NotEqual("", titleValue);
    }
}

public class NamesTests
{
    [Fact]
    public void EveryEnumValueHasItsProtocolName()
    {
        Assert.Equal(new[] { "ok", "access_denied", "timeout", "gone", "none", "unresolved" }, Enum.GetValues<IdentityState>().Select(Names.Of).ToArray());
        Assert.Equal(new[] { "ok", "empty", "no_window", "no_permission", "timeout", "unavailable" }, Enum.GetValues<TitleState>().Select(Names.Of).ToArray());
        Assert.Equal(new[] { "ok", "degraded", "stalled", "no_permission" }, Enum.GetValues<ChannelState>().Select(Names.Of).ToArray());
        Assert.Equal(new[] { "app_changed", "window_changed", "title_changed", "reconcile", "snapshot" }, Enum.GetValues<FocusTrigger>().Select(Names.Of).ToArray());
    }
}
