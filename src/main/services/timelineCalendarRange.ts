// Lightweight block read for the calendar month grid.
//
// The month view needs up to ~42 days of blocks at once. Building full
// DayTimelinePayloads for that many days re-derives sessions, websites, and
// focus data per day — far too heavy for a glance surface. This module reads
// the same persisted timeline_blocks rows the day view renders (one truth),
// reduced to the fields a month cell shows, in a single query.
//
// The optimized read is permitted ONLY while it preserves parity with
// DayTimelinePayload (Timeline blueprint, Key Contract). Three ways it did not:
//
//   Days. A range view must not omit a historical day merely because a separate
//   saved-block representation is absent. `invalidated_at IS NULL AND
//   is_live = 0` dropped any day whose blocks were all invalidated, and
//   invalidation is routine — a correction invalidates a day's blocks. A day
//   holding hours of tracked evidence rendered blank in the grid while the day
//   view rebuilt it on open. A day with no current generation now falls back to
//   a reconstruction from superseded ones, flagged `provisional`.
//
//   Duration. The old formula clamped the member sum to the block span.
//   `blockActiveSeconds` deliberately does not — see shared/blockDuration.ts:
//   clamping breaks additivity across a merge, because a merged block spans the
//   gap between its parts, so time clamped away before a merge reappears after
//   it. `weight_seconds` is stored as the raw session duration while
//   `blockActiveSeconds` clamps each session to its own span first, so the
//   parity formula clamps per member and does not clamp the total. 905 of 1,235
//   blocks in a real history read differently under the two.
//
//   Label. The old read took `override ?? label_current` raw, while the day view
//   runs the whole `userVisibleBlockLabel` chain — override verbatim, then
//   label_current / aiLabel / ruleBasedLabel each gated on isUsefulLabel, then
//   top artifact, then site, then category. A block whose stored label fails
//   that gate read as tab soup here and as a real name there. This module now
//   calls that function rather than keeping a second chain in parity by hand.
//
// Still not at parity: scheduled events. `CalendarRangeDay` has no field for
// them, so a range cell cannot show a meeting the day view resolves.

import type Database from 'better-sqlite3'
import type { AppCategory, ArtifactRef, CalendarRangeBlock, CalendarRangeDay, WorkContextAppSummary } from '@shared/types'
import { effectiveBlockKind } from '@shared/workKind'
import { userVisibleBlockLabel } from '@shared/blockLabel'
import { queryCorrectedActivityFactsForRange } from '../core/query/activityFactsQuery'
import { localDayBounds } from '../lib/localDate'
import { dominantCategoryForBlock } from './workBlocks'

/** The page shape the evidence blob stores — an ArtifactRef carrying its
 *  domain, which is what the kind resolver's domain vote needs. */
interface PageEvidence extends ArtifactRef {
  domain?: string
}

/** Per-domain seconds for the kind resolver, folded from the block's page
 *  evidence. The stored blob has no standalone per-domain totals, so a domain's
 *  weight is the sum of its pages. */
function websitesFromPages(pages: PageEvidence[]): Array<{ domain: string; totalSeconds: number }> {
  const byDomain = new Map<string, number>()
  for (const page of pages) {
    const domain = page.domain?.trim()
    if (!domain) continue
    byDomain.set(domain, (byDomain.get(domain) ?? 0) + (page.totalSeconds || 0))
  }
  return [...byDomain.entries()]
    .map(([domain, totalSeconds]) => ({ domain, totalSeconds }))
    .sort((left, right) => right.totalSeconds - left.totalSeconds)
}

interface RangeRow {
  id: string
  date: string
  start_time: number
  end_time: number
  label_current: string
  override_label: string | null
  category_distribution_json: string
  evidence_summary_json: string
  member_seconds: number | null
}

// Parity with blockActiveSeconds: each member is clamped to its OWN span before
// summing, and the total is never clamped to the block span. A member written
// with a null session end stores start + duration*1000, which makes the clamp a
// no-op there — matching sessionActiveSeconds returning the raw duration when
// endTime is null. So this is exact, not an approximation.
const MEMBER_SECONDS_SQL = `
  SELECT SUM(MIN(m.weight_seconds, MAX(0, (m.end_time - m.start_time) / 1000)))
  FROM timeline_block_members m
  WHERE m.block_id = b.id AND m.member_type = 'app_session'
`

