import Foundation
import CoreServices
import XCTest
@testable import DaylensCaptureMac

final class BrowserRegistryTests: XCTestCase {
  func bundle(_ schemes: [String]) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".app")
    try FileManager.default.createDirectory(at: url.appendingPathComponent("Contents"), withIntermediateDirectories: true)
    try writeSchemes(schemes, to: url)
    return url
  }

  func writeSchemes(_ schemes: [String], to url: URL) throws {
    let info: [String: Any] = ["CFBundleIdentifier": "com.example.notes", "CFBundleURLTypes": [["CFBundleURLSchemes": schemes]]]
    let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
    try data.write(to: url.appendingPathComponent("Contents/Info.plist"), options: .atomic)
  }

  func testEitherWebSchemeIsRegistered() throws {
    let registry = BrowserRegistry()
    for schemes in [["http"], ["https"], ["HTTPS"], ["http", "https"]] {
      let url = try bundle(schemes)
      defer { try? FileManager.default.removeItem(at: url) }
      XCTAssertTrue(registry.isRegisteredBrowser(bundleURL: url, bundleId: "com.example.notes"), "\(schemes)")
    }
    let url = try bundle(["notes", "mailto"])
    defer { try? FileManager.default.removeItem(at: url) }
    XCTAssertFalse(registry.isRegisteredBrowser(bundleURL: url, bundleId: "com.example.notes"))
  }

  func testRegistrationChangesAreSeenWithoutRestartingTheRegistry() throws {
    let registry = BrowserRegistry()
    let url = try bundle(["notes"])
    defer { try? FileManager.default.removeItem(at: url) }
    XCTAssertFalse(registry.isRegisteredBrowser(bundleURL: url, bundleId: "com.example.notes"))
    try writeSchemes(["http", "https"], to: url)
    XCTAssertTrue(registry.isRegisteredBrowser(bundleURL: url, bundleId: "com.example.notes"))
    try writeSchemes(["notes"], to: url)
    XCTAssertFalse(registry.isRegisteredBrowser(bundleURL: url, bundleId: "com.example.notes"))
  }

  func testMissingAndUnreadableBundlesWithholdTitles() throws {
    let registry = BrowserRegistry()
    XCTAssertTrue(registry.isRegisteredBrowser(bundleURL: nil, bundleId: "com.example.notes"))
    let missing = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".app")
    XCTAssertTrue(registry.isRegisteredBrowser(bundleURL: missing, bundleId: "com.example.notes"))
    let url = try bundle(["notes"])
    defer { try? FileManager.default.removeItem(at: url) }
    try Data("unreadable plist".utf8).write(to: url.appendingPathComponent("Contents/Info.plist"))
    XCTAssertTrue(registry.isRegisteredBrowser(bundleURL: url, bundleId: "com.example.notes"))
  }

  func testLaunchServicesOnlyRegistrationAndChangesAreSeen() throws {
    var ids: [String] = []
    let registry = BrowserRegistry(handlers: { _ in ids })
    let url = try bundle(["notes"])
    defer { try? FileManager.default.removeItem(at: url) }
    let registered = try XCTUnwrap((LSCopyAllHandlersForURLScheme("https" as CFString)?.takeRetainedValue() as? [String])?.first)
    XCTAssertTrue(BrowserRegistry().isRegisteredBrowser(bundleURL: url, bundleId: registered))
    XCTAssertFalse(registry.isRegisteredBrowser(bundleURL: url, bundleId: "com.example.notes"))
    ids = ["com.example.notes"]
    XCTAssertTrue(registry.isRegisteredBrowser(bundleURL: url, bundleId: "com.example.notes"))
    ids = []
    XCTAssertFalse(registry.isRegisteredBrowser(bundleURL: url, bundleId: "com.example.notes"))
    let failed = BrowserRegistry(handlers: { _ in nil })
    XCTAssertTrue(failed.isRegisteredBrowser(bundleURL: url, bundleId: "com.example.notes"))
  }

}
