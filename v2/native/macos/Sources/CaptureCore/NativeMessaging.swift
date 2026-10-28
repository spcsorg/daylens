import Foundation

/// How a browser started this binary as a native messaging host, if it did.
/// Chromium passes the caller's origin; Firefox passes the host manifest path and the add-on ID.
public enum HostLaunch: Equatable {
  case chromium(extensionId: String)
  case firefox(extensionId: String)

  public var extensionId: String {
    switch self {
    case .chromium(let id), .firefox(let id): return id
    }
  }

  public static func detect(_ args: [String]) -> HostLaunch? {
    for a in args.dropFirst() where a.hasPrefix("chrome-extension://") {
      let id = a.dropFirst("chrome-extension://".count).split(separator: "/", omittingEmptySubsequences: false).first.map(String.init) ?? ""
      return isChromiumId(id) ? .chromium(extensionId: id) : nil
    }
    if args.count >= 3, args[1].hasSuffix(".json"), isGeckoId(args[2]) { return .firefox(extensionId: args[2]) }
    return nil
  }

  static func isChromiumId(_ s: String) -> Bool {
    s.utf8.count == 32 && s.utf8.allSatisfy { $0 >= UInt8(ascii: "a") && $0 <= UInt8(ascii: "p") }
  }

  static func isGeckoId(_ s: String) -> Bool {
    guard !s.isEmpty, s.utf8.count <= 128, let at = s.firstIndex(of: "@"), at != s.startIndex else { return false }
    return s.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || "@._-".unicodeScalars.contains($0) } && s.filter { $0 == "@" }.count == 1
  }
}

/// Extensions this host answers. Browsers also enforce the allowlist in the host manifest; this is the second check.
/// Store IDs join this list when each store assigns them.
public let allowedExtensionIds: Set<String> = [
  "dgidcofcmgnlicmmepgomalcdcbgjjjg",  // unpacked dev build (manifest.chromium-dev.json key)
  "browser@daylens.app",
]

/// Native messaging frames: a 32-bit length in native byte order, then UTF-8 JSON.
public enum NativeFrame {
  /// Messages from the extension larger than this are skipped unread; none of ours comes close.
  public static let maxInbound = 64 * 1024
  /// Chromium refuses host messages over 1 MB.
  public static let maxOutbound = 1024 * 1024

  public static func encode(_ json: String) -> [UInt8]? {
    let body = Array(json.utf8)
    guard body.count <= maxOutbound else { return nil }
    var n = UInt32(body.count)
    return withUnsafeBytes(of: &n) { Array($0) } + body
  }
}

/// Splits a byte stream into frames. Oversized frames are consumed and reported, so the stream stays in step.
public struct FrameReader {
  public enum Item: Equatable { case message([UInt8]), oversized(Int) }
  private var buf: [UInt8] = []
  private var skipping = 0

  public init() {}

  public mutating func feed(_ bytes: [UInt8]) -> [Item] {
    var out: [Item] = []
    var input = bytes[...]
    if skipping > 0 {
      let n = min(skipping, input.count)
      skipping -= n
      input = input.dropFirst(n)
    }
    buf += input
    while buf.count >= 4 {
      let len = Int(buf.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) })
      if len > NativeFrame.maxInbound {
        out.append(.oversized(len))
        let have = buf.count - 4
        if have >= len {
          buf.removeFirst(4 + len)
        } else {
          skipping = len - have
          buf.removeAll()
        }
        continue
      }
      guard buf.count >= 4 + len else { break }
      out.append(.message(Array(buf[4..<(4 + len)])))
      buf.removeFirst(4 + len)
    }
    return out
  }
}

public struct TabReport: Equatable {
  public var trigger: String
  public var page: Bool
  public var reason: String?
  public var window: String?
  public var tab: String?
  public var url: String?
  public var title: String?
  public var epoch: Int64? = nil
}

public enum ExtensionMessage: Equatable {
  case tab(TabReport)
  /// This browser only, until a time or (nil) until resumed; held by the extension's profile (nil: none named). `req`
  /// is the extension's id for the request, carried back in Daylens's reply to it.
  case pause(untilWallMs: Int64?, profile: String? = nil, req: String? = nil)
  /// Ends this profile's pause of the browser; another profile's stays in force.
  case resume(profile: String? = nil, req: String? = nil)
  case open
  case status

  static let triggers: Set<String> = ["activated", "focus", "updated", "removed", "snapshot", "startup", "paused"]
  static let reasons: Set<String> = ["no_focused_window", "not_normal", "no_tab", "no_address", "paused"]

  /// The profile an extension names itself by: an id it made up, at most 64 characters; anything else is none.
  static func profile(_ v: Any?) -> String? {
    guard let s = v as? String, !s.isEmpty, s.utf16.count <= 64 else { return nil }
    return s
  }

