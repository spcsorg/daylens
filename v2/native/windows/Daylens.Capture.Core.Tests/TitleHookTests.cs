using Daylens.Capture.Core;
using Xunit;

public class TitleHookTests
{
    [Fact]
    public void AFailedHookIsRetriedWithBackoffAndReportedDegradedUntilItWorks()
    {
        var h = new TitleHookState();
        h.Attempted(42, false, 0);
        Assert.True(h.Degraded);
        Assert.Equal(ChannelState.Degraded, TitleChannel.State(0, h.Degraded));
        Assert.False(h.ShouldRetry(42, 999));
        Assert.True(h.ShouldRetry(42, 1_000));
        h.Attempted(42, false, 1_000);
        Assert.Equal(2_000, h.NextDelayMs(1_000));
        h.Attempted(42, false, 3_000);
        Assert.Equal(4_000, h.NextDelayMs(3_000));
        h.Attempted(42, true, 7_000);
        Assert.False(h.Degraded);
        Assert.Null(h.NextDelayMs(7_000));
        Assert.Equal(ChannelState.Ok, TitleChannel.State(0, h.Degraded));
    }

    [Fact]
    public void BackoffIsCappedAndRestartsForANewForegroundProcess()
    {
        var h = new TitleHookState();
        long t = 0;
        for (var i = 0; i < 10; i++) { h.Attempted(7, false, t); t += h.NextDelayMs(t)!.Value; }
        Assert.Equal(30_000, h.NextDelayMs(t - 30_000));
        h.Attempted(8, false, t);
        Assert.Equal(1_000, h.NextDelayMs(t));
        Assert.False(h.ShouldRetry(7, t + 5_000), "a process no longer in front is not retried");
    }

    [Fact]
    public void NothingInFrontIsNotDegraded()
    {
        var h = new TitleHookState();
        h.Attempted(0, false, 0);
        Assert.False(h.Degraded);
    }

    [Fact]
    public void AStuckResolverOutranksAMissingHook() =>
        Assert.Equal(ChannelState.Stalled, TitleChannel.State(5_000, true));
}
