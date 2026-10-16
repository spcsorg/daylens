import XCTest
@testable import CaptureCore

final class NativeMessagingTests: XCTestCase {
  let time = EventTime(wallMs: 1_792_130_412_345, monoUs: 881_234_567_890, tz: "Africa/Kigali", tzOffsetMin: 120)
  let dia = AppInfo(appId: "company.thebrowser.dia", name: "Dia", path: "/Applications/Dia.app", pid: 812, registeredBrowser: true, identityState: .ok)
  let devId = "abcdefghijklmnopabcdefghijklmnop"

  func fixture(_ name: String) throws -> NSDictionary {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../protocol/fixtures/valid.json").standardized
    let list = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String: Any]]
    return list.first { $0["name"] as? String == name }!["line"] as! NSDictionary
  }

  func encode(_ msg: String, seq: Int64) throws -> NSDictionary {
    guard case .tab(let r) = ExtensionMessage.parse(Array(msg.utf8))! else { throw XCTSkip("not a tab") }
    let line = envelope(run: "run-0002", seq: seq, boot: "boot-0001", time: time, platform: "macos", source: "browser_ext", kind: "tab",
                        obs: Obs.tab(r, browser: dia, extensionId: devId)).serialized()
    return try JSONSerialization.jsonObject(with: Data(line.utf8)) as! NSDictionary
  }

  func testTabLinesMatchGoldenFixtures() throws {
    let page = #"{"t":"tab","state":"page","trigger":"activated","window":"1785","tab":"1790","url":"https://example.com/search?q=budget","title":"Budget — “Q4” 日本語"}"#
    XCTAssertEqual(try encode(page, seq: 0), try fixture("host_mac_tab_page"))
    let unknown = #"{"t":"tab","state":"unknown","trigger":"focus","reason":"no_focused_window"}"#
    XCTAssertEqual(try encode(unknown, seq: 1), try fixture("host_mac_tab_unknown"))
  }

  func testLaunchDetection() {
    XCTAssertEqual(HostLaunch.detect(["/x/host", "chrome-extension://dgidcofcmgnlicmmepgomalcdcbgjjjg/"]), .chromium(extensionId: "dgidcofcmgnlicmmepgomalcdcbgjjjg"))
    XCTAssertEqual(HostLaunch.detect(["/x/host", "chrome-extension://dgidcofcmgnlicmmepgomalcdcbgjjjg/", "--parent-window=0"]), .chromium(extensionId: "dgidcofcmgnlicmmepgomalcdcbgjjjg"))
    XCTAssertEqual(HostLaunch.detect(["/x/host", "/Users/a/Library/Application Support/Mozilla/NativeMessagingHosts/app.daylens.browser.json", "browser@daylens"]), .firefox(extensionId: "browser@daylens"))
    XCTAssertNil(HostLaunch.detect(["/x/host"]))
    XCTAssertNil(HostLaunch.detect(["/x/host", "--heartbeat-s", "15"]), "the capture helper's own launch is never host mode")
    XCTAssertNil(HostLaunch.detect(["/x/host", "chrome-extension://NOTANID/"]))
    XCTAssertNil(HostLaunch.detect(["/x/host", "a.json", "no-at-sign"]))
  }

  func testOnlyKnownExtensionsAreAllowed() {
    XCTAssertTrue(allowedExtensionIds.contains("dgidcofcmgnlicmmepgomalcdcbgjjjg"))
    XCTAssertFalse(allowedExtensionIds.contains(devId))
  }

  func testFramesSplitAcrossReadsAndOversizedFramesAreSkippedInStep() {
    let a = NativeFrame.encode(#"{"t":"status"}"#)!
    var big = [UInt8](repeating: 0, count: 4)
    var n = UInt32(NativeFrame.maxInbound + 10)
    withUnsafeBytes(of: &n) { for (i, b) in $0.enumerated() { big[i] = b } }
    big += [UInt8](repeating: 0x41, count: NativeFrame.maxInbound + 10)
    let b = NativeFrame.encode(#"{"t":"open"}"#)!
    let stream = a + big + b
    var r = FrameReader()
    var items: [FrameReader.Item] = []
    var i = 0
    while i < stream.count {
      let end = min(stream.count, i + 7_001)
      items += r.feed(Array(stream[i..<end]))
      i = end
    }
    XCTAssertEqual(items, [.message(Array(#"{"t":"status"}"#.utf8)), .oversized(NativeFrame.maxInbound + 10), .message(Array(#"{"t":"open"}"#.utf8))])
  }

  func testOnlyWellFormedMessagesPass() {
    func p(_ s: String) -> ExtensionMessage? { ExtensionMessage.parse(Array(s.utf8)) }
    XCTAssertEqual(p(#"{"t":"pause","for":"hour"}"#), .pause(.hour))
    XCTAssertNil(p(#"{"t":"pause","for":"forever"}"#))
    XCTAssertNil(p(#"{"t":"tab","state":"page","trigger":"focus","window":"1"}"#), "a page needs an address")
    XCTAssertNil(p(#"{"t":"tab","state":"unknown","trigger":"focus","reason":"private_window"}"#))
    XCTAssertNil(p(#"{"t":"tab","state":"page","trigger":"keylogger","window":"1","url":"https://x"}"#))
    XCTAssertNil(p(#"{"t":"tab","state":"page","trigger":"focus","window":"1","url":"https://x/\#(String(repeating: "a", count: 2048))"}"#))
    XCTAssertNil(p("not json"))
    XCTAssertNil(p(#"{"t":"exec","cmd":"rm"}"#))
    guard case .tab(let r)? = p(#"{"t":"tab","state":"unknown","trigger":"focus","reason":"no_tab","url":"https://leak","title":"leak"}"#) else { return XCTFail() }
    XCTAssertNil(r.url, "unknown never carries an address, even if one is sent")
    XCTAssertNil(r.title)
    guard case .tab(let long)? = p(#"{"t":"tab","state":"page","trigger":"focus","window":"1","url":"https://x","title":"\#(String(repeating: "a", count: 1023))🌘🌘"}"#) else { return XCTFail() }
    XCTAssertEqual(long.title?.utf16.count, 1023)
  }

  func testServiceLinesBecomeExtensionStatus() {
    XCTAssertEqual(HostReply.fromService(#"{"op":"status","capture":"paused","until_wall_ms":1792130412345}"#),
                   #"{"t":"status","daylens":"connected","capture":"paused","until_wall_ms":1792130412345}"#)
    XCTAssertEqual(HostReply.fromService(#"{"op":"snapshot"}"#), #"{"t":"snapshot"}"#)
    XCTAssertNil(HostReply.fromService(#"{"op":"status","capture":"exfiltrate"}"#))
    XCTAssertNil(HostReply.fromService("garbage"))
    XCTAssertEqual(HostReply.control(.pause(.until_resumed)), #"{"op":"pause","for":"until_resumed"}"#)
  }
}
