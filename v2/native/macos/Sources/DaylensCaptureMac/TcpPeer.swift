// --tcp-peer <service port> <peer port>: the capture service asks which app is on the other end of a loopback
// connection to its browser listener. Prints one JSON line and exits; captures nothing.

import AppKit
import CaptureCore
import Darwin

enum TcpPeer {
  static func runIfAsked() {
    guard CommandLine.arguments.contains("--tcp-peer") else { return }
    guard let ports = PeerWalk.ports(CommandLine.arguments) else {
      print(#"{"ok":false,"reason":"bad_args"}"#)
      exit(64)
    }
    let owner = socketOwner(peerPort: ports.peer, servicePort: ports.service)
    let walked = PeerWalk.appAncestor(of: owner, me: getuid(), proc: proc, isApp: { pid in
      NSRunningApplication(processIdentifier: pid)?.activationPolicy == .regular
    })
    print(PeerWalk.answer(walked.map { appInfo(NSRunningApplication(processIdentifier: $0)) }))
    exit(0)
  }

  static func proc(_ pid: Int32) -> PeerWalk.Proc? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    return PeerWalk.Proc(pid: pid, ppid: Int32(info.pbi_ppid), uid: info.pbi_uid)
  }

  /// The process holding the IPv4 loopback socket 127.0.0.1:peerPort -> 127.0.0.1:servicePort. Another user's
  /// processes cannot be listed, so a peer owned by another user is never found.
  static func socketOwner(peerPort: UInt16, servicePort: UInt16) -> Int32? {
    let me = getpid()
    let count = proc_listallpids(nil, 0)
    guard count > 0 else { return nil }
    var pids = [pid_t](repeating: 0, count: Int(count) + 64)
    let got = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
    guard got > 0 else { return nil }
    let loopback = UInt32(0x7F00_0001).bigEndian
    for pid in pids.prefix(Int(got)) where pid > 0 && pid != me {
      let bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
      guard bytes > 0 else { continue }
      let stride = MemoryLayout<proc_fdinfo>.stride
      var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: Int(bytes) / stride + 8)
      let filled = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, &fds, Int32(fds.count * stride))
      guard filled > 0 else { continue }
      for fd in fds.prefix(Int(filled) / stride) where fd.proc_fdtype == UInt32(PROX_FDTYPE_SOCKET) {
        var si = socket_fdinfo()
        let size = Int32(MemoryLayout<socket_fdinfo>.size)
        guard proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, &si, size) == size, si.psi.soi_kind == Int32(SOCKINFO_TCP) else { continue }
        let ini = si.psi.soi_proto.pri_tcp.tcpsi_ini
        guard ini.insi_vflag & UInt8(INI_IPV4) != 0 else { continue }
        let lport = UInt16(bigEndian: UInt16(truncatingIfNeeded: ini.insi_lport))
        let fport = UInt16(bigEndian: UInt16(truncatingIfNeeded: ini.insi_fport))
        guard lport == peerPort, fport == servicePort else { continue }
        guard ini.insi_laddr.ina_46.i46a_addr4.s_addr == loopback, ini.insi_faddr.ina_46.i46a_addr4.s_addr == loopback else { continue }
        return pid
      }
    }
    return nil
  }
}
