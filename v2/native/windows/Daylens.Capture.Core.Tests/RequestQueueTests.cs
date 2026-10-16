using Daylens.Capture.Core;

namespace Daylens.Capture.Core.Tests;

public class RequestQueueTests
{
    const int Capacity = 256;

    static List<int> PopAll(RequestQueue<int> q)
    {
        var seen = new List<int>();
        while (q.TryPop(out var x)) seen.Add(x);
        return seen;
    }

    [Fact]
    public void OverflowWhileNotDrainedKeepsTheNewestInOrderAndRecordsTheLoss()
    {
        var q = new RequestQueue<int>(Capacity);
        for (var i = 0; i < 300; i++) q.Push(i, 1_000 + i);
        Assert.Equal(Capacity, q.Count);
        Assert.Equal(new QueueLoss(44, 1_000, 1_043), q.TakeLoss());
        Assert.Null(q.TakeLoss());
        Assert.Equal(Enumerable.Range(44, 256), PopAll(q));
    }

    [Fact]
    public void ASustainedBurstWhileBlockedWakesOnceAndStaysBounded()
    {
        var q = new RequestQueue<int>(Capacity);
        var wakes = 0;
        for (var i = 0; i < 100_000; i++)
            if (q.Push(i, i)) wakes++;
        Assert.Equal(1, wakes);
        Assert.Equal(Capacity, q.Count);
        Assert.Equal(new QueueLoss(100_000 - Capacity, 0, 100_000 - Capacity - 1), q.TakeLoss());
        Assert.Equal(Enumerable.Range(100_000 - Capacity, Capacity), PopAll(q));
        Assert.True(q.Push(1, 1), "after the queue drains, the next push wakes the worker again");
    }

    [Fact]
    public void AbandonedWorkCountsAsLostAndJoinsAnEarlierLoss()
    {
        var q = new RequestQueue<int>(2);
        q.Push(1, 10);
        q.Push(2, 20);
        q.Push(3, 30);
        q.Clear();
        Assert.Equal(new QueueLoss(3, 10, 30), q.TakeLoss());
        Assert.False(q.TryPop(out _));
    }

    [Fact]
    public void DiscardedInFlightWorkCountsAsLost()
    {
        var q = new RequestQueue<int>(Capacity);
        q.CountLost(50);
        q.CountLost(40);
        Assert.Equal(new QueueLoss(2, 40, 50), q.TakeLoss());
    }

    [Fact]
    public void LossIsReportedBeforeTheWorkThatFollowsIt()
    {
        var q = new RequestQueue<int>(2);
        foreach (var i in new[] { 1, 2, 3, 4 }) q.Push(i, i * 10);
        var events = new List<string>();
        q.Drain(x => events.Add($"item {x}"), l => events.Add($"loss {l.Count} {l.FromWallMs}-{l.ToWallMs}"));
        Assert.Equal(["loss 2 10-20", "item 3", "item 4"], events);
    }

    // The worker's first item blocks (a hung native call). Work piles up, overflows, then the worker is released.
    [Fact]
    public void BlockedWorkerOverflowThenReleaseReportsTheLossOnceAndKeepsTheNewest()
    {
        var q = new RequestQueue<int>(Capacity);
        var events = new List<string>();
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var wake = new AutoResetEvent(false);
        using var done = new ManualResetEventSlim();
        var worker = new Thread(() =>
        {
            wake.WaitOne();
            q.Drain(
                x =>
                {
                    if (x == 0) { entered.Set(); release.Wait(); }
                    lock (events) events.Add($"item {x}");
                },
                l => { lock (events) events.Add($"loss {l.Count} {l.FromWallMs}-{l.ToWallMs}"); });
            done.Set();
        }) { IsBackground = true };
        worker.Start();

        Assert.True(q.Push(0, 0));
        wake.Set();
        Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));

        var wakes = 0;
        for (var i = 1; i <= 10_000; i++)
            if (q.Push(i, 1_000 + i)) wakes++;
        Assert.Equal(0, wakes);
        Assert.Equal(Capacity, q.Count);

        release.Set();
        Assert.True(done.Wait(TimeSpan.FromSeconds(10)));

        var lost = 10_000 - Capacity;
        string[] expected =
        [
            "item 0",
            $"loss {lost} 1001-{1_000 + lost}",
            .. Enumerable.Range(lost + 1, Capacity).Select(i => $"item {i}"),
        ];
        Assert.Equal(expected, events);
        Assert.Null(q.TakeLoss());
        Assert.True(q.Push(1, 1), "the drain ended, so the next push wakes the worker");
    }

    // Abandon while the worker is stuck: queued work and the stuck item are lost; the loss line follows the release.
    [Fact]
    public void AbandonWhileBlockedReportsQueuedAndStuckWorkAfterRelease()
    {
        var q = new RequestQueue<int>(Capacity);
        var events = new List<string>();
        var abandoned = false;
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var worker = new Thread(() => q.Drain(
            x =>
            {
                if (x == 0) { entered.Set(); release.Wait(); }
                if (Volatile.Read(ref abandoned)) { q.CountLost(x * 100); return; }
                lock (events) events.Add($"item {x}");
            },
            l => { lock (events) events.Add($"loss {l.Count} {l.FromWallMs}-{l.ToWallMs}"); })) { IsBackground = true };

        q.Push(0, 0);
        worker.Start();
        Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
        for (var i = 1; i <= 10; i++) q.Push(i, i * 100);
        Volatile.Write(ref abandoned, true);
        q.Clear();
        release.Set();
        Assert.True(worker.Join(TimeSpan.FromSeconds(10)));

        Assert.Equal(["loss 11 0-1000"], events);
    }
}
