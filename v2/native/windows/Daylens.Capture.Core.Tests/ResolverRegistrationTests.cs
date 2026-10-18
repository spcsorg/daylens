using System.Diagnostics;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Versioning;
using Daylens.Capture.Core;
using Daylens.Capture.Windows;
using Microsoft.Win32;
using Xunit;

public sealed class WindowsTheoryAttribute : TheoryAttribute
{
    public WindowsTheoryAttribute()
    {
        if (!OperatingSystem.IsWindows()) Skip = "Requires the Windows registry and process APIs.";
    }
}

[SupportedOSPlatform("windows")]
[Collection("RegistryFixture")]
public class ResolverRegistrationTests
{
    static void Set(Resolver resolver, string field, object value) =>
        typeof(Resolver).GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(resolver, value);

    static AppInfo Identify(Resolver resolver, int pid) =>
        (AppInfo)typeof(Resolver).GetMethod("Identify", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(resolver, [(nint)1, pid])!;

    [WindowsTheory]
    [InlineData("http")]
    [InlineData("https")]
    public void CachedProcessSeesRegistrationAndRemovalOnTheNextIdentification(string scheme)
    {
        using var process = Process.GetCurrentProcess();
        Assert.True(Native.GetProcessTimes(process.Handle, out var created, out _, out _, out _));
        var path = process.MainModule!.FileName;
        var app = new AppInfo(path, "Test app", path, process.Id, false, IdentityState.Ok, null, Engine.AppRuntime, "Test publisher");
        // Seed only the stable identity, without starting resolver or emitter threads.
        var resolver = (Resolver)RuntimeHelpers.GetUninitializedObject(typeof(Resolver));
        var identities = new Dictionary<(int, long), AppInfo> { [(process.Id, created)] = app };
        Set(resolver, "_identities", identities);
        Set(resolver, "_webPackages", new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase));
        Set(resolver, "_browserExes", new HashSet<string>(StringComparer.OrdinalIgnoreCase));
        Assert.False(Identify(resolver, process.Id).RegisteredBrowser);
        var name = "DaylensCaptureTest" + Guid.NewGuid().ToString("N");
        var capabilities = $@"Software\{name}\Capabilities";
        var progId = name + ".URL";
        using var registered = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications");
        try
        {
            using (var urls = Registry.CurrentUser.CreateSubKey(capabilities + @"\URLAssociations")) urls.SetValue(scheme, progId);
            using (var command = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{progId}\shell\open\command")) command.SetValue("", $"\"{path}\" \"%1\"");
            registered.SetValue(name, capabilities);
            Assert.Equal(app with { RegisteredBrowser = true }, Identify(resolver, process.Id));
            Assert.Single(identities);
            Assert.Same(app, identities[(process.Id, created)]);
            registered.DeleteValue(name);
            Assert.False(Identify(resolver, process.Id).RegisteredBrowser);
            identities[(process.Id, created)] = app with { RegisteredBrowser = true };
            Assert.False(Identify(resolver, process.Id).RegisteredBrowser);
        }
        finally
        {
            registered.DeleteValue(name, throwOnMissingValue: false);
            Registry.CurrentUser.DeleteSubKeyTree($@"Software\{name}", throwOnMissingSubKey: false);
            Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\{progId}", throwOnMissingSubKey: false);
        }
    }
}
