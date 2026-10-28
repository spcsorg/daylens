using System.Buffers;
using System.Buffers.Binary;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Daylens.Capture.Core;

/// Finds the app behind a loopback TCP peer for the capture service: the process that owns the peer's socket in the
/// TCP table, then its browser's main process (Chromium and Firefox run their network code in child processes of the
/// same executable).
public static class TcpPeer
{
    public enum Refusal { NoSocket, OtherUser, NoApp }

    public static string Name(Refusal r) => r switch { Refusal.NoSocket => "no_socket", Refusal.OtherUser => "other_user", _ => "no_app" };

    /// Ports as the service passes them: its own listening port, then the peer's port.
    public static (ushort Service, ushort Peer)? Ports(string[] args)
    {
        var i = Array.IndexOf(args, "--tcp-peer");
        if (i < 0 || i + 2 >= args.Length) return null;
        return ushort.TryParse(args[i + 1], out var s) && ushort.TryParse(args[i + 2], out var p) && s > 0 && p > 0 ? (s, p) : null;
    }

    /// The owner of 127.0.0.1:peer -> 127.0.0.1:service in a MIB_TCPTABLE_OWNER_PID buffer (ports and addresses in
    /// network byte order, as GetExtendedTcpTable returns them).
    public static int? OwnerInTable(ReadOnlySpan<byte> table, ushort peerPort, ushort servicePort)
    {
        const int Row = 24;
        if (table.Length < 4) return null;
        var n = BinaryPrimitives.ReadUInt32LittleEndian(table);
        for (var i = 0; i < n && 4 + (i + 1) * Row <= table.Length; i++)
        {
            var r = table.Slice(4 + i * Row, Row);
            if (!IsLoopback(r.Slice(4, 4)) || !IsLoopback(r.Slice(12, 4))) continue;
            if (Port(r.Slice(8, 4)) != peerPort || Port(r.Slice(16, 4)) != servicePort) continue;
            return (int)BinaryPrimitives.ReadUInt32LittleEndian(r.Slice(20, 4));
        }
        return null;
    }

    static bool IsLoopback(ReadOnlySpan<byte> a) => a[0] == 127 && a[1] == 0 && a[2] == 0 && a[3] == 1;
    static ushort Port(ReadOnlySpan<byte> p) => BinaryPrimitives.ReadUInt16BigEndian(p);

    /// Climbs from the socket owner while the parent runs the same executable and is older, so a browser's network
    /// process resolves to its main process. Every process on the way must belong to this user.
    public static (int? Pid, Refusal? Why) MainProcess(int? owner, Func<int, ProcessEntry?> lookup, Func<int, bool> sameUser)
    {
        if (owner is not int start || lookup(start) is not { } cur) return (null, Refusal.NoSocket);
        if (!sameUser(cur.Pid)) return (null, Refusal.OtherUser);
        for (var i = 0; i < 32; i++)
        {
            if (lookup(cur.ParentPid) is not { } parent || parent.CreatedFileTime > cur.CreatedFileTime ||
                !string.Equals(Path.GetFileName(parent.ImagePath.Replace('\\', '/')), Path.GetFileName(cur.ImagePath.Replace('\\', '/')), StringComparison.OrdinalIgnoreCase))
                break;
            if (!sameUser(parent.Pid)) return (null, Refusal.OtherUser);
            cur = parent;
        }
        return (cur.Pid, null);
    }

    static readonly JsonWriterOptions Options = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static byte[] Answer(AppInfo? browser, Refusal? why)
    {
        var buf = new ArrayBufferWriter<byte>(256);
        using (var w = new Utf8JsonWriter(buf, Options))
        {
            w.WriteStartObject();
            w.WriteBoolean("ok", browser is not null);
            if (browser is not null) TabObs.WriteApp(w, "browser", browser);
            else w.WriteString("reason", Name(why ?? Refusal.NoApp));
            w.WriteEndObject();
        }
        return [.. buf.WrittenSpan, (byte)'\n'];
    }
}
