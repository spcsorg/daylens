using Daylens.Capture.Core;

namespace Daylens.Capture.Core.Tests;

public class Win32TimeTests
{
    [Theory]
    [InlineData(0UL, 0L)]
    [InlineData(9UL, 0L)]
    [InlineData(10UL, 1L)]
    [InlineData(19UL, 1L)]
    [InlineData(8_812_345_678_900UL, 881_234_567_890L)]
    [InlineData(ulong.MaxValue, 1_844_674_407_370_955_161L)]
    public void InterruptTimeIsHundredsOfNanoseconds(ulong interrupt, long expectedUs) =>
        Assert.Equal(expectedUs, Win32Time.InterruptTimeToMonoUs(interrupt));

    [Theory]
    [InlineData(100u, 40u, 60u)]
    [InlineData(7u, 7u, 0u)]
    [InlineData(5u, uint.MaxValue - 10, 16u)]
    [InlineData(0u, uint.MaxValue, 1u)]
    [InlineData(uint.MaxValue, 0u, uint.MaxValue)]
    public void TickDeltaSurvivesThe49DayWrap(uint now, uint then, uint expected) =>
        Assert.Equal(expected, Win32Time.TickDelta(now, then));

    const long Wall = 1_792_130_412_345, Mono = 881_234_567_890;

    [Fact]
    public void BackDateMovesBothClocksByTheTickDelta()
    {
        var (wall, mono) = Win32Time.BackDate(Wall, Mono, nowTick: 10_000, eventTick: 9_400);
        Assert.Equal(Wall - 600, wall);
        Assert.Equal(Mono - 600_000, mono);
    }

    [Fact]
    public void BackDateAcrossTheWrap()
    {
        var (wall, mono) = Win32Time.BackDate(Wall, Mono, nowTick: 5, eventTick: uint.MaxValue - 10);
        Assert.Equal(Wall - 16, wall);
        Assert.Equal(Mono - 16_000, mono);
    }

    [Fact]
    public void BackDateTrustsExactlySixtySeconds()
    {
        var (wall, mono) = Win32Time.BackDate(Wall, Mono, nowTick: 100_000, eventTick: 40_000);
        Assert.Equal(Wall - 60_000, wall);
        Assert.Equal(Mono - 60_000_000, mono);
    }

    [Theory]
    [InlineData(100_000u, 39_999u)]      // 60.001 s ago
    [InlineData(100_000u, 0u)]           // far past
    [InlineData(100_000u, 100_001u)]     // 1 ms in the future
    [InlineData(100_000u, 4_000_000u)]   // far future
    [InlineData(5u, 10u)]                // future, near the wrap
    public void BackDateIgnoresUntrustworthyTicks(uint nowTick, uint eventTick)
    {
        Assert.Equal((Wall, Mono), Win32Time.BackDate(Wall, Mono, nowTick, eventTick));
    }

    [Fact]
    public void BackDateWithEqualTicksIsNow() => Assert.Equal((Wall, Mono), Win32Time.BackDate(Wall, Mono, 42, 42));
}

public class WinEventsTests
{
    const int OBJID_CLIENT = -4, OBJID_TITLEBAR = -2, OBJID_CARET = -8;

    [Fact]
    public void ConstantsMatchWinUser()
    {
        Assert.Equal(0x0003u, WinEvents.EVENT_SYSTEM_FOREGROUND);
        Assert.Equal(0x800Cu, WinEvents.EVENT_OBJECT_NAMECHANGE);
        Assert.Equal(0, WinEvents.OBJID_WINDOW);
        Assert.Equal(0, WinEvents.CHILDID_SELF);
    }

    [Fact]
    public void ForegroundWindowItselfIsATitleChange() =>
        Assert.True(WinEvents.IsForegroundTitleChange(0x1234, WinEvents.OBJID_WINDOW, WinEvents.CHILDID_SELF, 0x1234));

    [Theory]
    [InlineData(OBJID_CLIENT, 0)]
    [InlineData(OBJID_TITLEBAR, 0)]
    [InlineData(OBJID_CARET, 0)]
    [InlineData(0, 1)]
    [InlineData(0, -1)]
    [InlineData(OBJID_CLIENT, 3)]
    public void ChildObjectsOfTheForegroundWindowAreNot(int idObject, int idChild) =>
        Assert.False(WinEvents.IsForegroundTitleChange(0x1234, idObject, idChild, 0x1234));

