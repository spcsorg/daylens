using Daylens.Capture.Core;
using Xunit;

public class WebProtocolTests
{
    const string Head = """<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"><Applications><Application Id="App"><Extensions>""";
    const string Tail = "</Extensions></Application></Applications></Package>";

    static string Manifest(params string[] protocols) =>
        Head + string.Concat(protocols.Select(p => $"""<uap:Extension Category="windows.protocol"><uap:Protocol Name="{p}" /></uap:Extension>""")) + Tail;

    [Fact] public void BothWebProtocolsMakeABrowser() => Assert.True(StoreApps.ManifestDeclaresWebProtocols(Manifest("http", "https", "mailto")));
    [Fact] public void HttpsAloneIsNot() => Assert.False(StoreApps.ManifestDeclaresWebProtocols(Manifest("https")));
    [Fact] public void OtherProtocolsAreNot() => Assert.False(StoreApps.ManifestDeclaresWebProtocols(Manifest("ms-calculator")));
    [Fact] public void CaseDoesNotMatter() => Assert.True(StoreApps.ManifestDeclaresWebProtocols(Manifest("HTTP", "Https")));
}
