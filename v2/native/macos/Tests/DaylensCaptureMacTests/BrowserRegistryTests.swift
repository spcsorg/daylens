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

  func testResolutionCost() throws {
    let registry = BrowserRegistry()
    let url = try bundle(["notes"])
    defer { try? FileManager.default.removeItem(at: url) }
    for _ in 0..<100 { _ = registry.isRegisteredBrowser(bundleURL: url, bundleId: "com.example.notes") }
    var samples: [Double] = []
    var cpuBefore = rusage(), cpuAfter = rusage()
    getrusage(RUSAGE_SELF, &cpuBefore)
    for _ in 0..<1000 {
      let start = DispatchTime.now().uptimeNanoseconds
      XCTAssertFalse(registry.isRegisteredBrowser(bundleURL: url, bundleId: "com.example.notes"))
      samples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
    }
    getrusage(RUSAGE_SELF, &cpuAfter)
    let cpuMs = Double(cpuAfter.ru_utime.tv_sec - cpuBefore.ru_utime.tv_sec + cpuAfter.ru_stime.tv_sec - cpuBefore.ru_stime.tv_sec) * 1000
      + Double(cpuAfter.ru_utime.tv_usec - cpuBefore.ru_utime.tv_usec + cpuAfter.ru_stime.tv_usec - cpuBefore.ru_stime.tv_usec) / 1000
    samples.sort()
    print("BrowserRegistry n=1000 mean=\(samples.reduce(0, +) / 1000)ms p95=\(samples[950])ms p99=\(samples[990])ms max=\(samples[999])ms CPU=\(cpuMs / 1000)ms/resolution")
  }

}
