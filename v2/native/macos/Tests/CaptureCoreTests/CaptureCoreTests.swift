import XCTest
@testable import CaptureCore

final class CaptureCoreTests: XCTestCase {
  let time = EventTime(wallMs: 1_792_130_412_345, monoUs: 881_234_567_890, tz: "Africa/Kigali", tzOffsetMin: 120)
  let term = AppInfo(appId: "com.apple.Terminal", name: "Terminal", path: "/System/Applications/Utilities/Terminal.app", pid: 501, registeredBrowser: false, engine: .none, identityState: .ok)

  func fixtures() throws -> [String: Any] {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../protocol/fixtures/valid.json").standardized
    let list = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String: Any]]
    return Dictionary(uniqueKeysWithValues: list.map { ($0["name"] as! String, $0["line"]!) })
  }

  func assertMatches(_ name: String, seq: Int64, source: String, kind: String, _ obs: JSON, file: StaticString = #filePath, line: UInt = #line) throws {
    let encoded = envelope(run: "run-0001", seq: seq, boot: "boot-0001", time: time, platform: "macos", source: source, kind: kind, obs: obs).serialized()
    let ours = try JSONSerialization.jsonObject(with: Data(encoded.utf8)) as! NSDictionary
    let golden = try fixtures()[name] as! NSDictionary
    XCTAssertEqual(ours, golden, name, file: file, line: line)
  }

  func testEncoderMatchesGoldenFixtures() throws {
    let p = Permissions(accessibility: "granted")
    try assertMatches("mac_hello", seq: 0, source: "helper", kind: "hello",
                      Obs.hello(awakeUs: 612_345_000_000, helper: "daylens-capture-macos", version: "2.0.0-dev", pid: 4242, os: "macOS 27.0.1", permissions: p, heartbeatS: 15, idleThresholdS: 120, reconcileS: 60))
    try assertMatches("mac_heartbeat", seq: 1, source: "helper", kind: "heartbeat", Obs.heartbeat(awakeUs: 612_345_678_901, permissions: p, focusRegistered: true, sessionRegistered: true, powerRegistered: true, titles: .ok, stallMs: 0, dropped: 0))
    try assertMatches("mac_focus_app", seq: 2, source: "nsworkspace", kind: "focus",
                      Obs.focus(trigger: .app_changed, app: term, window: .read(window: "w-1", title: "daylens — zsh — 80×24")))
    try assertMatches("mac_focus_title", seq: 3, source: "ax_observer", kind: "focus",
                      Obs.focus(trigger: .title_changed, app: term, window: .read(window: "w-1", title: "✳ Fix capture")))
    try assertMatches("mac_focus_no_permission", seq: 4, source: "nsworkspace", kind: "focus",
                      Obs.focus(trigger: .app_changed, app: term, window: WindowInfo(window: nil, title: nil, titleState: .no_permission)))
    try assertMatches("mac_input_idle", seq: 5, source: "idle_timer", kind: "input", Obs.input(idle: true, lastInputWallMs: 1_792_130_292_345, thresholdS: 120, snapshot: false))
    try assertMatches("mac_session_locked", seq: 6, source: "distributed_notification", kind: "session", Obs.session("locked", snapshot: false))
    try assertMatches("mac_power_sleep", seq: 7, source: "nsworkspace", kind: "power", Obs.power("sleep"))
    try assertMatches("mac_power_display_snapshot", seq: 7, source: "cg_display", kind: "power", Obs.power("display_off", snapshot: true))
    try assertMatches("mac_clock", seq: 8, source: "notification", kind: "clock", Obs.clock("timezone_changed"))
    try assertMatches("mac_bye", seq: 9, source: "helper", kind: "bye", Obs.bye("shutdown"))
    try assertMatches("mac_loss", seq: 20, source: "helper", kind: "loss", Obs.loss(count: 3, fromWallMs: 1_792_130_410_000, toWallMs: 1_792_130_411_000))
  }

  func testEscapingSurvivesHostileTitles() throws {
    let title = "quote \" backslash \\ newline \n tab \t nul \u{0} sep \u{2028} emoji 🌘 日本語"
    let s = Obs.focus(trigger: .title_changed, app: term, window: .read(window: "w", title: title)).serialized()
    let parsed = try JSONSerialization.jsonObject(with: Data(s.utf8)) as! [String: Any]
    XCTAssertEqual((parsed["window"] as! [String: Any])["title"] as? String, title)
    XCTAssertFalse(s.contains("\n"))
  }

  func testTitlesAreTruncatedOnCharacterBoundaries() {
    let long = String(repeating: "a", count: 1023) + "🌘🌘"
    let w = WindowInfo.read(window: nil, title: long)
    XCTAssertEqual(w.title!.utf16.count, 1023)
    XCTAssertEqual(WindowInfo.read(window: nil, title: "").titleState, .empty)
    XCTAssertNil(WindowInfo.read(window: nil, title: "").title)
  }

  func testEmitterAssignsSeqBeforeQueueingAndCountsDrops() {
    let gate = DispatchSemaphore(value: 0)
    var out: [String] = []
    let lock = NSLock()
    let e = Emitter(run: "r", boot: "b", platform: "macos", capacity: 2, reserve: 1) { line in
      gate.wait()
      lock.lock(); out.append(line); lock.unlock()
    }
    for _ in 0..<5 { e.emit(kind: "focus", source: "t", time: time, obs: Obs.power("sleep"), priority: .normal) }
    e.emit(kind: "power", source: "t", time: time, obs: Obs.power("sleep"), priority: .critical)
    e.emit(kind: "power", source: "t", time: time, obs: Obs.power("sleep"), priority: .critical)
    for _ in 0..<10 { gate.signal() }
    e.flush(timeout: 5)
    XCTAssertEqual(e.dropped, 4)
    let seqs = out.map { (try! JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any])["seq"] as! Int }
    XCTAssertEqual(seqs, [0, 1, 5], "two normal lines fit, the reserve takes one critical line, the gap shows as a seq jump")
    XCTAssertTrue(out.allSatisfy { $0.hasSuffix("\n") && $0.dropLast().firstIndex(of: "\n") == nil })
  }

  func testIdleSchedulerChecksOnlyWhenIdleCouldBeReached() {
    var s = IdleScheduler(thresholdS: 120)
    var d = s.evaluate(secondsSinceInput: 10)
    XCTAssertEqual(d.emit, false, "first look reports the state")
    XCTAssertEqual(d.nextCheckS, 110.25, accuracy: 0.01)
    d = s.evaluate(secondsSinceInput: 5)
    XCTAssertNil(d.emit, "still active: nothing to say")
    XCTAssertEqual(d.nextCheckS, 115.25, accuracy: 0.01)
    d = s.evaluate(secondsSinceInput: 121)
    XCTAssertEqual(d.emit, true)
    XCTAssertEqual(d.nextCheckS, 2)
    d = s.evaluate(secondsSinceInput: 400)
    XCTAssertNil(d.emit)
    d = s.evaluate(secondsSinceInput: 0.3)
    XCTAssertEqual(d.emit, false, "input after idle is reported")
    s.reset()
    XCTAssertEqual(s.evaluate(secondsSinceInput: 0).emit, false, "after a reset the state is reported again")
  }

  func testOkStateWithoutATitleIsNeverEncodedAsOk() {
    XCTAssertEqual(WindowInfo(window: "w", title: nil, titleState: .ok).titleState, .unavailable)
    XCTAssertEqual(WindowInfo(window: "w", title: "", titleState: .ok).titleState, .empty)
    XCTAssertEqual(WindowInfo(window: "w", title: "x", titleState: .ok).title, "x")
  }

  func testIdentityFieldsAreClipped() throws {
    let app = AppInfo(appId: String(repeating: "a", count: 5000), name: String(repeating: "n", count: 600), path: nil, pid: 1, registeredBrowser: false, identityState: .ok)
    let s = Obs.focus(trigger: .app_changed, app: app, window: .read(window: nil, title: "t")).serialized()
    let a = (try JSONSerialization.jsonObject(with: Data(s.utf8)) as! [String: Any])["app"] as! [String: Any]
    XCTAssertEqual((a["app_id"] as! String).count, 1024)
    XCTAssertEqual((a["name"] as! String).count, 512)
  }

  func testOverflowWhileBlockedIsRecordedWithItsTimeRange() {
    let q = RequestQueue<Int>(capacity: 64)
    for i in 0..<100 { _ = q.push(i, wallMs: 1000 + Int64(i)) }
    XCTAssertEqual(q.count, 64)
    XCTAssertEqual(q.takeLoss(), .init(count: 36, fromWallMs: 1000, toWallMs: 1035))
    XCTAssertNil(q.takeLoss(), "a loss is reported once")
    var seen: [Int] = []
    while let x = q.pop() { seen.append(x) }
    XCTAssertEqual(seen, Array(36..<100), "the newest work survives, in order")
  }

  func testABurstWhileBlockedSchedulesOneDrainAndStaysBounded() {
    let q = RequestQueue<Int>(capacity: 64)
    var wakes = 0
    for i in 0..<100_000 where q.push(i, wallMs: Int64(i)) { wakes += 1 }
    XCTAssertEqual(wakes, 1, "pending drains do not grow while the worker is stuck")
    XCTAssertEqual(q.count, 64)
    XCTAssertEqual(q.takeLoss()?.count, 100_000 - 64)
    while q.pop() != nil {}
    XCTAssertTrue(q.push(1, wallMs: 1), "after the queue drains, the next push schedules again")
  }

  func testAbandonedWorkCountsAsLost() {
    let q = RequestQueue<Int>(capacity: 64)
    _ = q.push(1, wallMs: 10)
    _ = q.push(2, wallMs: 20)
    q.clear()
    XCTAssertEqual(q.takeLoss(), .init(count: 2, fromWallMs: 10, toWallMs: 20))
    XCTAssertNil(q.pop())
  }

  func testInFlightWorkDiscardedAfterAbandonIsCounted() {
    let q = RequestQueue<Int>(capacity: 64)
    _ = q.push(1, wallMs: 10)
    _ = q.pop()
    q.recordLoss(wallMs: 10)
    XCTAssertEqual(q.takeLoss(), .init(count: 1, fromWallMs: 10, toWallMs: 10))
  }

  func testBundleClassifierSeparatesBrowsersFromWebRuntimeApps() {
    func l(_ res: [String]?, _ fws: [String] = [], gecko: Bool = false, helpers: [String: [String]] = [:]) -> BundleListing {
      BundleListing(resources: res, frameworks: fws, geckoBrowserResources: gecko, frameworkHelpers: helpers)
    }
    XCTAssertEqual(classifyBundle(l(["Info.plist"], ["Google Chrome Framework.framework"],
                                    helpers: ["Google Chrome Framework.framework": ["Google Chrome Helper.app", "Google Chrome Helper (Renderer).app"]])), .browser)
    XCTAssertEqual(classifyBundle(l(["omni.ja"], gecko: true)), .browser, "Firefox and portable Gecko browsers")
    XCTAssertEqual(classifyBundle(l(["app.asar", "icon.icns"], ["Electron Framework.framework"],
                                    helpers: ["Electron Framework.framework": ["Slack Helper (Renderer).app"]])), .app_runtime, "Electron ships a renderer helper too")
    XCTAssertEqual(classifyBundle(l(["app.asar"], ["Codex Framework.framework"],
                                    helpers: ["Codex Framework.framework": ["Codex Helper (Renderer).app"]])), .app_runtime, "a renamed Electron framework still has app.asar")
    XCTAssertEqual(classifyBundle(l(["icon.icns"], ["Chromium Embedded Framework.framework"])), .app_runtime, "CEF apps such as Spotify")
    XCTAssertEqual(classifyBundle(l(["Base.lproj"], ["Sparkle.framework"])), .none)
    XCTAssertEqual(classifyBundle(l(nil)), .unknown, "a bundle that cannot be read is unknown, never normal")
    XCTAssertEqual(classifyBundle(nil), .unknown)
  }

  func testAShortSleepStillReportsTheUserComingBack() {
    var s = IdleScheduler(thresholdS: 120)
    let resume: Int64 = 1_000_000
    _ = s.evaluate(secondsSinceInput: 5, nowWallMs: resume - 1000)
    s.reset()
    s.markResume(wallMs: resume)
    var d = s.evaluate(secondsSinceInput: 30, nowWallMs: resume + 500)
    XCTAssertEqual(d.emit, false, "the state after resume is reported")
    XCTAssertFalse(d.returned, "input from before the sleep is not a return")
    XCTAssertEqual(d.nextCheckS, 2, "keep looking briefly until the user is back")
    d = s.evaluate(secondsSinceInput: 0.2, nowWallMs: resume + 9_000)
    XCTAssertNil(d.emit, "never idle, so the state did not change")
    XCTAssertTrue(d.returned, "but the first input after the resume is reported")
    XCTAssertGreaterThan(d.nextCheckS, 100, "and checks go back to their normal pace")
    XCTAssertFalse(s.evaluate(secondsSinceInput: 0.1, nowWallMs: resume + 20_000).returned, "reported once")
  }

  func testTypingOneSecondAfterWakingThenReadingIsStillAReturn() {
    var s = IdleScheduler(thresholdS: 120)
    let resume: Int64 = 1_000_000
    s.reset()
    s.markResume(wallMs: resume)
    _ = s.evaluate(secondsSinceInput: 40, nowWallMs: resume + 200)
    // One keystroke 1 s after waking, then reading: the next look sees that input, now 2 s old.
    let d = s.evaluate(secondsSinceInput: 2, nowWallMs: resume + 3_000)
    XCTAssertTrue(d.returned, "input stamped after the resume is a return, however soon")
  }

  func testFlushIsBoundedWhenTheReaderStopsReading() {
    let blocked = DispatchSemaphore(value: 0)
    let e = Emitter(run: "r", boot: "b", platform: "macos") { _ in blocked.wait() }
    e.emit(kind: "power", source: "t", time: time, obs: Obs.power("sleep"), priority: .critical)
    let start = Date()
    XCTAssertFalse(e.flush(timeout: 0.1), "a blocked pipe is reported, not waited on")
    XCTAssertLessThan(Date().timeIntervalSince(start), 0.5, "sleep acknowledgement is never held up by stdout")
    blocked.signal()
    XCTAssertTrue(e.flush(timeout: 1))
  }

  private func makeBundle(_ layout: [String]) throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("daylens-bundle-\(UUID().uuidString)/Test.app")
    for path in layout {
      let u = root.appendingPathComponent(path)
      if path.hasSuffix("/") { try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true) }
      else {
        try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: u.path, contents: Data())
      }
    }
    return root
  }

  private func withUnreadable<T>(_ u: URL, _ body: () -> T) -> T {
    chmod(u.path, 0)
    defer { chmod(u.path, 0o755) }
    return body()
  }

  func testAnUnreadableHelpersFolderMakesTheScanUncertainNotEmpty() throws {
    let app = try makeBundle(["Contents/Resources/x.icns", "Contents/Frameworks/Some Framework.framework/Versions/Current/Helpers/Some Helper (Renderer).app/"])
    XCTAssertEqual(classifyBundle(scanBundle(at: app)), .browser, "readable, it is a browser")
    let helpers = app.appendingPathComponent("Contents/Frameworks/Some Framework.framework/Versions/Current/Helpers")
    XCTAssertEqual(withUnreadable(helpers) { classifyBundle(scanBundle(at: app)) }, .unknown, "unreadable, it must not drop to none")
  }

  func testAnUnreadableFrameworksOrBrowserFolderMakesTheScanUncertain() throws {
    let app = try makeBundle(["Contents/Resources/browser/omni.ja", "Contents/Frameworks/"])
    XCTAssertEqual(classifyBundle(scanBundle(at: app)), .browser)
    XCTAssertEqual(withUnreadable(app.appendingPathComponent("Contents/Resources/browser")) { classifyBundle(scanBundle(at: app)) }, .unknown)
    XCTAssertEqual(withUnreadable(app.appendingPathComponent("Contents/Frameworks")) { classifyBundle(scanBundle(at: app)) }, .unknown)
  }

  func testMissingFoldersAreSimplyEmpty() throws {
    let app = try makeBundle(["Contents/Resources/x.icns"])
    XCTAssertEqual(classifyBundle(scanBundle(at: app)), .none)
  }

  func testAnAppUpdateChangesTheBundleStampSoNoVerdictSurvivesIt() throws {
    let app = try makeBundle(["Contents/Resources/x.icns", "Contents/MacOS/Thing"])
    let plist = app.appendingPathComponent("Contents/Info.plist")
    try (["CFBundleExecutable": "Thing"] as NSDictionary).write(to: plist)
    let before = try XCTUnwrap(BundleStamp.of(app))
    XCTAssertEqual(BundleStamp.of(app), before, "unchanged files, same key")
    XCTAssertEqual(classifyBundle(scanBundle(at: app)), .none)
    // The update: the app becomes an Electron app and its executable is replaced.
    try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents/Frameworks/Electron Framework.framework"), withIntermediateDirectories: true)
    let exe = app.appendingPathComponent("Contents/MacOS/Thing")
    try FileManager.default.removeItem(at: exe)
    try Data(repeating: 1, count: 64).write(to: exe)
    let after = try XCTUnwrap(BundleStamp.of(app))
    XCTAssertNotEqual(before, after, "a cached none cannot be reused for the updated app")
    XCTAssertEqual(classifyBundle(scanBundle(at: app)), .app_runtime)
  }

  func testAProcessKeyIncludesItsStartTimeSoAReusedPidIsAnotherProcess() throws {
    let me = try XCTUnwrap(ProcessKey.of(getpid()))
    XCTAssertEqual(ProcessKey.of(getpid()), me, "the same process keeps its key")
    var reused = me
    reused.startSec += 1
    XCTAssertNotEqual(reused, me, "same PID, later start: not the same key")
    XCTAssertNil(ProcessKey.of(-1))
  }

  func testAStagedUpdateUnderAnUnchangedLauncherIsSeenByTheNextLaunch() throws {
    let app = try makeBundle(["Contents/Resources/x.icns", "Contents/MacOS/Thing"])
    try (["CFBundleExecutable": "Thing"] as NSDictionary).write(to: app.appendingPathComponent("Contents/Info.plist"))
    let registry = EngineRegistry()
    let launch1 = ProcessKey(pid: 4242, startSec: 1000, startUsec: 0)
    XCTAssertEqual(registry.engine(bundleURL: app, process: launch1), .none)
    // A staged update adds a Chromium browser framework; Info.plist and the launcher are untouched.
    try FileManager.default.createDirectory(
      at: app.appendingPathComponent("Contents/Frameworks/New Framework.framework/Versions/Current/Helpers/New Helper (Renderer).app"),
      withIntermediateDirectories: true)
    XCTAssertEqual(registry.engine(bundleURL: app, process: launch1), .none, "the running process is what it was when it started")
    let launch2 = ProcessKey(pid: 4242, startSec: 2000, startUsec: 0)
    XCTAssertEqual(registry.engine(bundleURL: app, process: launch2), .browser, "the next launch, even with a reused PID, sees the update")
  }

  func testEachLaunchScansOnceAndRepeatsAreFree() throws {
    let app = try makeBundle(["Contents/Resources/x.icns"])
    var scans = 0
    let registry = EngineRegistry(scan: { scans += 1; return scanBundle(at: $0) })
    let launch = ProcessKey(pid: 77, startSec: 5, startUsec: 0)
    for _ in 0..<100 { _ = registry.engine(bundleURL: app, process: launch) }
    XCTAssertEqual(scans, 1)
    _ = registry.engine(bundleURL: app, process: ProcessKey(pid: 78, startSec: 6, startUsec: 0))
    XCTAssertEqual(scans, 2)
  }

  func testActiveChecksNeverSpinFasterThanHalfASecond() {
    var s = IdleScheduler(thresholdS: 120)
    XCTAssertEqual(s.evaluate(secondsSinceInput: 119.99).nextCheckS, 0.5)
  }
}

