using System.Buffers;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Daylens.Capture.Core;

public readonly record struct EventTime(long WallMs, long MonoUs, string Tz, int TzOffsetMin);

public enum IdentityState { Ok, AccessDenied, Timeout, Gone, None, Unresolved }
public enum TitleState { Ok, Empty, NoWindow, NoPermission, Timeout, Unavailable }
public enum ChannelState { Ok, Degraded, Stalled, NoPermission }
public enum FocusTrigger { AppChanged, WindowChanged, TitleChanged, Reconcile, Snapshot }

public sealed record StoreIdentity(string Aumid, string? Package);

/// The executable's version resource; trusted Windows apps must match it, not only their file name.
public sealed record VersionInfo(string? OriginalFilename, string? ProductName);

/// Whether each event source's subscription is in place.
public readonly record struct Registrations(bool Focus, bool Session, bool Power);

public sealed record AppInfo(string? AppId, string? Name, string? Path, int? Pid, bool RegisteredBrowser, IdentityState IdentityState, StoreIdentity? Store, Engine Engine = Engine.Unknown, string? Signer = null, VersionInfo? Version = null)
{
    public static readonly AppInfo NoneInFront = new(null, null, null, null, false, IdentityState.None, null);
    public static AppInfo Unknown(int? pid, IdentityState state) => new(null, null, null, pid, false, state, null);
}

public sealed record WindowInfo
{
    public const int MaxTitleUtf16 = 1024;
    public string? Window { get; }
    public string? Title { get; }
    public TitleState TitleState { get; }

    public WindowInfo(string? window, string? title, TitleState state)
    {
        Window = window;
        Title = state == TitleState.Ok && !string.IsNullOrEmpty(title) ? Truncate(title) : null;
        // The protocol requires a title exactly when the state is ok.
        TitleState = state == TitleState.Ok && Title is null ? (title is null ? TitleState.Unavailable : TitleState.Empty) : state;
    }

    public static WindowInfo Read(string? window, string? title) =>
        title is null ? new(window, null, TitleState.Unavailable)
        : title.Length == 0 ? new(window, null, TitleState.Empty)
        : new(window, title, TitleState.Ok);

    static string? Truncate(string? s)
    {
        if (s is null || s.Length <= MaxTitleUtf16) return s;
        var cut = MaxTitleUtf16;
        if (char.IsHighSurrogate(s[cut - 1])) cut--;
        return s[..cut];
    }
}

public static class Names
{
    public static string Of(Engine e) => e switch
    {
        Engine.Browser => "browser", Engine.AppRuntime => "app_runtime", Engine.None => "none", _ => "unknown",
    };
    public static string Of(IdentityState s) => s switch
    {
        IdentityState.Ok => "ok", IdentityState.AccessDenied => "access_denied", IdentityState.Timeout => "timeout",
        IdentityState.Gone => "gone", IdentityState.Unresolved => "unresolved", _ => "none",
    };
    public static string Of(TitleState s) => s switch
    {
        TitleState.Ok => "ok", TitleState.Empty => "empty", TitleState.NoWindow => "no_window", TitleState.NoPermission => "no_permission",
        TitleState.Timeout => "timeout", _ => "unavailable",
    };
    public static string Of(ChannelState s) => s switch
    {
        ChannelState.Ok => "ok", ChannelState.Degraded => "degraded", ChannelState.Stalled => "stalled", _ => "no_permission",
    };
    public static string Of(FocusTrigger t) => t switch
    {
        FocusTrigger.AppChanged => "app_changed", FocusTrigger.WindowChanged => "window_changed", FocusTrigger.TitleChanged => "title_changed",
        FocusTrigger.Reconcile => "reconcile", _ => "snapshot",
    };
}

/// Builders for the obs object of each kind. Spec: v2/protocol/PROTOCOL.md.
public static class Obs
{
    const string NotApplicable = "not_applicable";

    static void Permissions(Utf8JsonWriter w)
    {
        w.WriteStartObject("permissions");
        w.WriteString("accessibility", NotApplicable);
        w.WriteEndObject();
    }

    public static Action<Utf8JsonWriter> Hello(string helper, string version, int pid, string os, int heartbeatS, int idleThresholdS, int reconcileS) => w =>
    {
        w.WriteString("helper", helper);
        w.WriteString("version", version);
        w.WriteNumber("pid", pid);
        w.WriteString("os", os);
        Permissions(w);
        w.WriteStartObject("config");
        w.WriteNumber("heartbeat_s", heartbeatS);
        w.WriteNumber("idle_threshold_s", idleThresholdS);
        w.WriteNumber("reconcile_s", reconcileS);
        w.WriteEndObject();
    };