const SELECT_COLUMNS = `
  b.id,
  b.date,
  b.start_time,
  b.end_time,
  b.label_current,
  o.label AS override_label,
  b.category_distribution_json,
  b.evidence_summary_json,
  (${MEMBER_SECONDS_SQL}) AS member_seconds
`

const NOT_DELETED = `
  NOT EXISTS (
    SELECT 1 FROM timeline_block_reviews r
    WHERE r.block_id = b.id AND r.review_state = 'ignored'
  )
`

/** Blocks for dates the current-generation read returned nothing for.
 *
 *  There is no clean "previous generation" to fall back to. `computed_at` is
 *  written per block, not per run, and `invalidated_at` forms partial cohorts
 *  because `persistTimelineDay` invalidates only the blocks a rebuild changed.
 *  Grouping by either column yields a fragment of a day, not a day.
 *
 *  So this reconstructs the most recent non-overlapping cover: walk candidates
 *  newest-invalidated first and keep a block only if its span is still free.
 *  Newer reconstructions win the spans they claim, older ones fill what is left,
 *  and no interval is ever counted twice. Live blocks (`invalidated_at IS NULL`)
 *  sort first, so today is covered by its live block.
 *
 *  The result is one generation stale by construction, which is why the day is
 *  flagged `provisional` — the day view rebuilds it properly on open. */
function provisionalRowsForUncoveredDates(
  db: Database.Database,
  fromDate: string,
  toDate: string,
  covered: ReadonlySet<string>,
): RangeRow[] {
  const dates = (db.prepare(`
    SELECT DISTINCT date FROM timeline_blocks WHERE date >= ? AND date <= ? ORDER BY date ASC
  `).all(fromDate, toDate) as Array<{ date: string }>)
    .map((row) => row.date)
    .filter((date) => !covered.has(date))
  if (dates.length === 0) return []

  const forDate = db.prepare(`
    SELECT ${SELECT_COLUMNS}, b.invalidated_at
    FROM timeline_blocks b
    LEFT JOIN block_label_overrides o ON o.block_id = b.id
    WHERE b.date = ? AND ${NOT_DELETED}
    ORDER BY
      CASE WHEN b.invalidated_at IS NULL THEN 0 ELSE 1 END ASC,
      b.invalidated_at DESC,
      b.start_time ASC
  `)

  const out: RangeRow[] = []
  for (const date of dates) {
    const candidates = forDate.all(date) as Array<RangeRow & { invalidated_at: number | null }>
    const claimed: Array<{ start: number; end: number }> = []
    const accepted: RangeRow[] = []
    for (const row of candidates) {
      const overlaps = claimed.some((span) => row.start_time < span.end && row.end_time > span.start)
      if (overlaps) continue
      claimed.push({ start: row.start_time, end: row.end_time })
      accepted.push(row)
    }
    accepted.sort((left, right) => left.start_time - right.start_time)
    out.push(...accepted)
  }
  return out
}

