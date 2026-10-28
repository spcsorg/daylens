using System.Diagnostics;
using System.Xml;
using Daylens.Capture.Core;

namespace Daylens.Capture.Core.Tests;

public class StoreAppsTests
{
    const string CoreWindow = "Windows.UI.Core.CoreWindow";
    const int FramePid = 1000;

    [Theory]
    [InlineData(@"C:\Windows\System32\ApplicationFrameHost.exe")]
    [InlineData(@"C:\WINDOWS\system32\APPLICATIONFRAMEHOST.EXE")]
    [InlineData(@"c:\windows\system32\applicationframehost.exe")]
    [InlineData("C:/Windows/System32/ApplicationFrameHost.exe")]
    [InlineData(@"\\?\C:\Windows\System32\ApplicationFrameHost.exe")]
    [InlineData("ApplicationFrameHost.exe")]
    public void FrameHostIsRecognised(string path) => Assert.True(StoreApps.IsFrameHost(path));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(@"C:\Windows\System32\NotApplicationFrameHost.exe")]
    [InlineData(@"C:\Windows\System32\ApplicationFrameHost.exe.bak")]
    [InlineData(@"C:\ApplicationFrameHost.exe\evil.exe")]
    [InlineData(@"C:\Windows\explorer.exe")]
    [InlineData("ApplicationFrameHost")]
    public void OtherPathsAreNot(string? path) => Assert.False(StoreApps.IsFrameHost(path));

    [Fact]
    public void PrefersCoreWindowOwnedByAnotherProcess()
    {
        ChildWindow[] children =
        [
            new(1, FramePid, "ApplicationFrameTitleBarWindow"),
            new(2, 0, CoreWindow),
            new(3, 2000, "ApplicationFrameInputSinkWindow"),
            new(4, 3000, CoreWindow),
        ];
        Assert.Equal(children[3], StoreApps.SelectContentWindow(FramePid, children));
    }

    [Fact]
    public void IgnoresCoreWindowOwnedByTheFrame()
    {
        ChildWindow[] children = [new(1, FramePid, CoreWindow), new(2, 2000, "Other")];
        Assert.Equal(children[1], StoreApps.SelectContentWindow(FramePid, children));
    }

    [Fact]
    public void IgnoresPidZero()
    {
        ChildWindow[] children = [new(1, 0, CoreWindow), new(2, 0, "Other")];
        Assert.Null(StoreApps.SelectContentWindow(FramePid, children));
    }

    [Fact]
    public void FallsBackToTheFirstChildFromAnotherProcess()
    {
        ChildWindow[] children = [new(1, FramePid, "Frame"), new(2, 2000, "A"), new(3, 3000, "B")];
        Assert.Equal(children[1], StoreApps.SelectContentWindow(FramePid, children));
    }

    [Fact]
    public void NothingSuitableGivesNull()
    {
        Assert.Null(StoreApps.SelectContentWindow(FramePid, []));
        Assert.Null(StoreApps.SelectContentWindow(FramePid, [new(1, FramePid, CoreWindow), new(2, FramePid, "Frame")]));
    }

    [Fact]
    public void ParsesAumid()
    {
        Assert.Equal(("Microsoft.WindowsCalculator_8wekyb3d8bbwe", "App"), StoreApps.ParseAumid("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"));
        Assert.Equal(("Microsoft.WindowsTerminal_8wekyb3d8bbwe", "App"), StoreApps.ParseAumid("Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"));
    }

    // Only the first '!' separates; an app id never contains one, so anything after it stays in AppId.
    [Fact]
    public void SplitsOnTheFirstBang() => Assert.Equal(("a", "b!c"), StoreApps.ParseAumid("a!b!c"));

    [Theory]
    [InlineData("")]
    [InlineData("NoBangHere")]
    [InlineData("!App")]
    [InlineData("Family!")]
    [InlineData("!")]
    [InlineData("!!")]
    public void MalformedAumidGivesNull(string aumid) => Assert.Null(StoreApps.ParseAumid(aumid));

    // Shape of a real Windows 10/11 manifest: default foundation namespace, uap VisualElements, two
    // applications, and an app extension whose own Properties/DisplayName and Id must not be mistaken for the app's.
    const string Manifest = """
        <?xml version="1.0" encoding="utf-8"?>
        <Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
                 xmlns:mp="http://schemas.microsoft.com/appx/2014/phone/manifest"
                 xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
                 xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"
                 xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
                 IgnorableNamespaces="mp uap uap3 rescap">
          <Identity Name="Contoso.Suite" Publisher="CN=Contoso, O=Contoso, C=US" Version="3.1.0.0" ProcessorArchitecture="x64" />
          <mp:PhoneIdentity PhoneProductId="6b8e2e1c-0000-0000-0000-000000000000" PhonePublisherId="00000000-0000-0000-0000-000000000000" />
          <Properties>
            <DisplayName>ms-resource:PackageDisplayName</DisplayName>
            <PublisherDisplayName>Contoso Ltd.</PublisherDisplayName>
            <Logo>Assets\StoreLogo.png</Logo>
          </Properties>
          <Dependencies>
            <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
          </Dependencies>
          <Resources>
            <Resource Language="x-generate" />
          </Resources>
          <Applications>
            <Application Id="Writer" Executable="Writer.exe" EntryPoint="Contoso.Writer.App">
              <uap:VisualElements DisplayName="ms-resource:WriterName" Description="ms-resource:WriterDescription"
                                  BackgroundColor="transparent" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png">
                <uap:DefaultTile Wide310x150Logo="Assets\Wide310x150Logo.png" />
                <uap:SplashScreen Image="Assets\SplashScreen.png" />
              </uap:VisualElements>
              <Extensions>
                <uap3:Extension Category="windows.appExtension">
                  <uap3:AppExtension Name="com.contoso.plugin" Id="Spell" DisplayName="Spell Checker" PublicFolder="Public">
                    <uap3:Properties>
                      <DisplayName>Not the app name</DisplayName>
                    </uap3:Properties>
                  </uap3:AppExtension>
                </uap3:Extension>
              </Extensions>
            </Application>
            <Application Id="App" Executable="Suite\Suite.exe" EntryPoint="Windows.FullTrustApplication">
              <uap:VisualElements DisplayName="Contoso Mail" Description="Mail" BackgroundColor="#FFFFFF"
                                  Square150x150Logo="Assets\Mail150.png" Square44x44Logo="Assets\Mail44.png" />
            </Application>
            <Application Id="Blank" Executable="Blank.exe" EntryPoint="Windows.FullTrustApplication">
              <uap:VisualElements DisplayName="" Description="x" BackgroundColor="#000000" Square150x150Logo="a.png" Square44x44Logo="b.png" />
            </Application>
          </Applications>
          <Capabilities>
            <rescap:Capability Name="runFullTrust" />
          </Capabilities>
        </Package>
        """;

    [Fact]
    public void PicksTheApplicationById()
    {
        Assert.Equal("ms-resource:WriterName", StoreApps.ManifestDisplayName(Manifest, "Writer"));
        Assert.Equal("Contoso Mail", StoreApps.ManifestDisplayName(Manifest, "App"));
    }

    [Theory]
    [InlineData("Missing")]
    [InlineData("Spell")]   // an AppExtension Id, not an Application
    [InlineData("Blank")]   // empty VisualElements DisplayName
    [InlineData("")]
    public void FallsBackToPackageDisplayName(string appId) =>
        Assert.Equal("ms-resource:PackageDisplayName", StoreApps.ManifestDisplayName(Manifest, appId));

    [Fact]
    public void Windows81ManifestShapeWorks()
    {
        const string old = """
            <Package xmlns="http://schemas.microsoft.com/appx/2010/manifest" xmlns:m2="http://schemas.microsoft.com/appx/2013/manifest">
              <Identity Name="Old.App" Publisher="CN=Old" Version="1.0.0.0" />
              <Properties><DisplayName>Old Package</DisplayName></Properties>
              <Applications>
                <Application Id="App" Executable="Old.exe" EntryPoint="Old.App">
                  <m2:VisualElements DisplayName="Old App" Description="x" BackgroundColor="#000000" ForegroundText="light" Square150x150Logo="a.png" Square30x30Logo="b.png" />
                </Application>
              </Applications>
            </Package>
            """;
        Assert.Equal("Old App", StoreApps.ManifestDisplayName(old, "App"));
    }

    [Fact]
    public void NoNameAnywhereGivesNull()
    {
        const string bare = """<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"><Applications><Application Id="App" /></Applications></Package>""";
        Assert.Null(StoreApps.ManifestDisplayName(bare, "App"));
    }

    // Decision: any DTD is refused. ManifestDisplayName throws XmlException before an entity is defined,
    // so no file or URL is ever read. Resolver.PackageDisplayName catches it and falls back to the exe name.
    // Real AppxManifest.xml files never carry a DTD.
    [Fact]
    public void ExternalEntityIsRefusedAndNeverRead()
    {
        var secret = "daylens-xxe-" + Guid.NewGuid().ToString("N");
        var secretPath = Path.Combine(Path.GetTempPath(), secret + ".txt");
        File.WriteAllText(secretPath, secret);
        try
        {
            var uri = new Uri(secretPath).AbsoluteUri;
            var xml = $"""
                <?xml version="1.0"?>
                <!DOCTYPE Package [ <!ENTITY xxe SYSTEM "{uri}"> ]>
                <Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10">
                  <Properties><DisplayName>&xxe;</DisplayName></Properties>
                  <Applications><Application Id="App"><uap:VisualElements DisplayName="&xxe;" /></Application></Applications>
                </Package>
                """;
            var ex = Assert.Throws<XmlException>(() => StoreApps.ManifestDisplayName(xml, "App"));
            Assert.DoesNotContain(secret, ex.ToString());
        }
        finally { File.Delete(secretPath); }
    }

    [Fact]
    public void ExternalDtdIsRefused()
    {
        const string xml = """
            <?xml version="1.0"?>
            <!DOCTYPE Package SYSTEM "http://127.0.0.1:9/evil.dtd">
            <Package><Properties><DisplayName>x</DisplayName></Properties></Package>
            """;
        Assert.Throws<XmlException>(() => StoreApps.ManifestDisplayName(xml, "App"));
    }

    [Fact]
    public void EntityExpansionBombIsRefusedQuickly()
    {
        const string xml = """
            <?xml version="1.0"?>
            <!DOCTYPE lolz [
              <!ENTITY lol "lol">
              <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
              <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
              <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
              <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">
              <!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">
              <!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;">
              <!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;">
              <!ENTITY lol9 "&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;">
            ]>
            <Package><Properties><DisplayName>&lol9;</DisplayName></Properties></Package>
            """;
        var sw = Stopwatch.StartNew();
        Assert.Throws<XmlException>(() => StoreApps.ManifestDisplayName(xml, "App"));
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not xml")]
    [InlineData("<Package><Properties>")]
    public void MalformedXmlThrowsXmlException(string xml) =>
        Assert.Throws<XmlException>(() => StoreApps.ManifestDisplayName(xml, "App"));

    const string FullName = "Contoso.Suite_3.1.0.0_x64__8wekyb3d8bbwe";
    const string Name = "Contoso.Suite";

    [Theory]
    [InlineData("ms-resource:AppName", "@{Contoso.Suite_3.1.0.0_x64__8wekyb3d8bbwe?ms-resource://Contoso.Suite/Resources/AppName}")]
    [InlineData("ms-resource:/Resources/AppName", "@{Contoso.Suite_3.1.0.0_x64__8wekyb3d8bbwe?ms-resource://Contoso.Suite/Resources/AppName}")]
    [InlineData("ms-resource://Contoso.Suite/Resources/AppName", "@{Contoso.Suite_3.1.0.0_x64__8wekyb3d8bbwe?ms-resource://Contoso.Suite/Resources/AppName}")]
    [InlineData("ms-resource:Strings/AppName", "@{Contoso.Suite_3.1.0.0_x64__8wekyb3d8bbwe?ms-resource://Contoso.Suite/Strings/AppName}")]
    [InlineData("ms-resource:///Resources/AppName", "@{Contoso.Suite_3.1.0.0_x64__8wekyb3d8bbwe?ms-resource:///Resources/AppName}")]
    [InlineData("MS-RESOURCE:AppName", "@{Contoso.Suite_3.1.0.0_x64__8wekyb3d8bbwe?ms-resource://Contoso.Suite/Resources/AppName}")]
    public void IndirectStringForResourceReferences(string displayName, string expected) =>
        Assert.Equal(expected, StoreApps.IndirectString(displayName, FullName, Name));

    [Theory]
    [InlineData("Calculator")]
    [InlineData("Contoso Mail")]
    [InlineData("")]
    [InlineData("ms-resourceAppName")]
    [InlineData(" ms-resource:AppName")]
    [InlineData("@{Contoso.Suite_3.1.0.0_x64__8wekyb3d8bbwe?ms-resource://Contoso.Suite/Resources/AppName}")]
    public void LiteralNamesGiveNull(string displayName) => Assert.Null(StoreApps.IndirectString(displayName, FullName, Name));

    [Theory]
    [InlineData("Calculator", true)]
    [InlineData("Contoso Mail", true)]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    [InlineData("ms-resource:AppName", false)]
    [InlineData("MS-RESOURCE://Pkg/Resources/AppName", false)]
    [InlineData("@{Contoso.Suite_3.1.0.0_x64__8wekyb3d8bbwe?ms-resource://Contoso.Suite/Resources/AppName}", false)]
    public void IsResolved(string? value, bool expected) => Assert.Equal(expected, StoreApps.IsResolved(value));
}
