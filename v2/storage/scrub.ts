// Zeroes deleted text that SQLite leaves inside b-tree pages. secure_delete zeroes a removed cell, but rebalancing
// rebuilds a page without clearing the space between its cell pointers and its cells, so copies of cells that moved
// to a sibling stay there; those copies outlive the rows' deletion. Writing pages goes through sqlite_dbpage inside an
// ordinary write transaction, so it is logged, atomic and visible to other connections like any other change.
import type Database from 'better-sqlite3'

export class ScrubUnavailableError extends Error {
  constructor(code: ScrubBlock = 'scrub_unavailable') {
    super(code)
  }
}

export type ScrubBlock = 'scrub_unavailable' | 'scrub_auto_vacuum' | 'scrub_file_too_large'

// A page's role is taken from the b-tree graph when the scrub starts. A page that later stops being a b-tree page
// becomes a freelist page (zeroed by secure_delete, or a trunk) or an overflow page, which start with a page number;
// below 2^24 pages that number's first byte is 0, never a b-tree type, so the type byte rules such a page out.
const MAX_PAGES = 2 ** 24

/**
 * Why this connection cannot scrub, or null: a SQLite without sqlite_dbpage (tools/buildSqlite.ts); a file with
 * auto_vacuum, whose pointer-map pages can start with a b-tree type byte; or one too large for the rule above.
 */
export function scrubBlocked(db: Database.Database): ScrubBlock | null {
  try {
    db.prepare('SELECT 1 FROM sqlite_dbpage WHERE pgno = 1').get()
  } catch {
    return 'scrub_unavailable'
  }
  if ((db.pragma('auto_vacuum', { simple: true }) as number) !== 0) return 'scrub_auto_vacuum'
  if ((db.pragma('page_count', { simple: true }) as number) >= MAX_PAGES) return 'scrub_file_too_large'
  return null
}

/** Outside any write transaction: which pages the file's b-trees reach (table and index pages, not overflow). */
export function btreePages(db: Database.Database): Uint8Array {
  const count = db.pragma('page_count', { simple: true }) as number
  const out = new Uint8Array(count + 1)
  for (const [pgno] of db.prepare(`SELECT pageno FROM dbstat WHERE aggregate = 0 AND pagetype IN ('internal', 'leaf')`).raw().iterate() as Iterable<[number]>) {
    if (pgno <= count) out[pgno] = 1
  }
  return out
}

const BTREE_PAGE_TYPES = new Set([0x02, 0x05, 0x0a, 0x0d])
// Pages zeroed per transaction at most. Its commit writes them all to the log with the lock held; on the 338 MB
// benchmark under load, batches of 1,100 to 1,700 pages had commits stall for 280 to 300 ms.
const MAX_BATCH = 400

/**
 * The byte ranges of a b-tree page that hold no cell: the gap between the cell pointer array and the cell content
 * area, and each freeblock's body after its 4-byte header. Fragment bytes (under 4 bytes each) are not located.
 * Null for a page that is not a b-tree page; throws for a b-tree page whose header or freeblock chain is invalid.
 */
export function unallocated(page: Uint8Array, pgno: number, usable: number): [number, number][] | null {
  const hdr = pgno === 1 ? 100 : 0
  const type = page[hdr]!
  if (!BTREE_PAGE_TYPES.has(type)) return null
  const u16 = (at: number) => (page[at]! << 8) | page[at + 1]!
  const cells = u16(hdr + 3)
  const content = u16(hdr + 5) || 65536
  const pointersEnd = hdr + (type === 0x02 || type === 0x05 ? 12 : 8) + 2 * cells
  if (pointersEnd > content || content > usable) throw new Error(`page ${pgno}: invalid header`)
  const ranges: [number, number][] = [[pointersEnd, content]]
  // Freeblocks lie in the content area in ascending order (SQLite's own integrity rule).
  for (let fb = u16(hdr + 1), floor = content; fb !== 0; ) {
    const size = u16(fb + 2)
    if (fb < floor || size < 4 || fb + size > usable) throw new Error(`page ${pgno}: invalid freeblock`)
    ranges.push([fb + 4, fb + size])
    floor = fb + size
    fb = u16(fb)
  }
  return ranges
}

function hasText(page: Uint8Array, ranges: readonly [number, number][] | null): ranges is [number, number][] {
  return ranges !== null && ranges.some(([a, b]) => page.subarray(a, b).some((x) => x !== 0))
}

