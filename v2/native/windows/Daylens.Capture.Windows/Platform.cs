using System.Runtime.Versioning;
using Daylens.Capture.Core;

namespace Daylens.Capture.Windows;

[SupportedOSPlatform("windows")]
internal static class Clock
{
    const long UnixEpochFileTime = 116444736000000000;
    static readonly object Gate = new();
    static TimeZoneInfo _zone = TimeZoneInfo.Local;
    static string _tzName = Iana(_zone);

    public static long WallMs()
    {
        Native.GetSystemTimePreciseAsFileTime(out var ft);
        return (ft - UnixEpochFileTime) / 10_000;
    }

    // Interrupt time keeps counting while the machine sleeps.
    public static long MonoUs()
    {
        Native.QueryInterruptTimePrecise(out var t);
        return Win32Time.InterruptTimeToMonoUs(t);
    }

    public static EventTime Now() => At(WallMs(), MonoUs());

    public static EventTime At(long wallMs, long monoUs)
    {
        TimeZoneInfo zone;
        string name;
        lock (Gate) { zone = _zone; name = _tzName; }
        var offset = (int)zone.GetUtcOffset(DateTimeOffset.FromUnixTimeMilliseconds(wallMs)).TotalMinutes;
        return new EventTime(wallMs, monoUs, name, offset);
    }

    /// .NET caches the local zone; drop the cache and report whether the zone itself changed.
    public static bool RefreshTimeZone()
    {
        TimeZoneInfo.ClearCachedData();
        var zone = TimeZoneInfo.Local;
        lock (Gate)
        {
            var changed = zone.Id != _zone.Id;
            _zone = zone;
            _tzName = Iana(zone);
            return changed;
        }
    }

    static string Iana(TimeZoneInfo zone) =>
        TimeZoneInfo.TryConvertWindowsIdToIanaId(zone.Id, out var iana) ? iana : Sanitize(zone.Id);

    static string Sanitize(string id) => id.Length <= 64 ? id : id[..64];

    public static string BootId()
    {
        var bootUnixS = (WallMs() - MonoUs() / 1000) / 1000;
        return $"boot-{bootUnixS / 60}";
    }
}

internal static class Diag
{
    /// Fixed codes only; never titles, names, paths or exception messages.
    public static void Write(string code, string value = "1")
    {
        try { Console.Error.WriteLine($"{code}={value}"); } catch { }
    }
}