    [Fact]
    public void OtherWindowsAreNot() =>
        Assert.False(WinEvents.IsForegroundTitleChange(0x5678, WinEvents.OBJID_WINDOW, WinEvents.CHILDID_SELF, 0x1234));

    [Fact]
    public void NullWindowIsNotEvenWhenNothingIsInFront()
    {
        Assert.False(WinEvents.IsForegroundTitleChange(0, WinEvents.OBJID_WINDOW, WinEvents.CHILDID_SELF, 0));
        Assert.False(WinEvents.IsForegroundTitleChange(0, WinEvents.OBJID_WINDOW, WinEvents.CHILDID_SELF, 0x1234));
    }
}

public class PowerTests
{
    static readonly Guid ConsoleDisplayStatus = new("6FE69556-704A-47A0-8F24-C28D936FDA47");
    static readonly Guid MonitorPowerOn = new("02731015-4510-4526-99E6-E5A17EBD1AEA");

    [Fact]
    public void ConstantsMatchWinUser()
    {
        Assert.Equal(0x4, Power.PBT_APMSUSPEND);
        Assert.Equal(0x7, Power.PBT_APMRESUMESUSPEND);
        Assert.Equal(0x12, Power.PBT_APMRESUMEAUTOMATIC);
        Assert.Equal(0x8013, Power.PBT_POWERSETTINGCHANGE);
        Assert.Equal(new Guid("2b84c20e-ad23-4ddf-93db-05ffbd7efca5"), Power.GUID_SESSION_DISPLAY_STATUS);
    }

    [Fact]
    public void Suspend() => Assert.Equal("sleep", Power.Classify(Power.PBT_APMSUSPEND));

    [Fact]
    public void ResumeAutomaticIsResume() => Assert.Equal("resume", Power.Classify(Power.PBT_APMRESUMEAUTOMATIC));

    [Fact]
    public void ResumeSuspendIsResumeUser() => Assert.Equal("resume_user", Power.Classify(Power.PBT_APMRESUMESUSPEND));

    [Fact]
    public void AutomaticThenUserResumeGivesResumeThenResumeUser()
    {
        var states = new[] { Power.PBT_APMSUSPEND, Power.PBT_APMRESUMEAUTOMATIC, Power.PBT_APMRESUMESUSPEND }.Select(p => Power.Classify(p));
        Assert.Equal(new[] { "sleep", "resume", "resume_user" }, states);
    }

    [Theory]
    [InlineData(0u, "display_off")]
    [InlineData(1u, "display_on")]
    [InlineData(2u, "display_dim")]
    public void SessionDisplayStatus(uint value, string expected) =>
        Assert.Equal(expected, Power.Classify(Power.PBT_POWERSETTINGCHANGE, Power.GUID_SESSION_DISPLAY_STATUS, value));

    [Theory]
    [InlineData(3u)]
    [InlineData(uint.MaxValue)]
    public void UnknownDisplayValuesAreIgnored(uint value) =>
        Assert.Null(Power.Classify(Power.PBT_POWERSETTINGCHANGE, Power.GUID_SESSION_DISPLAY_STATUS, value));

    [Fact]
    public void DisplayStatusWithoutAValueIsIgnored() =>
        Assert.Null(Power.Classify(Power.PBT_POWERSETTINGCHANGE, Power.GUID_SESSION_DISPLAY_STATUS, null));

    [Fact]
    public void OtherPowerSettingsAreIgnored()
    {
        Assert.Null(Power.Classify(Power.PBT_POWERSETTINGCHANGE, ConsoleDisplayStatus, 0));
        Assert.Null(Power.Classify(Power.PBT_POWERSETTINGCHANGE, MonitorPowerOn, 1));
        Assert.Null(Power.Classify(Power.PBT_POWERSETTINGCHANGE, Guid.Empty, 2));
        Assert.Null(Power.Classify(Power.PBT_POWERSETTINGCHANGE));
    }

