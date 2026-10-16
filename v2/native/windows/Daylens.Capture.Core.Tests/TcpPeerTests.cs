using System.Buffers.Binary;
using System.Text;
using Daylens.Capture.Core;

namespace Daylens.Capture.Core.Tests;

public class TcpPeerTests
{
    static byte[] Table(params (byte[] LocalAddr, ushort LocalPort, byte[] RemoteAddr, ushort RemotePort, int Pid)[] rows)
    {
        var buf = new byte[4 + rows.Length * 24];
        BinaryPrimitives.WriteUInt32LittleEndian(buf, (uint)rows.Length);
        for (var i = 0; i < rows.Length; i++)
        {
            var r = buf.AsSpan(4 + i * 24, 24);
            BinaryPrimitives.WriteUInt32LittleEndian(r, 5);
            rows[i].LocalAddr.CopyTo(r[4..]);
            BinaryPrimitives.WriteUInt16BigEndian(r[8..], rows[i].LocalPort);
            rows[i].RemoteAddr.CopyTo(r[12..]);
            BinaryPrimitives.WriteUInt16BigEndian(r[16..], rows[i].RemotePort);
            BinaryPrimitives.WriteUInt32LittleEndian(r[20..], (uint)rows[i].Pid);
        }
        return buf;
    }

    static readonly byte[] Lo = [127, 0, 0, 1];
    static readonly byte[] Lan = [192, 168, 1, 5];

    [Fact]
    public void TheOwnerIsThePeerSideOfTheLoopbackConnection()
    {
        var t = Table((Lo, 27481, Lo, 50123, 4), (Lan, 50123, Lo, 27481, 66), (Lo, 50123, Lo, 27481, 910));
        Assert.Equal(910, TcpPeer.OwnerInTable(t, 50123, 27481));
        Assert.Null(TcpPeer.OwnerInTable(t, 50124, 27481));
        Assert.Null(TcpPeer.OwnerInTable(Table((Lan, 50123, Lo, 27481, 66)), 50123, 27481));
        Assert.Null(TcpPeer.OwnerInTable(new byte[] { 9, 0, 0, 0 }, 1, 2));
    }

    [Fact]
    public void TheNetworkProcessResolvesToTheBrowsersMainProcess()
    {
        var procs = new Dictionary<int, ProcessEntry>
        {
            [900] = new(900, 4, "chrome.exe", 100),
            [910] = new(910, 900, "chrome.exe", 200),
            [920] = new(920, 4, "chrome.exe", 150),
            [930] = new(930, 940, "chrome.exe", 300),
            [940] = new(940, 4, "chrome.exe", 999),
        };
        ProcessEntry? Look(int p) => procs.TryGetValue(p, out var e) ? e : null;
        Assert.Equal((900, (TcpPeer.Refusal?)null), TcpPeer.MainProcess(910, Look, _ => true));
        Assert.Equal((930, (TcpPeer.Refusal?)null), TcpPeer.MainProcess(930, Look, _ => true));
        Assert.Equal((null, TcpPeer.Refusal.NoSocket), TcpPeer.MainProcess(null, Look, _ => true));
        Assert.Equal((null, TcpPeer.Refusal.OtherUser), TcpPeer.MainProcess(910, Look, p => p != 910));
        Assert.Equal((null, TcpPeer.Refusal.OtherUser), TcpPeer.MainProcess(910, Look, p => p != 900));
    }

    [Fact]
    public void ArgumentsAndAnswer()
    {
        Assert.Equal(((ushort)27481, (ushort)50123), TcpPeer.Ports(["--tcp-peer", "27481", "50123"]));
        Assert.Null(TcpPeer.Ports(["--tcp-peer", "27481"]));
        Assert.Null(TcpPeer.Ports(["--tcp-peer", "0", "1"]));
        Assert.Equal("{\"ok\":false,\"reason\":\"other_user\"}\n", Encoding.UTF8.GetString(TcpPeer.Answer(null, TcpPeer.Refusal.OtherUser)));
        var ok = Encoding.UTF8.GetString(TcpPeer.Answer(new AppInfo("C:\\c\\chrome.exe", "Google Chrome", "C:\\c\\chrome.exe", 900, false, IdentityState.Ok, null), null));
        Assert.StartsWith("{\"ok\":true,\"browser\":{\"app_id\":\"C:\\\\c\\\\chrome.exe\"", ok);
    }
}
