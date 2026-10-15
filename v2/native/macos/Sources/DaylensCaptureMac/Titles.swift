import AppKit
import ApplicationServices
import CaptureCore
import Foundation

struct FocusRequest {
  var trigger: FocusTrigger
  var app: AppInfo
  var time: EventTime
  var force: Bool
}

/// Owns every Accessibility call on its own thread and run loop, so a hung app can delay
/// titles but never the main thread's app, session, power and heartbeat events.
final class TitleWorker: Thread {
  private let emitter: Emitter
  private let lock = NSLock()
  private var pending: FocusRequest?
  private var busySinceUs: Int64 = 0
  private var runLoop: CFRunLoop?
  private let ready = DispatchSemaphore(value: 0)

  // Touched only on this thread.
  private var observer: AXObserver?
  private var observedPid: pid_t = 0
  private var observedApp: AppInfo = .none
  private var appElement: AXUIElement?
  private var focusedWindow: AXUIElement?
  private var lastEmitted: (app: AppInfo, window: WindowInfo)?
  private var registrationFailed = false
  private var _degraded = false

  init(emitter: Emitter) {
    self.emitter = emitter
    super.init()
    name = "daylens.capture.titles"
    qualityOfService = .utility
  }

  override func start() {
    super.start()
    ready.wait()
  }

