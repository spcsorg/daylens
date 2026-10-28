// The MCP server's own connection for what it must write: the read log, and an assistant's requests to change something. It
// runs in the assistant's process, whether or not capture is running, so it opens the database itself, never migrates
// it, and keeps every transaction short. A write a pending deletion would cover is refused, as storage refuses it.
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileRequest, recentRequests, request, settleRequest, type AssistantRequest, type RequestChange } from '../storage/assistantRequests.ts'
import { ChangeBus } from '../storage/changes.ts'
import { fencedBy, pendingTombstones } from '../storage/rules.ts'
import { pendingVerdict, sourceMatches, type HourSource } from '../storage/hours.ts'
import { PendingDeletionError, type AssistantRead } from '../storage/index.ts'
import { checkSchema } from './reader.ts'

// How long a write waits for capture or the deletion worker to release the database, as the deletion worker waits.
const BUSY_TIMEOUT_MS = 5000

export class AssistantStore {
  readonly db: Database.Database
  private readonly now: () => number
  // Announces a filed request to the app the way storage announces its own changes.
  private readonly bus: ChangeBus

  constructor(db: Database.Database, now: () => number = Date.now) {
    this.db = db
    this.now = now
    this.bus = new ChangeBus(db, path.dirname(db.name), now)
  }

  static open(file: string, now?: () => number): AssistantStore {
    const db = new Database(file, { fileMustExist: true })
    try {
      checkSchema(db)
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
      db.pragma('foreign_keys = ON')
      db.pragma('secure_delete = ON')
    } catch (err) {
      db.close()
      throw err
    }
    return new AssistantStore(db, now)
  }

  close(): void {
    this.db.close()
  }

  /**
   * The same entry Storage.recordAssistantRead writes, for a read made after the deletion `mark` (Reader.deletionMark).
   * Refused when a deletion under way covers what was read, or when any deletion began since the read: one that also
   * finished in between is no longer pending, and the read may hold what it removed. One transaction, so the entry is
   * seen whole or not at all, by readers, by a deletion's planning and after a crash. It holds a row per hour, app and
   * site the read showed: about 3 microseconds each, so a read showing 5,000 commits in about 15 ms.
   */
  recordRead(r: AssistantRead, mark: number): number {
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM deletions WHERE id > ?').get(mark)) throw new PendingDeletionError('a deletion began while this was read; nothing was returned, try again')
      this.refuseFenced(r.hours ?? [], r.sources ?? [], r)
      const id = Number(
        this.db
          .prepare('INSERT INTO assistant_reads (assistant, at_wall_ms, tool, from_wall_ms, to_wall_ms, query) VALUES (?, ?, ?, ?, ?, ?)')
          .run(r.assistant, this.now(), r.tool, r.from_wall_ms, r.to_wall_ms, r.query ?? null).lastInsertRowid,
      )
      const item = this.db.prepare('INSERT INTO assistant_read_items (read_id, hour_id, app_id, site) VALUES (?, ?, ?, ?)')
      for (const h of r.hours ?? []) item.run(id, h, null, null)
      for (const s of r.sources ?? []) item.run(id, null, s.app_id?.toLowerCase() ?? null, s.site?.toLowerCase().replace(/^www\./, '') ?? null)
      return id
    }).immediate()
  }

  /** Files a request for the app to carry out, or to ask the person about. */
  fileRequest(assistant: string, change: RequestChange): number {
    return fileRequest(this.db, this.bus, assistant, change, this.now())
  }

  request(id: number): AssistantRequest | null {
    return request(this.db, id)
  }

  /** Expires a request still pending; false when the app has already taken it up. */
  expireRequest(id: number): boolean {
    return settleRequest(this.db, this.bus, id, 'expired', null, this.now())
  }

  recentRequests(): AssistantRequest[] {
    return recentRequests(this.db, this.now())
  }

  private refuseFenced(hourIds: readonly number[], sources: readonly HourSource[], span: { from_wall_ms: number; to_wall_ms: number }): void {
    const pending = pendingTombstones(this.db)
    if (pending.length === 0) return
    const hour = this.db.prepare('SELECT start_wall_ms, end_wall_ms, sources FROM hours WHERE id = ?')
    for (const id of hourIds) {
      if (fencedBy(this.db, 'hour', id).length > 0) throw new PendingDeletionError('this hour is being deleted')
      const h = hour.get(id) as { start_wall_ms: number; end_wall_ms: number; sources: string } | undefined
      if (h && pendingVerdict({ ...h, sources: JSON.parse(h.sources) as HourSource[] }, pending).verdict !== null) throw new PendingDeletionError('this hour is being deleted')
    }
    for (const t of pending) {
      const overlaps = (t.to_wall_ms === null || span.from_wall_ms < t.to_wall_ms) && (t.from_wall_ms === null || span.to_wall_ms > t.from_wall_ms)
      if (!overlaps) continue
      if (t.kind === 'range') throw new PendingDeletionError('this span is being deleted')
      if (sources.some((src) => sourceMatches(t, src))) throw new PendingDeletionError('this app or site is being deleted')
    }
  }
}
