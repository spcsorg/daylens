using System.Diagnostics;
using System.Text.Json;
using Daylens.Capture.Core;
using static Daylens.Capture.Core.Tests.TestSupport;

namespace Daylens.Capture.Core.Tests;

public class EmitterTests
{
    static readonly TimeSpan Long = TimeSpan.FromSeconds(30);

    /// A writer that can be held shut, so the queue fills deterministically.
    sealed class Sink
    {
        readonly object _lock = new();
        readonly List<byte[]> _lines = new();
        public readonly ManualResetEventSlim Open = new(true);
        public readonly ManualResetEventSlim Entered = new(false);
        public Action? OnWrite;

        public void Write(byte[] line)
        {
            Entered.Set();
            Assert.True(Open.Wait(Long), "test never released the writer");
            OnWrite?.Invoke();
            lock (_lock) _lines.Add(line);
        }

        public List<byte[]> Lines { get { lock (_lock) return [.. _lines]; } }
        public long[] Seqs() => Lines.Select(l => JsonDocument.Parse(l).RootElement.GetProperty("seq").GetInt64()).ToArray();
    }

    static Emitter Make(Sink sink, int capacity = 1024, int reserve = 64) => new("run-0001", "boot-0001", "windows", sink.Write, capacity, reserve);

    static void Normal(Emitter e) => e.Emit("focus", "win_event", Time, Obs.Power("x"), Emitter.Priority.Normal);
    static void Critical(Emitter e) => e.Emit("power", "power", Time, Obs.Power("x"), Emitter.Priority.Critical);

    /// Holds the writer inside its first write, so exactly one line is in flight.
    static void HoldWriterOnFirstLine(Sink sink, Emitter e)
    {
        sink.Open.Reset();
        Normal(e);
        Assert.True(sink.Entered.Wait(Long));
    }

    [Fact]
    public void LinesCarryEnvelopeAndStartAtSeqZero()
    {
        var sink = new Sink();
        var e = Make(sink);
        Normal(e);
        Critical(e);
        e.Flush(Long);
        Assert.Equal(new long[] { 0, 1 }, sink.Seqs());
        foreach (var line in sink.Lines)
        {
            var obj = AssertSingleValidLine(line);
            Assert.Equal("run-0001", obj["run"]!.GetValue<string>());
            Assert.Equal("boot-0001", obj["boot"]!.GetValue<string>());
            Assert.Equal("windows", obj["platform"]!.GetValue<string>());
        }
    }

    // Same scenario as the Swift test: writer stalled, capacity 2, reserve 1, five normal then two critical.
    [Fact]
    public void MatchesSwiftEmitterWhenTheWriterStallsBeforeTheFirstLine()
    {
        var sink = new Sink();
        sink.Open.Reset();
        var e = Make(sink, capacity: 2, reserve: 1);
        for (var i = 0; i < 5; i++) Normal(e);
        Critical(e);
        Critical(e);
        sink.Open.Set();
        e.Flush(Long);
        Assert.Equal(new long[] { 0, 1, 5 }, sink.Seqs());
        Assert.Equal(4, e.Dropped);
    }

    // The line being written counts against capacity, so the outcome does not depend on whether the writer
    // thread had already picked up the first line.
    [Fact]
    public void LineInFlightCountsAgainstCapacity()
    {
        var sink = new Sink();
        var e = Make(sink, capacity: 2, reserve: 1);
        HoldWriterOnFirstLine(sink, e);
        for (var i = 0; i < 4; i++) Normal(e);
        Critical(e);
        Critical(e);
        sink.Open.Set();
        e.Flush(Long);
        Assert.Equal(new long[] { 0, 1, 5 }, sink.Seqs());
        Assert.Equal(4, e.Dropped);
    }

    [Fact]
    public void SeqIsAssignedToDroppedLinesSoLossShowsAsAJump()
    {
        var sink = new Sink();
        var e = Make(sink, capacity: 1, reserve: 0);
        HoldWriterOnFirstLine(sink, e);
        for (var i = 0; i < 9; i++) Normal(e);
        Critical(e);
        Assert.Equal(10, e.Dropped);
        sink.Open.Set();
        e.Flush(Long);
        Normal(e);
        e.Flush(Long);
        Assert.Equal(new long[] { 0, 11 }, sink.Seqs());
        Assert.Equal(10, e.Dropped);
    }

    [Fact]
    public void NormalLinesDropFirstAndCriticalLinesUseTheReserve()
    {
        var sink = new Sink();
        var e = Make(sink, capacity: 3, reserve: 2);
        HoldWriterOnFirstLine(sink, e); // seq 0, in flight
        Normal(e);                      // seq 1, queued: capacity now full
        Normal(e);                      // seq 2
        Normal(e);                      // seq 3 dropped: normal lines never use the reserve
        Critical(e);                    // seq 4 takes the reserve
        Normal(e);                      // seq 5 dropped
        Critical(e);                    // seq 6 takes the last reserve slot
        Critical(e);                    // seq 7 dropped: reserve exhausted
        Assert.Equal(3, e.Dropped);
        sink.Open.Set();
        e.Flush(Long);
        Assert.Equal(new long[] { 0, 1, 2, 4, 6 }, sink.Seqs());
    }

