import AppKit
import CaptureCore
import Darwin
import Foundation

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
final class BrowserRegistry {
  private let lock = NSLock()
  private var cache: [String: Bool] = [:]

  func isRegisteredBrowser(bundleURL: URL?, bundleId: String?) -> Bool {
    guard let url = bundleURL else { return false }
    let key = bundleId ?? url.path
    lock.lock()
    if let v = cache[key] { lock.unlock(); return v }
    lock.unlock()
    var result = false
    if let info = Bundle(url: url)?.infoDictionary, let types = info["CFBundleURLTypes"] as? [[String: Any]] {
      let schemes = Set(types.flatMap { ($0["CFBundleURLSchemes"] as? [String]) ?? [] }.map { $0.lowercased() })
      result = schemes.contains("http") && schemes.contains("https")
    }
    lock.lock(); cache[key] = result; lock.unlock()
    return result
  }
}

let browsers = BrowserRegistry()

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
