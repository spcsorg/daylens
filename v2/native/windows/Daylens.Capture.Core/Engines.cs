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

    /// Packaged apps: the manifest says whether the app handles web links; unreadable means unknown.
    public static Engine ForPackage(bool? declaresWebProtocols) => declaresWebProtocols switch
    {
        true => Engine.Browser,
        false => Engine.None,
        null => Engine.Unknown,
    };
}
