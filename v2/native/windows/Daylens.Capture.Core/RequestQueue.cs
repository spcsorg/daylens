namespace Daylens.Capture.Core;

public readonly record struct QueueLoss(int Count, long FromWallMs, long ToWallMs);

/// A bounded FIFO between producers and one worker, ported from the macOS helper. Drops are recorded with
/// their time range so they can be reported (they happen before any line exists, so no seq shows them),
/// and at most one drain is ever pending.
public sealed class RequestQueue<T>(int capacity)
{
    readonly object _gate = new();
    readonly Queue<(T Item, long WallMs)> _items = new();
    bool _drainPending;
    QueueLoss? _loss;

    public int Count { get { lock (_gate) return _items.Count; } }

    /// Drops the oldest item when full. Returns true when the caller must wake the worker; false when a drain is already pending.
    public bool Push(T item, long wallMs)
    {
        lock (_gate)
        {
            if (_items.Count >= capacity) Record(_items.Dequeue().WallMs);
            _items.Enqueue((item, wallMs));
            if (_drainPending) return false;
            _drainPending = true;
            return true;
        }
    }

    /// The next item; false when empty, which also ends the pending drain.
    public bool TryPop(out T item)
    {
        lock (_gate)
        {
            if (_items.TryDequeue(out var e))
            {
                item = e.Item;
                return true;
            }
            _drainPending = false;
            item = default!;
            return false;
        }
    }

    /// Everything still queued is abandoned and counted as lost.
    public void Clear()
    {
        lock (_gate)
        {
            while (_items.TryDequeue(out var e)) Record(e.WallMs);
        }
    }

    /// Counts work the worker took but then discarded.
    public void CountLost(long wallMs)
    {
        lock (_gate) Record(wallMs);
    }

    public QueueLoss? TakeLoss()
    {
        lock (_gate)
        {
            var l = _loss;
            _loss = null;
            return l;
        }
    }

    /// One drain, run by the worker after a wake: items in order, each loss reported before the item that follows it, and once more at the end.
    public void Drain(Action<T> handle, Action<QueueLoss> reportLoss)
    {
        while (TryPop(out var item))
        {
            if (TakeLoss() is { } l) reportLoss(l);
            handle(item);
        }
        if (TakeLoss() is { } last) reportLoss(last);
    }

    void Record(long wallMs) =>
        _loss = _loss is { } l
            ? new QueueLoss(l.Count + 1, Math.Min(l.FromWallMs, wallMs), Math.Max(l.ToWallMs, wallMs))
            : new QueueLoss(1, wallMs, wallMs);
}
