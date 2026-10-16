using Daylens.Capture.Core;
using Xunit;

public class ResumeReturnTests
{
    [Fact]
    public void AShortSleepStillReportsTheUserComingBack()
    {
        var s = new IdleScheduler(120);
        const long resume = 1_000_000;
        s.Evaluate(5, resume - 1000);
        s.Reset();
        s.MarkResume(resume);
        var d = s.Evaluate(30, resume + 500);
        Assert.Equal(false, d.Emit);
        Assert.False(d.Returned);
        Assert.Equal(2, d.NextCheckS);
        Assert.False(s.Evaluate(1, resume + 1_500).Returned);
        d = s.Evaluate(0.2, resume + 9_000);
        Assert.Null(d.Emit);
        Assert.True(d.Returned);
        Assert.True(d.NextCheckS > 100);
        Assert.False(s.Evaluate(0.1, resume + 20_000).Returned);
    }
}
