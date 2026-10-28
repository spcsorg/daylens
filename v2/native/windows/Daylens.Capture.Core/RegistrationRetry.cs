namespace Daylens.Capture.Core;

/// Retries event-source registrations that failed (WTS registration can fail early in boot), backing off
/// from the first delay to the maximum. Not thread-safe: the helper uses it from its main thread only.
public sealed class RegistrationRetry(long firstDelayMs = 5_000, long maxDelayMs = 60_000)
{
    /// Display status is retried like the others but not reported; power means suspend/resume.
    public enum Source { Focus, Session, Power, Display }

    /// Recovered: sources that just succeeded after failing. NextDelayMs: when to run again, null when all are registered.
    public readonly record struct Result(IReadOnlyList<Source> Recovered, long? NextDelayMs)
    {
        /// Lock and unlock notices were missed while session registration was missing.
        public bool SnapshotSession => Recovered.Contains(Source.Session);
    }

    struct Slot
    {
        public bool Attempted, Registered;
        public long DueMs, DelayMs;
    }

    readonly Slot[] _slots = new Slot[Enum.GetValues<Source>().Length];

    public bool IsRegistered(Source s) => _slots[(int)s].Registered;

    public Registrations Report() => new(IsRegistered(Source.Focus), IsRegistered(Source.Session), IsRegistered(Source.Power));

    /// Attempts every source that is due: all of them on the first run, then each failed one on its own backoff.
    public Result Run(long nowMs, Func<Source, bool> register)
    {
        var recovered = new List<Source>();
        long? next = null;
        for (var i = 0; i < _slots.Length; i++)
        {
            ref var slot = ref _slots[i];
            if (slot.Registered) continue;
            if (!slot.Attempted || nowMs >= slot.DueMs)
            {
                var ok = register((Source)i);
                if (ok && slot.Attempted) recovered.Add((Source)i);
                if (ok) slot.Registered = true;
                else
                {
                    slot.DelayMs = slot.Attempted ? Math.Min(slot.DelayMs * 2, maxDelayMs) : firstDelayMs;
                    slot.DueMs = nowMs + slot.DelayMs;
                }
                slot.Attempted = true;
                if (slot.Registered) continue;
            }
            var wait = Math.Max(1, slot.DueMs - nowMs);
            next = next is long n ? Math.Min(n, wait) : wait;
        }
        return new Result(recovered, next);
    }
}
