import Foundation
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
}
