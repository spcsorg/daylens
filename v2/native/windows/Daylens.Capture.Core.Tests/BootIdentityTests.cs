using Daylens.Capture.Core;
using Xunit;

public class BootIdentityTests
{
    const long Wall = 1_792_130_412_345;
    const long Mono = 7_200_000_000; // two hours of uptime, in microseconds

    [Fact]
    public void TheKernelCounterSurvivesTheClockBeingSetBackAnHour()
    {
        var before = BootIdentity.Compute(812, Wall, Mono);
        var after = BootIdentity.Compute(812, Wall - 3_600_000 + 2_000, Mono + 2_000_000);
        Assert.Equal(before, after);
    }

    [Fact]
    public void TheClockFormulaAloneWouldNotSurviveIt()
    {
        // The reason the counter is preferred: wall minus uptime moves with the wall clock.
        var before = BootIdentity.Compute(null, Wall, Mono);
        var after = BootIdentity.Compute(null, Wall - 3_600_000 + 2_000, Mono + 2_000_000);
        Assert.NotEqual(before, after);
    }

    [Fact]
    public void ANewBootIsANewIdentity() =>
        Assert.NotEqual(BootIdentity.Compute(812, Wall, Mono), BootIdentity.Compute(813, Wall + 60_000, 5_000_000));

    [Fact]
    public void WithoutAClockChangeTheFallbackIsStableAcrossHelperRestarts() =>
        Assert.Equal(BootIdentity.Compute(null, Wall, Mono), BootIdentity.Compute(null, Wall + 30_000, Mono + 30_000_000));
}
