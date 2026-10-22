// Search across every day, grouped the way people remember things: pages, files, windows and hours. Each item is
// listed once, with every hour it was seen in, and says how it opens. Full-text only; no AI.
import { readHour, type HourField } from '../storage/hours.ts'
import { pendingTombstones, searchFence } from '../storage/rules.ts'
import type { Reader } from './reader.ts'

export type OpenAction =
  | { kind: 'url'; url: string }
  // Capture records file names and window titles, not paths, so a file or window opens by bringing its app forward.
  | { kind: 'app'; app_id: string; app_name: string | null }
  | { kind: 'hour'; hour_start_wall_ms: number; hour_id: number | null }

export interface SeenIn {
  hour_start_wall_ms: number
  // The written hour at that time, if there is one.
  hour_id: number | null
}

export interface FoundItem {
  kind: 'page' | 'file' | 'window'
  // Captured text: untrusted, shown as plain text only.
  title: string
  url: string | null
  file: string | null
  app_id: string
  app_name: string | null
  first_wall_ms: number
  last_wall_ms: number
  seen_in: SeenIn[]
  open: OpenAction
}

export interface FoundHour {
  kind: 'hour'
  hour_id: number
  start_wall_ms: number
  end_wall_ms: number
  status: 'facts' | 'written'
  title: string | null
  summary: string | null
  corrected: HourField[]
  open: OpenAction
}

export interface SearchResults {
  pages: FoundItem[]
  files: FoundItem[]
  windows: FoundItem[]
  hours: FoundHour[]
  // The groups that matched more items than they return.
  more: Group[]
  // No entry had every word typed, so these are entries with any of them: looser matches, labelled as such.
  looser: boolean
}

export interface SearchOptions {
  // How many items each group returns. A product decision with no default: the caller states it.
  perGroup: number
  fromWallMs?: number
  toWallMs?: number
  // 'all': every word must appear (the search box), else any word does, as looser matches. 'any': ranked by how many
  // and how rare (Ask's question words).
  match?: 'all' | 'any'
}

/** Words only, quoted, so nothing typed is ever read as query syntax; the last word also matches as a prefix. */
export function ftsQuery(text: string, match: 'all' | 'any' = 'all'): string | null {
  const words = text.normalize('NFC').match(/[\p{L}\p{N}\p{M}]+/gu) ?? []
  if (words.length === 0) return null
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(match === 'all' ? ' ' : ' OR ')
}

export type Group = 'pages' | 'files' | 'windows' | 'hours'

interface Doc {
  kind: 'activity' | 'hour'
  hour_start_wall_ms: number
  app_id: string
  app_name: string | null
  title: string
  url: string
  files: string
  hour_id: number | null
  first_wall_ms: number
  last_wall_ms: number
}

function keyOf(g: Group, d: Pick<Doc, 'hour_id' | 'url' | 'files' | 'app_id' | 'title'>): string {
  return g === 'hours' ? String(d.hour_id) : g === 'pages' ? d.url : g === 'files' ? d.files.toLowerCase() : `${d.app_id.toLowerCase()}\u0000${d.title}`
}

// Which entries each group draws from, as index queries, so a group whose matches are rare is found without reading
// every entry the words match. A file is an entry whose file name has the words; a page, any other entry with an
// address; a window, any other entry. A window has no address, so entries whose address has any of the words (a site
// name typed as the query) are not read for windows. Entries are still checked exactly when read.
const PASSES: readonly { group: Group; match: (q: string, any: string) => string }[] = [
  { group: 'pages', match: (q) => `{title address files} : (${q}) NOT files : (${q})` },
  { group: 'files', match: (q) => `files : (${q})` },
  { group: 'windows', match: (q, any) => `{title files} : (${q}) NOT files : (${q}) NOT address : (${any})` },
  { group: 'hours', match: (q) => `hour_text : (${q})` },
]

