import Foundation

/// A bounded FIFO between a producer and one worker. Drops are recorded with their time range so they can be
/// reported (they happen before any line exists, so no seq shows them), and at most one drain is ever scheduled.
public final class RequestQueue<T> {
  public struct Loss: Equatable {
    public var count: Int
    public var fromWallMs: Int64
    public var toWallMs: Int64
  }

  private let lock = NSLock()
  private var items: [(item: T, wallMs: Int64)] = []
  private var head = 0
  private let capacity: Int
  private var drainScheduled = false
  private var loss: Loss?

  public init(capacity: Int) { self.capacity = capacity }

  public var count: Int { lock.lock(); defer { lock.unlock() }; return items.count - head }

  /// Returns true when the caller must schedule a drain; false when one is already pending.
  public func push(_ item: T, wallMs: Int64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if items.count - head >= capacity {
      record(items[head].wallMs)
      head += 1
    }
    items.append((item, wallMs))
    compact()
    if drainScheduled { return false }
    drainScheduled = true
    return true
  }

  /// The next item, or nil when empty, which also clears the pending-drain mark.
  public func pop() -> T? {
    lock.lock()
    defer { lock.unlock() }
    guard head < items.count else {
      drainScheduled = false
      return nil
    }
    let item = items[head].item
    head += 1
    compact()
    return item
  }

  /// Everything still queued is abandoned and counted as lost.
  public func clear() {
    lock.lock()
    defer { lock.unlock() }
    for i in head..<items.count { record(items[i].wallMs) }
    items.removeAll(keepingCapacity: true)
    head = 0
  }

  public func takeLoss() -> Loss? {
    lock.lock()
    defer { lock.unlock() }
    let l = loss
    loss = nil
    return l
  }

  private func record(_ wallMs: Int64) {
    if var l = loss {
      l.count += 1
      l.fromWallMs = min(l.fromWallMs, wallMs)
      l.toWallMs = max(l.toWallMs, wallMs)
      loss = l
    } else {
      loss = Loss(count: 1, fromWallMs: wallMs, toWallMs: wallMs)
    }
  }

  private func compact() {
    if head > 64 && head * 2 > items.count {
      items.removeFirst(head)
      head = 0
    }
  }
}
