import AppKit
import CaptureCore
import CoreServices
import Darwin
import Foundation
import Security

enum Clock {
  // CLOCK_MONOTONIC_RAW keeps counting while the Mac sleeps (CLOCK_UPTIME_RAW does not).
  static func monoUs() -> Int64 { Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) / 1000) }
  // CLOCK_UPTIME_RAW stops while asleep, dark wakes aside, which lets the service tell sleep from a stall.
  static func awakeUs() -> Int64 { Int64(clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000) }
  static func wallMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)) }

  private static let tzLock = NSLock()
  private static var tz: TimeZone = TimeZone.current

  static func resetTimeZone() {
    NSTimeZone.resetSystemTimeZone()
    tzLock.lock(); tz = TimeZone.current; tzLock.unlock()
  }

  static func now() -> EventTime {
    let wall = wallMs()
    let mono = monoUs()
    tzLock.lock(); let zone = tz; tzLock.unlock()
    let offset = zone.secondsFromGMT(for: Date(timeIntervalSince1970: Double(wall) / 1000)) / 60
    return EventTime(wallMs: wall, monoUs: mono, tz: zone.identifier, tzOffsetMin: offset)
  }
}

let faultBlockTitles = ProcessInfo.processInfo.environment["DAYLENS_CAPTURE_FAULT"] == "block_titles"

/// The kernel's boot session UUID, which a clock change cannot alter. Without it, the boot time computed from
/// wall time minus uptime, reported as the degraded "clock" source.
func bootIdentity() -> (id: String, source: String) {
  var size = 0
  sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0)
  if size > 0 {
    var buf = [CChar](repeating: 0, count: size)
    sysctlbyname("kern.bootsessionuuid", &buf, &size, nil, 0)
    let s = String(cString: buf)
    if !s.isEmpty { return (s, "kernel") }
  }
  return ("bootclock-\((Clock.wallMs() - Clock.monoUs() / 1000) / 60_000)", "clock")
}

func osDescription() -> String {
  let v = ProcessInfo.processInfo.operatingSystemVersion
  return "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

/// Diagnostics on stderr are fixed codes only; never titles, names or paths.
func diag(_ code: String, _ value: String = "1") {
  FileHandle.standardError.write("\(code)=\(value)\n".data(using: .utf8)!)
}

/// Whether an app registers to open http or https links; shared code decides what it means.
final class BrowserRegistry {
  private let handlers: (String) -> [String]?

  init(handlers: @escaping (String) -> [String]? = { scheme in
    LSCopyAllHandlersForURLScheme(scheme as CFString)?.takeRetainedValue() as? [String]
  }) { self.handlers = handlers }

  func isRegisteredBrowser(bundleURL: URL?, bundleId: String?) -> Bool {
    guard let url = bundleURL,
          let info = NSDictionary(contentsOf: url.appendingPathComponent("Contents/Info.plist")) as? [String: Any] else {
      diag("browser_registry_unavailable")
      return true
    }
    if let raw = info["CFBundleURLTypes"] {
      guard let types = raw as? [[String: Any]] else { diag("browser_registry_unavailable"); return true }
      for type in types {
        guard let schemes = type["CFBundleURLSchemes"] as? [String] else { diag("browser_registry_unavailable"); return true }
        if schemes.contains(where: { ["http", "https"].contains($0.lowercased()) }) { return true }
      }
    }
    guard let id = bundleId else { diag("browser_registry_unavailable"); return true }
    for scheme in ["http", "https"] {
      guard let ids = handlers(scheme) else { diag("browser_registry_unavailable"); return true }
      if ids.contains(where: { $0.caseInsensitiveCompare(id) == .orderedSame }) { return true }
    }
    return false
  }
}

let browsers = BrowserRegistry()

let engines = EngineRegistry()

/// The Team ID of a running app, taken from its code signature only after the system confirms that signature
/// is valid for the running process. Nil for unsigned, ad-hoc or Apple platform code. Cached per process.
final class SignerRegistry {
  private let lock = NSLock()
  private var cache: [ProcessKey: String?] = [:]

  func teamId(pid: pid_t) -> String? {
    // Keyed on PID plus start time, so a reused PID never inherits another process's signer.
    guard let key = ProcessKey.of(pid) else { return lookUp(pid) }
    lock.lock()
    if let hit = cache[key] { lock.unlock(); return hit }
    lock.unlock()
    let team = lookUp(pid)
    lock.lock()
    if cache.count > 256 { cache.removeAll() }
    cache[key] = team
    lock.unlock()
    return team
  }

  private func lookUp(_ pid: pid_t) -> String? {
    var code: SecCode?
    let attributes = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code else { return nil }
    guard SecCodeCheckValidity(code, [], nil) == errSecSuccess else { return nil }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess else { return nil }
    return (info as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String
  }
}

let signers = SignerRegistry()

func appInfo(_ app: NSRunningApplication?) -> AppInfo {
  guard let app else { return .none }
  if app.isTerminated {
    return AppInfo(appId: nil, name: nil, path: nil, pid: Int(app.processIdentifier), registeredBrowser: false, identityState: .gone)
  }
  return AppInfo(
    appId: app.bundleIdentifier ?? app.executableURL?.path,
    name: app.localizedName,
    path: app.bundleURL?.path ?? app.executableURL?.path,
    pid: Int(app.processIdentifier),
    registeredBrowser: browsers.isRegisteredBrowser(bundleURL: app.bundleURL, bundleId: app.bundleIdentifier),
    engine: engines.engine(bundleURL: app.bundleURL, process: ProcessKey.of(app.processIdentifier)),
    signer: signers.teamId(pid: app.processIdentifier),
    identityState: .ok)
}

func writeStdout(_ s: String) {
  var data = Array(s.utf8)
  var off = 0
  while off < data.count {
    let n = data.withUnsafeMutableBytes { Darwin.write(1, $0.baseAddress! + off, $0.count - off) }
    if n < 0 {
      if errno == EINTR { continue }
      _exit(0)  // reader is gone; skip atexit teardown on this writer thread
    }
    off += n
  }
}
