<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-76

**Work Order Number:** WO-76
**Work Order Title:** [renderer] Deliver the Context Inspector surface
**Initialized At (UTC):** 2026-08-15T12:20:00Z

## Phase 1: Start / Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
      `read_work_order(76)` returned the summary, in/out of scope,
      REQ-AIA-RT-005 with its five acceptance criteria, and one flagged comment
      recording that the backend dependency is merged on `main` in `f4cb36ce`
      and that AC-AIA-002.3 was left "not verified end-to-end" by WO-53.
- [x] Identify linked requirements and blueprints
      REQ-AIA-RT-005, and the Agent Runtime & Context Packet blueprint
      (`b3ed6474-1327-4b15-b0fe-6fdb956f9868`).
- [x] Review every connected requirements document
      REQ-AIA-RT-005 was read in full from the work order description. No
      separate requirements document ID was linked, so `read_requirement` was
      not called.
- [x] Review every connected blueprint document
      `read_blueprint(b3ed6474-…)` read all 34 lines. **It is an unfilled
      template** — boilerplate prompt text in every section, no summary, no
      components, no contracts, no ADRs. Recorded in `context.md`.
- [x] Follow links to other blueprints in linked documents and read each referenced blueprint via MCP
      The linked blueprint names a parent, AI Agent
      (`0bbc0ff1-fccd-4b18-bf28-50d0b08b67cf`), read in full via MCP: 152
      lines, including Key Contracts, Integration Contracts, and ADR-001
      through ADR-004. That is the document carrying the contracts this work
      was built to. The sibling child Corrections & Actions in Chat
      (`952e0de6-…`) was not read, because the AI Agent blueprint states it
      owns confirmation and mutation mechanics, which this work order does not
      touch.
- [x] Review every referenced blueprint discovered that way; add them to **Referenced Blueprints** in `context.md`
      Both are listed in `context.md` with what was and was not read, and with
      the note that AI Agent carries six unresolved comment threads whose
      contents were not fetched.
- [x] Extract acceptance criteria from requirements
      AC-AIA-002.3 (the criterion this work order closes) and all five
      REQ-AIA-RT-005 criteria recorded verbatim in `context.md`, with a
      forward pointer to the honest grading in `review-log.md`.
- [x] Identify architecture path from blueprints (components, contracts, composition)
      The existing inspection chain was traced end to end and confirmed to be a
      pass-through at every hop after the service:
      `contextPacketInspection.ts` → `ai.handlers.ts:103` →
      `preload/index.ts:687` → `ContextPacketInspector.tsx`, with two entry
      points (`AIWorkspace.tsx:642`, `ContextPacketSection.tsx:79`). Recorded in
      `context.md`.
- [x] `context.md` is filled for Work Order, connected requirements, connected blueprints, referenced blueprints, and known delivery links
      Written by hand, with branch and base commit recorded.

- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**

## Phase 2: Planning And Implementation

### Implementation Plan

- [x] Implementation plan documented in `implementation-plan.md`
- [x] Testing section documented in `implementation-plan.md`

### Baseline

- [x] Known-good starting point confirmed before any change
      `npm test` on `main-wo76` (`cf405e84`): **350 files · 2410 pass · 0 fail
      · 11 skip**, exit 0.
- [x] Branch created from the specified base
      `wo-76/context-inspector` from `main-wo76`, which is `main` fetched from
      `/Users/tonny/Dev-Personal/daylens` at `cf405e84`. Worked in the existing
      worktree `/Users/tonny/Dev-Personal/dl-2-entities`; no new worktree
      created, and no other worktree touched.

### Implementation

- [x] Studied the existing surface before adding anything
      `ContextPacketInspector.tsx` (311 lines), `contextPacketInspection.ts`
      (330 lines), `evidenceCoverage.ts`, `deterministicFacts.ts`,
      `factClaims.ts` and `ChatAgentResult` were all read in full before any
      edit. Confirmed by reading `aiService.ts` that `agentResult.evidence` was
      being dropped at persistence, and by grep that nothing under
      `src/renderer`, `src/preload` or `src/main/ipc` referenced it.
- [x] Extended the existing inspector rather than building a second one
      No new renderer component file. The new section lives inside
      `ContextPacketInspector.tsx`, reuses its `sectionTitleStyle`,
      `quietTextStyle` and `badgeStyle`, and follows its inline-style,
      `useState`/`useEffect` convention. No new state library, no new styling
      approach.
- [x] Answer evidence persisted, carried over IPC and preload, and rendered
      Persisted at `aiService.ts` as `agent.evidence`; read back by
      `answerEvidenceForMessage`; placed on `ContextPacketInspection`; carried
      by the existing `IPC.CONTEXT_PACKETS.INSPECT` channel with no new IPC
      surface; rendered as "What backed the answer".
