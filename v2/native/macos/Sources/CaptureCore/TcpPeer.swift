import Foundation

/// Finds the app behind a loopback TCP peer for the capture service: the process that owns the peer's socket, then
/// the nearest ancestor that is an app (a browser's network process is a child of its main process).
public enum PeerWalk {
  public struct Proc: Equatable {
    public let pid: Int32
    public let ppid: Int32
    public let uid: UInt32
    public init(pid: Int32, ppid: Int32, uid: UInt32) { self.pid = pid; self.ppid = ppid; self.uid = uid }
  }

  public enum Refusal: String, Error { case no_socket, other_user, no_app }

  public static func appAncestor(of owner: Int32?, me: UInt32, proc: (Int32) -> Proc?, isApp: (Int32) -> Bool) -> Result<Int32, Refusal> {
    guard let owner, let start = proc(owner) else { return .failure(.no_socket) }
    guard start.uid == me else { return .failure(.other_user) }
    var cur = start
    for _ in 0..<32 {
      if isApp(cur.pid) { return cur.uid == me ? .success(cur.pid) : .failure(.other_user) }
      guard cur.ppid > 1, let parent = proc(cur.ppid) else { return .failure(.no_app) }
      cur = parent
    }
    return .failure(.no_app)
  }

  /// Ports as the service passes them: its own listening port, then the peer's port.
  public static func ports(_ args: [String]) -> (service: UInt16, peer: UInt16)? {
    guard let i = args.firstIndex(of: "--tcp-peer"), i + 2 < args.count, let s = UInt16(args[i + 1]), let p = UInt16(args[i + 2]), s > 0, p > 0 else { return nil }
    return (s, p)
  }

  public static func answer(_ r: Result<AppInfo, Refusal>) -> String {
    switch r {
    case .success(let app): return JSON.object([("ok", .bool(true)), ("browser", app.json)]).serialized()
    case .failure(let why): return JSON.object([("ok", .bool(false)), ("reason", .string(why.rawValue))]).serialized()
    }
  }
}
