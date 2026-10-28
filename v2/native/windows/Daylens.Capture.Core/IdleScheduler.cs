namespace Daylens.Capture.Core;

/// Decides when to look at idle time next. There is no OS event for "became idle", so the helper
/// checks once at the moment idleness could first be reached, and briefly while already idle.
public sealed class IdleScheduler(double thresholdS, double idlePollS = 2)
{
    public bool? Idle { get; private set; }

    /// Set at a resume, by the monotonic clock; cleared by the first input after it. A short sleep never crosses the
    /// idle threshold, so without this the user coming back would produce no line at all. A change of the wall clock
    /// does not move input from before the resume to after it.
    public long? ResumeBoundaryUs { get; private set; }

    public readonly record struct Decision(bool? Emit, double NextCheckS, bool Returned = false);

    public Decision Evaluate(double secondsSinceInput, long nowMonoUs = 0)
    {
        var nowIdle = secondsSinceInput >= thresholdS;
        var changed = Idle != nowIdle;
        Idle = nowIdle;
        var next = nowIdle ? idlePollS : Math.Max(0.5, thresholdS - secondsSinceInput + 0.25);
        var returned = false;
        if (ResumeBoundaryUs is long boundary)
        {
            // Any input after the resume is the return, however soon after waking it came.
            if (nowMonoUs - (long)(secondsSinceInput * 1_000_000) > boundary)
            {
                returned = true;
                ResumeBoundaryUs = null;
            }
            else next = Math.Min(next, idlePollS);
        }
        return new Decision(changed ? nowIdle : null, next, returned);
    }

    public void Reset() => Idle = null;

    public void MarkResume(long monoUs) => ResumeBoundaryUs = monoUs;
}
