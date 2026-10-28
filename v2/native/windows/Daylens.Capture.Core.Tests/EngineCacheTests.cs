using Daylens.Capture.Core;
using Xunit;

public class EngineCacheTests
{
    static string Install(params string[] files)
    {
        var dir = Path.Combine(Path.GetTempPath(), "daylens-cache-" + Guid.NewGuid());
        foreach (var f in files)
        {
            var p = Path.Combine(dir, f);
            Directory.CreateDirectory(Path.GetDirectoryName(p)!);
            File.WriteAllText(p, "");
        }
        return dir;
    }

    [Fact]
    public void AStagedUpdateUnderAnUnchangedLauncherIsSeenByTheNextLaunch()
    {
        var dir = Install("launcher.exe");
        var exe = Path.Combine(dir, "launcher.exe");
        var cache = new EngineCache();
        Assert.Equal(Engine.None, cache.Get(100, 1_000, exe));
        // The staged update: a browser library appears next to a launcher that does not change.
        Directory.CreateDirectory(Path.Combine(dir, "131.0.1"));
        File.WriteAllText(Path.Combine(dir, "131.0.1", "chrome.dll"), "");
        Assert.Equal(Engine.None, cache.Get(100, 1_000, exe));
        Assert.Equal(Engine.Browser, cache.Get(100, 2_000, exe));
    }

    [Fact]
    public void EachLaunchScansOnceAndRepeatsAreFree()
    {
        var exe = Path.Combine(Install("app.exe"), "app.exe");
        var cache = new EngineCache();
        for (var i = 0; i < 100; i++) cache.Get(7, 5, exe);
        Assert.Equal(1, cache.Scans);
        cache.Get(8, 6, exe);
        Assert.Equal(2, cache.Scans);
    }

    [Fact]
    public void AProcessWithoutAKnownStartTimeIsNeverCached()
    {
        var exe = Path.Combine(Install("app.exe"), "app.exe");
        var cache = new EngineCache();
        cache.Get(7, 0, exe);
        cache.Get(7, 0, exe);
        Assert.Equal(2, cache.Scans);
    }
}
