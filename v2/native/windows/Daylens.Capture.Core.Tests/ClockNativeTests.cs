using System.Runtime.Versioning;
using Daylens.Capture.Windows;

[SupportedOSPlatform("windows")]
public class ClockNativeTests
{
    [WindowsTheory]
    [InlineData(1)]
    [InlineData(5)]
    public void NativeClockReadsWallMonotonicAndAwakeTime(int samples)
    {
        var previous = Clock.MonoUs();
        for (var i = 0; i < samples; i++)
        {
            var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var wall = Clock.WallMs();
            var after = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Assert.InRange(wall, before - 1000, after + 1000);
            var mono = Clock.MonoUs();
            Assert.True(mono >= previous);
            previous = mono;
            var awake = Clock.AwakeUs();
            Assert.InRange(awake, 0, Clock.MonoUs());
        }
    }
}
