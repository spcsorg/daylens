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
                      Obs.hello(helper: "daylens-capture-macos", version: "2.0.0-dev", pid: 4242, os: "macOS 27.0.1", permissions: p, heartbeatS: 15, idleThresholdS: 120, reconcileS: 60))
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
    e.flush()
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

  func testActiveChecksNeverSpinFasterThanHalfASecond() {
    var s = IdleScheduler(thresholdS: 120)
    XCTAssertEqual(s.evaluate(secondsSinceInput: 119.99).nextCheckS, 0.5)
  }
}
