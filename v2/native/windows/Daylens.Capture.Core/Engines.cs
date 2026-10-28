namespace Daylens.Capture.Core;

public enum Engine { Browser, AppRuntime, None, Unknown }

/// Separates real browsers from apps that merely embed a web engine, from the files next to the executable.
/// Every Electron app ships Chromium, so "has Chromium" is not enough: Electron carries resources/app.asar and
/// CEF carries libcef.dll, while a Chromium browser ships its own browser library and Gecko browsers ship browser/omni.ja.
public static class Engines
{
    static readonly string[] ChromiumBrowserLibraries = ["chrome.dll", "msedge.dll", "opera_browser.dll", "chrome_elf.dll"];

    /// <param name="entries">Paths relative to the executable's folder, at most two levels deep; null when it could not be listed.</param>
    public static Engine Classify(IEnumerable<string>? entries)
    {
        if (entries is null) return Engine.Unknown;
        var set = new HashSet<string>(entries.Select(e => e.Replace('\\', '/').TrimEnd('/').ToLowerInvariant()));
        if (set.Contains("browser/omni.ja")) return Engine.Browser;
        if (set.Contains("resources/app.asar") || set.Contains("resources/app") || set.Contains("resources/default_app.asar") || set.Contains("libcef.dll"))
            return Engine.AppRuntime;
        foreach (var e in set)
        {
            var name = e[(e.LastIndexOf('/') + 1)..];
            if (ChromiumBrowserLibraries.Contains(name)) return Engine.Browser;
        }
        return Engine.None;
    }

    public const int ScanLimit = 400;

    /// Names in the folder and one level below, enough for resources/app.asar, version/chrome.dll and browser/omni.ja.
    /// Any error, or a folder with more entries than the limit, makes the scan uncertain (null): a partial
    /// listing must never pass for "no engine".
    public static List<string>? Scan(string dir, int limit = ScanLimit)
    {
        try
        {
            var entries = new List<string>();
            var top = Directory.EnumerateFileSystemEntries(dir).Take(limit + 1).ToList();
            if (top.Count > limit) return null;
            foreach (var e in top)
            {
                var name = Path.GetFileName(e);
                entries.Add(name);
                // Directory.Exists answers false on errors too; asking for the attributes throws instead, so an
                // entry that cannot be examined makes the scan uncertain rather than hiding what is inside it.
                if ((File.GetAttributes(e) & FileAttributes.Directory) == 0) continue;
                var sub = Directory.EnumerateFileSystemEntries(e).Take(limit + 1).ToList();
                if (sub.Count > limit) return null;
                foreach (var s in sub) entries.Add(name + "/" + Path.GetFileName(s));
            }
            return entries;
        }
        catch
        {
            return null;
        }
    }

    // A package declaring either web scheme is a browser; otherwise its install-folder scan decides.
    public static Engine ForPackage(bool? declaresWebProtocols, Engine scannedInstallFolder) =>
        declaresWebProtocols == true ? Engine.Browser : scannedInstallFolder;
}
