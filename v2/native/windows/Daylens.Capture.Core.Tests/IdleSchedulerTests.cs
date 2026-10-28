using Daylens.Capture.Core;

namespace Daylens.Capture.Core.Tests;

// Mirrors v2/native/macos/Tests/CaptureCoreTests/CaptureCoreTests.swift so both helpers schedule idle checks the same way.
public class IdleSchedulerTests
{
    const double Precision = 0.01;

    [Fact]
    public void ChecksOnlyWhenIdleCouldBeReached()
    {
        var s = new IdleScheduler(120);
        var d = s.Evaluate(10);
        Assert.False(d.Emit); // first look reports the state
        Assert.Equal(110.25, d.NextCheckS, Precision);
        d = s.Evaluate(5);
        Assert.Null(d.Emit); // still active: nothing to say
        Assert.Equal(115.25, d.NextCheckS, Precision);
        d = s.Evaluate(121);
        Assert.True(d.Emit);
        Assert.Equal(2, d.NextCheckS);
        d = s.Evaluate(400);
        Assert.Null(d.Emit);
        d = s.Evaluate(0.3);
        Assert.False(d.Emit); // input after idle is reported
        s.Reset();
        Assert.False(s.Evaluate(0).Emit); // after a reset the state is reported again
    }

    [Fact]
    public void ActiveChecksNeverSpinFasterThanHalfASecond()
    {
        var s = new IdleScheduler(120);
        Assert.Equal(0.5, s.Evaluate(119.99).NextCheckS);
        Assert.Equal(0.5, new IdleScheduler(120).Evaluate(119.75).NextCheckS);
        Assert.Equal(0.75, new IdleScheduler(120).Evaluate(119.5).NextCheckS, Precision);
    }

    [Fact]
    public void FirstEvaluationReportsIdleWhenAlreadyIdle()
    {
        var s = new IdleScheduler(120);
        var d = s.Evaluate(500);
        Assert.True(d.Emit);
        Assert.Equal(2, d.NextCheckS);
        Assert.True(s.Idle);
    }

    [Fact]
    public void ThresholdItselfCountsAsIdle()
    {
        var s = new IdleScheduler(120);
        Assert.False(s.Evaluate(119.999).Emit);
        Assert.True(s.Evaluate(120).Emit);
    }

    [Fact]
    public void IdlePollIntervalIsConfigurable()
    {
        var s = new IdleScheduler(60, idlePollS: 5);
        Assert.Equal(5, s.Evaluate(61).NextCheckS);
        Assert.Equal(5, s.Evaluate(1_000).NextCheckS);
    }

    [Fact]
    public void ResetForgetsStateAndReportsIdleAgain()
    {
        var s = new IdleScheduler(120);
        Assert.True(s.Evaluate(200).Emit);
        Assert.Null(s.Evaluate(300).Emit);
        s.Reset();
        Assert.Null(s.Idle);
        Assert.True(s.Evaluate(300).Emit);
    }

    [Fact]
    public void StateIsUnknownBeforeTheFirstEvaluation() => Assert.Null(new IdleScheduler(120).Idle);
}