function usableSize(db: Database.Database, read: Database.Statement): number {
  // Bytes reserved at the end of every page (the database header's byte 20) hold no cells.
  return (db.pragma('page_size', { simple: true }) as number) - (read.get(1) as Buffer)[20]!
}

/**
 * Outside any write transaction: from page `from` on, the b-tree pages (`btree`, from btreePages) whose unallocated
 * space is not all zeros, up to `max` of them. Returns them with the page to continue from (null at the last page).
 */
export function scanPages(db: Database.Database, from: number, max: number, btree: Uint8Array): { pages: number[]; next: number | null } {
  const read = db.prepare('SELECT data FROM sqlite_dbpage WHERE pgno = ?').pluck()
  const usable = usableSize(db, read)
  const count = Math.min(db.pragma('page_count', { simple: true }) as number, btree.length - 1)
  const pages: number[] = []
  for (let pgno = from; pgno <= count; pgno++) {
    if (btree[pgno] !== 1) continue
    const page = read.get(pgno) as Buffer
    if (hasText(page, unallocated(page, pgno, usable))) pages.push(pgno)
    if (pages.length >= max && pgno < count) return { pages, next: pgno + 1 }
  }
  return { pages, next: null }
}

/**
 * Inside the caller's write transaction: zeroes the unallocated space of the given pages, read again here since they
 * may have changed after the scan, until `budgetMs` has passed. Returns how many of the pages it went through.
 */
export function zeroPages(db: Database.Database, pages: readonly number[], budgetMs: number): number {
  // sqlite_dbpage is read-only in defensive mode, which better-sqlite3 turns on; it is off only for these writes.
  db.unsafeMode(true)
  try {
    const start = performance.now()
    const read = db.prepare('SELECT data FROM sqlite_dbpage WHERE pgno = ?').pluck()
    const write = db.prepare('UPDATE sqlite_dbpage SET data = ? WHERE pgno = ?')
    const usable = usableSize(db, read)
    let n = 0
    for (const pgno of pages) {
      const page = read.get(pgno) as Buffer | undefined
      n++
      if (page !== undefined) {
        const ranges = unallocated(page, pgno, usable)
        if (hasText(page, ranges)) {
          const copy = Buffer.from(page)
          for (const [a, b] of ranges) copy.fill(0, a, b)
          write.run(copy, pgno)
        }
      }
      if (performance.now() - start > budgetMs) break
    }
    return n
  } finally {
    db.unsafeMode(false)
  }
}

/**
 * Scrubs every page: a scan outside the lock finds pages that need it, and `transaction` (which retries and yields as
 * the caller requires) zeroes a batch of them. Each batch's size follows how long its whole transaction, commit
 * included, took against `stepMs`; a page written costs about as much again to commit. `onTransaction` reports each
 * transaction's duration and page count (benchmarks and tests).
 */
export function scrubAll(db: Database.Database, stepMs: number, transaction: <T>(fn: () => T) => T, onTransaction: (ms: number, pages: number) => void = () => {}): void {
  const blocked = scrubBlocked(db)
  if (blocked !== null) throw new ScrubUnavailableError(blocked)
  const btree = btreePages(db)
  // An automatic checkpoint would run inside the commit call and be timed as if it held the lock; a passive one
  // between batches keeps the log as short without taking the writer lock.
  const autocheckpoint = db.pragma('wal_autocheckpoint', { simple: true }) as number
  db.pragma('wal_autocheckpoint = 0')
  try {
    let batch = 200
    for (let from: number | null = 1; from !== null; ) {
      const scan = scanPages(db, from, batch, btree)
      for (let i = 0; i < scan.pages.length; ) {
        const todo = scan.pages.slice(i)
        const t = performance.now()
        const n = transaction(() => zeroPages(db, todo, stepMs))
        const ms = performance.now() - t
        onTransaction(ms, n)
        db.pragma('wal_checkpoint(PASSIVE)')
        i += n
        if (ms > stepMs) batch = Math.max(10, Math.floor(batch / 2))
        else if (ms < stepMs / 2) batch = Math.min(MAX_BATCH, Math.ceil(batch * 1.5))
      }
      from = scan.next
    }
  } finally {
    db.pragma(`wal_autocheckpoint = ${autocheckpoint}`)
  }
}
