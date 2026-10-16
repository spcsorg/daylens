import AppKit
import ApplicationServices
import CaptureCore
import Foundation

struct FocusRequest {
  var trigger: FocusTrigger
  var app: AppInfo
  var time: EventTime
  var force: Bool
  var generation: Int = 0
}

/// Owns every Accessibility call on its own thread and run loop, so a hung app can delay
/// titles but never the main thread's app, session, power and heartbeat events.
final class TitleWorker: Thread {
  private let emitter: Emitter
  private let lock = NSLock()
  private let queue = RequestQueue<FocusRequest>(capacity: 64)
  private var generation = 0
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

  /// Every request is kept in order, so sub-second switches survive a busy worker; overflow is reported as a loss.
  func submit(_ r: FocusRequest) {
    lock.lock()
    var next = r
    next.generation = generation
    lock.unlock()
    guard queue.push(next, wallMs: r.time.wallMs), let rl = runLoop else { return }
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

  /// Called from the main thread when this worker is stuck and the main thread reported focus itself:
  /// anything older must not land after that report.
  func abandon() {
    lock.lock()
    generation += 1
    lock.unlock()
    queue.clear()
  }

  private var currentGeneration: Int { lock.lock(); defer { lock.unlock() }; return generation }

  private func drain() {
    while let r = queue.pop() {
      reportLoss()
      drainWith(r)
    }
    reportLoss()
  }

  private func reportLoss() {
    guard let l = queue.takeLoss() else { return }
    diag("title_queue_loss", String(l.count))
    emitter.emit(kind: "loss", source: "helper", time: Clock.now(),
                 obs: Obs.loss(count: l.count, fromWallMs: l.fromWallMs, toWallMs: l.toWallMs), priority: .critical)
  }

  private func drainWith(_ r: FocusRequest) {
    setBusy(true)
    defer { setBusy(false) }
    // Test-only fault: hold this worker in one call, as a hung app would.
    if faultBlockTitles { while true { Thread.sleep(forTimeInterval: 3600) } }
    let pid = pid_t(r.app.pid ?? 0)
    if pid != observedPid || observer == nil { observe(pid: pid, app: r.app) } else { observedApp = r.app }
    guard AXIsProcessTrusted() else {
      emitIfChanged(r.trigger, WindowInfo(window: nil, title: nil, titleState: .no_permission), time: r.time, force: true, generation: r.generation)
      return
    }
    let win = focused()
    if !CFEqualOptional(win, focusedWindow) { watchWindow(win) }
    emitIfChanged(r.trigger, readTitle(win), time: r.time, force: r.force || r.trigger == .app_changed, generation: r.generation)
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
    // Title changes are watched on the focused window only; on the app element they also fire for every label and button.
    for n in [kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification] {
      let err = AXObserverAddNotification(obs, element, n as CFString, refcon)
      if err != .success && err != .notificationAlreadyRegistered {
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

  private func emitIfChanged(_ trigger: FocusTrigger, _ w: WindowInfo, time: EventTime, force: Bool, generation: Int? = nil) {
    if let g = generation, g != currentGeneration { return }
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
