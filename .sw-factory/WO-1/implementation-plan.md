<!--lint disable no-undefined-references strong-marker-->

# Implementation Plan: WO-1

**Work Order:** WO-1 — [backend] Unify corrected day projections for all calendar ranges
**Created At (UTC):** 2026-08-11T07:28:31Z

## Summary

Make the calendar range read produce the same account as the day view. The
Timeline blueprint permits an optimized range read, so the fast single-query path
over persisted `timeline_blocks` stays; it is corrected to compute duration and
label the way the day path does, and gains a corrected-projection fallback for
days the fast path structurally cannot represent — days whose blocks are
invalidated, and today. Renderer layout, range controls, segmentation rules, and
correction writes stay out.

## Code Reuse And Package Structure

Reused rather than rebuilt:

- `src/shared/blockDuration.ts` — `blockActiveSeconds`. The authority for Active
  duration. The fast path must reproduce it in SQL rather than invent a third
  measure; the fallback path calls it directly.
- `src/shared/blockLabel.ts` — `userVisibleBlockLabel`, `isUsefulLabel`,
  `naturalizeLabel`. The authority for the displayed label.
- `src/main/services/workBlocks.ts` — `getTimelineDayPayload` (the corrected day
  projection used for fallback days) and `dominantCategoryForBlock` (already
  used by the fast path; category resolution is already at parity).
- `src/main/services/workBlocks.ts` — `localDateString` for identifying today.

Created or modified:

- `src/main/services/timelineCalendarRange.ts` — the only production file this
  work order changes. Duration and label parity, plus the fallback path.
- `tests/timelineCalendarRange.test.ts` (**exists**, 114 lines, 4 tests) —
  extended, not created. Follow its existing seeding helpers rather than
  introducing a second fixture style.

No schema change, no migration: every column this plan reads already exists.

## Components And Flow

`#TimelineProjection` (Timeline blueprint) is the component this work order
brings the range read under. `getTimelineRangeBlocks(db, fromDate, toDate)` keeps
its signature and its `CalendarRangeDay[]` return type, so `db.handlers.ts:476`
and the renderer month view are untouched.

The function becomes two passes over one date range:

1. **Fast pass.** The existing single query over `timeline_blocks`, joined to
   `block_label_overrides`, filtered on `invalidated_at IS NULL AND is_live = 0`
   and non-`ignored` reviews. Corrected for duration and label as below. This
   remains the path for the overwhelming majority of days — 133 of 136 on the
   probed database.
2. **Fallback pass.** For each date in `[fromDate, toDate]` that the fast pass
   produced no day for but which has activity evidence, build the day through
   `getTimelineDayPayload(db, date, null, { analysis: false })` and project its
   `WorkContextBlock[]` down to `CalendarRangeBlock[]`.

`analysis: false` follows the DEV-292 precedent: read the day as the timeline
shows it, never a divergent fine build. `materialize` stays unset so a passive
month read never persists today and never ends provisional mode behind the user's
back — the guard `getTimelineDayPayload` already documents at `workBlocks.ts:6673`.

One shared projector maps a source block to `CalendarRangeBlock` so the two
passes cannot drift again.

## Steps

1. **Correct Active duration in the fast pass (D2).** Replace
   `SUM(m.weight_seconds)` with a per-member clamp,
   `SUM(MIN(m.weight_seconds, MAX(0, (m.end_time - m.start_time) / 1000)))`, and
   drop the outer `Math.min(memberSeconds, spanSeconds)`. `weight_seconds` is
   written as the raw `session.durationSeconds` (`workBlocks.ts:5320-5328`) while
   `blockActiveSeconds` clamps each session to its own span before summing, so
   the SQL clamp reproduces `sessionActiveSeconds` exactly. Members written with
   a null session end store `start + duration*1000`, making the clamp a no-op
   there, which matches `sessionActiveSeconds` returning the raw duration when
   `endTime` is null. Result: `memberSeconds > 0 ? max(1, memberSeconds) :
   max(1, spanSeconds)`, matching `blockActiveSeconds`'s two branches and its
   floor of 1. Correct the module comment, which currently claims the clamped
   measure *is* `blockActiveSeconds`.

2. **Correct label resolution in the fast pass (D3).** Select the latest AI and
   rule-sourced labels per block from `timeline_block_labels`, then resolve
   through the same precedence `userVisibleBlockLabel` uses: override verbatim →
   `label_current` → AI → rule, each gated on `isUsefulLabel`, winner passed
   through `naturalizeLabel`. Today the fast path returns
   `override_label ?? label_current` raw, so a block whose `label_current` fails
   `isUsefulLabel` reads differently in month and day views.

3. **Add the fallback pass (D1).** Enumerate dates in range; find those with no
   fast-pass day. Probe which of those carry activity evidence with one bounded
   query. Build each through `getTimelineDayPayload` and project. Cap the number
   of rebuilt days per call (`MAX_FALLBACK_DAYS`, 8) so a pathological month
   cannot turn a glance surface into 42 day builds; when the cap truncates,
   `console.warn` names the dropped dates rather than silently under-reporting.
   Sort the merged result by date so the return order stays stable.

4. **Extract the shared projector.** One `toCalendarRangeBlock` used by both
   passes, so duration, label, category, and kind are computed in exactly one
   place.

5. **Size D4 and record the outcome.** Check whether the renderer month cell
   consumes scheduled-event context. If it does not, `CalendarRangeDay` carries
   no field for it and adding one is renderer work this order excludes — record
   AC-TL-006.4 as an open projection-contract gap in `review-log.md` with the
   evidence, rather than widening scope. If it does, add the projection here.

Steps 1, 2, and 4 touch the same function and are done together. Step 3 depends
on step 4's projector.

## Testing

Extend `tests/timelineCalendarRange.test.ts` (4 existing tests, all must keep
passing) using its own seeding helpers.

- A block with sessions summing beyond its wall-clock span reports the same
  `activeSeconds` from `getTimelineRangeBlocks` as `blockActiveSeconds` reports
  for the equivalent `WorkContextBlock` — the D2 regression, and the case that
  reappears after a merge.
- A session whose stored duration exceeds its own span is clamped to that span,
  not to the block span.
- A block with no session members falls back to `max(1, span)`.
- A user override wins verbatim over `label_current`, including when it contains
  characters `naturalizeLabel` would strip.
- A block whose `label_current` fails `isUsefulLabel` resolves to the AI label,
  then the rule label — the D3 regression.
- A day whose blocks are all `invalidated_at IS NOT NULL` but which has activity
  evidence appears in the range with its corrected blocks — the D1 regression,
  and the 2026-07-01 case.
- Today appears in the range even with no persisted blocks, and the call
  persists nothing: `validPersistedTimelineBlockCount` is unchanged afterwards.
- A day with neither blocks nor evidence stays absent.
- The fallback cap truncates deterministically and warns.

Commands:

```bash
node scripts/run-tests.mjs timelineCalendarRange
npm run typecheck && npm run lint
```

Manual verification against the real database is a separate grading step: open
the month view and confirm 2026-07-01 renders its 8.07 tracked hours instead of
blank. Recorded in `review-log.md` under User-Facing Verification, and it is what
moves the `docs/acceptance/` line for this surface off `landed`.
