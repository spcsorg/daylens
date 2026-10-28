using System.Text.Json;

namespace Daylens.Capture.Core;

/// Assigns sequence numbers and writes lines through a bounded queue on a dedicated thread,
/// so a stalled reader can never block capture. Drops are counted and show up as seq jumps.
public sealed class Emitter
{
    public enum Priority { Normal, Critical }

    readonly object _gate = new();
    readonly Queue<byte[]> _queue = new();
    readonly Action<byte[]> _write;
    readonly int _capacity;
    readonly int _reserve;
    readonly Thread _writer;
    long _seq;
    long _dropped;

    public string Run { get; }
    public string Boot { get; }
    public string Platform { get; }

    public Emitter(string run, string boot, string platform, Action<byte[]> write, int capacity = 1024, int reserve = 64)
    {
        Run = run; Boot = boot; Platform = platform;
        _write = write; _capacity = capacity; _reserve = reserve;
        _writer = new Thread(WriteLoop) { IsBackground = true, Name = "daylens.capture.writer" };
        _writer.Start();
    }

    public long Dropped { get { lock (_gate) return _dropped; } }

    public void Emit(string kind, string source, EventTime time, Action<Utf8JsonWriter> obs, Priority priority)
    {
        // Built under the lock so lines reach the queue in seq order whichever thread emits.
        lock (_gate)
        {
            var seq = _seq++;
            var limit = priority == Priority.Critical ? _capacity + _reserve : _capacity;
            // The line being written still holds its slot, as in the Swift emitter.
            if (_queue.Count + (_writing ? 1 : 0) >= limit)
            {
                _dropped++;
                return;
            }
            _queue.Enqueue(Envelope.Line(Run, seq, Boot, time, Platform, source, kind, obs));
            Monitor.PulseAll(_gate);
        }
    }

    public void Flush(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        lock (_gate)
        {
            while ((_queue.Count > 0 || _writing) && DateTime.UtcNow < deadline) Monitor.Wait(_gate, 50);
        }
    }

    bool _writing;

    void WriteLoop()
    {
        while (true)
        {
            byte[] line;
            lock (_gate)
            {
                while (_queue.Count == 0) Monitor.Wait(_gate);
                line = _queue.Dequeue();
                _writing = true;
            }
            _write(line);
            lock (_gate)
            {
                _writing = false;
                Monitor.PulseAll(_gate);
            }
        }
    }
}
