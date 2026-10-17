import Foundation

public enum Engine: String { case browser, app_runtime, none, unknown }

/// Separates real browsers from apps that merely embed a web engine. Every Electron app ships Chromium,
/// so "has Chromium" is not enough: Electron and CEF apps carry their own markers, and a Chromium browser
/// ships its own renderer helper inside its framework.
public struct BundleListing {
  public var resources: [String]?
  public var frameworks: [String]
  public var geckoBrowserResources: Bool
  public var frameworkHelpers: [String: [String]]
  public init(resources: [String]?, frameworks: [String], geckoBrowserResources: Bool, frameworkHelpers: [String: [String]]) {
    self.resources = resources; self.frameworks = frameworks
    self.geckoBrowserResources = geckoBrowserResources; self.frameworkHelpers = frameworkHelpers
  }
}

public func classifyBundle(_ b: BundleListing?) -> Engine {
  guard let b, let resources = b.resources else { return .unknown }
  if b.geckoBrowserResources { return .browser }
  let electron = b.frameworks.contains("Electron Framework.framework") || resources.contains("app.asar")
    || resources.contains("default_app.asar") || resources.contains("app")
  if electron || b.frameworks.contains("Chromium Embedded Framework.framework") { return .app_runtime }
  for fw in b.frameworks where fw.hasSuffix(".framework") {
    if (b.frameworkHelpers[fw] ?? []).contains(where: { $0.hasSuffix("Helper (Renderer).app") }) { return .browser }
  }
  return .none
}

/// Reads what classifyBundle needs. A folder that is missing is empty; a folder that exists but cannot be
/// read makes the whole scan uncertain (nil), so a partial view can never pass for "no engine".
public func scanBundle(at url: URL, fileManager fm: FileManager = .default) -> BundleListing? {
  enum Read { case entries([String]), absent, failed }
  func read(_ u: URL) -> Read {
    do { return .entries(try fm.contentsOfDirectory(atPath: u.path)) } catch {
      let code = (error as NSError).code
      if (error as NSError).domain == NSCocoaErrorDomain && (code == NSFileReadNoSuchFileError || code == NSFileNoSuchFileError) {
        return .absent
      }
      return .failed
    }
  }
  let contents = url.appendingPathComponent("Contents")
  let res = contents.appendingPathComponent("Resources")
  guard case .entries(let resources) = read(res) else { return nil }
  var gecko = false
  if resources.contains("browser") {
    switch read(res.appendingPathComponent("browser")) {
    case .entries(let b): gecko = b.contains("omni.ja")
    case .absent: break
    case .failed: return nil
    }
  }
  var frameworks: [String] = []
  switch read(contents.appendingPathComponent("Frameworks")) {
  case .entries(let f): frameworks = f
  case .absent: break
  case .failed: return nil
  }
  var helpers: [String: [String]] = [:]
  for fw in frameworks where fw.hasSuffix(".framework") {
    let base = contents.appendingPathComponent("Frameworks").appendingPathComponent(fw)
    var found: [String]? = nil
    for sub in ["Versions/Current/Helpers", "Helpers"] {
      switch read(base.appendingPathComponent(sub)) {
      case .entries(let h): found = h
      case .absent: continue
      case .failed: return nil
      }
      break
    }
    helpers[fw] = found ?? []
  }
  return BundleListing(resources: resources, frameworks: frameworks, geckoBrowserResources: gecko, frameworkHelpers: helpers)
}

/// Engine verdicts, one per running process. Files can change under a launcher that stays the same (a staged
/// update adds a browser library), so a verdict never outlives the process it was made for: each launch scans once.
public final class EngineRegistry {
  private struct Key: Hashable {
    var process: ProcessKey
    var bundle: BundleStamp?
  }

  private let lock = NSLock()
  private var cache: [Key: Engine] = [:]
  private let scan: (URL) -> BundleListing?

  public init(scan: @escaping (URL) -> BundleListing? = { scanBundle(at: $0) }) { self.scan = scan }

  public func engine(bundleURL: URL?, process: ProcessKey?) -> Engine {
    guard let url = bundleURL else { return .unknown }
    let key = process.map { Key(process: $0, bundle: BundleStamp.of(url)) }
    if let key {
      lock.lock()
      if let e = cache[key] { lock.unlock(); return e }
      lock.unlock()
    }
    let e = classifyBundle(scan(url))
    // An uncertain scan, or a lookup with no process to tie it to, is not remembered.
    if e != .unknown, let key {
      lock.lock()
      if cache.count > 512 { cache.removeAll() }
      cache[key] = e
      lock.unlock()
    }
    return e
  }
}
