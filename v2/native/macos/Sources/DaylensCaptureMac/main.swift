// Daylens V2 capture helper for macOS. Reports facts as protocol v1 lines on stdout; decides nothing.
// Spec: v2/protocol/PROTOCOL.md

import AppKit
import ApplicationServices
import CaptureCore
import CoreGraphics
import Foundation
import IOKit.pwr_mgt

let helperVersion = "2.0.0-dev"

func intArg(_ name: String, _ fallback: Int, max: Int) -> Int {
  let args = CommandLine.arguments
  guard let i = args.firstIndex(of: name), i + 1 < args.count, let v = Int(args[i + 1]), v > 0, v <= max else { return fallback }
  return v
}

let heartbeatS = intArg("--heartbeat-s", 15, max: 3600)
let idleThresholdS = intArg("--idle-threshold-s", 120, max: 86400)
let reconcileS = intArg("--reconcile-s", 60, max: 86400)

signal(SIGPIPE, SIG_IGN)

// Diagnostic: classify app bundles and exit, so the engine rule can be checked against real installed apps.
if let i = CommandLine.arguments.firstIndex(of: "--classify") {
  for path in CommandLine.arguments[(i + 1)...] { print("\(engines.engine(bundleURL: URL(fileURLWithPath: path)).rawValue)\t\(path)") }
  exit(0)
}

let emitter = Emitter(run: UUID().uuidString, boot: bootSessionId(), platform: "macos", write: writeStdout)
let titles = TitleWorker(emitter: emitter)

func emit(_ kind: String, _ source: String, _ obs: JSON, time: EventTime = Clock.now()) {
  emitter.emit(kind: kind, source: source, time: time, obs: obs, priority: kind == "focus" || kind == "input" ? .normal : .critical)
}

func permissions() -> Permissions { Permissions(accessibility: AXIsProcessTrusted() ? "granted" : "denied") }

// MARK: focus

var frontPid: pid_t = 0

func requestFocus(_ trigger: FocusTrigger, _ app: NSRunningApplication?, time: EventTime = Clock.now(), force: Bool = false) {
  let info = appInfo(app)
  // A stuck title worker must not hold back the app change itself.
  if titles.stallMs > 1000 && (trigger == .app_changed || trigger == .snapshot) {
    titles.abandon()
    emit("focus", "nsworkspace", Obs.focus(trigger: trigger, app: info, window: WindowInfo(window: nil, title: nil, titleState: .timeout)), time: time)
  }
  titles.submit(FocusRequest(trigger: trigger, app: info, time: time, force: force))
}

// MARK: idle

var idle = IdleScheduler(thresholdS: Double(idleThresholdS))
let idleTimer = DispatchSource.makeTimerSource(queue: .main)
var idleSuspended = false
var screenIsLocked = false

func secondsSinceInput() -> Double {
  CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
}

func checkIdle(snapshot: Bool = false) {
  let since = secondsSinceInput()
  let time = Clock.now()
  let d = idle.evaluate(secondsSinceInput: since)
  if let nowIdle = d.emit ?? (snapshot ? idle.idle : nil) {
    emit("input", "idle_timer", Obs.input(idle: nowIdle, lastInputWallMs: time.wallMs - Int64(since * 1000), thresholdS: idleThresholdS, snapshot: snapshot), time: time)
  }
  if !idleSuspended {
    idleTimer.schedule(deadline: .now() + d.nextCheckS, leeway: .milliseconds(d.nextCheckS > 5 ? 1000 : 500))
  }
}

// Nobody types on a locked or sleeping Mac; look again when it is back and unlocked.
func suspendIdle(_ suspend: Bool) {
  if !suspend && screenIsLocked { return }
  if suspend == idleSuspended { return }
  idleSuspended = suspend
  if suspend { idleTimer.schedule(deadline: .distantFuture) } else { checkIdle() }
}

// MARK: session

