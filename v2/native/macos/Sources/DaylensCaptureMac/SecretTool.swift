// --secret get|set|delete <name>: a generic password in the login Keychain, readable only by this signed binary
// without a prompt. Captures nothing.

import CaptureCore
import Foundation
import Security

enum SecretTool {
  static func runIfAsked() {
    guard CommandLine.arguments.contains("--secret") else { return }
    guard let cmd = SecretCommand.parse(CommandLine.arguments) else { exit(64) }
    let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: SecretCommand.service, kSecAttrAccount as String: cmd.name]
    switch cmd.op {
    case .set:
      guard let line = readLine(strippingNewline: true), !line.isEmpty, let data = line.data(using: .utf8) else { exit(65) }
      SecItemDelete(base as CFDictionary)
      var add = base
      add[kSecValueData as String] = data
      add[kSecAttrLabel as String] = "Daylens browser connection"
      exit(SecItemAdd(add as CFDictionary, nil) == errSecSuccess ? 0 : 1)
    case .get:
      var q = base
      q[kSecReturnData as String] = true
      q[kSecMatchLimit as String] = kSecMatchLimitOne
      var out: CFTypeRef?
      let status = SecItemCopyMatching(q as CFDictionary, &out)
      if status == errSecItemNotFound { exit(SecretCommand.notFound) }
      guard status == errSecSuccess, let data = out as? Data, let s = String(data: data, encoding: .utf8) else { exit(1) }
      FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
      exit(0)
    case .delete:
      let status = SecItemDelete(base as CFDictionary)
      exit(status == errSecSuccess ? 0 : status == errSecItemNotFound ? SecretCommand.notFound : 1)
    }
  }
}
