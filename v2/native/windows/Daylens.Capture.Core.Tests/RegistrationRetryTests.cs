using Daylens.Capture.Core;
using Source = Daylens.Capture.Core.RegistrationRetry.Source;

namespace Daylens.Capture.Core.Tests;

public class RegistrationRetryTests
{
    /// Drives the retry the way Program does: run, then wake when the returned delay elapses.
    sealed class Harness(Func<Source, int, bool> succeeds)
    {
        public readonly RegistrationRetry Retry = new();
        public readonly List<(Source Source, long AtMs)> Attempts = [];
        public long NowMs;

        public RegistrationRetry.Result Run() => Retry.Run(NowMs, s =>
        {
            var n = Attempts.Count(a => a.Source == s);
            Attempts.Add((s, NowMs));
            return succeeds(s, n);
        });

        public long[] AttemptTimes(Source s) => Attempts.Where(a => a.Source == s).Select(a => a.AtMs).ToArray();
    }

    [Fact]
    public void FirstRunAttemptsEverySourceAndAllSucceeding()
    {
        var h = new Harness((_, _) => true);
        var r = h.Run();
        Assert.Equal(Enum.GetValues<Source>(), h.Attempts.Select(a => a.Source).ToArray());
        Assert.Empty(r.Recovered);
        Assert.False(r.SnapshotSession, "the startup snapshot already covers the first registration");
        Assert.Null(r.NextDelayMs);
        Assert.Equal(new Registrations(true, true, true), h.Retry.Report());
    }

    [Fact]
    public void SessionFailsOnceThenSucceeds()
    {
        var h = new Harness((s, n) => s != Source.Session || n >= 1);

        var first = h.Run();
        Assert.Equal(5_000, first.NextDelayMs);
        Assert.False(first.SnapshotSession);
        Assert.Equal(new Registrations(Focus: true, Session: false, Power: true), h.Retry.Report());

        h.NowMs = first.NextDelayMs!.Value;
        var second = h.Run();
        Assert.Equal([Source.Session], second.Recovered);
        Assert.True(second.SnapshotSession);
        Assert.Null(second.NextDelayMs);
        Assert.Equal(new Registrations(true, true, true), h.Retry.Report());

        Assert.Equal([0L, 5_000L], h.AttemptTimes(Source.Session));
        foreach (var s in new[] { Source.Focus, Source.Power, Source.Display }) Assert.Equal([0L], h.AttemptTimes(s));
    }

    [Fact]
    public void PersistentFailureBacksOffFromFiveToSixtySeconds()
    {
        var h = new Harness((s, _) => s != Source.Power);
        for (var i = 0; i < 9; i++)
        {
            var r = h.Run();
            Assert.False(h.Retry.Report().Power);
            h.NowMs += r.NextDelayMs!.Value;
        }
        // Delays 5, 10, 20, 40, then capped at 60.
        Assert.Equal([0L, 5_000, 15_000, 35_000, 75_000, 135_000, 195_000, 255_000, 315_000], h.AttemptTimes(Source.Power));
        Assert.Equal([0L], h.AttemptTimes(Source.Focus));
    }

    [Fact]
    public void EarlyWakeAttemptsNothingAndReportsTheRemainingWait()
    {
        var h = new Harness((s, n) => s != Source.Focus || n >= 1);
        h.Run();
        h.NowMs = 4_000;
        var r = h.Run();
        Assert.Equal(1_000, r.NextDelayMs);
        Assert.Single(h.AttemptTimes(Source.Focus));
        Assert.False(h.Retry.Report().Focus);
    }

    [Fact]
    public void LateWakeBacksOffFromTheActualAttempt()
    {
        var h = new Harness((s, _) => s != Source.Session);
        h.Run();
        h.NowMs = 7_000;
        Assert.Equal(10_000, h.Run().NextDelayMs);
        Assert.Equal([0L, 7_000], h.AttemptTimes(Source.Session));
    }

    [Fact]
    public void SourcesBackOffIndependentlyAndTheTimerFollowsTheEarliest()
    {
        // Focus fails twice, session fails throughout.
        var h = new Harness((s, n) => s == Source.Focus ? n >= 2 : s != Source.Session);
        var r = h.Run();
        Assert.Equal(5_000, r.NextDelayMs);
        h.NowMs = 5_000;
        r = h.Run();
        Assert.Equal(10_000, r.NextDelayMs);
        h.NowMs = 15_000;
        r = h.Run();
        Assert.Equal([Source.Focus], r.Recovered);
        Assert.False(r.SnapshotSession);
        Assert.Equal(20_000, r.NextDelayMs);
        Assert.Equal(new Registrations(Focus: true, Session: false, Power: true), h.Retry.Report());
    }

    [Fact]
    public void FailedDisplayRegistrationIsRetriedButNotReportedAsPower()
    {
        var h = new Harness((s, _) => s != Source.Display);
        var r = h.Run();
        Assert.Equal(5_000, r.NextDelayMs);
        Assert.Equal(new Registrations(true, true, true), h.Retry.Report());
        Assert.False(h.Retry.IsRegistered(Source.Display));
    }
}
