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
    // This thread has no autorelease pool of its own; each unit of work drains one.
    CFRunLoopPerformBlock(rl, CFRunLoopMode.defaultMode.rawValue) { [weak self] in autoreleasepool { self?.drain() } }
    CFRunLoopWakeUp(rl)
  }

  func permissionChanged() {
    guard let rl = runLoop else { return }
    CFRunLoopPerformBlock(rl, CFRunLoopMode.defaultMode.rawValue) { [weak self] in autoreleasepool {
      guard let self else { return }
      self.teardown()
      self.drainWith(FocusRequest(trigger: .snapshot, app: self.observedApp, time: Clock.now(), force: true))
    } }
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
    if !pendingNotifications.isEmpty { registerPending() }
    emitIfChanged(r.trigger, currentWindowInfo(), time: r.time, force: r.force || r.trigger == .app_changed, generation: r.generation)
  }

  private func setBusy(_ busy: Bool) {
    lock.lock(); busySinceUs = busy ? Clock.monoUs() : 0; lock.unlock()
  }

  private func teardown() {
    if let obs = observer {
      CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .defaultMode)
    }
    cancelRefresh()
    observer = nil
    appElement = nil
    focusedWindow = nil
    observedPid = 0
    pendingNotifications = []
  }

  private func observe(pid: pid_t, app: AppInfo) {
    teardown()
    observedPid = pid
    observedApp = app
    registrationFailed = false
    refreshAttempt = 0
    guard pid > 0, AXIsProcessTrusted() else { updateDegraded(); return }
    appElement = AXUIElementCreateApplication(pid)
    var obs: AXObserver?
    guard AXObserverCreate(pid, axCallback, &obs) == .success, let obs else {
      registrationFailed = true
      diag("ax_observer_create_failed")
      updateDegraded()
      return
    }
    observer = obs
    CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .defaultMode)
    // Title changes are watched on the focused window only; on the app element they also fire for every label and button.
    pendingNotifications = [kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification]
    registerPending()
  }

  /// A just-launched or busy app answers -25204 until its Accessibility server is ready; those registrations are retried.
  private func registerPending() {
    guard let obs = observer, let element = appElement else { return }
    let refcon = Unmanaged.passUnretained(self).toOpaque()
    for n in pendingNotifications {
      let err = AXObserverAddNotification(obs, element, n as CFString, refcon)
      switch err {
      case .success, .notificationAlreadyRegistered:
        pendingNotifications.remove(n)
      case .cannotComplete:
        // A busy app may still have taken the registration; the retry confirms it. Stop asking it for now.
        diag("ax_add_notification_pending", String(err.rawValue))
        updateDegraded()
        scheduleRefresh()
        return
      default:
        pendingNotifications.remove(n)
        registrationFailed = true
        diag("ax_add_notification_failed", String(err.rawValue))
      }
    }
    updateDegraded()
    if pendingNotifications.isEmpty { refreshAttempt = 0 }
  }

  // MARK: refresh with backoff

  private var pendingNotifications: Set<String> = []
  private var refreshTimer: CFRunLoopTimer?
  private var refreshAttempt = 0
  private static let refreshDelays: [Double] = [0.3, 1, 2, 4, 8, 15, 30, 60]

  private func scheduleRefresh() {
    guard refreshTimer == nil else { return }
    let delay = TitleWorker.refreshDelays[min(refreshAttempt, TitleWorker.refreshDelays.count - 1)]
    refreshAttempt += 1
    let timer = CFRunLoopTimerCreateWithHandler(nil, CFAbsoluteTimeGetCurrent() + delay, 0, 0, 0) { [weak self] _ in autoreleasepool {
      guard let self else { return }
      self.refreshTimer = nil
      self.setBusy(true)
      defer { self.setBusy(false) }
      if !self.pendingNotifications.isEmpty { self.registerPending() }
      self.emitIfChanged(.window_changed, self.currentWindowInfo(), time: Clock.now(), force: false)
    } }
    refreshTimer = timer
    CFRunLoopAddTimer(CFRunLoopGetCurrent(), timer, .defaultMode)
  }

  private func cancelRefresh() {
    if let t = refreshTimer { CFRunLoopTimerInvalidate(t) }
    refreshTimer = nil
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
    switch e1 {
    case .success, .notificationAlreadyRegistered:
      registrationFailed = false
    case .invalidUIElement:
      // The window closed between finding it and watching it.
      focusedWindow = nil
    case .cannotComplete:
      focusedWindow = nil
      scheduleRefresh()
    default:
      registrationFailed = true
      diag("ax_title_observer_failed", String(e1.rawValue))
    }
    updateDegraded()
  }

  private func updateDegraded() {
    lock.lock(); _degraded = registrationFailed || !pendingNotifications.isEmpty; lock.unlock()
  }

  private enum WindowLookup {
    case window(AXUIElement)
    case noWindow
    case busy
    case failed
  }

  private func element(_ ref: CFTypeRef?) -> AXUIElement? {
    guard let ref, CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
    return (ref as! AXUIElement)
  }

  private func string(_ el: AXUIElement, _ attr: String) -> String? {
    var ref: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success ? ref as? String : nil
  }

  private func isWindow(_ el: AXUIElement) -> Bool { string(el, kAXRoleAttribute) == kAXWindowRole }

  /// Focused window, then main window, then the first real window. A busy reply ends the pass at once,
  /// so one slow app costs at most one timeout.
  private func lookUpWindow() -> WindowLookup {
    guard let app = appElement else { return .failed }
    var sawNoValue = false
    for attr in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
      var ref: CFTypeRef?
      switch AXUIElementCopyAttributeValue(app, attr as CFString, &ref) {
      case .success:
        if let w = element(ref), isWindow(w) { return .window(w) }
      case .cannotComplete:
        return .busy
      case .noValue:
        sawNoValue = true
      default:
        break
      }
    }
    var ref: CFTypeRef?
    switch AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &ref) {
    case .success:
      let windows = ((ref as? [AnyObject]) ?? []).compactMap { element($0) }.filter { w in
        guard isWindow(w) else { return false }
        var m: CFTypeRef?
        return !(AXUIElementCopyAttributeValue(w, kAXMinimizedAttribute as CFString, &m) == .success && (m as? Bool) == true)
      }
      if let standard = windows.first(where: { string($0, kAXSubroleAttribute) == kAXStandardWindowSubrole }) { return .window(standard) }
      if let any = windows.first { return .window(any) }
      return .noWindow
    case .cannotComplete:
      return .busy
    case .noValue:
      return .noWindow
    default:
      return sawNoValue ? .noWindow : .failed
    }
  }

  /// Resolves the window to report, watches it, and reads its title.
  private func currentWindowInfo() -> WindowInfo {
    switch lookUpWindow() {
    case .window(let w):
      if !CFEqualOptional(w, focusedWindow) { watchWindow(w) }
      let info = readTitle(w)
      if info.titleState == .unavailable, focusedWindow == nil, case .window(let again) = lookUpWindow() {
        // The window went away mid-read; one fresh look.
        watchWindow(again)
        return readTitle(again)
      }
      if info.titleState == .timeout { scheduleRefresh() }
      return info
    case .noWindow:
      if focusedWindow != nil { watchWindow(nil) }
      return WindowInfo(window: nil, title: nil, titleState: .no_window)
    case .busy:
      scheduleRefresh()
      return WindowInfo(window: nil, title: nil, titleState: .timeout)
    case .failed:
      if !pendingNotifications.isEmpty { scheduleRefresh() }
      return WindowInfo(window: nil, title: nil, titleState: .unavailable)
    }
  }

  private func readTitle(_ win: AXUIElement) -> WindowInfo {
    let id = "ax-\(CFHash(win))"
    var ref: CFTypeRef?
    switch AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &ref) {
    case .success: return WindowInfo.read(window: id, title: ref as? String)
    case .noValue: return WindowInfo(window: id, title: nil, titleState: .empty)
    case .apiDisabled: return WindowInfo(window: id, title: nil, titleState: .no_permission)
    case .cannotComplete: return WindowInfo(window: id, title: nil, titleState: .timeout)
    case .invalidUIElement:
      focusedWindow = nil
      return WindowInfo(window: id, title: nil, titleState: .unavailable)
    default: return WindowInfo(window: id, title: nil, titleState: .unavailable)
    }
  }

  private func emitIfChanged(_ trigger: FocusTrigger, _ w: WindowInfo, time: EventTime, force: Bool, generation: Int? = nil) {
    if let g = generation, g != currentGeneration {
      queue.recordLoss(wallMs: time.wallMs)
      reportLoss()
      return
    }
    if !force, let last = lastEmitted, last.app == observedApp, last.window == w { return }
    lastEmitted = (observedApp, w)
    emitter.emit(kind: "focus", source: trigger == .reconcile ? "reconcile" : "ax_observer", time: time,
                 obs: Obs.focus(trigger: trigger, app: observedApp, window: w), priority: .normal)
  }

  func onNotification(_ name: String, element: AXUIElement) {
    // A queued switch is older than this notice; reporting the old app now would date it after the switch. The switch reads the window itself.
    guard queue.count == 0 else { return }
    let time = Clock.now()
    setBusy(true)
    defer { setBusy(false) }
    switch name {
    case kAXTitleChangedNotification:
      guard let fw = focusedWindow, CFEqual(fw, element) else { fallthrough }
      emitIfChanged(.title_changed, readTitle(fw), time: time, force: false)
    case kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification, kAXUIElementDestroyedNotification:
      emitIfChanged(.window_changed, currentWindowInfo(), time: time, force: false)
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
  autoreleasepool { Unmanaged<TitleWorker>.fromOpaque(refcon).takeUnretainedValue().onNotification(name as String, element: element) }
}
