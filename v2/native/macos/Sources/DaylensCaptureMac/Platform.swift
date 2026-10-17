import AppKit
import CaptureCore
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

func bootSessionId() -> String {
  var size = 0
  sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0)
  guard size > 0 else { return "unknown-boot" }
  var buf = [CChar](repeating: 0, count: size)
  sysctlbyname("kern.bootsessionuuid", &buf, &size, nil, 0)
  let s = String(cString: buf)
  return s.isEmpty ? "unknown-boot" : s
}

func osDescription() -> String {
  let v = ProcessInfo.processInfo.operatingSystemVersion
  return "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

/// Diagnostics on stderr are fixed codes only; never titles, names or paths.
func diag(_ code: String, _ value: String = "1") {
  FileHandle.standardError.write("\(code)=\(value)\n".data(using: .utf8)!)
}

/// Whether an app registers to open http and https links. A platform fact; shared code decides what it means.
/// Keyed on the bundle's current files, and read straight from Info.plist (Bundle caches it), so an update is seen.
final class BrowserRegistry {
  private let lock = NSLock()
  private var cache: [BundleStamp: Bool] = [:]

  func isRegisteredBrowser(bundleURL: URL?, bundleId: String?) -> Bool {
    guard let url = bundleURL, let stamp = BundleStamp.of(url) else { return false }
    lock.lock()
    if let v = cache[stamp] { lock.unlock(); return v }
    lock.unlock()
    var result = false
    let plist = url.appendingPathComponent("Contents/Info.plist")
    if let info = NSDictionary(contentsOf: plist) as? [String: Any], let types = info["CFBundleURLTypes"] as? [[String: Any]] {
      let schemes = Set(types.flatMap { ($0["CFBundleURLSchemes"] as? [String]) ?? [] }.map { $0.lowercased() })
      result = schemes.contains("http") && schemes.contains("https")
    }
    lock.lock()
    if cache.count > 512 { cache.removeAll() }
    cache[stamp] = result
    lock.unlock()
    return result
  }
}

let browsers = BrowserRegistry()

/// Reads a bundle's own files to tell a browser from an app built on a web runtime; cached per bundle contents.
final class EngineRegistry {
  private let lock = NSLock()
  private var cache: [BundleStamp: Engine] = [:]

  func engine(bundleURL: URL?) -> Engine {
    guard let url = bundleURL else { return .unknown }
    let stamp = BundleStamp.of(url)
    if let stamp {
      lock.lock()
      if let e = cache[stamp] { lock.unlock(); return e }
      lock.unlock()
    }
    let e = classifyBundle(scanBundle(at: url))
    // An uncertain scan, or a bundle whose files could not be stamped, is looked at again next time.
    if e != .unknown, let stamp {
      lock.lock()
      if cache.count > 512 { cache.removeAll() }
      cache[stamp] = e
      lock.unlock()
    }
    return e
  }
}

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
    engine: engines.engine(bundleURL: app.bundleURL),
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