- [x] The person can see which claims are backed by which evidence, which figures were computed deterministically, and what was flagged uncertain or unavailable
      Four subsections: claims traced to evidence (with identity, source and
      the statement each resolves to); figures Daylens computed (with what the
      model wrote first, when it was replaced); claims nothing backs; and what
      the answer was made to admit in words.
- [x] Exclusion clause enforced at the boundary, not only upstream
      `projectAnswerEvidence` rebuilds the shape field by field from the
      persisted row, checking union members, bounding free text and dropping
      malformed rows. Proven load-bearing by mutation — see `review-log.md`.
- [x] Out-of-scope areas untouched
      `chatAgent.ts` not modified. Context-packet assembly
      (`contextPacket.ts`) not modified. No provider-runtime work, no thread
      deletion or purge work.
- [x] Nothing under `~/Library/Application Support/` read or written
      All work in the worktree; tests run against
      `createProductionTestDatabase` fixtures. The app was never launched,
      partly for this reason.
- [x] No credential, token or real personal activity added to any file
      Every planted value in the new test is synthetic. The key-shaped ones
      (`sk-ant-fake-0000-DO-NOT-LEAK-0000` and siblings) are obviously fake by
      construction and follow the existing precedent in
      `tests/contextPacketInspection.test.ts`.

## Phase 3: Review And Verification

### Review

- [x] Review round recorded in `review-log.md`
      One round, performed by the implementer directly. No second reviewer and
      no review subagent was used, and the log says so.
- [x] Defects found in review were fixed and re-verified
      Two non-blocking defects: type imports inserted out of the file's
      alphabetical order, and a doc comment on `projectAnswerEvidence` that
      described behaviour the code does not have. Both fixed. No blocking
      defect was found, and none is invented to pad the log.

### Verification

- [x] Typecheck passes
      `npm run typecheck`: clean, exit 0.
- [x] Lint passes
      `npm run lint`: 0 errors, 128 warnings — identical to the baseline count,
      re-measured on a stashed tree in the same session. No warning is in a
      file this work order touched.
- [x] New tests genuinely exercise the acceptance criterion
      `tests/answerEvidenceInspection.test.ts`, 6 tests. Two carry secrets end
      to end through the real agent turn and the persisted row; two plant
      secrets directly in the row to prove the read projection is what stops
      them; one covers honest null for pre-evidence turns; one covers the write
      projection. Mutation-checked: breaking the projection fails 2 of them.
- [x] Full test suite run with counts recorded
      **351 files · 2416 pass · 0 fail · 11 skip**, exit 0. Baseline was 350
      files · 2410 pass · 0 fail · 11 skip. See `review-log.md`.
- [x] `npm run timeline:eval -- --strict` still exits 0
      Confirmed; unchanged from `main`.
- [x] No existing test weakened, skipped or deleted
      `git diff` touches no file under `tests/` other than the new one. The
      existing assertion in `tests/contextPacketInspection.test.ts` that tool
      trace payloads never ride the inspection is left intact — and is the
      reason AC-AIA-RT-005.2 was deliberately left unmet rather than satisfied
      by weakening it.
- [SKIP] Exploratory pass on user-visible behavior in the running app
      Skip reason: launching the desktop app would read the owner's live
      database, which this work order is forbidden to touch. This is a genuine
      coverage gap, not a pass: **no human has seen the new section render.**
      Layout, wrapping of long identities, and the appearance of the amber
      "replaced" and "unbacked" treatments in light and dark are unobserved.
      Recorded in `review-log.md` under Not Verified.
- [x] Latest `review-log.md` verdict recorded
      Approved for commit, with AC-AIA-RT-005.2, RT-005.3 and RT-005.4 stated
      as not met rather than claimed.

- [x] **Certification: Phase 3 complete.**

## Final Completion Check

- [x] All phase certifications above are complete
- [x] Checklist is fully filled out with evidence
- [x] Review log is complete (`review-log.md`)
- [x] Implementation plan was followed (`implementation-plan.md`)
- [x] All intended files are present in the working tree
- [x] `context.md` force-added
      `.gitignore` matches `CONTEXT.md` case-insensitively on macOS, so
      `git add -f` was used, matching the existing WO-53 / WO-68 / WO-73 /
      WO-74 / WO-95 records rather than editing `.gitignore`.
- [SKIP] Work order status updated to `in_progress` / `in_review` via MCP
      Skip reason: the task did not authorize writing to the Factory, and
      `edit_work_order` mutates shared project state. The local execution
      status in `context.md` is `in_review`; no external status was changed.
- [x] Nothing pushed
- [x] No AI or tool attribution anywhere in the commit
