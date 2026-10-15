import Foundation

/// Decides when to look at idle time next. There is no OS event for "became idle", so the helper
/// checks once at the moment idleness could first be reached, and briefly while already idle.
public struct IdleScheduler {
  public let thresholdS: Double
  public let idlePollS: Double
  public private(set) var idle: Bool? = nil

  public init(thresholdS: Double, idlePollS: Double = 2) {
    self.thresholdS = thresholdS
    self.idlePollS = idlePollS
  }

  public struct Decision: Equatable {
    public var emit: Bool?
    public var nextCheckS: Double
  }

  public mutating func evaluate(secondsSinceInput: Double) -> Decision {
    let nowIdle = secondsSinceInput >= thresholdS
    let changed = idle != nowIdle
    idle = nowIdle
    let next = nowIdle ? idlePollS : max(0.5, thresholdS - secondsSinceInput + 0.25)
    return Decision(emit: changed ? nowIdle : nil, nextCheckS: next)
  }

  public mutating func reset() { idle = nil }
}
