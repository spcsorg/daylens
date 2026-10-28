// The app an agent process runs in, found by walking up its parent processes to the first one that is an app.

/// How a host app was found: the system's responsible process, the parent chain, or not at all.
public enum HostBasis: String { case responsible, parent, none }

/// Walks from `pid` up through `parent` until `app` names one; nil past the launchd root, on a loop, or after
/// `maxSteps` processes. A detached multiplexer (tmux) or a remote shell (sshd) leads to launchd, so to nil.
public func hostAncestor<App>(of pid: Int32, parent: (Int32) -> Int32?, app: (Int32) -> App?, maxSteps: Int = 64) -> App? {
  var seen = Set<Int32>()
  var current: Int32? = pid
  for _ in 0..<maxSteps {
    guard let p = current, p > 1, seen.insert(p).inserted else { return nil }
    if let a = app(p) { return a }
    current = parent(p)
  }
  return nil
}
