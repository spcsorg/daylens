// Native messaging host mode: started by a browser for the Daylens extension, it forwards tab reports to the
// capture service as protocol lines over a local socket and relays status back. It captures nothing itself.
// The browser keeps this process alive while the extension's port is open, so it idles with no timers.

import AppKit
import CaptureCore
import Darwin
import Foundation

enum BrowserHost {
  static func runIfLaunchedByBrowser() {
    guard let launch = HostLaunch.detect(CommandLine.arguments) else { return }
    guard allowedExtensionIds.contains(launch.extensionId) else {
      diag("browser_host_refused", "extension")
      exit(1)
    }
    signal(SIGPIPE, SIG_IGN)
    // The browser that started us; the capture service matches it against the app in front.
    let browser = appInfo(NSRunningApplication(processIdentifier: getppid()))
    let host = Host(extensionId: launch.extensionId, browser: browser, socketPath: socketPath())
    host.start()
    dispatchMain()
  }

  static func socketPath() -> String {
    if let p = ProcessInfo.processInfo.environment["DAYLENS_V2_BROWSER_SOCKET"], !p.isEmpty { return p }
    var buf = [CChar](repeating: 0, count: Int(PATH_MAX))
    let n = confstr(_CS_DARWIN_USER_TEMP_DIR, &buf, buf.count)
    let tmp = n > 0 ? String(cString: buf) : NSTemporaryDirectory()
    return (tmp as NSString).appendingPathComponent("daylens-v2/browser.sock")
  }
}

private final class Host {
  let extensionId: String
  let browser: AppInfo
  let socketPath: String
  private let lock = NSLock()
  private var fd: Int32 = -1
  private var generation = 0
  private let stdoutLock = NSLock()
  private var emitter: Emitter!
  private var watch: DispatchSourceFileSystemObject?

  init(extensionId: String, browser: AppInfo, socketPath: String) {
    self.extensionId = extensionId
    self.browser = browser
    self.socketPath = socketPath
  }

  func start() {
    emitter = Emitter(run: UUID().uuidString, boot: bootIdentity().id, platform: "macos", capacity: 256, reserve: 0) { [weak self] line in
      self?.writeSocket(line)
    }
    diag("browser_host_started", browser.identityState.rawValue)
    if !connect() { replyToExtension(HostReply.notRunning()) }
    watchForService()
    Thread.detachNewThread { [self] in readExtension() }
  }

  // MARK: extension side

  private func readExtension() {
    var reader = FrameReader()
    var chunk = [UInt8](repeating: 0, count: 16 * 1024)
    while true {
      let n = chunk.withUnsafeMutableBytes { read(0, $0.baseAddress!, $0.count) }
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { exit(0) }  // the browser closed the port
      for item in reader.feed(Array(chunk[0..<n])) {
        switch item {
        case .oversized: diag("browser_host_dropped", "too_long")
        case .message(let bytes):
          guard let m = ExtensionMessage.parse(bytes) else {
            diag("browser_host_dropped", "bad_message")
            continue
          }
          handle(m)
        }
      }
    }
  }

  private func handle(_ m: ExtensionMessage) {
    switch m {
    case .open:
      replyToExtension(HostReply.opened(openDaylens()))
    case .tab(let r):
      if !isConnected() { _ = connect() }
      emitter.emit(kind: "tab", source: "browser_ext", time: Clock.now(), obs: Obs.tab(r, browser: browser, extensionId: extensionId), priority: .normal)
    default:
      if !isConnected() && !connect() {
        replyToExtension(HostReply.notRunning())
        return
      }
      if let line = HostReply.control(m) { writeSocket(line + "\n") }
    }
  }

  func replyToExtension(_ json: String) {
    guard let frame = NativeFrame.encode(json) else { return }
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    var off = 0
    while off < frame.count {
      let n = frame.withUnsafeBytes { write(1, $0.baseAddress! + off, $0.count - off) }
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { exit(0) }
      off += n
    }
  }

  // MARK: service side

  private func isConnected() -> Bool {
    lock.lock(); defer { lock.unlock() }
    return fd >= 0
  }

