import Foundation

/// Ordered JSON value; key order is kept so lines are stable and cheap to build.
public indirect enum JSON: Equatable {
  case string(String)
  case int(Int64)
  case bool(Bool)
  case null
  case object([(String, JSON)])

  public static func == (a: JSON, b: JSON) -> Bool {
    switch (a, b) {
    case let (.string(x), .string(y)): return x == y
    case let (.int(x), .int(y)): return x == y
    case let (.bool(x), .bool(y)): return x == y
    case (.null, .null): return true
    case let (.object(x), .object(y)):
      return x.count == y.count && zip(x, y).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
    default: return false
    }
  }

  public static func str(_ s: String?) -> JSON { s.map(JSON.string) ?? .null }
  public static func int(_ v: Int?) -> JSON { v.map { .int(Int64($0)) } ?? .null }

  public func serialized() -> String {
    var out = ""
    out.reserveCapacity(256)
    write(into: &out)
    return out
  }

  func write(into out: inout String) {
    switch self {
    case .string(let s): JSON.writeString(s, into: &out)
    case .int(let v): out += String(v)
    case .bool(let b): out += b ? "true" : "false"
    case .null: out += "null"
    case .object(let pairs):
      out += "{"
      for (i, (k, v)) in pairs.enumerated() {
        if i > 0 { out += "," }
        JSON.writeString(k, into: &out)
        out += ":"
        v.write(into: &out)
      }
      out += "}"
    }
  }

  static func writeString(_ s: String, into out: inout String) {
    out += "\""
    for u in s.unicodeScalars {
      switch u {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      case _ where u.value < 0x20 || u.value == 0x2028 || u.value == 0x2029:
        out += String(format: "\\u%04x", u.value)
      default: out.unicodeScalars.append(u)
      }
    }
    out += "\""
  }
}
