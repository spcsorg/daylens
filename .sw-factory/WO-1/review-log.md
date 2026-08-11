<!--lint disable strong-marker-->

# Review Log: WO-1

**Work Order:** WO-1 — [backend] Unify corrected day projections for all calendar ranges
**Initialized At (UTC):** 2026-08-11T07:28:31Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## No review round has run

Phase 3 was never entered. This execution completed context gathering and the
implementation plan, then stopped before writing production code: another session
was found actively editing `src/main/services/timelineCalendarRange.ts`, the
single file this work order changes. There is no implementation to review.

The defects recorded in `context.md` are a verified defect register, not review
findings — they describe the current state of the code, which nothing in this
work order has yet altered.

When implementation lands, open Round 1 here and grade it against the four
acceptance criteria of REQ-TL-006 and against the Timeline blueprint's range
parity contract. The user-facing check that closes AC-TL-006.3: open the month
view and confirm 2026-07-01 renders its 8.07 tracked hours instead of blank.

---

## Round 1 — 2026-08-11, verification of the uncommitted implementation

**Verdict: CHANGES REQUESTED.** Three of the four defects are genuinely fixed and
one previously unrecorded defect was fixed alongside them. AC-TL-006.3 is met for
the case the defect table sized and unmet for the case the criterion actually
states; AC-TL-006.4 is unmet and acknowledged in the code.

Read-only review. No file was edited: `timelineCalendarRange.ts` was last written
at 09:57 by another session and this round did not enter that zone.

**Method.** Code reading against `blockDuration.ts` / `blockLabel.ts` as the
parity references, plus SQL probes against a read-only handle on the live
database. One attempted runtime probe through `stageReadOnlyCopyOfRealDb` is
**discarded**: `initDb()` resolved `userData` before the harness override took
effect and built an empty database at the Electron temp path, so it reported zero
sessions for every day. Nothing below rests on it. The live database was never
written to.

### Verified fixed

- **D2 (duration), in substance.** The span clamp is gone and the per-member
  clamp matches `sessionActiveSeconds`. The `memberSeconds > 0` branch returns
  `max(1, sum)`, matching `blockActiveSeconds`. Additivity across a merge is
  restored, which was the point.
- **D3 (label), in substance.** The hand-rolled `override ?? label_current` is
  replaced by a real call to `userVisibleBlockLabel` through the new
  `LabelResolvableBlock` projection type. One chain, one implementation.
- **Previously unrecorded: `block_kind` coerced every grid block to `work`.** The
  stored column holds a display bucket that cannot express `leisure`, and the old
  cast flattened it. Now resolved on read via `effectiveBlockKind`, with
  `BlockCategoryBucket` added so the bad cast no longer compiles. Covered by
  `tests/blockKindReadPath.test.ts`. This is the highest-value fix in the change
  and it is not in the work order's defect register.

### F1 — blocking. AC-TL-006.3 is unmet for a day with no block rows at all

`provisionalRowsForUncoveredDates` draws its candidate dates from
`SELECT DISTINCT date FROM timeline_blocks`, so it can only recover a day that
*has* rows to reconstruct from. The criterion is written for the opposite case:

> a historical day with a corrected activity account but **no saved Timeline
> blocks** is included consistently in day, week, and month ranges.

Evidence, live database, 2026-08-11:

| Day | focus_events | timeline_blocks rows | Recovered? |
| --- | --- | --- | --- |
| 2026-07-01 | 3,069 | 95, all invalidated | yes, provisional |
| 2026-07-22 | 10,151 | 11, all invalidated | yes, provisional |
| 2026-08-11 | 2,682 | **0** | **no, still absent** |

Today is the third row of the defect register's own table and it is still blank
in the grid. Its activity exists only as focus events; there are no app_sessions
and no blocks, so there is nothing for the reconstruction to walk. The day view
projects it from focus events on open, which is exactly the divergence
AC-TL-006.3 names.

The existing fallback is the right mechanism for the invalidated-cohort case and
should stay. Closing this case needs a different source: the candidate-date set
has to come from evidence (focus events / corrected facts) rather than from
`timeline_blocks`, with the day still flagged `provisional`. That is a design
decision with a cost — it is the one place this work order would touch the
corrected-facts boundary for date discovery — so it belongs to whoever owns
implementation, not to this round.

### F2 — minor. Integer truncation understates the clamp on 5,326 blocks

`MAX(0, (m.end_time - m.start_time) / 1000)` is integer division on two INTEGER
columns, so it truncates, while `sessionActiveSeconds` uses `Math.round`. The two
disagree by one second per member wherever the clamp binds and the millisecond
remainder is >= 500:

- 59,305 of 229,920 app_session members (26%), across 5,326 distinct blocks.

Each affected block reads one second low per affected member, so the range view
sits slightly under the day view on exactly the blocks the parity contract
covers. Fix is confined to the SQL:
`CAST(ROUND((m.end_time - m.start_time) / 1000.0) AS INTEGER)`.

### F3 — minor, latent. Members summing to zero take the wrong branch

`blockActiveSeconds` distinguishes "no sessions" (returns the span) from
"sessions that carry no time" (returns 1), and `blockDuration.ts` documents why
the second must not fall back to the span. The new code tests `memberSeconds > 0`
and so sends both cases to `spanSeconds`. Not currently reachable: zero blocks in
the live database have app_session members whose clamped sum is 0. Latent, and
cheap to close by branching on member presence rather than on the sum.

### F4 — recorded limit, no action. The label chain skips two rungs

`userVisibleBlockLabel` resolves override → label_current → aiLabel →
ruleBasedLabel → artifact → site → category. The range projection supplies
neither `aiLabel` nor `ruleBasedLabel`, and it cannot: `timeline_blocks` persists
`label_current` and `label_source` only, with no column for either. A block whose
`label_current` fails `isUsefulLabel` while a runtime-derived aiLabel would have
passed will read differently in the two views. Narrow in practice, since
`label_current` already holds the resolved stored label. Structural, correctly
handled by making the fields optional on `LabelResolvableBlock` rather than
faking them. Record it; do not chase it in this work order.

### F5 — AC-TL-006.4 unmet, acknowledged

`CalendarRangeDay` still carries no scheduled-event field and the range read
selects none. The module header states this plainly. Consistent with
`context.md`, which sized D4 as a projection-contract gap rather than a visible
defect. It must not be checked off as satisfied.

### Tests

`tests/timelineCalendarRange.test.ts` (12), `tests/blockKindReadPath.test.ts` (4),
`tests/boundaryReasonPersistence.test.ts` (6) all pass. Full suite green: 330
files, 2,220 pass, 0 fail. `npm run typecheck` clean.

No test covers F1 — a fixture day with evidence and zero `timeline_blocks` rows
would fail today and is the regression test that should land with the fix.

### To close this work order

1. F1: include a day that has a corrected activity account and no block rows.
2. F2: round rather than truncate in `MEMBER_SECONDS_SQL`.
3. F3: branch on member presence, not on the sum.
4. Decide AC-TL-006.4 explicitly — implement the field or record it as accepted
   drift with the requirement owner. Do not leave it silently unchecked.
5. Exploratory pass still owed: open the month view and confirm 2026-07-01 shows
   its 8.07 hours, and that today is not blank.
