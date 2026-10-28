using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Versioning;
using Daylens.Capture.Windows;
using Microsoft.Win32;

[SupportedOSPlatform("windows")]
[Collection("RegistryFixture")]
public class LinkHandlerTests
{
    const string Exe = @"C:\Apps\Jot\app-4.41.0\jot.exe";
    static void SetIfPresent(Resolver resolver, string name, object value) =>
        typeof(Resolver).GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)?.SetValue(resolver, value);

    static Resolver ResolverFor(string? effective = null)
    {
        var resolver = (Resolver)RuntimeHelpers.GetUninitializedObject(typeof(Resolver));
        SetIfPresent(resolver, "_browserExes", new HashSet<string>(StringComparer.OrdinalIgnoreCase));
        SetIfPresent(resolver, "_effectiveCommand", (Func<string, string?>)(_ => effective));
        _ = Registry.CurrentUser;
        var version = RegistryKey.Version;
        SetIfPresent(resolver, "_registrationChanges", (Func<bool>)(() =>
        {
            var next = RegistryKey.Version;
            var changed = next != version;
            version = next;
            return changed;
        }));
        return resolver;
    }

    static bool Registered(Resolver resolver) =>
        (bool)typeof(Resolver).GetMethod("IsRegisteredBrowser", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(resolver, [Exe])!;

    [Theory]
    [InlineData("http")]
    [InlineData("https")]
    public void UserChoiceOnlyHandlerIsDetected(string scheme)
    {
        var id = "DaylensFixture" + Guid.NewGuid().ToString("N");
        var choicePath = $@"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\{scheme}\UserChoice";
        try
        {
            using (var choice = Registry.CurrentUser.CreateSubKey(choicePath)) choice.SetValue("ProgId", id);
            using (var command = Registry.ClassesRoot.CreateSubKey($@"{id}\shell\open\command")) command.SetValue("", $"\"{Exe}\" \"%1\"");
            Assert.True(Registered(ResolverFor()));
        }
        finally
        {
            Registry.CurrentUser.DeleteSubKeyTree(choicePath, false);
            Registry.ClassesRoot.DeleteSubKeyTree(id, false);
        }
    }

    [Theory]
    [InlineData("http")]
    [InlineData("https")]
    public void OpenWithProgidsOnlyHandlerAndChangesAreDetected(string scheme)
    {
        var id = "DaylensFixture" + Guid.NewGuid().ToString("N");
        var path = $@"{scheme}\OpenWithProgids";
        var resolver = ResolverFor();
        Assert.False(Registered(resolver));
        try
        {
            using (var openWith = Registry.ClassesRoot.CreateSubKey(path)) openWith.SetValue(id, "");
            using (var command = Registry.ClassesRoot.CreateSubKey($@"{id}\shell\open\command")) command.SetValue("", $"\"{Exe}\" \"%1\"");
            Assert.True(Registered(resolver));
            Registry.ClassesRoot.OpenSubKey(path)!.DeleteValue(id);
            Assert.False(Registered(resolver));
        }
        finally { Registry.ClassesRoot.DeleteSubKeyTree(id, false); }
    }

    [Fact]
    public void EffectiveProtocolCommandIsDetected() => Assert.True(Registered(ResolverFor($"\"{Exe}\" \"%1\"")));

    [Fact]
    public void SquirrelLauncherTargetsTheRunningVersionedExecutable()
    {
        var id = "DaylensFixture" + Guid.NewGuid().ToString("N");
        try
        {
            using (var apps = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications")) apps.SetValue(id, $@"Software\{id}\Capabilities");
            using (var urls = Registry.CurrentUser.CreateSubKey($@"Software\{id}\Capabilities\URLAssociations")) urls.SetValue("http", id);
            using (var command = Registry.ClassesRoot.CreateSubKey($@"{id}\shell\open\command")) command.SetValue("", @"""C:\Apps\Jot\Update.exe"" --processStart ""jot.exe"" --process-start-args ""%1""");
            Assert.True(Registered(ResolverFor()));
        }
        finally
        {
            Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications")!.DeleteValue(id);
            Registry.CurrentUser.DeleteSubKeyTree($@"Software\{id}", false);
            Registry.ClassesRoot.DeleteSubKeyTree(id, false);
        }
    }

    [Fact]
    public void UnchangedCachedIdentificationDoesNoRegistryWork()
    {
        var id = "DaylensCostFixture" + Guid.NewGuid().ToString("N");
        try
        {
            using var apps = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications");
            for (var i = 0; i < 100; i++)
            {
                apps.SetValue(id + i, $@"Software\{id}\{i}\Capabilities");
                using var urls = Registry.CurrentUser.CreateSubKey($@"Software\{id}\{i}\Capabilities\URLAssociations");
                urls.SetValue("http", id + i);
                using var cmd = Registry.ClassesRoot.CreateSubKey($@"{id}{i}\shell\open\command");
                cmd.SetValue("", $"C:\\Other\\app{i}.exe %1");
            }
            var resolver = ResolverFor();
            Assert.False(Registered(resolver));
            var reads = RegistryKey.Reads;
            for (var i = 0; i < 100; i++) Assert.False(Registered(resolver));
            Assert.Equal(reads, RegistryKey.Reads);
        }
        finally
        {
            for (var i = 0; i < 100; i++)
            {
                Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications")!.DeleteValue(id + i);
                Registry.ClassesRoot.DeleteSubKeyTree(id + i, false);
            }
            Registry.CurrentUser.DeleteSubKeyTree($@"Software\{id}", false);
        }
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\"unterminated")]
    public void HandlerWithoutAnExecutableDoesNotWithholdUnrelatedTitles(string value)
    {
        const string id = "DaylensEmptyHandler";
        const string path = @"http\OpenWithProgids";
        var stderr = Console.Error;
        using var diagnostic = new StringWriter();
        try
        {
            using (var openWith = Registry.ClassesRoot.CreateSubKey(path)) openWith.SetValue(id, "");
            using (var command = Registry.ClassesRoot.CreateSubKey($@"{id}\shell\open\command")) command.SetValue("", value);
            Console.SetError(diagnostic);
            Assert.False(Registered(ResolverFor()));
            Assert.Contains("browser_command_unusable=1", diagnostic.ToString());
        }
        finally
        {
            Console.SetError(stderr);
            Registry.ClassesRoot.OpenSubKey(path)!.DeleteValue(id);
            Registry.ClassesRoot.DeleteSubKeyTree(id, false);
        }
    }

    [Fact]
    public void UnreadableHandlerStillWithholdsEveryAppsTitles()
    {
        const string id = "DaylensUnreadableHandler";
        const string path = @"https\OpenWithProgids";
        using var command = Registry.ClassesRoot.CreateSubKey($@"{id}\shell\open\command");
        try
        {
            using (var openWith = Registry.ClassesRoot.CreateSubKey(path)) openWith.SetValue(id, "");
            command.SetValue("", $"\"{Exe}\" %1");
            command.FailReads = true;
            Assert.True(Registered(ResolverFor()));
        }
        finally
        {
            command.FailReads = false;
            Registry.ClassesRoot.OpenSubKey(path)!.DeleteValue(id);
            Registry.ClassesRoot.DeleteSubKeyTree(id, false);
        }
    }

    [Fact]
    public void FailedRegistryReadWithholdsTitles()
    {
        Registry.LocalMachine.FailReads = true;
        try { Assert.True(Registered(ResolverFor())); }
        finally { Registry.LocalMachine.FailReads = false; }
    }

    [Fact]
    public void TransientRegistryFailureWithholdsTitlesOnlyWhileReadsFail()
    {
        var resolver = ResolverFor();
        var version = RegistryKey.Version;
        Registry.LocalMachine.FailReads = true;
        try
        {
            Assert.True(Registered(resolver));
            Assert.True(Registered(resolver));
        }
        finally { Registry.LocalMachine.FailReads = false; }
        Assert.Equal(version, RegistryKey.Version);
        Assert.False(Registered(resolver));
        Assert.False(Registered(resolver));
        Registry.LocalMachine.FailReads = true;
        try
        {
            Registry.CurrentUser.CreateSubKey(@"Software\DaylensTransientChange").Dispose();
            Assert.True(Registered(resolver));
            Assert.True(Registered(resolver));
        }
        finally
        {
            Registry.LocalMachine.FailReads = false;
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\DaylensTransientChange", false);
        }
        Assert.False(Registered(resolver));
    }
}