export function getTimelineRangeBlocks(
  db: Database.Database,
  fromDate: string,
  toDate: string,
): CalendarRangeDay[] {
  const rows = db.prepare(`
    SELECT ${SELECT_COLUMNS}
    FROM timeline_blocks b
    LEFT JOIN block_label_overrides o ON o.block_id = b.id
    WHERE b.date >= ? AND b.date <= ?
      AND b.invalidated_at IS NULL
      AND b.is_live = 0
      AND ${NOT_DELETED}
    ORDER BY b.date ASC, b.start_time ASC
  `).all(fromDate, toDate) as RangeRow[]

  // A day whose every block was invalidated, or whose only block is still live,
  // has activity and no current generation. Recover the newest superseded
  // generation for exactly those days rather than dropping the day. Bounded: one
  // extra query, only for dates the main read returned nothing for.
  const covered = new Set(rows.map((row) => row.date))
  const fallbackRows = provisionalRowsForUncoveredDates(db, fromDate, toDate, covered)
  const provisionalDates = new Set(fallbackRows.map((row) => row.date))

  const days = new Map<string, CalendarRangeDay>()

  for (const row of [...rows, ...fallbackRows]) {
    let distribution: Partial<Record<AppCategory, number>> = {}
    try {
      distribution = JSON.parse(row.category_distribution_json || '{}')
    } catch {
      distribution = {}
    }

    // Same category resolution as the day view's persisted read path: the
    // stored dominant_category can lag the recomputed one, so recompute from
    // the distribution + top page/document artifacts.
    let topArtifacts: ArtifactRef[] = []
    let topApps: WorkContextAppSummary[] = []
    let pages: PageEvidence[] = []
    try {
      const evidence = JSON.parse(row.evidence_summary_json || '{}') as {
        pages?: PageEvidence[]
        documents?: ArtifactRef[]
        apps?: WorkContextAppSummary[]
      }
      pages = Array.isArray(evidence.pages) ? evidence.pages : []
      topApps = Array.isArray(evidence.apps) ? evidence.apps : []
      topArtifacts = [
        ...pages,
        ...(Array.isArray(evidence.documents) ? evidence.documents : []),
      ]
        .sort((left, right) => right.totalSeconds - left.totalSeconds)
        .slice(0, 6)
    } catch {
      topArtifacts = []
      topApps = []
      pages = []
    }

    // blockActiveSeconds' two branches and its floor of 1, with no span clamp.
    const spanSeconds = Math.max(1, Math.round((row.end_time - row.start_time) / 1000))
    const memberSeconds = row.member_seconds ?? 0
    const activeSeconds = memberSeconds > 0 ? Math.max(1, memberSeconds) : spanSeconds

    const dominantCategory = dominantCategoryForBlock(distribution, topArtifacts)
    const websites = websitesFromPages(pages)

    const block: CalendarRangeBlock = {
      id: row.id,
      date: row.date,
      startTime: row.start_time,
      endTime: row.end_time,
      dominantCategory,
      // The day view's whole chain, not `override ?? label_current`. aiLabel and
      // ruleBasedLabel are absent from this projection, so the chain skips them
      // and lands on the artifact / site / category fallbacks — the same
      // fallbacks, in the same order, as the day view.
      label: userVisibleBlockLabel({
        label: { current: row.label_current, override: row.override_label ?? null },
        dominantCategory,
        topApps,
        topArtifacts,
        websites,
      }),
      // ADR-002: kind is resolved on read, never trusted from storage. The
      // month grid previously cast the stored block_kind column into WorkKind,
      // which silently coerced its 'communication' / 'meeting' / 'mixed'
      // buckets to 'work' — and since that column can never hold 'leisure',
      // every block in the grid read as work. `kind` is left undefined on
      // purpose so the resolver recomputes rather than short-circuiting.
      kind: effectiveBlockKind({
        dominantCategory,
        categoryDistribution: distribution,
        topApps,
        websites,
      }),
      activeSeconds,
    }

    const day = days.get(row.date)
    if (day) {
      day.blocks.push(block)
      day.activeSeconds += activeSeconds
    } else {
      days.set(row.date, {
        date: row.date,
        blocks: [block],
        activeSeconds,
        ...(provisionalDates.has(row.date) ? { provisional: true } : {}),
      })
    }
  }

  // A provisional day's block shapes come from superseded generations, and
  // summing their member weights double-counts the same underlying sessions —
  // on a real invalidated day that overstated the total by more than threefold.
  // A plausible wrong number is worse than a blank cell, so the total comes from
  // the corrected activity facts, the same boundary every other user-facing
  // total reads, while the stale blocks supply only the shapes the cell draws.
  for (const date of provisionalDates) {
    const day = days.get(date)
    if (!day) continue
    const [fromMs, toMs] = localDayBounds(date)
    try {
      day.activeSeconds = queryCorrectedActivityFactsForRange(db, fromMs, toMs).focusSeconds
    } catch {
      // Leave the block-derived total rather than dropping the day entirely;
      // `provisional` already tells the consumer not to trust it precisely.
    }
  }

  return [...days.values()].sort((left, right) => left.date.localeCompare(right.date))
}
