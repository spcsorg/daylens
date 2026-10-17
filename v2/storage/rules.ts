// What may be stored and derived: pauses, deletions (tombstones), exclusions and retention. One copy of these rules
// serves capture, import, derivation and the deletion worker, each loading them from the database.
import type Database from 'better-sqlite3'
import type { ExclusionRule } from '../capture/defaults.ts'
import { Privacy, type ObservationRow } from '../capture/normalize.ts'
import { siteOf, type ObsRow } from './derive.ts'

export const DAY_MS = 86_400_000

export interface Tombstone {
  id: number
  kind: 'range' | 'source' | 'site'
  from_wall_ms: number | null
  to_wall_ms: number | null
  app_id: string | null
  site: string | null
  // pending: in force for admission, material still being removed; done: removed; purged: also gone from disk.
  state: 'pending' | 'done' | 'purged'
}

export interface PauseState {
  id: number
  since_wall_ms: number
  // null: until resumed.
  until_wall_ms: number | null
  // Set once the pause is over; while null the pause is active.
  ended_wall_ms: number | null
  gap_id: number | null
}

/** Where a pause stops refusing material: when it ended, else when it was set to end, else never. */
export function pauseEnd(p: PauseState): number {
  return p.ended_wall_ms ?? p.until_wall_ms ?? Number.POSITIVE_INFINITY
}

export function matchesSite(site: string | null, tombSite: string): boolean {
  return site !== null && (site === tombSite || site.endsWith(`.${tombSite}`))
}

export function tombstoneMatches(t: Pick<Tombstone, 'kind' | 'app_id' | 'site'>, appId: string | null, url: string | null): boolean {
  if (t.kind === 'range') return true
  if (t.kind === 'source') return appId !== null && appId.toLowerCase() === t.app_id
  return matchesSite(siteOf(url), t.site!)
}

export function pendingTombstones(db: Database.Database): Tombstone[] {
  return db.prepare(`SELECT id, kind, from_wall_ms, to_wall_ms, lower(app_id) AS app_id, lower(site) AS site, state FROM deletions WHERE state = 'pending'`).all() as Tombstone[]
}

/**
 * SQL that keeps a search entry (alias `d`) only if no pending deletion covers it: while a deletion is still being
 * carried out, what it covers is already hidden. Applied inside the query, so LIMIT counts only visible entries.
 */
export function searchFence(pending: readonly Tombstone[]): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  const hourSource = (cond: string) => `EXISTS (SELECT 1 FROM hours h, json_each(h.sources) j WHERE h.id = d.hour_id AND ${cond})`
  for (const t of pending) {
    const overlap = 'd.last_wall_ms >= ? AND d.first_wall_ms < ?'
    const span = [t.from_wall_ms ?? Number.MIN_SAFE_INTEGER, t.to_wall_ms ?? Number.MAX_SAFE_INTEGER]
    if (t.kind === 'range') {
      parts.push(`NOT (${overlap})`)
      params.push(...span)
    } else if (t.kind === 'source') {
      parts.push(`NOT (${overlap} AND ((d.kind = 'activity' AND lower(d.app_id) = ?) OR (d.kind = 'hour' AND ${hourSource(`lower(json_extract(j.value, '$.app_id')) = ?`)})))`)
      params.push(...span, t.app_id, t.app_id)
    } else {
      const site = `lower(json_extract(j.value, '$.site'))`
      parts.push(
        `NOT (${overlap} AND ((d.kind = 'activity' AND (d.site = ? OR d.site LIKE '%.' || ?)) OR (d.kind = 'hour' AND ${hourSource(`(${site} = ? OR ${site} LIKE '%.' || ?)`)})))`,
      )
      params.push(...span, t.site, t.site, t.site, t.site)
    }
  }
  return { sql: parts.length ? parts.join(' AND ') : '1', params }
}

export class Rules {
  tombstones: Tombstone[] = []
  pauses: PauseState[] = []
  retentionDays: number | null = null
  privacy: Privacy = new Privacy([])
  private readonly db: Database.Database
  private readonly now: () => number

  constructor(db: Database.Database, now: () => number) {
    this.db = db
    this.now = now
    this.load()
  }

  load(): void {
    this.loadTombstones()
    this.loadPauses()
    this.loadExclusions()
    const r = this.db.prepare(`SELECT value FROM settings WHERE key = 'retention_days'`).get() as { value: string } | undefined
    this.retentionDays = r ? (JSON.parse(r.value) as number | null) : null
  }

  loadTombstones(): void {
    this.tombstones = (this.db.prepare('SELECT id, kind, from_wall_ms, to_wall_ms, app_id, site, state FROM deletions ORDER BY id').all() as Tombstone[]).map((t) => ({
      ...t,
      app_id: t.app_id?.toLowerCase() ?? null,
      site: t.site?.toLowerCase() ?? null,
    }))
  }

  loadPauses(): void {
    this.pauses = this.db.prepare('SELECT id, since_wall_ms, until_wall_ms, ended_wall_ms, gap_id FROM pauses ORDER BY id').all() as PauseState[]
  }

  loadExclusions(): void {
    this.privacy = new Privacy(this.db.prepare('SELECT match, value, label FROM exclusions ORDER BY id').all() as ExclusionRule[])
  }

  /** Paused, past retention, or deleted material is never written. */
  accepts(eventWallMs: number, appId: string | null, url: string | null): boolean {
    for (const p of this.pauses) if (eventWallMs >= p.since_wall_ms && eventWallMs < pauseEnd(p)) return false
    if (this.retentionDays !== null && eventWallMs < this.now() - this.retentionDays * DAY_MS) return false
    for (const t of this.tombstones) {
      const inRange = (t.from_wall_ms === null || eventWallMs >= t.from_wall_ms) && (t.to_wall_ms === null || eventWallMs < t.to_wall_ms)
      if (inRange && tombstoneMatches(t, appId, url)) return false
    }
    return true
  }

  excluded(row: ObservationRow): boolean {
    if (row.kind !== 'focus') return false
    let aumid: string | null = null
    if (row.detail?.includes('"aumid"')) {
      try {
        aumid = (JSON.parse(row.detail) as { store?: { aumid?: string } }).store?.aumid ?? null
      } catch {
        aumid = null
      }
    }
    return this.privacy.excludes(row.app_id, row.app_path, aumid)
  }

  /** Whether a row seen at fromWallMs may be taken to cover (from, to]: no pause or deletion for it falls in between. */
  mayCover(appId: string | null, url: string | null, fromWallMs: number, toWallMs: number): boolean {
    const overlaps = (s: number, e: number) => s <= toWallMs && e > fromWallMs
    for (const p of this.pauses) if (overlaps(p.since_wall_ms, pauseEnd(p))) return false
    for (const t of this.tombstones) {
      if (overlaps(t.from_wall_ms ?? Number.NEGATIVE_INFINITY, t.to_wall_ms ?? Number.POSITIVE_INFINITY) && tombstoneMatches(t, appId, url)) return false
    }
    return true
  }

  /** Derivation: where a row's interval must stop short (a pause or a deletion that applies to it begins). */
  cut(s: number, e: number, row: ObsRow): number {
    for (const p of this.pauses) if (p.since_wall_ms > s && p.since_wall_ms < e) e = p.since_wall_ms
    for (const t of this.tombstones) {
      if (t.from_wall_ms === null || t.from_wall_ms <= s || t.from_wall_ms >= e) continue
      if (tombstoneMatches(t, row.app_id, row.url)) e = t.from_wall_ms
    }
    return e
  }
}
