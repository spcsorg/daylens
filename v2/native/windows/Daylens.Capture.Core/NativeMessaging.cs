using System.Buffers;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Daylens.Capture.Core;

/// How a browser started this binary as a native messaging host, if it did.
/// Chromium passes the caller's origin (and --parent-window on Windows); Firefox passes the manifest path and add-on ID.
public sealed record HostLaunch(bool Firefox, string ExtensionId)
{
    /// Extensions this host answers. Browsers also enforce the host manifest's allowlist; this is the second check.
    /// Store IDs join this list when each store assigns them.
    public static readonly IReadOnlySet<string> Allowed = new HashSet<string>(StringComparer.Ordinal)
    {
        "dgidcofcmgnlicmmepgomalcdcbgjjjg", // unpacked dev build (manifest.chromium-dev.json key)
        "browser@daylens.app",
    };

    public static HostLaunch? Detect(string[] args)
    {
        foreach (var a in args)
        {
            if (!a.StartsWith("chrome-extension://", StringComparison.Ordinal)) continue;
            var id = a["chrome-extension://".Length..].Split('/')[0];
            return IsChromiumId(id) ? new HostLaunch(false, id) : null;
        }
        if (args.Length >= 2 && args[0].EndsWith(".json", StringComparison.OrdinalIgnoreCase) && IsGeckoId(args[1])) return new HostLaunch(true, args[1]);
        return null;
    }

    static bool IsChromiumId(string s) => s.Length == 32 && s.All(c => c is >= 'a' and <= 'p');

    static bool IsGeckoId(string s) =>
        s.Length is > 2 and <= 128 && s.Count(c => c == '@') == 1 && s[0] != '@' && s.All(c => char.IsAsciiLetterOrDigit(c) || c is '@' or '.' or '_' or '-');
}

/// Native messaging frames: a 32-bit length in native byte order (little-endian on Windows), then UTF-8 JSON.
public static class NativeFrame
{
    /// Messages from the extension larger than this are skipped unread; none of ours comes close.
    public const int MaxInbound = 64 * 1024;
    /// Chromium refuses host messages over 1 MB.
    public const int MaxOutbound = 1024 * 1024;

    public static byte[]? Encode(ReadOnlySpan<byte> json)
    {
        if (json.Length > MaxOutbound) return null;
        var frame = new byte[4 + json.Length];
        BitConverter.TryWriteBytes(frame, json.Length);
        json.CopyTo(frame.AsSpan(4));
        return frame;
    }
}

/// Splits a byte stream into frames. Oversized frames are consumed and reported, so the stream stays in step.
public sealed class FrameReader
{
    public readonly record struct Item(byte[]? Message, int Oversized);
    readonly List<byte> _buf = new();
    int _skipping;

    public List<Item> Feed(ReadOnlySpan<byte> bytes)
    {
        var items = new List<Item>();
        if (_skipping > 0)
        {
            var n = Math.Min(_skipping, bytes.Length);
            _skipping -= n;
            bytes = bytes[n..];
        }
        foreach (var b in bytes) _buf.Add(b);
        while (_buf.Count >= 4)
        {
            var len = BitConverter.ToInt32([_buf[0], _buf[1], _buf[2], _buf[3]]);
            if (len < 0 || len > NativeFrame.MaxInbound)
            {
                var claimed = len < 0 ? int.MaxValue : len;
                items.Add(new Item(null, claimed));
                var have = _buf.Count - 4;
                if (len >= 0 && have >= len) _buf.RemoveRange(0, 4 + len);
                else
                {
                    _skipping = len < 0 ? int.MaxValue : len - have;
                    _buf.Clear();
                }
                continue;
            }
            if (_buf.Count < 4 + len) break;
            items.Add(new Item(_buf.GetRange(4, len).ToArray(), 0));
            _buf.RemoveRange(0, 4 + len);
        }
        return items;
    }
}

