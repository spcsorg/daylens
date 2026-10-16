import Foundation

/// Decides when to look at idle time next. There is no OS event for "became idle", so the helper
/// checks once at the moment idleness could first be reached, and briefly while already idle.
public struct IdleScheduler {
  public let thresholdS: Double
  public let idlePollS: Double
  public private(set) var idle: Bool? = nil
  /// Set at a resume; cleared by the first input after it. A short sleep never crosses the idle threshold,
  /// so without this the user coming back would produce no line at all.
  public private(set) var resumeBoundaryMs: Int64? = nil
  /// Waking the machine can itself count as input at the boundary; only input clearly after it is a return.
  public static let returnMarginMs: Int64 = 2000

  public init(thresholdS: Double, idlePollS: Double = 2) {
    self.thresholdS = thresholdS
    self.idlePollS = idlePollS
  }

  public struct Decision: Equatable {
    public var emit: Bool?
    public var nextCheckS: Double
    /// Input arrived after the last resume: report it even if the idle state did not change.
    public var returned: Bool = false
  }

  public mutating func evaluate(secondsSinceInput: Double, nowWallMs: Int64 = 0) -> Decision {
    let nowIdle = secondsSinceInput >= thresholdS
    let changed = idle != nowIdle
    idle = nowIdle
    var next = nowIdle ? idlePollS : max(0.5, thresholdS - secondsSinceInput + 0.25)
    var returned = false
    if let boundary = resumeBoundaryMs {
      if nowWallMs - Int64(secondsSinceInput * 1000) > boundary + IdleScheduler.returnMarginMs {
        returned = true
        resumeBoundaryMs = nil
      } else {
        next = min(next, idlePollS)
      }
    }
    return Decision(emit: changed ? nowIdle : nil, nextCheckS: next, returned: returned)
  }

  public mutating func reset() { idle = nil }

  public mutating func markResume(wallMs: Int64) { resumeBoundaryMs = wallMs }
}
