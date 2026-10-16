using Daylens.Capture.Core;
using Xunit;

public class EngineTests
{
    [Fact] public void ChromeWithItsVersionedLibraryIsABrowser() =>
        Assert.Equal(Engine.Browser, Engines.Classify(["chrome.exe", "chrome_proxy.exe", "131.0.6778.86", "131.0.6778.86/chrome.dll", "131.0.6778.86/chrome_elf.dll", "131.0.6778.86/resources.pak"]));

    [Fact] public void EdgeIsABrowser() =>
        Assert.Equal(Engine.Browser, Engines.Classify(["msedge.exe", "131.0.2903.70", "131.0.2903.70/msedge.dll"]));

    [Fact] public void PaleMoonPortableIsABrowserWithoutAnyRegistration() =>
        Assert.Equal(Engine.Browser, Engines.Classify(["palemoon.exe", "xul.dll", "omni.ja", "browser", "browser/omni.ja", "browser/features"]));

    [Fact] public void FirefoxIsABrowser() =>
        Assert.Equal(Engine.Browser, Engines.Classify(["firefox.exe", "xul.dll", "browser", "browser\\omni.ja"]));

    [Theory]
    [InlineData("Slack")]
    [InlineData("Code")]
    [InlineData("Daylens")]
    public void ElectronAppsShipChromiumButAreNotBrowsers(string app) =>
        Assert.Equal(Engine.AppRuntime, Engines.Classify([$"{app}.exe", "ffmpeg.dll", "chrome_100_percent.pak", "resources.pak", "resources", "resources/app.asar", "locales"]));

    [Fact] public void ElectronWithAnUnpackedAppFolderIsNotABrowser() =>
        Assert.Equal(Engine.AppRuntime, Engines.Classify(["app.exe", "resources", "resources/app", "chrome_elf.dll"]));

    [Fact] public void CefAppsAreNotBrowsers() =>
        Assert.Equal(Engine.AppRuntime, Engines.Classify(["Spotify.exe", "libcef.dll", "chrome_elf.dll", "icudtl.dat"]));

    [Fact] public void AnOrdinaryAppHasNoEngine() =>
        Assert.Equal(Engine.None, Engines.Classify(["notepad++.exe", "SciLexer.dll", "plugins", "plugins/NppExport"]));

    [Fact] public void AFolderThatCannotBeListedIsUnknownNeverNormal() =>
        Assert.Equal(Engine.Unknown, Engines.Classify(null));

    [Theory]
    [InlineData(true, Engine.Browser)]
    [InlineData(false, Engine.None)]
    [InlineData(null, Engine.Unknown)]
    public void PackagedAppsFollowTheirManifest(bool? web, Engine expected) => Assert.Equal(expected, Engines.ForPackage(web));

    [Fact] public void EngineIsWrittenOnEveryFocusLine()
    {
        var line = Envelope.Line("r", 0, "b", new EventTime(1, 1, "UTC", 0), "windows", "win_event", "focus",
            Obs.Focus(FocusTrigger.AppChanged, new AppInfo("x", "x", "C:\\x.exe", 1, false, IdentityState.Ok, null, Engine.AppRuntime), WindowInfo.Read("w", "t")));
        Assert.Contains("\"engine\":\"app_runtime\"", System.Text.Encoding.UTF8.GetString(line));
    }
}