public sealed record TabReport(string Trigger, bool Page, string? Reason, string? Window, string? Tab, string? Url, string? Title);

public abstract record ExtensionMessage
{
    public sealed record TabMsg(TabReport Report) : ExtensionMessage;
    public sealed record Pause(string For) : ExtensionMessage;
    public sealed record Resume : ExtensionMessage;
    public sealed record Open : ExtensionMessage;
    public sealed record Status : ExtensionMessage;

    static readonly HashSet<string> Triggers = ["activated", "focus", "updated", "removed", "snapshot", "startup", "paused"];
    static readonly HashSet<string> Reasons = ["no_focused_window", "not_normal", "no_tab", "no_address", "paused"];
    static readonly HashSet<string> PauseFor = ["hour", "tomorrow", "until_resumed"];

    /// Anything not exactly one of our messages is null and is dropped.
    public static ExtensionMessage? Parse(ReadOnlySpan<byte> json)
    {
        try
        {
            var r = new Utf8JsonReader(json);
            using var doc = JsonDocument.ParseValue(ref r);
            var o = doc.RootElement;
            if (o.ValueKind != JsonValueKind.Object) return null;
            string? Str(string k, int max) =>
                o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String && v.GetString() is { } s && s.Length <= max ? s : null;
            switch (Str("t", 16))
            {
                case "status": return new Status();
                case "resume": return new Resume();
                case "open": return new Open();
                case "pause": return Str("for", 32) is { } f && PauseFor.Contains(f) ? new Pause(f) : null;
                case "tab":
                    var trigger = Str("trigger", 16);
                    if (trigger is null || !Triggers.Contains(trigger)) return null;
                    var state = Str("state", 16);
                    if (state == "unknown")
                        return Str("reason", 32) is { } reason && Reasons.Contains(reason) ? new TabMsg(new TabReport(trigger, false, reason, null, null, null, null)) : null;
                    if (state != "page") return null;
                    var url = Str("url", 2048);
                    var window = Str("window", 64);
                    if (string.IsNullOrEmpty(url) || window is null) return null;
                    var title = o.TryGetProperty("title", out var tv) && tv.ValueKind == JsonValueKind.String ? Clip(tv.GetString(), 1024) : null;
                    return new TabMsg(new TabReport(trigger, true, null, window, Str("tab", 64), url, string.IsNullOrEmpty(title) ? null : title));
                default: return null;
            }
        }
        catch (JsonException) { return null; }
    }

    internal static string? Clip(string? s, int max)
    {
        if (s is null || s.Length <= max) return s;
        return s[..(char.IsHighSurrogate(s[max - 1]) ? max - 1 : max)];
    }
}

public static class TabObs
{
    public static Action<Utf8JsonWriter> Tab(TabReport r, AppInfo browser, string extensionId) => w =>
    {
        w.WriteString("trigger", r.Trigger);
        w.WriteString("state", r.Page ? "page" : "unknown");
        Nullable(w, "reason", r.Reason);
        w.WriteStartObject("browser");
        Nullable(w, "app_id", ExtensionMessage.Clip(browser.AppId, 1024));
        Nullable(w, "name", ExtensionMessage.Clip(browser.Name, 512));
        Nullable(w, "path", ExtensionMessage.Clip(browser.Path, 2048));
        if (browser.Pid is int pid) w.WriteNumber("pid", pid); else w.WriteNull("pid");
        w.WriteBoolean("registered_browser", browser.RegisteredBrowser);
        w.WriteString("identity_state", Names.Of(browser.IdentityState));
        if (browser.Store is { } s)
        {
            w.WriteStartObject("store");
            w.WriteString("aumid", s.Aumid);
            Nullable(w, "package", s.Package);
            w.WriteEndObject();
        }
        else w.WriteNull("store");
        w.WriteEndObject();
        w.WriteString("extension", extensionId);
        Nullable(w, "window", r.Window);
        Nullable(w, "tab", r.Tab);
        Nullable(w, "url", r.Url);
        Nullable(w, "title", r.Title);
    };

