<!--lint disable strong-marker-->

# Work Order Entity Index: WO-1

**Initialized At (UTC):** 2026-08-11T07:28:31Z
**Current Status:** in_progress — Phase 1 complete, Phase 2 implementation underway.

## Work Order

- WO-1: [backend] Unify corrected day projections for all calendar ranges (`6ed9e603-5564-410e-b482-7f7f79f87052`)
  <https://factory.8090.ai/project/45f2f431-ae93-407c-913b-8bce76ba3085/work-orders/1>
  Phase 1 (2026-08-09 → 2026-08-15). Type: Build. Status on the board: Backlog.

Source of record for this execution is the 2026-08-11 Factory export
(`~/Downloads/daylens-work-orders-2026-08-11-092326.csv`,
`Daylens_Combined_Requirements.md`, `Daylens_Combined_Blueprints.md`), which
carries the work order description, its embedded requirement, and all 39
blueprints.

## Requirements

The work order's `Requirement IDs` column is empty; the governing requirement is
embedded in the work order description itself and belongs to the **Timeline**
feature node (`4c1e7728-9c36-47ee-af52-b807884763fd`).

**REQ-TL-006: Keep day and range views consistent.**

- **AC-TL-006.1** — selecting a day, week, or month range presents that range.
  *Already met.* Not touched by this work order.
- **AC-TL-006.2** — a block appearing in more than one range shows the same
  boundaries, Active duration, label, category, and Block state in each range.
  **Unmet.** Two independent divergences, both proven below.
- **AC-TL-006.3** — a historical day with a corrected activity account but no
  saved Timeline blocks is included consistently in day, week, and month ranges.
  **Unmet.** Proven against the live database: 3 days omitted from the month grid.
- **AC-TL-006.4** — a scheduled event inside a range presents its context in
  every range where it is visible. **Unmet.** The month path selects no
  scheduled-event data at all.

## Blueprints

**Governing — Timeline** (`956a29de-1240-4256-b312-308479b427e4`).

Its Key Contracts state the bar for this work order almost verbatim:

> `DayTimelinePayload` data must remain consistent across day, week, and month
> presentation. Range views must not omit a historical day merely because a
> separate saved-block representation is absent.

and:

> Day, week, and month presenters consume one equivalent corrected projection
> contract. Range loading can use optimized reads only when they preserve block,
> duration, label, category, state, gap, and scheduled-event parity with
> `DayTimelinePayload`.

That second sentence is the design constraint: the optimized read is *permitted*,
so the fix is not "make the month view call the day path 42 times". It is to keep
the fast path and make it parity-correct, with a corrected-projection fallback
for the days the fast path cannot represent.

ADR-001 (corrected activity projection is Timeline's only activity source) and
ADR-003 (persisted corrections are high-priority inputs and survive rebuilds) both
bind here.

## Referenced Blueprints

Blueprints reached through `@…` mentions and links while reading linked blueprints.

- **Corrected Activity Facts** (`98858637-3876-41a0-8775-4a9fc527d7be`) — the
  `queryCorrectedActivityFactsForRange` boundary the day path already uses.
  ADR-002 applies corrections at the boundary, which is what makes a rebuilt day
  trustworthy. Its noted migration gap ("several services still query evidence or
  legacy tables directly") is exactly what `timelineCalendarRange.ts` does.
- **Local Data Store (SQLite)** (`a4ffe581-946e-48eb-b1ff-e97ddd46ca97`) — the
  read boundary; month reads must stay a bounded query on the fast path.
- **Corrections** (`db58bb95-dc6f-49d8-b0f9-d5c33040098a`) — sibling feature that
  owns `block_label_overrides` and block reviews, both of which the month query
  reads directly. Read to confirm the override-wins precedence the fast path
  implements is correct.
- **Desktop Application (Electron)** (`cb566efa-9a7c-4636-9c76-a8aac624f7b7`) —
  the IPC boundary (`db.handlers.ts:476`) the range read crosses.

**Excluded:** Day Recap & Analysis, Wrapped, Apps, Search & Memory and the
remaining blueprints hold no contract on the range-read path. Renderer layout is
explicitly out of this work order's scope.

## Architecture path

- `src/main/services/timelineCalendarRange.ts` — `getTimelineRangeBlocks`, the
  month/range fast path. **The file this work order changes.**
- `src/main/services/workBlocks.ts:6667` — `getTimelineDayPayload`, the corrected
  day projection and the parity reference.
- `src/shared/blockDuration.ts` — `blockActiveSeconds`, the additive duration
  measure the day path uses.
- `src/shared/blockLabel.ts:142` — `userVisibleBlockLabel`, the label resolution
  the day path uses.
- `src/main/ipc/db.handlers.ts:476` — the IPC entry point.
- `src/renderer/views/Timeline.tsx:2544` — week view (7× `getTimelineDay`),
  `:2819` — month view (`getTimelineRangeBlocks`). Renderer is out of scope; the
  week path is noted because it is the third divergent read.

## Verified defects

Probed against a copy of the live database
(`~/Library/Application Support/DaylensWindows/daylens.sqlite`, 1.1 GB) on
2026-08-11.

**D1 — the month grid omits days that have activity (AC-TL-006.3).**
136 days carry activity evidence; 133 have valid persisted blocks. The three
omitted days and their causes:

| Day | Evidence | Blocks | Cause |
| --- | --- | --- | --- |
| 2026-07-01 | 170 sessions, **8.07 h**, 3069 focus events | 95, all invalidated | `invalidated_at IS NULL` filter |
| 2026-07-22 | 10,151 focus events | 11, all invalidated | same |
| 2026-08-11 (today) | 1,885 focus events | none | `is_live = 0` filter + not yet materialized |

A day holding eight hours of tracked work renders blank in the month grid while
the day view rebuilds and shows it. Invalidation is routine — a correction
invalidates a day's blocks — so this is not an edge case.

**D2 — Active duration diverges (AC-TL-006.2).**
The fast path computes `min(member_seconds, spanSeconds)`. `blockActiveSeconds`
deliberately does **not** clamp to span, and `blockDuration.ts` documents why:
clamping breaks additivity across a merge, because a merged block spans the gap
between its parts, so "time clamped away before the merge reappears after it".
The module comment in `timelineCalendarRange.ts` claims it uses "the same
session-time basis as blockActiveSeconds — clamped to the wall-clock span", which
is self-contradictory: that clamp is precisely the difference.

**D3 — the label diverges (AC-TL-006.2).**
The fast path resolves `override_label ?? label_current` raw. The day path uses
`userVisibleBlockLabel`, which applies the override, then falls through
`label.current` → `aiLabel` → `ruleBasedLabel` gated on `isUsefulLabel`, and
passes the winner through `naturalizeLabel`. A block whose `label_current` is not
a useful label reads differently in the two views.

**D4 — scheduled events absent from the range (AC-TL-006.4).**
`getTimelineRangeBlocks` selects no scheduled-event data. `DayTimelinePayload`
carries resolved scheduled meetings. Sized during implementation; if the renderer
month cell does not consume it, this is a projection-contract gap rather than a
visible defect, and is recorded as such.

## Delivery

- Branch: `factory/v2-ship`
- Pull Request URL: https://github.com/<owner>/daylens/pull/259
