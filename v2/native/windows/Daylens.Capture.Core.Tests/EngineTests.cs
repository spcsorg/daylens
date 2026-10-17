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
    [InlineData(true, Engine.None, Engine.Browser)]
    [InlineData(false, Engine.Browser, Engine.Browser)]
    [InlineData(null, Engine.Browser, Engine.Browser)]
    [InlineData(false, Engine.AppRuntime, Engine.AppRuntime)]
    [InlineData(false, Engine.Unknown, Engine.Unknown)]
    [InlineData(false, Engine.None, Engine.None)]
    public void PackagedAppsAreScannedAndAMissingProtocolDeclarationProvesNothing(bool? declaresWeb, Engine scanned, Engine expected) =>
        Assert.Equal(expected, Engines.ForPackage(declaresWeb, scanned));

    [Fact]
    public void APackagedChromiumBrowserWithoutAProtocolDeclarationIsStillABrowser()
    {
        var dir = TempDir("SomeBrowser.exe", "AppxManifest.xml", "131.0.1/chrome.dll");
        Assert.Equal(Engine.Browser, Engines.ForPackage(false, Engines.Classify(Engines.Scan(dir))));
    }

    [Fact] public void EngineIsWrittenOnEveryFocusLine()
    {
        var line = Envelope.Line("r", 0, "b", new EventTime(1, 1, "UTC", 0), "windows", "win_event", "focus",
            Obs.Focus(FocusTrigger.AppChanged, new AppInfo("x", "x", "C:\\x.exe", 1, false, IdentityState.Ok, null, Engine.AppRuntime), WindowInfo.Read("w", "t")));
        Assert.Contains("\"engine\":\"app_runtime\"", System.Text.Encoding.UTF8.GetString(line));
    }

    static string TempDir(params string[] files)
    {
        var dir = Path.Combine(Path.GetTempPath(), "daylens-engine-" + Guid.NewGuid());
        foreach (var f in files)
        {
            var p = Path.Combine(dir, f);
            if (f.EndsWith('/')) Directory.CreateDirectory(p);
            else { Directory.CreateDirectory(Path.GetDirectoryName(p)!); File.WriteAllText(p, ""); }
        }
        return dir;
    }

    [Fact]
    public void AFullListingIsClassifiedNormally()
    {
        var dir = TempDir("chrome.exe", "131.0.1/chrome.dll");
        Assert.Equal(Engine.Browser, Engines.Classify(Engines.Scan(dir)));
    }

    [Fact]
    public void ATruncatedListingIsUncertainNotNone()
    {
        var dir = TempDir("app.exe");
        for (var i = 0; i < 20; i++) File.WriteAllText(Path.Combine(dir, $"f{i}.bin"), "");
        Assert.Null(Engines.Scan(dir, limit: 10));
        Assert.Equal(Engine.Unknown, Engines.Classify(Engines.Scan(dir, limit: 10)));
    }

    [Fact]
    public void ATruncatedNestedListingIsUncertain()
    {
        var dir = TempDir("app.exe", "big/");
        for (var i = 0; i < 20; i++) File.WriteAllText(Path.Combine(dir, "big", $"f{i}.bin"), "");
        Assert.Null(Engines.Scan(dir, limit: 10));
    }

    [Fact]
    public void AnUnreadableNestedFolderIsUncertainNotNone()
    {
        if (OperatingSystem.IsWindows()) return; // permissions are set the Unix way here; Windows ACLs are covered on the VM
        var dir = TempDir("browser.exe", "131.0.1/chrome.dll");
        var nested = Path.Combine(dir, "131.0.1");
        File.SetUnixFileMode(nested, UnixFileMode.None);
        try { Assert.Equal(Engine.Unknown, Engines.Classify(Engines.Scan(dir))); }
        finally { File.SetUnixFileMode(nested, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute); }
    }

    [Fact]
    public void AFolderThatCanBeListedButNotTraversedIsUncertainNotNone()
    {
        if (OperatingSystem.IsWindows()) return; // Windows ACLs are covered on the VM
        var dir = TempDir("browser.exe", "131.0.1/chrome.dll");
        File.SetUnixFileMode(dir, UnixFileMode.UserRead);
        try { Assert.Equal(Engine.Unknown, Engines.Classify(Engines.Scan(dir))); }
        finally { File.SetUnixFileMode(dir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute); }
    }
}
