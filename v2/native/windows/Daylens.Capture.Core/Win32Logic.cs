using System.Xml;

namespace Daylens.Capture.Core;

/// Platform logic with no Win32 calls, so it is unit-tested on any OS.
public static class Win32Time
{
    /// QueryInterruptTimePrecise counts 100 ns units since boot and keeps counting while asleep.
    public static long InterruptTimeToMonoUs(ulong interrupt100ns) => (long)(interrupt100ns / 10);

    /// Tick counts (GetTickCount, GetLastInputInfo, WinEvent dwmsEventTime) wrap every 49.7 days.
    public static uint TickDelta(uint now, uint then) => unchecked(now - then);

    /// Places an event that happened at <paramref name="eventTick"/> on our clocks, measured now.
    public static (long WallMs, long MonoUs) BackDate(long nowWallMs, long nowMonoUs, uint nowTick, uint eventTick)
    {
        var deltaMs = TickDelta(nowTick, eventTick);
        if (deltaMs > 60_000) deltaMs = 0; // a tick from the future or far past is not trusted
        return (nowWallMs - deltaMs, nowMonoUs - deltaMs * 1000L);
    }
}

public static class WinEvents
{
    public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    public const uint EVENT_OBJECT_NAMECHANGE = 0x800C;
    public const int OBJID_WINDOW = 0;
    public const int CHILDID_SELF = 0;

    /// A name change is a title change only for the foreground top-level window itself.
    public static bool IsForegroundTitleChange(nint hwnd, int idObject, int idChild, nint foreground) =>
        hwnd != 0 && hwnd == foreground && idObject == OBJID_WINDOW && idChild == CHILDID_SELF;
}

public static class Power
{
    public const int PBT_APMSUSPEND = 0x4;
    public const int PBT_APMRESUMESUSPEND = 0x7;
    public const int PBT_APMRESUMEAUTOMATIC = 0x12;
    public const int PBT_POWERSETTINGCHANGE = 0x8013;
    public static readonly Guid GUID_SESSION_DISPLAY_STATUS = new("2B84C20E-AD23-4ddf-93DB-05FFBD7EFCA5");

    /// PBT_APMRESUMEAUTOMATIC follows every resume, user or not; PBT_APMRESUMESUSPEND means a person is there.
    public static string? Classify(int pbt, Guid? setting = null, uint? value = null) => pbt switch
    {
        PBT_APMSUSPEND => "sleep",
        PBT_APMRESUMEAUTOMATIC => "resume",
        PBT_APMRESUMESUSPEND => "resume_user",
        PBT_POWERSETTINGCHANGE when setting == GUID_SESSION_DISPLAY_STATUS => value switch
        {
            0 => "display_off",
            1 => "display_on",
            2 => "display_dim",
            _ => null,
        },
        _ => null,
    };
}

public static class Sessions
{
    public const int WTS_CONSOLE_CONNECT = 0x1, WTS_CONSOLE_DISCONNECT = 0x2, WTS_REMOTE_CONNECT = 0x3, WTS_REMOTE_DISCONNECT = 0x4;
    public const int WTS_SESSION_LOGON = 0x5, WTS_SESSION_LOGOFF = 0x6, WTS_SESSION_LOCK = 0x7, WTS_SESSION_UNLOCK = 0x8;

    public static string? Classify(int wtsEvent) => wtsEvent switch
    {
        WTS_CONSOLE_CONNECT => "console_connect",
        WTS_CONSOLE_DISCONNECT => "console_disconnect",
        WTS_REMOTE_CONNECT => "remote_connect",
        WTS_REMOTE_DISCONNECT => "remote_disconnect",
        WTS_SESSION_LOGON => "logon",
        WTS_SESSION_LOGOFF => "logoff",
        WTS_SESSION_LOCK => "locked",
        WTS_SESSION_UNLOCK => "unlocked",
        _ => null,
    };

    /// WTSINFOEX_LEVEL1.SessionFlags on Windows 8 and later.
    public static string FromSessionFlags(int flags) => flags switch { 0 => "locked", 1 => "unlocked", _ => "unknown" };
}

public readonly record struct ChildWindow(nint Hwnd, int Pid, string ClassName);

