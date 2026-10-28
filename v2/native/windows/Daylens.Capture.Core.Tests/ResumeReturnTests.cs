using Daylens.Capture.Core;
using Xunit;

public class ResumeReturnTests
{
    [Fact]
    public void AShortSleepStillReportsTheUserComingBack()
    {
        var s = new IdleScheduler(120);
        const long resume = 1_000_000_000;
        s.Evaluate(5, resume - 1_000_000);
        s.Reset();
        s.MarkResume(resume);
        var d = s.Evaluate(30, resume + 500_000);
        Assert.Equal(false, d.Emit);
        Assert.False(d.Returned);
        Assert.Equal(2, d.NextCheckS);
        d = s.Evaluate(0.2, resume + 9_000_000);
        Assert.Null(d.Emit);
        Assert.True(d.Returned);
        Assert.True(d.NextCheckS > 100);
        Assert.False(s.Evaluate(0.1, resume + 20_000_000).Returned);
    }

    [Fact]
    public void TypingOneSecondAfterWakingThenReadingIsStillAReturn()
    {
        var s = new IdleScheduler(120);
        const long resume = 1_000_000_000;
        s.Reset();
        s.MarkResume(resume);
        s.Evaluate(40, resume + 200_000);
        Assert.True(s.Evaluate(2, resume + 3_000_000).Returned);
    }

    [Fact]
    public void InputFromBeforeTheResumeIsNotTheReturnWhateverTheWallClockDid()
    {
        // Last input at 90 s, resume at 100 s, then the wall clock is moved a minute forward: by the monotonic clock the
        // input 12 s before 102 s is still before the resume, and the real return at 103 s is still to come.
        var s = new IdleScheduler(120);
        s.MarkResume(100_000_000);
        Assert.False(s.Evaluate(12, 102_000_000).Returned);
        Assert.True(s.Evaluate(1, 104_000_000).Returned);
    }
}
