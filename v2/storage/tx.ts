// Write transactions that take the writer lock first (BEGIN IMMEDIATE). A deferred transaction that reads before
// writing fails with SQLITE_BUSY_SNAPSHOT if another connection commits in between, which waiting cannot fix.
import type Database from 'better-sqlite3'

// Only another connection's lock clears by waiting; SQLITE_LOCKED comes from this connection itself, so it is a failure.
const BUSY = new Set(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_RECOVERY', 'SQLITE_BUSY_TIMEOUT'])

export function isBusy(err: unknown): boolean {
  return BUSY.has((err as { code?: string })?.code ?? '')
}

/** One immediate transaction; busy errors are thrown for the caller to retry. */
export function immediate<T>(db: Database.Database, fn: () => T): T {
  return db.transaction(fn).immediate()
}

const parked = new Int32Array(new SharedArrayBuffer(4))
let beforeWrite: () => void = () => {}

let afterWrite: () => void = () => {}

/** Called before every retrying write transaction: the deletion worker waits there while capture wants the lock. */
export function setBeforeWrite(fn: () => void): void {
  beforeWrite = fn
}

/** Called after every retrying write transaction commits: the deletion worker's sign of progress. */
export function setAfterWrite(fn: () => void): void {
  afterWrite = fn
}

/**
 * For the deletion worker, which may block: retries the whole transaction while another connection holds the lock,
 * waiting a little longer each time (up to a second between tries). Any other error is thrown.
 */
export function immediateRetrying<T>(db: Database.Database, fn: () => T): T {
  for (let wait = 10; ; wait = Math.min(wait * 2, 1000)) {
    beforeWrite()
    try {
      const out = immediate(db, fn)
      afterWrite()
      return out
    } catch (err) {
      if (!isBusy(err)) throw err
      Atomics.wait(parked, 0, 0, wait)
    }
  }
}
