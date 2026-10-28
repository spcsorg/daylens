namespace Daylens.Capture.Core;

/// The title-change hook is installed per foreground process. A failed install is retried with backoff
/// for as long as that process stays in front, and title coverage is reported degraded until it works.
public sealed class TitleHookState(long firstDelayMs = 1_000, long maxDelayMs = 30_000)
{
    int _pid;
    bool _hooked;
    long _dueMs;
    long _delayMs;

    public bool Degraded => _pid != 0 && !_hooked;

    /// Records an install attempt for the process now in front; a new process starts its backoff afresh.
    public void Attempted(int pid, bool ok, long nowMs)
    {
        if (pid != _pid)
        {
            _pid = pid;
            _delayMs = 0;
        }
        _hooked = ok || pid == 0;
        if (_hooked) return;
        _delayMs = _delayMs == 0 ? firstDelayMs : Math.Min(_delayMs * 2, maxDelayMs);
        _dueMs = nowMs + _delayMs;
    }

    public bool ShouldRetry(int pid, long nowMs) => pid == _pid && Degraded && nowMs >= _dueMs;

    public long? NextDelayMs(long nowMs) => Degraded ? Math.Max(1, _dueMs - nowMs) : null;
}

public static class TitleChannel
{
    public const long StalledAfterMs = 3_000;

    public static ChannelState State(long resolverStallMs, bool hookDegraded) =>
        resolverStallMs > StalledAfterMs ? ChannelState.Stalled : hookDegraded ? ChannelState.Degraded : ChannelState.Ok;
}
