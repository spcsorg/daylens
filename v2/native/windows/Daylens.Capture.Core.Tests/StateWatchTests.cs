using Daylens.Capture.Core;

namespace Daylens.Capture.Core.Tests;

public class StateWatchTests
{
    [Fact]
    public void AReadReportsALockOrDarkDisplayWhoseNoticeWasMissed()
    {
        var w = new StateWatch();
        Assert.Equal("display_on", w.ReadDisplay("display_on"));
        Assert.Equal("unlocked", w.ReadLock("unlocked"));
        Assert.Null(w.ReadDisplay("display_on"));
        Assert.Null(w.ReadLock("unlocked"));
        Assert.Equal("display_off", w.ReadDisplay("display_off"));
        Assert.Equal("locked", w.ReadLock("locked"));
    }

    [Fact]
    public void AStateThatCannotBeReadIsReadAgainUntilItCanAndAnUnknownLockIsReportedOnce()
    {
        var w = new StateWatch();
        Assert.Null(w.ReadDisplay(null));
        Assert.Equal("display_on", w.ReadDisplay("display_on"));
        Assert.Equal("unknown", w.ReadLock("unknown"));
        Assert.Null(w.ReadLock("unknown"));
        Assert.Equal("unlocked", w.ReadLock("unlocked"));
    }

    [Fact]
    public void ANoticeIsWhatTheNextReadIsComparedWith()
    {
        var w = new StateWatch();
        w.ReadLock("unlocked");
        w.NoteLock("locked");
        Assert.Null(w.ReadLock("locked"));
        w.NoteDisplay("display_off");
        Assert.Equal("display_on", w.ReadDisplay("display_on"));
    }
}
