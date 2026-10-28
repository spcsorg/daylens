namespace Daylens.Capture.Core;

/// Engine verdicts, one per running process. Files can change under a launcher that stays the same (a staged
/// update adds version/chrome.dll), so a verdict never outlives the process it was made for: each launch scans once.
public sealed class EngineCache(Func<string, IEnumerable<string>?>? scan = null)
{
    readonly Func<string, IEnumerable<string>?> _scan = scan ?? (dir => Engines.Scan(dir));
    readonly Dictionary<(int Pid, long Created, FileStamp Exe), Engine> _cache = new();

    public int Scans { get; private set; }

    public Engine Get(int pid, long processCreated, string exePath)
    {
        var dir = Path.GetDirectoryName(exePath);
        if (dir is null) return Engine.Unknown;
        var stamp = FileStamp.Of(exePath);
        (int, long, FileStamp)? key = processCreated != 0 && stamp is { } s ? (pid, processCreated, s) : null;
        if (key is { } k && _cache.TryGetValue(k, out var cached)) return cached;
        Scans++;
        var engine = Engines.Classify(_scan(dir));
        if (_cache.Count > 512) _cache.Clear();
        // An uncertain scan, or a process whose start time is unknown, is not remembered.
        if (engine != Engine.Unknown && key is { } k2) _cache[k2] = engine;
        return engine;
    }
}
