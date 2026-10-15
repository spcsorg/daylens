import Foundation

/// Assigns sequence numbers and writes lines through a bounded queue on a dedicated thread,
/// so a stalled reader can never block capture. Drops are counted and show up as seq jumps.
public final class Emitter {
  public enum Priority { case normal, critical }

  private let lock = NSLock()
  private let queue = DispatchQueue(label: "daylens.capture.writer", qos: .utility)
  private let write: (String) -> Void
  private let capacity: Int
  private let reserve: Int
  private var seq: Int64 = 0
  private var queued = 0
  private var _dropped: Int64 = 0
  public let run: String
  public let boot: String
  public let platform: String

  public init(run: String, boot: String, platform: String, capacity: Int = 1024, reserve: Int = 64, write: @escaping (String) -> Void) {
    self.run = run; self.boot = boot; self.platform = platform
    self.capacity = capacity; self.reserve = reserve; self.write = write
  }

  public var dropped: Int64 { lock.lock(); defer { lock.unlock() }; return _dropped }

  public func emit(kind: String, source: String, time: EventTime, obs: JSON, priority: Priority) {
    lock.lock()
    let s = seq
    seq += 1
    let limit = priority == .critical ? capacity + reserve : capacity
    if queued >= limit {
      _dropped += 1
      lock.unlock()
      return
    }
    queued += 1
    lock.unlock()
    let line = envelope(run: run, seq: s, boot: boot, time: time, platform: platform, source: source, kind: kind, obs: obs).serialized() + "\n"
    queue.async {
      self.write(line)
      self.lock.lock()
      self.queued -= 1
      self.lock.unlock()
    }
  }

  public func flush() { queue.sync {} }
}