  @discardableResult
  private func connect() -> Bool {
    lock.lock()
    if fd >= 0 { lock.unlock(); return true }
    let s = socket(AF_UNIX, SOCK_STREAM, 0)
    guard s >= 0 else { lock.unlock(); return false }
    var on: Int32 = 1
    setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let path = Array(socketPath.utf8)
    guard path.count < MemoryLayout.size(ofValue: addr.sun_path) else {
      close(s); lock.unlock(); diag("browser_host_socket", "path_too_long"); return false
    }
    withUnsafeMutableBytes(of: &addr.sun_path) { p in
      p.copyBytes(from: path)
      p[path.count] = 0
    }
    let ok = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    } == 0
    guard ok, peerIsUs(s) else {
      close(s); lock.unlock(); return false
    }
    fd = s
    generation += 1
    let gen = generation
    lock.unlock()
    diag("browser_host_connected")
    Thread.detachNewThread { [self] in readService(s, gen) }
    // Daylens has no state from us yet; ask the extension for the present.
    replyToExtension(HostReply.snapshot())
    return true
  }

  /// The socket's folder is private to this user, and the listener must run as this user too.
  private func peerIsUs(_ s: Int32) -> Bool {
    var uid: uid_t = 0
    var gid: gid_t = 0
    return getpeereid(s, &uid, &gid) == 0 && uid == getuid()
  }

  private func disconnect(_ gen: Int) {
    lock.lock()
    guard gen == generation, fd >= 0 else { lock.unlock(); return }
    close(fd)
    fd = -1
    lock.unlock()
    diag("browser_host_disconnected")
    replyToExtension(HostReply.notRunning())
  }

  private func writeSocket(_ line: String) {
    lock.lock()
    let s = fd
    let gen = generation
    lock.unlock()
    guard s >= 0 else { return }
    let bytes = Array(line.utf8)
    var off = 0
    while off < bytes.count {
      let n = bytes.withUnsafeBytes { write(s, $0.baseAddress! + off, $0.count - off) }
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { return disconnect(gen) }
      off += n
    }
  }

  private func readService(_ s: Int32, _ gen: Int) {
    var pending: [UInt8] = []
    var chunk = [UInt8](repeating: 0, count: 4096)
    while true {
      let n = chunk.withUnsafeMutableBytes { read(s, $0.baseAddress!, $0.count) }
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { return disconnect(gen) }
      pending += chunk[0..<n]
      while let nl = pending.firstIndex(of: 0x0A) {
        let line = String(decoding: pending[..<nl], as: UTF8.self)
        pending.removeSubrange(...nl)
        if let reply = HostReply.fromService(line) { replyToExtension(reply) }
      }
      if pending.count > 16 * 1024 { pending.removeAll() }
    }
  }

  /// The service creates the socket in its own folder; a change in that folder is the cue to connect.
  private func watchForService() {
    let dir = (socketPath as NSString).deletingLastPathComponent
    mkdir(dir, 0o700)
    let dfd = open(dir, O_EVTONLY)
    guard dfd >= 0 else { diag("browser_host_watch_failed"); return }
    let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: dfd, eventMask: [.write], queue: .main)
    src.setEventHandler { [weak self] in
      guard let self, !self.isConnected() else { return }
      self.connect()
    }
    src.setCancelHandler { close(dfd) }
    src.resume()
    watch = src
  }

  // MARK: open

  /// Opens the outermost app bundle that contains this binary. A binary outside any bundle (a dev build) cannot.
  private func openDaylens() -> Bool {
    let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().standardizedFileURL
    var app: URL?
    var u = exe
    while u.path != "/" {
      if u.pathExtension == "app" { app = u }
      u.deleteLastPathComponent()
    }
    guard let app else { return false }
    var pid: pid_t = 0
    let args = ["/usr/bin/open", app.path]
    var argv = args.map { strdup($0) } + [nil]
    defer { argv.forEach { free($0) } }
    return posix_spawn(&pid, "/usr/bin/open", nil, nil, &argv, environ) == 0
  }
}