public static class StoreApps
{
    public static bool IsFrameHost(string? exePath) =>
        exePath is not null && Path.GetFileName(exePath.Replace('\\', '/')).Equals("ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase);

    /// The packaged app's own window is a CoreWindow child owned by a different process than the frame.
    public static ChildWindow? SelectContentWindow(int framePid, IEnumerable<ChildWindow> children)
    {
        ChildWindow? fallback = null;
        foreach (var c in children)
        {
            if (c.Pid == framePid || c.Pid == 0) continue;
            if (c.ClassName == "Windows.UI.Core.CoreWindow") return c;
            fallback ??= c;
        }
        return fallback;
    }

    public static (string Family, string AppId)? ParseAumid(string aumid)
    {
        var bang = aumid.IndexOf('!');
        if (bang <= 0 || bang == aumid.Length - 1) return null;
        return (aumid[..bang], aumid[(bang + 1)..]);
    }

    /// The DisplayName of one application entry in an AppxManifest, as written (literal or ms-resource).
    public static string? ManifestDisplayName(string manifestXml, string appId)
    {
        var doc = new XmlDocument { XmlResolver = null };
        using (var reader = XmlReader.Create(new StringReader(manifestXml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null }))
            doc.Load(reader);
        string? packageName = null;
        string? packageDisplay = null;
        foreach (XmlNode n in doc.GetElementsByTagName("*"))
        {
            if (n is not XmlElement e) continue;
            if (e.LocalName == "Identity" && packageName is null) packageName = e.GetAttribute("Name");
            if (e.LocalName == "DisplayName" && e.ParentNode?.LocalName == "Properties") packageDisplay ??= e.InnerText.Trim();
            if (e.LocalName == "Application" && e.GetAttribute("Id") == appId)
            {
                foreach (XmlNode c in e.ChildNodes)
                    if (c is XmlElement v && v.LocalName == "VisualElements" && v.GetAttribute("DisplayName") is { Length: > 0 } d) return d;
            }
        }
        return packageDisplay is { Length: > 0 } ? packageDisplay : null;
    }

    /// Turns a manifest ms-resource reference into the @{PackageFullName?ms-resource://...} form SHLoadIndirectString needs.
    public static string? IndirectString(string displayName, string packageFullName, string packageName)
    {
        const string prefix = "ms-resource:";
        if (!displayName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
        var key = displayName[prefix.Length..];
        string uri =
            key.StartsWith("//", StringComparison.Ordinal) ? prefix + key
            : key.StartsWith('/') ? $"{prefix}//{packageName}{key}"
            : key.Contains('/') ? $"{prefix}//{packageName}/{key}"
            : $"{prefix}//{packageName}/Resources/{key}";
        return $"@{{{packageFullName}?{uri}}}";
    }

    /// Whether a package manifest declares the http and https protocols, which makes the app a browser.
    public static bool ManifestDeclaresWebProtocols(string manifestXml)
    {
        var doc = new XmlDocument { XmlResolver = null };
        using (var reader = XmlReader.Create(new StringReader(manifestXml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null }))
            doc.Load(reader);
        bool http = false, https = false;
        foreach (XmlNode n in doc.GetElementsByTagName("*"))
        {
            if (n is not XmlElement e || e.LocalName != "Protocol") continue;
            var name = e.GetAttribute("Name");
            http |= name.Equals("http", StringComparison.OrdinalIgnoreCase);
            https |= name.Equals("https", StringComparison.OrdinalIgnoreCase);
        }
        return http && https;
    }

    /// SHLoadIndirectString can "succeed" by echoing an unresolved reference.
    public static bool IsResolved(string? s) =>
        !string.IsNullOrWhiteSpace(s) && !s.StartsWith("ms-resource:", StringComparison.OrdinalIgnoreCase) && !s.StartsWith("@{", StringComparison.Ordinal);
}

public static class Browsers
{
    /// The executable from a shell\open\command value such as "C:\..\chrome.exe" --single-argument %1.
    public static string? CommandExe(string? command)
    {
        if (string.IsNullOrWhiteSpace(command)) return null;
        var c = command.Trim();
        if (c[0] == '"')
        {
            var end = c.IndexOf('"', 1);
            return end > 1 ? c[1..end] : null;
        }
        var exe = c.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
        // ".exe" inside a directory name (C:\Apps\Foo.exelent\) is not the end of the path.
        while (exe > 0 && exe + 4 < c.Length && !char.IsWhiteSpace(c[exe + 4]))
            exe = c.IndexOf(".exe", exe + 4, StringComparison.OrdinalIgnoreCase);
        return exe > 0 ? c[..(exe + 4)] : c.Split(' ')[0];
    }
}
