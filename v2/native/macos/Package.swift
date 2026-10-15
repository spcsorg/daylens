// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DaylensCaptureMac",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "daylens-capture-macos", targets: ["DaylensCaptureMac"]),
  ],
  targets: [
    .target(name: "CaptureCore"),
    .executableTarget(
      name: "DaylensCaptureMac",
      dependencies: ["CaptureCore"],
      swiftSettings: [.unsafeFlags(["-Osize"], .when(configuration: .release))]
    ),
    .testTarget(name: "CaptureCoreTests", dependencies: ["CaptureCore"]),
  ],
  swiftLanguageModes: [.v5]
)
