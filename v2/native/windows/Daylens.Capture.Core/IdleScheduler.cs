namespace Daylens.Capture.Core;

/// Decides when to look at idle time next. There is no OS event for "became idle", so the helper
/// checks once at the moment idleness could first be reached, and briefly while already idle.
public sealed class IdleScheduler(double thresholdS, double idlePollS = 2)
{
    public bool? Idle { get; private set; }

    /// Set at a resume; cleared by the first input after it. A short sleep never crosses the idle threshold,
    /// so without this the user coming back would produce no line at all.
    public long? ResumeBoundaryMs { get; private set; }

    /// Waking the machine can itself count as input at the boundary; only input clearly after it is a return.
    public const long ReturnMarginMs = 2000;

    public readonly record struct Decision(bool? Emit, double NextCheckS, bool Returned = false);

    public Decision Evaluate(double secondsSinceInput, long nowWallMs = 0)
    {
        var nowIdle = secondsSinceInput >= thresholdS;
        var changed = Idle != nowIdle;
        Idle = nowIdle;
        var next = nowIdle ? idlePollS : Math.Max(0.5, thresholdS - secondsSinceInput + 0.25);
        var returned = false;
        if (ResumeBoundaryMs is long boundary)
        {
            if (nowWallMs - (long)(secondsSinceInput * 1000) > boundary + ReturnMarginMs)
            {
                returned = true;
                ResumeBoundaryMs = null;
            }
            else next = Math.Min(next, idlePollS);
        }
        return new Decision(changed ? nowIdle : null, next, returned);
    }

    public void Reset() => Idle = null;

    public void MarkResume(long wallMs) => ResumeBoundaryMs = wallMs;
}
