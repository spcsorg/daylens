import Foundation

public let protocolVersion: Int64 = 1
public let maxTitleUTF16 = 1024

public struct EventTime {
  public var wallMs: Int64
  public var monoUs: Int64
  public var tz: String
  public var tzOffsetMin: Int
  public init(wallMs: Int64, monoUs: Int64, tz: String, tzOffsetMin: Int) {
    self.wallMs = wallMs; self.monoUs = monoUs; self.tz = tz; self.tzOffsetMin = tzOffsetMin
  }
  var json: JSON {
    .object([("wall_ms", .int(wallMs)), ("mono_us", .int(monoUs)), ("tz", .string(tz)), ("tz_offset_min", .int(Int64(tzOffsetMin)))])
  }
}

public enum IdentityState: String { case ok, access_denied, timeout, gone, none, unresolved }
public enum TitleState: String { case ok, empty, no_window, no_permission, timeout, unavailable }
public enum ChannelState: String { case ok, degraded, stalled, no_permission }
public enum FocusTrigger: String { case app_changed, window_changed, title_changed, reconcile, snapshot }

public struct AppInfo: Equatable {
  public var appId: String?
  public var name: String?
  public var path: String?
  public var pid: Int?
  public var registeredBrowser: Bool
  public var engine: Engine
  public var signer: String?
  public var identityState: IdentityState
  public init(appId: String?, name: String?, path: String?, pid: Int?, registeredBrowser: Bool, engine: Engine = .unknown,
              signer: String? = nil, identityState: IdentityState) {
    self.appId = appId; self.name = name; self.path = path; self.pid = pid
    self.registeredBrowser = registeredBrowser; self.engine = engine; self.signer = signer; self.identityState = identityState
  }
  public static let none = AppInfo(appId: nil, name: nil, path: nil, pid: nil, registeredBrowser: false, engine: .unknown, identityState: .none)
  var json: JSON {
    .object([
      ("app_id", .str(clip(appId, 1024))), ("name", .str(clip(name, 512))), ("path", .str(clip(path, 2048))), ("pid", .int(pid)),
      ("registered_browser", .bool(registeredBrowser)), ("engine", .string(engine.rawValue)), ("signer", .str(clip(signer, 256))),
      ("identity_state", .string(identityState.rawValue)), ("store", .null),
    ])
  }
}

public struct WindowInfo: Equatable {
  public var window: String?
  public var title: String?
  public var titleState: TitleState
  public init(window: String?, title: String?, titleState: TitleState) {
    self.window = window
    let t = titleState == .ok && !(title ?? "").isEmpty ? WindowInfo.truncate(title) : nil
    self.title = t
    // The protocol requires a title exactly when the state is ok.
    self.titleState = titleState == .ok && t == nil ? (title == nil ? .unavailable : .empty) : titleState
  }
  /// Builds from a raw title read: empty strings become `.empty`.
  public static func read(window: String?, title: String?) -> WindowInfo {
    guard let t = title else { return WindowInfo(window: window, title: nil, titleState: .unavailable) }
    return t.isEmpty ? WindowInfo(window: window, title: nil, titleState: .empty) : WindowInfo(window: window, title: t, titleState: .ok)
  }
  static func truncate(_ s: String?) -> String? { clip(s, maxTitleUTF16) }
  var json: JSON {
    .object([("window", .str(window)), ("title", .str(title)), ("title_state", .string(titleState.rawValue))])
  }
}

/// Clips to `max` UTF-16 code units on a character boundary, matching the validator's string limits.
public func clip(_ s: String?, _ max: Int) -> String? {
  guard let s, s.utf16.count > max else { return s }
  var out = ""
  var n = 0
  for ch in s {
    let w = ch.utf16.count
    if n + w > max { break }
    out.append(ch)
    n += w
  }
  return out
}

public struct Permissions {
  public var accessibility: String
  public init(accessibility: String) { self.accessibility = accessibility }
  var json: JSON { .object([("accessibility", .string(accessibility))]) }
}

public enum Obs {
  public static func hello(helper: String, version: String, pid: Int, os: String, permissions: Permissions, heartbeatS: Int, idleThresholdS: Int, reconcileS: Int) -> JSON {
    .object([
      ("helper", .string(helper)), ("version", .string(version)), ("pid", .int(pid)), ("os", .string(os)),
      ("permissions", permissions.json),
      ("config", .object([("heartbeat_s", .int(heartbeatS)), ("idle_threshold_s", .int(idleThresholdS)), ("reconcile_s", .int(reconcileS))])),
    ])
  }
  public static func heartbeat(awakeUs: Int64, permissions: Permissions, focusRegistered: Bool, sessionRegistered: Bool, powerRegistered: Bool,
                               titles: ChannelState, stallMs: Int64, dropped: Int64) -> JSON {
    .object([("awake_us", .int(awakeUs)), ("permissions", permissions.json),
             ("registrations", .object([("focus", .bool(focusRegistered)), ("session", .bool(sessionRegistered)), ("power", .bool(powerRegistered))])), ("titles", .string(titles.rawValue)), ("stall_ms", .int(stallMs)), ("dropped", .int(dropped))])
  }
  public static func focus(trigger: FocusTrigger, app: AppInfo, window: WindowInfo) -> JSON {
    .object([("trigger", .string(trigger.rawValue)), ("app", app.json), ("window", window.json)])
  }
  public static func input(idle: Bool, lastInputWallMs: Int64, thresholdS: Int, snapshot: Bool) -> JSON {
    .object([("state", .string(idle ? "idle" : "active")), ("last_input_wall_ms", .int(lastInputWallMs)), ("threshold_s", .int(thresholdS)), ("snapshot", .bool(snapshot))])
  }
  public static func session(_ state: String, snapshot: Bool) -> JSON {
    .object([("state", .string(state)), ("snapshot", .bool(snapshot))])
  }
  public static func power(_ state: String) -> JSON { .object([("state", .string(state))]) }
  public static func clock(_ change: String) -> JSON { .object([("change", .string(change))]) }
  public static func loss(count: Int, fromWallMs: Int64, toWallMs: Int64) -> JSON {
    .object([("channel", .string("focus")), ("count", .int(count)), ("from_wall_ms", .int(fromWallMs)), ("to_wall_ms", .int(toWallMs))])
  }
  public static func bye(_ reason: String) -> JSON { .object([("reason", .string(reason))]) }
}

public func envelope(run: String, seq: Int64, boot: String, time: EventTime, platform: String, source: String, kind: String, obs: JSON) -> JSON {
  .object([
    ("v", .int(protocolVersion)), ("run", .string(run)), ("seq", .int(seq)), ("boot", .string(boot)), ("t", time.json),
    ("platform", .string(platform)), ("source", .string(source)), ("kind", .string(kind)), ("obs", obs),
  ])
}
