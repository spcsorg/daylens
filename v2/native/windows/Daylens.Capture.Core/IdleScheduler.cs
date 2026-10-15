namespace Daylens.Capture.Core;

/// Decides when to look at idle time next. There is no OS event for "became idle", so the helper
/// checks once at the moment idleness could first be reached, and briefly while already idle.
public sealed class IdleScheduler(double thresholdS, double idlePollS = 2)
{
    public bool? Idle { get; private set; }

    public readonly record struct Decision(bool? Emit, double NextCheckS);

    public Decision Evaluate(double secondsSinceInput)
    {
        var nowIdle = secondsSinceInput >= thresholdS;
        var changed = Idle != nowIdle;
        Idle = nowIdle;
        var next = nowIdle ? idlePollS : Math.Max(0.5, thresholdS - secondsSinceInput + 0.25);
        return new Decision(changed ? nowIdle : null, next);
    }

    public void Reset() => Idle = null;
}