  override func main() {
    // Applies to every element, including windows obtained later.
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.5)
    runLoop = CFRunLoopGetCurrent()
    // Keeps the run loop alive with no other sources attached.
    let port = NSMachPort()
    RunLoop.current.add(port, forMode: .default)
    ready.signal()
    while true { CFRunLoopRun() }
  }

  /// Milliseconds the worker has been inside one request, or 0.
  var stallMs: Int64 {
    lock.lock(); defer { lock.unlock() }
    return busySinceUs == 0 ? 0 : (Clock.monoUs() - busySinceUs) / 1000
  }

  var degraded: Bool { lock.lock(); defer { lock.unlock() }; return _degraded }

  /// Only the newest request matters; an older one still waiting is replaced.
  func submit(_ r: FocusRequest) {
    lock.lock()
    let replacingForced = pending?.force ?? false
    var next = r
    if replacingForced { next.force = true }
    pending = next
    lock.unlock()
    guard let rl = runLoop else { return }
    CFRunLoopPerformBlock(rl, CFRunLoopMode.defaultMode.rawValue) { [weak self] in self?.drain() }
    CFRunLoopWakeUp(rl)
  }

  func permissionChanged() {
    guard let rl = runLoop else { return }
    CFRunLoopPerformBlock(rl, CFRunLoopMode.defaultMode.rawValue) { [weak self] in
      guard let self else { return }
      self.teardown()
      self.drainWith(FocusRequest(trigger: .snapshot, app: self.observedApp, time: Clock.now(), force: true))
    }
    CFRunLoopWakeUp(rl)
  }

  private func drain() {
    lock.lock()
    guard let r = pending else { lock.unlock(); return }
    pending = nil
    lock.unlock()
    drainWith(r)
  }

  private func drainWith(_ r: FocusRequest) {
    setBusy(true)
    defer { setBusy(false) }
    let pid = pid_t(r.app.pid ?? 0)
    if pid != observedPid || observer == nil { observe(pid: pid, app: r.app) } else { observedApp = r.app }
    guard AXIsProcessTrusted() else {
      emitIfChanged(r.trigger, WindowInfo(window: nil, title: nil, titleState: .no_permission), time: r.time, force: true)
      return
    }
    let win = focused()
    if !CFEqualOptional(win, focusedWindow) { watchWindow(win) }
    emitIfChanged(r.trigger, readTitle(win), time: r.time, force: r.force || r.trigger == .app_changed)
  }

  private func setBusy(_ busy: Bool) {
    lock.lock(); busySinceUs = busy ? Clock.monoUs() : 0; lock.unlock()
  }

  private func teardown() {
    if let obs = observer {
      CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .defaultMode)
    }
    observer = nil
    appElement = nil
    focusedWindow = nil
    observedPid = 0
  }

  private func observe(pid: pid_t, app: AppInfo) {
    teardown()
    observedPid = pid
    observedApp = app
    registrationFailed = false
    guard pid > 0, AXIsProcessTrusted() else { updateDegraded(); return }
    let element = AXUIElementCreateApplication(pid)
    appElement = element
    var obs: AXObserver?
    let refcon = Unmanaged.passUnretained(self).toOpaque()
    guard AXObserverCreate(pid, axCallback, &obs) == .success, let obs else {
      registrationFailed = true
      diag("ax_observer_create_failed")
      updateDegraded()
      return
    }
    observer = obs
    for n in [kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification, kAXTitleChangedNotification] {
      let err = AXObserverAddNotification(obs, element, n as CFString, refcon)
      if err != .success && err != .notificationAlreadyRegistered && n != kAXTitleChangedNotification {
        registrationFailed = true
        diag("ax_add_notification_failed", String(err.rawValue))
      }
    }
    CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .defaultMode)
    updateDegraded()
  }

  private func watchWindow(_ win: AXUIElement?) {
    let refcon = Unmanaged.passUnretained(self).toOpaque()
    if let obs = observer, let old = focusedWindow {
      AXObserverRemoveNotification(obs, old, kAXTitleChangedNotification as CFString)
      AXObserverRemoveNotification(obs, old, kAXUIElementDestroyedNotification as CFString)
    }
    focusedWindow = win
    guard let obs = observer, let win else { return }
    let e1 = AXObserverAddNotification(obs, win, kAXTitleChangedNotification as CFString, refcon)
    _ = AXObserverAddNotification(obs, win, kAXUIElementDestroyedNotification as CFString, refcon)
    registrationFailed = !(e1 == .success || e1 == .notificationAlreadyRegistered)
    if registrationFailed { diag("ax_title_observer_failed", String(e1.rawValue)) }
    updateDegraded()
  }

  private func updateDegraded() {
    lock.lock(); _degraded = registrationFailed; lock.unlock()
  }

  private func focused() -> AXUIElement? {
    guard let app = appElement else { return nil }
    var ref: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &ref)
    guard err == .success, let ref, CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
    return (ref as! AXUIElement)
  }

  private func readTitle(_ win: AXUIElement?) -> WindowInfo {
    guard let win else { return WindowInfo(window: nil, title: nil, titleState: .unavailable) }
    let id = "ax-\(CFHash(win))"
    var ref: CFTypeRef?
    switch AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &ref) {
    case .success: return WindowInfo.read(window: id, title: ref as? String)
    case .noValue: return WindowInfo(window: id, title: nil, titleState: .empty)
    case .apiDisabled: return WindowInfo(window: id, title: nil, titleState: .no_permission)
    case .cannotComplete: return WindowInfo(window: id, title: nil, titleState: .timeout)
    default: return WindowInfo(window: id, title: nil, titleState: .unavailable)
    }
  }

  private func emitIfChanged(_ trigger: FocusTrigger, _ w: WindowInfo, time: EventTime, force: Bool) {
    if !force, let last = lastEmitted, last.app == observedApp, last.window == w { return }
    lastEmitted = (observedApp, w)
    emitter.emit(kind: "focus", source: trigger == .reconcile ? "reconcile" : "ax_observer", time: time,
                 obs: Obs.focus(trigger: trigger, app: observedApp, window: w), priority: .normal)
  }

  fileprivate func onNotification(_ name: String, element: AXUIElement) {
    let time = Clock.now()
    setBusy(true)
    defer { setBusy(false) }
    switch name {
    case kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification, kAXUIElementDestroyedNotification:
      let win = focused()
      if !CFEqualOptional(win, focusedWindow) { watchWindow(win) }
      emitIfChanged(.window_changed, readTitle(win), time: time, force: false)
    case kAXTitleChangedNotification:
      // App-level registrations also report title changes of buttons and other elements.
      guard let fw = focusedWindow, CFEqual(fw, element) else {
        let win = focused()
        if !CFEqualOptional(win, focusedWindow) { watchWindow(win) }
        emitIfChanged(.window_changed, readTitle(win), time: time, force: false)
        return
      }
      emitIfChanged(.title_changed, readTitle(fw), time: time, force: false)
    default:
      break
    }
  }

  /// Fallback when this worker is stuck: the main thread reports the app change without a title.
  func lastKnownApp() -> AppInfo { observedApp }
}

private func CFEqualOptional(_ a: AXUIElement?, _ b: AXUIElement?) -> Bool {
  switch (a, b) {
  case (nil, nil): return true
  case let (x?, y?): return CFEqual(x, y)
  default: return false
  }
}

private func axCallback(_ observer: AXObserver, _ element: AXUIElement, _ name: CFString, _ refcon: UnsafeMutableRawPointer?) {
  guard let refcon else { return }
  Unmanaged<TitleWorker>.fromOpaque(refcon).takeUnretainedValue().onNotification(name as String, element: element)
}