final class HostWalkTests: XCTestCase {
  // pid -> (parent, app) as a process table; the walk sees only these two functions.
  func walk(_ table: [Int32: (Int32, String?)], from pid: Int32) -> String? {
    hostAncestor(of: pid, parent: { table[$0]?.0 }, app: { table[$0]?.1 })
  }

  func testATerminalSessionFindsTheTerminal() {
    let table: [Int32: (Int32, String?)] = [500: (400, nil), 400: (300, nil), 300: (100, nil), 100: (1, "com.mitchellh.ghostty")]
    XCTAssertEqual(walk(table, from: 500), "com.mitchellh.ghostty")
  }

  func testTheNearestAppWins() {
    let table: [Int32: (Int32, String?)] = [500: (400, nil), 400: (200, "com.microsoft.VSCode"), 200: (100, nil), 100: (1, "com.apple.dock")]
    XCTAssertEqual(walk(table, from: 500), "com.microsoft.VSCode")
  }

  func testADetachedOrRemoteSessionHasNoHost() {
    XCTAssertNil(walk([500: (400, nil), 400: (1, nil)], from: 500), "tmux server or sshd under launchd")
    XCTAssertNil(walk([:], from: 500), "a process that is gone")
  }

  func testALoopInTheTableEnds() {
    XCTAssertNil(walk([500: (400, nil), 400: (500, nil)], from: 500))
  }
}

