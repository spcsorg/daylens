<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-1

**Work Order Number:** WO-1
**Work Order Title:** [backend] Unify corrected day projections for all calendar ranges
**Initialized At (UTC):** 2026-08-11T07:28:31Z

**Execution state: Phase 1 complete, Phase 2 not started, handed off.**
Context gathering and the implementation plan are done. No production code was
written. Execution stopped deliberately: another session was found actively
editing `src/main/services/timelineCalendarRange.ts` — the single file this work
order changes — along with `workBlocks.ts`, `schema.ts`, `migrations.ts` (v69),
and `types.ts`. Continuing would have collided. Ownership passed to that session
on 2026-08-11; see `context.md` for the verified defects and
`implementation-plan.md` for the approach.

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      Read in full from the 2026-08-11 Factory export
      (`~/Downloads/daylens-work-orders-2026-08-11-092326.csv`). Summary, In
      Scope, Out of Scope, and the embedded REQ-TL-006 with four acceptance
      criteria.
- [x] Identify linked requirements and blueprints
      Blueprint: **Timeline** (`956a29de-1240-4256-b312-308479b427e4`). The
      export's `Requirement IDs` column is empty; the governing requirement is
      embedded in the work order description and belongs to the Timeline feature
      node. Recorded in `context.md`.
- [x] Review every connected requirements document
      REQ-TL-006 graded criterion by criterion in `context.md`: AC-006.1 already
      met, AC-006.2/.3/.4 unmet with evidence.
- [x] Review every connected blueprint document
      Timeline blueprint read in full, including ADR-001 (corrected projection is
      the only activity source) and ADR-003 (persisted corrections survive
      rebuilds). Its Key Contracts state this work order's bar almost verbatim
      and explicitly permit an optimized range read, which shapes the approach.
- [x] Follow `@…` mentions **and links** to other blueprints in linked documents and read each referenced blueprint via MCP
      Timeline's composition and contracts resolve to Corrected Activity Facts,
      Local Data Store (SQLite), Corrections, and Desktop Application (Electron).
      All four read.
- [x] Review every referenced blueprint discovered that way; add them to **Referenced Blueprints** in `context.md`
      Listed in `context.md` with why each was reached and what it constrains.
- [x] Extract acceptance criteria from requirements
      Four criteria (AC-TL-006.1 through .4), each mapped to a verified defect or
      to "already met", in `context.md`.
- [x] Identify architecture path from blueprints (components, contracts, composition)
      `#TimelineProjection` is the component this read comes under. File-level
      path recorded in `context.md`.
- [x] `context.md` is filled or updated with `execution/scripts/update-context-index.sh` for Work Order, connected requirements, connected blueprints, referenced blueprints, and known delivery links
      Filled by hand rather than by the script, matching the DEV-292 precedent in
      this repository: the records were read from the on-disk Factory export
      rather than resolved live.

- [x] **Certification: Phase 1 complete.** Four acceptance criteria extracted,
      one governing and four referenced blueprints read, and four defects
      verified against a copy of the live database. Phase 2 was not entered —
      see the execution state above.

## Phase 2: Planning And Implementation

### Implementation Plan

(see `execution/writing-implementation-plans.md`)

- [x] Implementation plan documented in `implementation-plan.md`
      Five ordered steps covering the three in-scope defects, plus an explicit
      step to size AC-TL-006.4 rather than silently widen scope.
- [x] Testing section documented in `implementation-plan.md`
      Nine scenarios against `tests/timelineCalendarRange.test.ts`, which already
      exists (114 lines, 4 tests) and is extended rather than created.

### Implementation

- [ ] Implemented changes are scoped to the Work Order
      NOT STARTED. No production code written. Handed off — see the execution
      state at the top of this file.
- [ ] Tests added or updated for changed behavior
      NOT STARTED, same cause.
- [ ] Documentation, generated files, fixtures, migrations, or config updated where relevant
      NOT STARTED, same cause. The plan requires no schema change or migration:
      every column it reads already exists.

- [ ] **Certification: Phase 2 NOT complete.** Planning is done; implementation
      was deliberately not started to avoid colliding with concurrent work in the
      same file.

## Phase 3: Review And Verification

### Review

- [ ] Review subagent spawned per `execution/review-phase.md` and returned a verdict
      NOT REACHED. Phase 3 requires an implementation to review; none exists.
- [ ] All acceptance criteria from the Work Order and linked requirements are satisfied
      NOT REACHED. Three of the four are currently unmet — that is the defect
      register in `context.md`, not a review result.
- [ ] Architecture is aligned with linked blueprints, or documented drift is accepted
      NOT REACHED.
- [ ] Exploratory pass on user-visible or external behavior — not only automated tests; for browser apps, use browser-based testing if available. Brief notes in `review-log.md` or evidence.
      NOT REACHED. The manual check when this lands: open the month view and
      confirm 2026-07-01 renders its 8.07 tracked hours instead of blank.
- [ ] Latest `review-log.md` verdict is `APPROVED`
      NOT REACHED. No review round has run.

- [ ] **Certification: Phase 3 NOT complete.** Not entered.

## Final Completion Check

- [ ] All phase certifications above are complete
      No. Phase 1 only.
- [x] Checklist is fully filled out with evidence
      Every item above is `[x]` with evidence or carries an explicit
      not-started/not-reached reason.
- [ ] Review log is complete (`review-log.md`)
      No round has run; `review-log.md` records that rather than an empty round.
- [ ] Implementation plan was followed (`implementation-plan.md`)
      Not yet — the plan is written but unexecuted.
- [ ] All intended files are present in the working tree
      No production file was changed by this execution.
- [SKIP] Work order status updated to `in_review`
      Skip reason: the work order is not in review. It remains Backlog on the
      board, and the board is the owner's to move. Ownership of the work passed
      to the concurrent session on 2026-08-11.