    public static Action<Utf8JsonWriter> Heartbeat(long awakeUs, Registrations registrations, ChannelState titles, long stallMs, long dropped) => w =>
    {
        w.WriteNumber("awake_us", awakeUs);
        Permissions(w);
        w.WriteStartObject("registrations");
        w.WriteBoolean("focus", registrations.Focus);
        w.WriteBoolean("session", registrations.Session);
        w.WriteBoolean("power", registrations.Power);
        w.WriteEndObject();
        w.WriteString("titles", Names.Of(titles));
        w.WriteNumber("stall_ms", stallMs);
        w.WriteNumber("dropped", dropped);
    };

    public static Action<Utf8JsonWriter> Focus(FocusTrigger trigger, AppInfo app, WindowInfo window) => w =>
    {
        w.WriteString("trigger", Names.Of(trigger));
        w.WriteStartObject("app");
        // Clipped to the validator's limits: exe metadata is controlled by the exe, and one long field must not void the line.
        WriteNullable(w, "app_id", Clip(app.AppId, 1024));
        WriteNullable(w, "name", Clip(app.Name, 512));
        WriteNullable(w, "path", Clip(app.Path, 2048));
        if (app.Pid is int pid) w.WriteNumber("pid", pid); else w.WriteNull("pid");
        w.WriteBoolean("registered_browser", app.RegisteredBrowser);
        w.WriteString("engine", Names.Of(app.Engine));
        WriteNullable(w, "signer", Clip(app.Signer, 256));
        if (app.Version is { } v)
        {
            w.WriteStartObject("version_info");
            WriteNullable(w, "original_filename", Clip(v.OriginalFilename, 260));
            WriteNullable(w, "product_name", Clip(v.ProductName, 256));
            w.WriteEndObject();
        }
        else w.WriteNull("version_info");
        w.WriteString("identity_state", Names.Of(app.IdentityState));
        if (app.Store is { } s)
        {
            w.WriteStartObject("store");
            w.WriteString("aumid", s.Aumid);
            WriteNullable(w, "package", s.Package);
            w.WriteEndObject();
        }
        else w.WriteNull("store");
        w.WriteEndObject();
        w.WriteStartObject("window");
        WriteNullable(w, "window", window.Window);
        WriteNullable(w, "title", window.Title);
        w.WriteString("title_state", Names.Of(window.TitleState));
        w.WriteEndObject();
    };

    public static Action<Utf8JsonWriter> Input(bool idle, long lastInputWallMs, int thresholdS, bool snapshot) => w =>
    {
        w.WriteString("state", idle ? "idle" : "active");
        w.WriteNumber("last_input_wall_ms", lastInputWallMs);
        w.WriteNumber("threshold_s", thresholdS);
        w.WriteBoolean("snapshot", snapshot);
    };

    public static Action<Utf8JsonWriter> Session(string state, bool snapshot) => w =>
    {
        w.WriteString("state", state);
        w.WriteBoolean("snapshot", snapshot);
    };

    public static Action<Utf8JsonWriter> Power(string state) => w => w.WriteString("state", state);
    public static Action<Utf8JsonWriter> Clock(string change) => w => w.WriteString("change", change);
    public static Action<Utf8JsonWriter> Loss(int count, long fromWallMs, long toWallMs) => w =>
    {
        w.WriteString("channel", "focus");
        w.WriteNumber("count", count);
        w.WriteNumber("from_wall_ms", fromWallMs);
        w.WriteNumber("to_wall_ms", toWallMs);
    };

    public static Action<Utf8JsonWriter> Bye(string reason) => w => w.WriteString("reason", reason);

    static string? Clip(string? s, int max)
    {
        if (s is null || s.Length <= max) return s;
        var cut = char.IsHighSurrogate(s[max - 1]) ? max - 1 : max;
        return s[..cut];
    }

    static void WriteNullable(Utf8JsonWriter w, string name, string? value)
    {
        if (value is null) w.WriteNull(name); else w.WriteString(name, value);
    }
}

public static class Envelope
{
    public const int Version = 1;
    static readonly JsonWriterOptions Options = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, Indented = false };

    public static byte[] Line(string run, long seq, string boot, EventTime t, string platform, string source, string kind, Action<Utf8JsonWriter> obs)
    {
        var buf = new ArrayBufferWriter<byte>(512);
        using (var w = new Utf8JsonWriter(buf, Options))
        {
            w.WriteStartObject();
            w.WriteNumber("v", Version);
            w.WriteString("run", run);
            w.WriteNumber("seq", seq);
            w.WriteString("boot", boot);
            w.WriteStartObject("t");
            w.WriteNumber("wall_ms", t.WallMs);
            w.WriteNumber("mono_us", t.MonoUs);
            w.WriteString("tz", t.Tz);
            w.WriteNumber("tz_offset_min", t.TzOffsetMin);
            w.WriteEndObject();
            w.WriteString("platform", platform);
            w.WriteString("source", source);
            w.WriteString("kind", kind);
            w.WriteStartObject("obs");
            obs(w);
            w.WriteEndObject();
            w.WriteEndObject();
        }
        var line = new byte[buf.WrittenCount + 1];
        buf.WrittenSpan.CopyTo(line);
        line[^1] = (byte)'\n';
        return line;
    }
}
