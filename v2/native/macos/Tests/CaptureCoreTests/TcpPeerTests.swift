import XCTest
@testable import CaptureCore

final class TcpPeerTests: XCTestCase {
  let me: UInt32 = 501
  // 900 is the browser app, 910 its network process, 920 a process of another user, 930 a tool with no app above it.
  lazy var procs: [Int32: PeerWalk.Proc] = [
    1: .init(pid: 1, ppid: 0, uid: 0),
    900: .init(pid: 900, ppid: 1, uid: me),
    910: .init(pid: 910, ppid: 900, uid: me),
    920: .init(pid: 920, ppid: 1, uid: 502),
    930: .init(pid: 930, ppid: 1, uid: me),
  ]

  func walk(_ pid: Int32?) -> Result<Int32, PeerWalk.Refusal> {
    PeerWalk.appAncestor(of: pid, me: me, proc: { self.procs[$0] }, isApp: { $0 == 900 })
  }

  func testTheBrowsersNetworkProcessWalksUpToTheBrowser() {
    XCTAssertEqual(walk(910), .success(900))
    XCTAssertEqual(walk(900), .success(900))
  }

  func testRefusals() {
    XCTAssertEqual(walk(nil), .failure(.no_socket))
    XCTAssertEqual(walk(999), .failure(.no_socket))
    XCTAssertEqual(walk(920), .failure(.other_user))
    XCTAssertEqual(walk(930), .failure(.no_app))
  }

  func testArgumentsAndAnswer() {
    XCTAssertEqual(PeerWalk.ports(["x", "--tcp-peer", "27481", "50123"])?.service, 27481)
    XCTAssertNil(PeerWalk.ports(["x", "--tcp-peer", "27481"]))
    XCTAssertNil(PeerWalk.ports(["x", "--tcp-peer", "0", "1"]))
    XCTAssertNil(PeerWalk.ports(["x", "--tcp-peer", "70000", "1"]))
    XCTAssertEqual(PeerWalk.answer(.failure(.other_user)), #"{"ok":false,"reason":"other_user"}"#)
  }

  func testSecretCommandsTakeOnlyAPairingId() {
    XCTAssertEqual(SecretCommand.parse(["x", "--secret", "get", "AAAAAAAAAAAAAAAAAAAAAA"]), SecretCommand(op: .get, name: "AAAAAAAAAAAAAAAAAAAAAA"))
    XCTAssertEqual(SecretCommand.parse(["x", "--secret", "set", "a-b_c0123456789ABCDEFG"])?.op, .set)
    XCTAssertNil(SecretCommand.parse(["x", "--secret", "list", "AAAAAAAAAAAAAAAAAAAAAA"]))
    XCTAssertNil(SecretCommand.parse(["x", "--secret", "get", "short"]))
    XCTAssertNil(SecretCommand.parse(["x", "--secret", "get", "../../../../../etc/pass"]))
    XCTAssertNil(SecretCommand.parse(["x", "--secret", "get"]))
  }
}

