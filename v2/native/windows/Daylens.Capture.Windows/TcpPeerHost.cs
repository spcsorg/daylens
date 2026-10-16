// --tcp-peer <service port> <peer port>: the capture service asks which app is on the other end of a loopback
// connection to its browser listener. Prints one JSON line and exits; captures nothing.

using System.Runtime.Versioning;
using Daylens.Capture.Core;

namespace Daylens.Capture.Windows;

[SupportedOSPlatform("windows")]
internal static unsafe class TcpPeerHost
{
    public static int? TryRun(string[] args)
    {
        if (!args.Contains("--tcp-peer")) return null;
        var stdout = Console.OpenStandardOutput();
        var ports = TcpPeer.Ports(args);
        if (ports is not { } pp)
        {
            stdout.Write("{\"ok\":false,\"reason\":\"bad_args\"}\n"u8);
            return 64;
        }
        var owner = Owner(pp.Peer, pp.Service);
        var procs = BrowserHost.Snapshot();
        var (main, why) = TcpPeer.MainProcess(owner, p => procs.TryGetValue(p, out var e) ? e : null, BrowserHost.SameUser);
        stdout.Write(TcpPeer.Answer(main is int pid ? BrowserHost.Identify(pid) : null, why));
        stdout.Flush();
        return 0;
    }

    static int? Owner(ushort peer, ushort service)
    {
        uint size = 0;
        Native.GetExtendedTcpTable(null, ref size, false, Native.AF_INET, Native.TCP_TABLE_OWNER_PID_ALL, 0);
        for (var attempt = 0; attempt < 4 && size > 0; attempt++)
        {
            // The table can grow between the size query and the read; ask again with the new size.
            var buf = new byte[size + 1024];
            var len = (uint)buf.Length;
            uint rc;
            fixed (byte* p = buf) rc = Native.GetExtendedTcpTable(p, ref len, false, Native.AF_INET, Native.TCP_TABLE_OWNER_PID_ALL, 0);
            if (rc == 0) return TcpPeer.OwnerInTable(buf.AsSpan(0, (int)len), peer, service);
            if (rc != Native.ERROR_INSUFFICIENT_BUFFER_TCP) return null;
            size = len;
        }
        return null;
    }
}
