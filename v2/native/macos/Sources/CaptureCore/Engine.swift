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