const COLUMNS = 'd.kind, d.hour_start_wall_ms, d.app_id, d.app_name, d.title, d.url, d.files, d.hour_id, d.first_wall_ms, d.last_wall_ms'
const GROUPS: readonly Group[] = ['pages', 'files', 'windows', 'hours']
const EMPTY: SearchResults = { pages: [], files: [], windows: [], hours: [], more: [], looser: false }

export function search(reader: Reader, text: string, opts: SearchOptions): SearchResults {
  if (!Number.isInteger(opts.perGroup) || opts.perGroup < 1) throw new RangeError('perGroup must be a positive whole number')
  const match = opts.match ?? 'all'
  const found = searchWith(reader, text, opts, match)
  const nothing = GROUPS.every((g) => found[g].length === 0)
  if (!(match === 'all' && nothing && (text.normalize('NFC').match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).length > 1)) return found
  const looser = searchWith(reader, text, opts, 'any')
  return GROUPS.some((g) => looser[g].length > 0) ? { ...looser, looser: true } : found
}

function searchWith(reader: Reader, text: string, opts: SearchOptions, match: 'all' | 'any'): SearchResults {
  const q = ftsQuery(text, match)
  if (q === null) return EMPTY
  const db = reader.db
  const from = opts.fromWallMs ?? Number.MIN_SAFE_INTEGER
  const to = opts.toWallMs ?? Number.MAX_SAFE_INTEGER
  return db.transaction(() => {
    const fence = searchFence(pendingTombstones(db))
    const where = `d.hour_start_wall_ms >= ? AND d.hour_start_wall_ms < ? AND ${fence.sql}`
    // Each group's matches best first (ties: newest entry first), ranked once and read in growing batches until the
    // group has its items. Ordering by rank scores every match, so it is done once per group, not per batch. Across
    // all time, ranking reads only the index and each batch's entries are read after; within dates, entries outside
    // them are left out before ranking, so a narrow range ranks only its own.
    const read = db.prepare(`SELECT d.id, ${COLUMNS} FROM json_each(?) j CROSS JOIN search_docs d ON d.id = j.value WHERE ${where}`)
    const ranked = db.prepare('SELECT rowid FROM search WHERE search MATCH ? ORDER BY rank, rowid DESC').pluck()
    const rankedIn = db.prepare(`SELECT d.id, ${COLUMNS} FROM search CROSS JOIN search_docs d ON d.id = search.rowid WHERE search MATCH ? AND ${where} ORDER BY search.rank, search.rowid DESC`)
    const dated = opts.fromWallMs !== undefined || opts.toWallMs !== undefined
    const docsOf = (rows: (Doc & { id: number })[]) => new Map(rows.map((d) => [d.id, d]))
    function* batches(match: string): Generator<{ ids: number[]; docs: Map<number, Doc & { id: number }> }> {
      const rows = dated ? (rankedIn.all(match, from, to, ...fence.params) as (Doc & { id: number })[]) : null
      const ids = rows ? rows.map((d) => d.id) : (ranked.all(match) as number[])
      const all = rows ? docsOf(rows) : null
      for (let i = 0, n = 64; i < ids.length; i += n, n *= 2) {
        const slice = ids.slice(i, i + n)
        yield { ids: slice, docs: all ?? docsOf(read.all(JSON.stringify(slice), from, to, ...fence.params) as (Doc & { id: number })[]) }
      }
    }
    const chosen = new Map<Group, Map<string, Doc>>(GROUPS.map((g) => [g, new Map()]))
    // One item past the limit is chosen to learn whether the group has more; it is not read further.
    const full = (g: Group) => chosen.get(g)!.size > opts.perGroup
    const any = ftsQuery(text, 'any')!
    for (const pass of PASSES) {
      if (full(pass.group)) continue
      for (const { ids, docs } of batches(pass.match(q, any))) {
        for (const id of ids) {
          const d = docs.get(id)
          if (!d) continue
          // Pages and windows pass over the same entries: each lands in its own group, if there is room.
          const g: Group = d.kind === 'hour' ? 'hours' : d.url !== '' ? 'pages' : pass.group === 'files' ? 'files' : 'windows'
          if ((g === 'hours') !== (pass.group === 'hours') || full(g)) continue
          const items = chosen.get(g)!
          const k = keyOf(g, d)
          if (!items.has(k)) items.set(k, d)
          if (full(pass.group)) break
        }
        if (full(pass.group)) break
      }
    }

    // Every entry of a chosen item, whether or not it matched the words: the item's title may have changed between
    // sightings. Found through the index by its own text; the query keeps those with the same address or title, and
    // code compares the rest exactly (SQLite's lower() folds only ASCII). CROSS JOIN keeps the index lookup outermost;
    // given the date range, the planner would otherwise walk every entry in range testing each.
    const field = { pages: 'address', files: 'files', windows: 'title' } as const
    const entriesOf = db.prepare(
      `SELECT ${COLUMNS} FROM search CROSS JOIN search_docs d ON d.id = search.rowid
       WHERE search MATCH ? AND d.kind = 'activity' AND (CASE ? WHEN 'pages' THEN d.url = ? WHEN 'files' THEN d.url = '' ELSE d.url = '' AND d.title = ? END) AND ${where}`,
    )
    const entries = (g: Exclude<Group, 'hours'>, first: Doc): Doc[] => {
      const text = g === 'pages' ? first.url : g === 'files' ? first.files : first.title
      // Every address has its scheme and most have www: their index entries are the largest and narrow nothing.
      const words = (text.normalize('NFC').match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).filter((w) => g !== 'pages' || !/^(https?|www)$/i.test(w))
      if (words.length === 0) return [first]
      const phrase = `${field[g]} : (${words.map((w) => `"${w}"`).join(' ')})`
      const key = keyOf(g, first)
      const own = (entriesOf.all(phrase, g, first.url, first.title, from, to, ...fence.params) as Doc[]).filter((d) => keyOf(g, d) === key)
      return own.length > 0 ? own : [first]
    }

    const out: SearchResults = { pages: [], files: [], windows: [], hours: [], more: GROUPS.filter(full), looser: false }
    for (const g of out.more) chosen.get(g)!.delete([...chosen.get(g)!.keys()].at(-1)!)
    const hourIdAt = db.prepare('SELECT id FROM hours WHERE start_wall_ms = ?').pluck()
    for (const g of GROUPS) {
      for (const first of chosen.get(g)!.values()) {
        if (g === 'hours') {
          const h = readHour(db, first.hour_id!)
          if (!h) continue
          out.hours.push({
            kind: 'hour', hour_id: h.id, start_wall_ms: h.start_wall_ms, end_wall_ms: h.end_wall_ms, status: h.status, title: h.title, summary: h.summary, corrected: h.corrected,
            open: { kind: 'hour', hour_start_wall_ms: h.start_wall_ms, hour_id: h.id },
          })
          continue
        }
        const docs = entries(g, first)
        const latest = docs.reduce((a, b) => (b.last_wall_ms > a.last_wall_ms ? b : a))
        const starts = [...new Set(docs.map((d) => d.hour_start_wall_ms))].sort((a, b) => b - a)
        const item = {
          title: latest.title,
          app_id: latest.app_id,
          app_name: latest.app_name,
          first_wall_ms: Math.min(...docs.map((d) => d.first_wall_ms)),
          last_wall_ms: latest.last_wall_ms,
          seen_in: starts.map((s) => ({ hour_start_wall_ms: s, hour_id: (hourIdAt.get(s) as number | undefined) ?? null })),
        }
        const app: OpenAction = { kind: 'app', app_id: latest.app_id, app_name: latest.app_name }
        if (g === 'pages') out.pages.push({ kind: 'page', ...item, url: latest.url, file: null, open: { kind: 'url', url: latest.url } })
        else if (g === 'files') out.files.push({ kind: 'file', ...item, url: null, file: latest.files, open: app })
        else out.windows.push({ kind: 'window', ...item, url: null, file: null, open: app })
      }
    }
    return out
  })()
}
