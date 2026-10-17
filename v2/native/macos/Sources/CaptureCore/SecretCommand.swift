/// `--secret get|set|delete <name>`: the capture service keeps browser pairing keys in secure storage through this.
/// The secret itself only ever crosses stdin and stdout.
public struct SecretCommand: Equatable {
  public enum Op: String { case get, set, delete }
  public let op: Op
  public let name: String

  /// Exit status when the item does not exist.
  public static let notFound: Int32 = 2
  public static let service = "app.daylens.browser.pairing"

  public static func parse(_ args: [String]) -> SecretCommand? {
    guard let i = args.firstIndex(of: "--secret"), i + 2 < args.count, let op = Op(rawValue: args[i + 1]) else { return nil }
    let name = args[i + 2]
    guard name.utf8.count == 22, name.utf8.allSatisfy({ c in
      (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x2D || c == 0x5F
    }) else { return nil }
    return SecretCommand(op: op, name: name)
  }
}