    [Fact]
    public void QueueRecoversAfterDraining()
    {
        var sink = new Sink();
        var e = Make(sink, capacity: 1, reserve: 0);
        HoldWriterOnFirstLine(sink, e);
        Normal(e);
        sink.Open.Set();
        e.Flush(Long);
        for (var i = 0; i < 5; i++) { Normal(e); e.Flush(Long); }
        Assert.Equal(new long[] { 0, 2, 3, 4, 5, 6 }, sink.Seqs());
        Assert.Equal(1, e.Dropped);
    }

    [Fact]
    public void FlushWaitsUntilEveryQueuedLineIsWritten()
    {
        var sink = new Sink { OnWrite = () => Thread.Sleep(2) };
        var e = Make(sink);
        for (var i = 0; i < 50; i++) Normal(e);
        e.Flush(Long);
        Assert.Equal(50, sink.Lines.Count);
    }

    [Fact]
    public void FlushGivesUpAtTheTimeoutWhenTheReaderIsStuck()
    {
        var sink = new Sink();
        var e = Make(sink);
        HoldWriterOnFirstLine(sink, e);
        Normal(e);
        var sw = Stopwatch.StartNew();
        e.Flush(TimeSpan.FromMilliseconds(200));
        sw.Stop();
        Assert.InRange(sw.ElapsedMilliseconds, 150, 5_000);
        Assert.Empty(sink.Lines);
        sink.Open.Set();
        e.Flush(Long);
        Assert.Equal(2, sink.Lines.Count);
    }

    [Fact]
    public void EmitNeverBlocksOnAStalledReader()
    {
        var sink = new Sink();
        var e = Make(sink, capacity: 16, reserve: 4);
        HoldWriterOnFirstLine(sink, e);
        var sw = Stopwatch.StartNew();
        for (var i = 0; i < 10_000; i++) Normal(e);
        sw.Stop();
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(10), $"emits took {sw.Elapsed}");
        Assert.Equal(10_000 - 15, e.Dropped);
        sink.Open.Set();
    }

    static Action<Utf8JsonWriter> Tagged(int thread, int n) => w =>
    {
        w.WriteNumber("thread", thread);
        w.WriteNumber("n", n);
    };

    static (long Seq, int Thread, int N) Parse(byte[] line)
    {
        var root = JsonDocument.Parse(line).RootElement;
        var obs = root.GetProperty("obs");
        return (root.GetProperty("seq").GetInt64(), obs.GetProperty("thread").GetInt32(), obs.GetProperty("n").GetInt32());
    }

    static void Hammer(Emitter e, int threads, int perThread, Func<int, Emitter.Priority> priority)
    {
        using var start = new Barrier(threads);
        var workers = Enumerable.Range(0, threads).Select(t => new Thread(() =>
        {
            start.SignalAndWait();
            for (var n = 0; n < perThread; n++) e.Emit("focus", "win_event", Time, Tagged(t, n), priority(n));
        })).ToList();
        workers.ForEach(w => w.Start());
        workers.ForEach(w => Assert.True(w.Join(Long)));
    }

    [Fact]
    public void ConcurrentEmitsReachTheWriterInSeqOrderWithoutGaps()
    {
        const int threads = 8, perThread = 5_000;
        var sink = new Sink();
        var e = Make(sink, capacity: threads * perThread);
        Hammer(e, threads, perThread, _ => Emitter.Priority.Normal);
        e.Flush(Long);

        var parsed = sink.Lines.Select(Parse).ToList();
        Assert.Equal(threads * perThread, parsed.Count);
        Assert.Equal(Enumerable.Range(0, threads * perThread).Select(i => (long)i), parsed.Select(p => p.Seq));
        foreach (var group in parsed.GroupBy(p => p.Thread))
            Assert.Equal(Enumerable.Range(0, perThread), group.Select(p => p.N));
        Assert.Equal(0, e.Dropped);
    }

    [Fact]
    public void ConcurrentEmitsUnderPressureStayOrderedAndAccountForEveryLine()
    {
        const int threads = 8, perThread = 5_000;
        var sink = new Sink { OnWrite = () => Thread.SpinWait(2_000) };
        var e = Make(sink, capacity: 8, reserve: 4);
        Hammer(e, threads, perThread, n => n % 5 == 0 ? Emitter.Priority.Critical : Emitter.Priority.Normal);
        e.Flush(Long);

        var parsed = sink.Lines.Select(Parse).ToList();
        Assert.True(e.Dropped > 0, "test did not create pressure");
        Assert.Equal(threads * perThread, parsed.Count + e.Dropped);
        for (var i = 1; i < parsed.Count; i++) Assert.True(parsed[i].Seq > parsed[i - 1].Seq, $"seq {parsed[i].Seq} after {parsed[i - 1].Seq}");
        Assert.All(parsed, p => Assert.InRange(p.Seq, 0, threads * perThread - 1));
        foreach (var group in parsed.GroupBy(p => p.Thread))
        {
            var ns = group.Select(p => p.N).ToList();
            for (var i = 1; i < ns.Count; i++) Assert.True(ns[i] > ns[i - 1]);
        }
        // Critical lines have the reserve, so they must survive far better than normal ones.
        const double criticalTotal = threads * perThread / 5, normalTotal = threads * perThread - criticalTotal;
        var criticalKept = parsed.Count(p => p.N % 5 == 0);
        var normalKept = parsed.Count - criticalKept;
        Assert.True(criticalKept / criticalTotal >= normalKept / normalTotal, $"critical kept {criticalKept}, normal kept {normalKept}");
    }
}
