/// The display and lock state last reported, so a periodic read reports only a change: a notice can be missed while
/// the machine stays awake, and a state that could not be read is read again until it can be.
public final class StateWatch {
  public private(set) var display: String?
  public private(set) var lock: String?

  public init() {}

  /// A read of the display ("display_on" or "display_off", nil when it cannot be read): the state to report, or nil.
  /// A read that fails is reported once as "display_unknown", so the service stops recording until one succeeds.
  public func readDisplay(_ state: String?) -> String? {
    let read = state ?? "display_unknown"
    if read == display { return nil }
    display = read
    return read
  }

  public func noteDisplay(_ state: String) { display = state }

  /// A read of the lock ("locked", "unlocked" or "unknown"): the state to report, or nil.
  public func readLock(_ state: String) -> String? {
    if state == lock { return nil }
    lock = state
    return state
  }

  public func noteLock(_ state: String) { lock = state }
}