  /// A request id: 1 to 32 letters, digits, '-' or '_'; anything else is none.
  static func req(_ v: Any?) -> String? {
    guard let s = v as? String, (1...32).contains(s.utf8.count), s.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95 }) else { return nil }
    return s
  }

  /// Absent or null: none. Otherwise a non-negative JSON integer, never a boolean.
  static func epoch(_ v: Any?) -> Int64?? {
    guard let v, !(v is NSNull) else { return .some(nil) }
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue >= 0, n.doubleValue == n.doubleValue.rounded(), n.doubleValue < 9e15 else { return nil }
    return .some(n.int64Value)
  }

  /// Anything not exactly one of our messages is nil and is dropped.
  public static func parse(_ bytes: [UInt8]) -> ExtensionMessage? {
    guard let o = (try? JSONSerialization.jsonObject(with: Data(bytes))) as? [String: Any], let t = o["t"] as? String else { return nil }
    switch t {
    case "status": return .status
    case "resume": return .resume(profile: profile(o["profile"]), req: req(o["req"]))
    case "open": return .open
    case "pause":
      guard o.keys.contains("until_wall_ms"), let until = epoch(o["until_wall_ms"]) else { return nil }
      return .pause(untilWallMs: until, profile: profile(o["profile"]), req: req(o["req"]))
    case "tab":
      guard let trigger = o["trigger"] as? String, triggers.contains(trigger), let state = o["state"] as? String, let ep = epoch(o["epoch"]) else { return nil }
      if state == "unknown" {
        guard let reason = o["reason"] as? String, reasons.contains(reason) else { return nil }
        return .tab(TabReport(trigger: trigger, page: false, reason: reason, window: nil, tab: nil, url: nil, title: nil, epoch: ep))
      }
      guard state == "page", let url = o["url"] as? String, !url.isEmpty, url.utf16.count <= 2048 else { return nil }
      func id(_ k: String) -> String? { (o[k] as? String).flatMap { $0.utf16.count <= 64 ? $0 : nil } }
      guard let window = id("window") else { return nil }
      let title = (o["title"] as? String).flatMap { $0.isEmpty ? nil : clip($0, maxTitleUTF16) }
      return .tab(TabReport(trigger: trigger, page: true, reason: nil, window: window, tab: id("tab"), url: url, title: title, epoch: ep))
    default: return nil
    }
  }
}

extension Obs {
  public static func tab(_ r: TabReport, browser: AppInfo, extensionId: String) -> JSON {
    var pairs: [(String, JSON)] = [
      ("trigger", .string(r.trigger)), ("state", .string(r.page ? "page" : "unknown")), ("reason", .str(r.reason)),
      ("browser", browser.json), ("extension", .string(extensionId)),
      ("window", .str(r.window)), ("tab", .str(r.tab)), ("url", .str(r.url)), ("title", .str(r.title)),
    ]
    if let e = r.epoch { pairs.append(("epoch", .int(e))) }
    return .object(pairs)
  }
}

/// What the host tells the extension, built from a line the capture service sent or from the host's own state.
public enum HostReply {
  public static func notRunning() -> String {
    JSON.object([("t", .string("status")), ("daylens", .string("not_running")), ("capture", .string("running")), ("until_wall_ms", .null)]).serialized()
  }

  public static func opened(_ ok: Bool) -> String {
    JSON.object([("t", .string("opened")), ("ok", .bool(ok))]).serialized()
  }

  public static func snapshot() -> String { JSON.object([("t", .string("snapshot"))]).serialized() }

  /// Maps one line from the capture service; nil for anything unexpected.
  public static func fromService(_ line: String) -> String? {
    guard let o = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any], let op = o["op"] as? String else { return nil }
    if op == "snapshot" {
      guard let ep = ExtensionMessage.epoch(o["epoch"]) else { return nil }
      guard let e = ep else { return snapshot() }
      return JSON.object([("t", .string("snapshot")), ("epoch", .int(e))]).serialized()
    }
    // The reply to one pause or resume names it; a status with none is news of another change.
    let req: [(String, JSON)] = ExtensionMessage.req(o["req"]).map { [("req", .string($0))] } ?? []
    // A pause or resume Daylens could not carry out: the extension takes its own back and says so.
    if op == "error" {
      guard let f = o["for"] as? String, let t = ["browser_pause": "pause", "browser_resume": "resume"][f] else { return nil }
      return JSON.object([("t", .string("error")), ("for", .string(t))] + req).serialized()
    }
    guard op == "status", let capture = o["capture"] as? String, capture == "running" || capture == "paused" else { return nil }
    let until: JSON = (o["until_wall_ms"] as? NSNumber).map { .int($0.int64Value) } ?? .null
    return JSON.object([("t", .string("status")), ("daylens", .string("connected")), ("capture", .string(capture)), ("until_wall_ms", until)] + req).serialized()
  }

  /// A pause or resume names the browser that started this host: an extension pauses only its own browser.
  public static func control(_ m: ExtensionMessage, browser: AppInfo) -> String? {
    switch m {
    case .pause(let until, let profile, let req):
      return JSON.object([("op", .string("browser_pause")), ("until_wall_ms", until.map { .int($0) } ?? .null), ("browser", browser.json), ("profile", .str(profile)), ("req", .str(req))]).serialized()
    case .resume(let profile, let req): return JSON.object([("op", .string("browser_resume")), ("browser", browser.json), ("profile", .str(profile)), ("req", .str(req))]).serialized()
    case .status: return JSON.object([("op", .string("status"))]).serialized()
    default: return nil
    }
  }
}
