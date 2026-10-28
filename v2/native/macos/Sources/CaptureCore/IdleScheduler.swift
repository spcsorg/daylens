import Foundation

/// Decides when to look at idle time next. There is no OS event for "became idle", so the helper
/// checks once at the moment idleness could first be reached, and briefly while already idle.
public struct IdleScheduler {
  public let thresholdS: Double
  public let idlePollS: Double
  public private(set) var idle: Bool? = nil
  /// Set at a resume, by the monotonic clock; cleared by the first input after it. A short sleep never crosses the
  /// idle threshold, so without this the user coming back would produce no line at all. A change of the wall clock
  /// does not move input from before the resume to after it.
  public private(set) var resumeBoundaryUs: Int64? = nil

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

  public mutating func evaluate(secondsSinceInput: Double, nowMonoUs: Int64 = 0) -> Decision {
    let nowIdle = secondsSinceInput >= thresholdS
    let changed = idle != nowIdle
    idle = nowIdle
    var next = nowIdle ? idlePollS : max(0.5, thresholdS - secondsSinceInput + 0.25)
    var returned = false
    if let boundary = resumeBoundaryUs {
      // Any input after the resume is the return, however soon after waking it came.
      if nowMonoUs - Int64(secondsSinceInput * 1_000_000) > boundary {
        returned = true
        resumeBoundaryUs = nil
      } else {
        next = min(next, idlePollS)
      }
    }
    return Decision(emit: changed ? nowIdle : nil, nextCheckS: next, returned: returned)
  }

  public mutating func reset() { idle = nil }

  public mutating func markResume(monoUs: Int64) { resumeBoundaryUs = monoUs }
}