    [Theory]
    [InlineData(0x0)]  // PBT_APMQUERYSUSPEND
    [InlineData(0x2)]  // PBT_APMQUERYSUSPENDFAILED
    [InlineData(0x6)]  // PBT_APMRESUMECRITICAL
    [InlineData(0x8)]  // PBT_APMBATTERYLOW
    [InlineData(0xA)]  // PBT_APMPOWERSTATUSCHANGE
    [InlineData(0xB)]  // PBT_APMOEMEVENT
    [InlineData(-1)]
    public void UnknownBroadcastsAreIgnored(int pbt) => Assert.Null(Power.Classify(pbt));

    [Fact]
    public void ADisplaySettingNeverChangesASuspendOrResume() =>
        Assert.Equal("sleep", Power.Classify(Power.PBT_APMSUSPEND, Power.GUID_SESSION_DISPLAY_STATUS, 1));
}

public class SessionsTests
{
    [Theory]
    [InlineData(0x1, "console_connect")]
    [InlineData(0x2, "console_disconnect")]
    [InlineData(0x3, "remote_connect")]
    [InlineData(0x4, "remote_disconnect")]
    [InlineData(0x5, "logon")]
    [InlineData(0x6, "logoff")]
    [InlineData(0x7, "locked")]
    [InlineData(0x8, "unlocked")]
    public void WtsEvents(int wts, string expected) => Assert.Equal(expected, Sessions.Classify(wts));

    [Theory]
    [InlineData(0x0)]
    [InlineData(0x9)]  // WTS_SESSION_REMOTE_CONTROL
    [InlineData(0xA)]  // WTS_SESSION_CREATE
    [InlineData(0xB)]  // WTS_SESSION_TERMINATE
    [InlineData(-1)]
    public void OtherWtsEventsAreIgnored(int wts) => Assert.Null(Sessions.Classify(wts));

    [Theory]
    [InlineData(0, "locked")]      // WTS_SESSIONSTATE_LOCK
    [InlineData(1, "unlocked")]    // WTS_SESSIONSTATE_UNLOCK
    [InlineData(-1, "unknown")]    // WTS_SESSIONSTATE_UNKNOWN (0xFFFFFFFF)
    [InlineData(2, "unknown")]
    public void SessionFlags(int flags, string expected) => Assert.Equal(expected, Sessions.FromSessionFlags(flags));
}

public class BrowsersTests
{
    [Theory]
    [InlineData("\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\" --single-argument %1", @"C:\Program Files\Google\Chrome\Application\chrome.exe")]
    [InlineData("\"C:\\Program Files\\Mozilla Firefox\\firefox.exe\" -osint -url \"%1\"", @"C:\Program Files\Mozilla Firefox\firefox.exe")]
    [InlineData("\"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe\"", @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")]
    [InlineData("   \"C:\\x\\b.exe\"  %1  ", @"C:\x\b.exe")]
    public void QuotedPathWithArgs(string command, string expected) => Assert.Equal(expected, Browsers.CommandExe(command));

    [Theory]
    [InlineData("C:\\Program Files\\Mozilla Firefox\\firefox.exe -osint -url \"%1\"", @"C:\Program Files\Mozilla Firefox\firefox.exe")]
    [InlineData("C:\\Program Files\\Some Browser\\browser.exe", @"C:\Program Files\Some Browser\browser.exe")]
    [InlineData("C:\\PROGRA~1\\Foo\\BROWSER.EXE %1", @"C:\PROGRA~1\Foo\BROWSER.EXE")]
    [InlineData("rundll32.exe \"C:\\x\\url.dll\",FileProtocolHandler %1", "rundll32.exe")]
    [InlineData("C:\\x\\browser --url %1", @"C:\x\browser")]
    public void UnquotedPath(string command, string expected) => Assert.Equal(expected, Browsers.CommandExe(command));

    // ".exe" inside a directory name is not the end of the executable path.
    [Theory]
    [InlineData("C:\\Apps\\Foo.exelent\\browser.exe --url %1", @"C:\Apps\Foo.exelent\browser.exe")]
    [InlineData("C:\\Apps\\v1.exe_files\\browser.exe", @"C:\Apps\v1.exe_files\browser.exe")]
    public void UnquotedPathWithExeInsideADirectoryName(string command, string expected) =>
        Assert.Equal(expected, Browsers.CommandExe(command));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\"")]
    [InlineData("\"\"")]
    [InlineData("\"\" --arg")]
    [InlineData("\"C:\\x\\b.exe --unterminated")]
    public void EmptyOrMalformedGivesNull(string? command) => Assert.Null(Browsers.CommandExe(command));
}