    static void Nullable(Utf8JsonWriter w, string name, string? v)
    {
        if (v is null) w.WriteNull(name); else w.WriteString(name, v);
    }
}

/// What the host tells the extension and the capture service.
public static class HostReply
{
    static readonly JsonWriterOptions Options = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    static byte[] Json(Action<Utf8JsonWriter> body)
    {
        var buf = new ArrayBufferWriter<byte>(128);
        using (var w = new Utf8JsonWriter(buf, Options))
        {
            w.WriteStartObject();
            body(w);
            w.WriteEndObject();
        }
        return buf.WrittenSpan.ToArray();
    }

    public static byte[] NotRunning() => Json(w =>
    {
        w.WriteString("t", "status");
        w.WriteString("daylens", "not_running");
        w.WriteString("capture", "running");
        w.WriteNull("until_wall_ms");
    });

    public static byte[] Opened(bool ok) => Json(w => { w.WriteString("t", "opened"); w.WriteBoolean("ok", ok); });

    public static byte[] Snapshot() => Json(w => w.WriteString("t", "snapshot"));

    /// Maps one line from the capture service; null for anything unexpected.
    public static byte[]? FromService(ReadOnlySpan<byte> line)
    {
        try
        {
            var r = new Utf8JsonReader(line);
            using var doc = JsonDocument.ParseValue(ref r);
            var o = doc.RootElement;
            if (o.ValueKind != JsonValueKind.Object || !o.TryGetProperty("op", out var op) || op.ValueKind != JsonValueKind.String) return null;
            if (op.GetString() == "snapshot") return Snapshot();
            if (op.GetString() != "status" || !o.TryGetProperty("capture", out var c) || c.GetString() is not ("running" or "paused")) return null;
            var capture = c.GetString()!;
            long? until = o.TryGetProperty("until_wall_ms", out var u) && u.ValueKind == JsonValueKind.Number && u.TryGetInt64(out var ms) ? ms : null;
            return Json(w =>
            {
                w.WriteString("t", "status");
                w.WriteString("daylens", "connected");
                w.WriteString("capture", capture);
                if (until is long v) w.WriteNumber("until_wall_ms", v); else w.WriteNull("until_wall_ms");
            });
        }
        catch (JsonException) { return null; }
    }

    public static byte[]? Control(ExtensionMessage m) => m switch
    {
        ExtensionMessage.Pause p => Line(Json(w => { w.WriteString("op", "pause"); w.WriteString("for", p.For); })),
        ExtensionMessage.Resume => Line(Json(w => w.WriteString("op", "resume"))),
        ExtensionMessage.Status => Line(Json(w => w.WriteString("op", "status"))),
        _ => null,
    };

    static byte[] Line(byte[] json) => [.. json, (byte)'\n'];
}

/// One process in the chain that started the host.
public readonly record struct ProcessEntry(int Pid, int ParentPid, string ImagePath, long CreatedFileTime);

public static class LaunchChain
{
    /// The browser behind this host: the parent, or the parent's parent when Chromium put cmd.exe in between.
    /// A parent created after its child is a reused pid, not our parent.
    public static int? BrowserPid(int selfPid, Func<int, ProcessEntry?> lookup)
    {
        if (lookup(selfPid) is not { } self) return null;
        if (lookup(self.ParentPid) is not { } parent || parent.CreatedFileTime > self.CreatedFileTime) return null;
        if (!IsCmd(parent.ImagePath)) return parent.Pid;
        if (lookup(parent.ParentPid) is not { } grand || grand.CreatedFileTime > parent.CreatedFileTime) return null;
        return grand.Pid;
    }

    static bool IsCmd(string path) => Path.GetFileName(path.Replace('\\', '/')).Equals("cmd.exe", StringComparison.OrdinalIgnoreCase);
}