final class StateWatchTests: XCTestCase {
  func testAReadReportsALockOrDarkDisplayWhoseNoticeWasMissed() {
    let w = StateWatch()
    XCTAssertEqual(w.readDisplay("display_on"), "display_on")
    XCTAssertEqual(w.readLock("unlocked"), "unlocked")
    XCTAssertNil(w.readDisplay("display_on"))
    XCTAssertNil(w.readLock("unlocked"))
    XCTAssertEqual(w.readDisplay("display_off"), "display_off")
    XCTAssertEqual(w.readLock("locked"), "locked")
  }

  func testAStateThatCannotBeReadIsReadAgainUntilItCanAndAnUnknownLockIsReportedOnce() {
    let w = StateWatch()
    XCTAssertNil(w.readDisplay(nil))
    XCTAssertEqual(w.readDisplay("display_on"), "display_on")
    XCTAssertEqual(w.readLock("unknown"), "unknown")
    XCTAssertNil(w.readLock("unknown"))
    XCTAssertEqual(w.readLock("unlocked"), "unlocked")
  }

  func testANoticeIsWhatTheNextReadIsComparedWith() {
    let w = StateWatch()
    _ = w.readLock("unlocked")
    w.noteLock("locked")
    XCTAssertNil(w.readLock("locked"))
    w.noteDisplay("display_off")
    XCTAssertEqual(w.readDisplay("display_on"), "display_on")
  }
}
