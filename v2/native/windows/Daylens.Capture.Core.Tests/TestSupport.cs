using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Daylens.Capture.Core;

namespace Daylens.Capture.Core.Tests;

static class TestSupport
{
    public static readonly EventTime Time = new(1_792_130_412_345, 881_234_567_890, "Example/Town", -300);
    public const int MaxLineBytes = 16 * 1024;

    // Builds strings from code points so editors and tools never rewrite them; lone surrogates allowed.
    public static string U(params int[] units) => new(units.Select(u => (char)u).ToArray());

    public static string FixturesPath()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "protocol", "fixtures", "valid.json");
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException("v2/protocol/fixtures/valid.json not found above " + AppContext.BaseDirectory);
    }

    public static Dictionary<string, JsonObject> Fixtures()
    {
        var list = JsonNode.Parse(File.ReadAllText(FixturesPath()))!.AsArray();
        return list.ToDictionary(e => e!["name"]!.GetValue<string>(), e => e!["line"]!.AsObject());
    }

    /// Everything the protocol and the TS validator require of one emitted line, at the byte level.
    public static JsonObject AssertSingleValidLine(byte[] line)
    {
        Assert.NotEmpty(line);
        Assert.Equal((byte)'\n', line[^1]);
        Assert.Equal(1, line.Count(b => b == (byte)'\n'));
        Assert.DoesNotContain((byte)'\r', line);
        Assert.True(line.Length <= MaxLineBytes, $"line is {line.Length} bytes, over the 16 KiB limit");

        var text = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(line);
        // Other line splitters (Python splitlines, some loggers) break on these; they must arrive escaped.
        Assert.DoesNotContain(U(0x2028), text);
        Assert.DoesNotContain(U(0x2029), text);
        Assert.DoesNotContain(U(0x0085), text);

        using var doc = JsonDocument.Parse(line.AsMemory(0, line.Length - 1));
        Assert.Equal(JsonValueKind.Object, doc.RootElement.ValueKind);
        return JsonNode.Parse(line.AsSpan(0, line.Length - 1))!.AsObject();
    }

    public static byte[] FocusLine(AppInfo app, WindowInfo window, long seq = 0) =>
        Envelope.Line("run-0001", seq, "boot-0001", Time, "windows", "win_event", "focus", Obs.Focus(FocusTrigger.TitleChanged, app, window));

    public static readonly AppInfo Calculator = new(
        "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
        "Calculator",
        @"C:\Program Files\WindowsApps\Microsoft.WindowsCalculator_11.2405.2.0_x64__8wekyb3d8bbwe\CalculatorApp.exe",
        9120,
        false,
        IdentityState.Ok,
        new StoreIdentity("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", "Microsoft.WindowsCalculator_11.2405.2.0_x64__8wekyb3d8bbwe"),
        Engine.None);

    /// True when the string has no unpaired surrogate.
    public static bool IsWellFormedUtf16(string s)
    {
        for (var i = 0; i < s.Length; i++)
        {
            if (char.IsHighSurrogate(s[i]))
            {
                if (i + 1 >= s.Length || !char.IsLowSurrogate(s[i + 1])) return false;
                i++;
            }
            else if (char.IsLowSurrogate(s[i])) return false;
        }
        return true;
    }
}
