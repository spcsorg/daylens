namespace Daylens.Capture.Core;

/// The display and lock state last reported, so a periodic read reports only a change: a notice can be missed while
/// the machine stays awake, and a state that could not be read is read again until it can be. Main thread only.
public sealed class StateWatch
{
    public string? Display { get; private set; }
    public string? Lock { get; private set; }

    /// A read of the display ("display_on", "display_off", "display_dim"; null when it cannot be read): the state to report, or null.
    /// A read that fails is reported once as "display_unknown", so the service stops recording until one succeeds.
    public string? ReadDisplay(string? state)
    {
        var read = state ?? "display_unknown";
        if (read == Display) return null;
        Display = read;
        return read;
    }

    public void NoteDisplay(string state) => Display = state;

    /// A read of the lock ("locked", "unlocked" or "unknown"): the state to report, or null.
    public string? ReadLock(string state)
    {
        if (state == Lock) return null;
        Lock = state;
        return state;
    }

    public void NoteLock(string state) => Lock = state;
}