func screenLocked() -> Bool? {
  guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else { return nil }
  return (dict["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

func snapshot() {
  requestFocus(.snapshot, NSWorkspace.shared.frontmostApplication, force: true)
  checkIdle(snapshot: true)
  let locked = screenLocked()
  screenIsLocked = locked ?? false
  if screenIsLocked { suspendIdle(true) }
  emit("session", "cg_session", Obs.session(locked.map { $0 ? "locked" : "unlocked" } ?? "unknown", snapshot: true))
}

final class DistributedObserver: NSObject {
  @objc func locked(_ n: Notification) {
    emit("session", "distributed_notification", Obs.session("locked", snapshot: false))
    screenIsLocked = true
    suspendIdle(true)
  }
  @objc func unlocked(_ n: Notification) {
    emit("session", "distributed_notification", Obs.session("unlocked", snapshot: false))
    screenIsLocked = false
    suspendIdle(false)
    requestFocus(.reconcile, NSWorkspace.shared.frontmostApplication)
  }
  @objc func accessibilityChanged(_ n: Notification) {
    // The trust change lands slightly after the notification.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
      diag("accessibility", AXIsProcessTrusted() ? "granted" : "denied")
      titles.permissionChanged()
    }
  }
}

// MARK: start

titles.start()

emit("hello", "helper", Obs.hello(helper: "daylens-capture-macos", version: helperVersion, pid: Int(getpid()), os: osDescription(),
                                  permissions: permissions(), heartbeatS: heartbeatS, idleThresholdS: idleThresholdS, reconcileS: reconcileS))

let ws = NSWorkspace.shared.notificationCenter
ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
  let time = Clock.now()
  let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
  frontPid = app?.processIdentifier ?? 0
  requestFocus(.app_changed, app, time: time)
}
// System sleep and wake come from IOKit, the route Apple documents for background processes.
// Sleep must be acknowledged, or the Mac waits 30 s before sleeping.
let kMessageCanSystemSleep: UInt32 = 0xE000_0270
let kMessageSystemWillSleep: UInt32 = 0xE000_0280
let kMessageSystemHasPoweredOn: UInt32 = 0xE000_0300
var rootPowerPort: io_connect_t = 0
var powerNotifier: io_object_t = 0
var powerPortRef: IONotificationPortRef?
rootPowerPort = IORegisterForSystemPower(nil, &powerPortRef, { _, _, type, arg in
  switch type {
  case kMessageCanSystemSleep:
    IOAllowPowerChange(rootPowerPort, Int(bitPattern: arg))
  case kMessageSystemWillSleep:
    emit("power", "iokit", Obs.power("sleep"))
    suspendIdle(true)
    emitter.flush()
    IOAllowPowerChange(rootPowerPort, Int(bitPattern: arg))
  case kMessageSystemHasPoweredOn:
    emit("power", "iokit", Obs.power("resume"))
    idle.reset()
    suspendIdle(false)
  default:
    break
  }
}, &powerNotifier)
if rootPowerPort != 0, let ref = powerPortRef {
  CFRunLoopAddSource(CFRunLoopGetMain(), IONotificationPortGetRunLoopSource(ref).takeUnretainedValue(), .commonModes)
} else {
  diag("power_register_failed")
}
ws.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { _ in
  emit("power", "nsworkspace", Obs.power("display_off"))
}
ws.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { _ in
  emit("power", "nsworkspace", Obs.power("display_on"))
}
ws.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main) { _ in
  emit("session", "nsworkspace", Obs.session("console_disconnect", snapshot: false))
  suspendIdle(true)
}
ws.addObserver(forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: .main) { _ in
  emit("session", "nsworkspace", Obs.session("console_connect", snapshot: false))
  suspendIdle(false)
}

let dObserver = DistributedObserver()
let dnc = DistributedNotificationCenter.default()
dnc.addObserver(dObserver, selector: #selector(DistributedObserver.locked(_:)), name: Notification.Name("com.apple.screenIsLocked"), object: nil, suspensionBehavior: .deliverImmediately)
dnc.addObserver(dObserver, selector: #selector(DistributedObserver.unlocked(_:)), name: Notification.Name("com.apple.screenIsUnlocked"), object: nil, suspensionBehavior: .deliverImmediately)
dnc.addObserver(dObserver, selector: #selector(DistributedObserver.accessibilityChanged(_:)), name: Notification.Name("com.apple.accessibility.api"), object: nil, suspensionBehavior: .deliverImmediately)

NotificationCenter.default.addObserver(forName: .NSSystemClockDidChange, object: nil, queue: .main) { _ in
  emit("clock", "notification", Obs.clock("time_changed"))
}
NotificationCenter.default.addObserver(forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main) { _ in
  Clock.resetTimeZone()
  emit("clock", "notification", Obs.clock("timezone_changed"))
}

idleTimer.setEventHandler { autoreleasepool { checkIdle() } }
idleTimer.schedule(deadline: .distantFuture)
idleTimer.resume()

// Heartbeats come from the main thread: if it wedges, they stop.
let heartbeat = DispatchSource.makeTimerSource(queue: .main)
heartbeat.schedule(deadline: .now() + .seconds(heartbeatS), repeating: .seconds(heartbeatS), leeway: .milliseconds(heartbeatS * 100))
heartbeat.setEventHandler { autoreleasepool {
  let p = permissions()
  let stall = titles.stallMs
  let state: ChannelState = p.accessibility != "granted" ? .no_permission : stall > 2000 ? .stalled : titles.degraded ? .degraded : .ok
  emit("heartbeat", "helper", Obs.heartbeat(awakeUs: Clock.awakeUs(), permissions: p, focusRegistered: true, sessionRegistered: true,
                                            powerRegistered: rootPowerPort != 0, titles: state, stallMs: stall, dropped: emitter.dropped))
} }
heartbeat.resume()

let reconcile = DispatchSource.makeTimerSource(queue: .main)
reconcile.schedule(deadline: .now() + .seconds(reconcileS), repeating: .seconds(reconcileS), leeway: .seconds(max(1, reconcileS / 10)))
reconcile.setEventHandler { autoreleasepool {
  let app = NSWorkspace.shared.frontmostApplication
  let changed = (app?.processIdentifier ?? 0) != frontPid
  frontPid = app?.processIdentifier ?? 0
  requestFocus(changed ? .app_changed : .reconcile, app)
} }
reconcile.resume()

// Control from the capture service. End of input means the service is gone.
Thread.detachNewThread {
  while let line = readLine() {
    if line.contains("\"shutdown\"") {
      DispatchQueue.main.async {
        emit("bye", "helper", Obs.bye("shutdown"))
        emitter.flush()
        _exit(0)
      }
    } else if line.contains("\"snapshot\"") {
      DispatchQueue.main.async { snapshot() }
    }
  }
  _exit(0)
}

frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
snapshot()
diag("started", AXIsProcessTrusted() ? "ax_granted" : "ax_denied")
// Screen sleep and wake notices only reach a process that is an NSApplication; .prohibited keeps it out of the Dock and menu bar.
let nsApp = NSApplication.shared
nsApp.setActivationPolicy(.prohibited)
nsApp.run()
