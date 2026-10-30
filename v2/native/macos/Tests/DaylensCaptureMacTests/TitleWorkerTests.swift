import ApplicationServices
import CaptureCore
import Foundation
import XCTest
@testable import DaylensCaptureMac

final class TitleWorkerTests: XCTestCase {
  // The worker thread is never started, so a submitted switch stays queued, as it does while the worker is busy.
  func testAWindowNoticeFromTheAppJustLeftIsNotReportedAfterTheSwitch() {
    var lines: [String] = []
    let lock = NSLock()
    let emitter = Emitter(run: "r", boot: "b", platform: "macos") { line in lock.lock(); lines.append(line); lock.unlock() }
    let worker = TitleWorker(emitter: emitter)
    let leftWindow = AXUIElementCreateApplication(1)
    let notes = AppInfo(appId: "com.example.notes", name: "Notes", path: nil, pid: 4242, registeredBrowser: false, identityState: .ok)

    worker.submit(FocusRequest(trigger: .app_changed, app: notes, time: Clock.now(), force: false))
    worker.onNotification(kAXFocusedWindowChangedNotification, element: leftWindow)
    XCTAssertTrue(emitter.flush(timeout: 5))
    XCTAssertEqual(lines.count, 0, "a window notice arriving after the switch, before it is handled, would date the old app later than the switch")

    worker.abandon()
    worker.onNotification(kAXFocusedWindowChangedNotification, element: leftWindow)
    XCTAssertTrue(emitter.flush(timeout: 5))
    XCTAssertEqual(lines.count, 1, "with no switch waiting, a window notice is reported")
  }
}
