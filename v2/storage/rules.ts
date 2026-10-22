// What may be stored and derived: pauses, deletions (tombstones), exclusions and retention. One copy of these rules
// serves capture, import, derivation and the deletion worker, each loading them from the database.
import type Database from 'better-sqlite3'
import { addressHost } from '../capture/address.ts'
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
  // Lowercased; null when the pause covers everything.
  app_id: string | null
}

/** Where a pause stops refusing material: when it ended, else when it was set to end, else never. */
export function pauseCovers(p: Pick<PauseState, 'app_id'>, appId: string | null): boolean {
  return p.app_id === null || (appId !== null && appId.toLowerCase() === p.app_id)
}

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

/** The pending deletions that fenced this hour, thread or read when they were planned. */
export function fencedBy(db: Database.Database, kind: 'hour' | 'thread' | 'read', ref: number): Tombstone[] {
  return db
    .prepare(
      `SELECT d.id, d.kind, d.from_wall_ms, d.to_wall_ms, lower(d.app_id) AS app_id, lower(d.site) AS site, d.state
       FROM deletion_fence f JOIN deletions d ON d.id = f.tombstone_id WHERE f.kind = ? AND f.ref = ? AND d.state = 'pending'`,
    )
    .all(kind, ref) as Tombstone[]
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
  for (const t of pending) {
    const overlap = 'd.last_wall_ms >= ? AND d.first_wall_ms < ?'
    const span = [t.from_wall_ms ?? Number.MIN_SAFE_INTEGER, t.to_wall_ms ?? Number.MAX_SAFE_INTEGER]
    if (t.kind === 'range') {
      parts.push(`NOT (${overlap})`)
      params.push(...span)
    } else if (t.kind === 'source') {
      parts.push(`NOT (${overlap} AND d.kind = 'activity' AND lower(d.app_id) = ?)`)
      params.push(...span, t.app_id)
    } else {
      parts.push(`NOT (${overlap} AND d.kind = 'activity' AND (d.site = ? OR d.site LIKE '%.' || ?))`)
      params.push(...span, t.site, t.site)
    }
    // Hours this deletion fenced when it was planned, whatever their text or sources say now.
    parts.push(`NOT (d.kind = 'hour' AND d.hour_id IN (SELECT ref FROM deletion_fence WHERE tombstone_id = ? AND kind = 'hour'))`)
    params.push(t.id)
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
    this.pauses = (this.db.prepare('SELECT id, since_wall_ms, until_wall_ms, ended_wall_ms, gap_id, app_id FROM pauses ORDER BY id').all() as PauseState[]).map((p) => ({
      ...p,
      app_id: p.app_id?.toLowerCase() ?? null,
    }))
  }

  // Rules no longer in force, with when they were.
  pastExclusions: { rule: ExclusionRule; privacy: Privacy; from: number; to: number }[] = []

  loadExclusions(): void {
    this.privacy = new Privacy(this.db.prepare('SELECT match, value, label FROM exclusions ORDER BY id').all() as ExclusionRule[])
    const past = this.db.prepare(`SELECT match, value, from_wall_ms AS f, to_wall_ms AS t FROM exclusion_periods WHERE to_wall_ms IS NOT NULL`).all() as { match: ExclusionRule['match']; value: string; f: number; t: number }[]
    this.pastExclusions = past.map((p) => {
      const rule: ExclusionRule = { match: p.match, value: p.value, label: p.value }
      return { rule, privacy: new Privacy([rule]), from: p.f, to: p.t }
    })
  }

  /** The rules no longer in force that were at a time. */
  exclusionsAt(wallMs: number): { rule: ExclusionRule; privacy: Privacy }[] {
    return this.pastExclusions.filter((p) => wallMs >= p.from && wallMs < p.to)
  }

  /** Paused, past retention, or deleted material is never written. */
  accepts(eventWallMs: number, appId: string | null, url: string | null): boolean {
    for (const p of this.pauses) if (eventWallMs >= p.since_wall_ms && eventWallMs < pauseEnd(p) && pauseCovers(p, appId)) return false
    if (this.retentionDays !== null && eventWallMs < this.now() - this.retentionDays * DAY_MS) return false
    for (const t of this.tombstones) {
      const inRange = (t.from_wall_ms === null || eventWallMs >= t.from_wall_ms) && (t.to_wall_ms === null || eventWallMs < t.to_wall_ms)
      if (inRange && tombstoneMatches(t, appId, url)) return false
    }
    return true
  }

  /** A row of an excluded app, or a page on an excluded site (and its subdomains). */
  excluded(row: ObservationRow & { url?: string | null }): boolean {
    if (row.kind !== 'focus' && row.kind !== 'page') return false
    if (row.url && this.privacy.siteExcluded(addressHost(row.url))) return true
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
    for (const p of this.pauses) if (overlaps(p.since_wall_ms, pauseEnd(p)) && pauseCovers(p, appId)) return false
    for (const t of this.tombstones) {
      if (overlaps(t.from_wall_ms ?? Number.NEGATIVE_INFINITY, t.to_wall_ms ?? Number.POSITIVE_INFINITY) && tombstoneMatches(t, appId, url)) return false
    }
    return true
  }

  /** Derivation: where a row's interval must stop short (a pause or a deletion that applies to it begins). */
  cut(s: number, e: number, row: ObsRow): number {
    for (const p of this.pauses) if (p.since_wall_ms > s && p.since_wall_ms < e && pauseCovers(p, row.app_id)) e = p.since_wall_ms
    for (const t of this.tombstones) {
      if (t.from_wall_ms === null || t.from_wall_ms <= s || t.from_wall_ms >= e) continue
      if (tombstoneMatches(t, row.app_id, row.url)) e = t.from_wall_ms
    }
    return e
  }
}
