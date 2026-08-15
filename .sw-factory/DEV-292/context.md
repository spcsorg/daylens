<!--lint disable strong-marker-->

# Work Order Entity Index: DEV-292

**Initialized At (UTC):** 2026-08-11T06:08:40Z
**Blueprint alignment completed (UTC):** 2026-08-11
**Current Status:** in_review — implementation, verification, and all five spec
acceptance lines complete across two review rounds. Phase 1 is certified as of
Round 3: the Software Factory's requirements and blueprints were read and graded.
Three drift items are open against the Factory authority; none is a regression in
what DEV-292 landed, and one was already carried as an advisory. See
`review-log.md` Round 3.

## Work Order

- DEV-292: Make the day recap good: an iteration tool over real days, and a budget that lets it finish (`DEV-292`)
  <https://linear.app/irachrist1/issue/DEV-292>

## Requirements

Read from the Software Factory (project `45f2f431-ae93-407c-913b-8bce76ba3085`)
on 2026-08-11. The Factory holds 27 requirements documents: 6 `OVERVIEW` and the
21 `FEATURE` nodes that are the authority for this layer.

**Governing:**

- **Day Recap & Analysis** (`b11912fb-c852-4d0e-9466-89c4663c750d`), child of
  Timeline — the owning requirement. Seven REQs, ~30 acceptance criteria. The
  ones DEV-292 is graded against:
  - `REQ-TL-DRA-001` Generate a grounded day recap — AC-001.1 (2–4 sentences),
    AC-001.2 (every claim supported by grounded context), **AC-001.3 (a presented
    total matches the Timeline account — unmet)**, AC-001.4 (everyday language,
    no raw window titles, no internal vocabulary, no productivity score),
    AC-001.5 (state material uncertainty rather than assert a reading).
  - `REQ-TL-DRA-002` Degrade recap generation honestly — AC-002.1/.2/.3. Met.
    This is the requirement DEV-292's `degradedRecapReason` work directly serves.
  - `REQ-TL-DRA-007` Preserve and version the grounded interpretation —
    **AC-007.3 unmet** (a recap result retains no inspectable version).

**Adjacent, read for contract boundaries, not graded here:**

- **Timeline** (`4c1e7728-9c36-47ee-af52-b807884763fd`) — parent; owns the
  corrected account the recap reads.
- **Voice & Interpretation Contract** (`cf885bbe-b4ce-4ba1-b6e5-4813f57949aa`) —
  the recap is a "generated activity description" under this contract.
- **Corrections** (`dd710c5b-a2f9-4a19-9a27-a83c7d40939c`) — the authority the
  recap's `analysis: false` read inherits.

The local specifications remain useful as design rationale and are **not** the
authority for acceptance:

- `docs/specs/day-recap-and-analysis.md` — status Draft for build, approved in
  direction by the owner 2026-07-22. Its `## Acceptance` section (5 prose lines)
  is what Rounds 1 and 2 graded. It is a near-subset of the Factory requirement's
  ~30 acceptance criteria, and it carries the failure narrative and the reference
  gap analysis the Factory node does not.
- `docs/specs/label-voice.md` — the voice contract `recapVoiceFindings` checks.

## Blueprints

Read from the Software Factory on 2026-08-11. The Factory holds 39 blueprints:
21 feature blueprints (one per feature requirement) and 18 architecture
blueprints (`Components` and `Containers`).

**Which of the 39 govern the recap path — nine.**

Feature layer:

- **Day Recap & Analysis** (`713e33c4-f2c9-4d79-81d6-daa1928b8bab`) — the direct
  owner. Its System Contracts name `generateDaySummary` as reachable but
  unestablished: "its implementation is absent from the tracked expected service
  path. Its source coverage, grounding, output shape, and version behavior are
  not established by this blueprint." DEV-292 landed in exactly that function and
  settles three of those four. **The blueprint is stale against the tree.**
- **Timeline** (`956a29de-1240-4256-b312-308479b427e4`) — parent. ADR-001 makes
  `DayTimelinePayload` the only activity source; the recap complies.
- **Corrections** (`db58bb95-dc6f-49d8-b0f9-d5c33040098a`) — sibling. Establishes
  the correction authority the recap's read inherits. The recap writes no account
  change, so the `CorrectionCommand` contract does not bind it.
- **Voice & Interpretation Contract** (`54e028ec-b55e-4036-9799-ddc78d568584`) —
  requires one normalized `SummaryVoice` across every generated activity
  description. **The recap does not apply it.**

Architecture layer:

- **Voice & Label Policy** (`3388b42a-94fa-4b75-b665-7b919a335fe8`) — ADR-002
  splits label voice (`labelVoice.ts`) from generated-response voice
  (`voiceContract.ts`). `recapVoiceFindings` sits on the wrong side of that line.
- **Corrected Activity Facts** (`98858637-3876-41a0-8775-4a9fc527d7be`) — ADR-002
  applies corrections at the shared query boundary, which is what makes the
  recap's `analysis: false` read trustworthy.
- **Local Data Store (SQLite)** (`a4ffe581-946e-48eb-b1ff-e97ddd46ca97`) — the
  read boundary, and the read-only semantics the recap lab's staged copy uses.
- **AI Provider Controls** (`a5463dbe-52b9-48c8-8676-fb539878e869`) — owns
  timeouts, error classification, the circuit breaker, and spend. Corroborates
  the accepted drift on the call-site timeout belt: the blueprint itself records
  that the orchestration choke point is intended rather than verified.
- **Desktop Application (Electron)** (`cb566efa-9a7c-4636-9c76-a8aac624f7b7`) —
  the container; the renderer→preload→main IPC boundary the recap request crosses.

**Checked and excluded.** Wrapped (`27e6cda8`) shares `DayTimelinePayload` but
runs a separate enrichment and validation path, so it constrains parity rather
than this path's implementation. Search & Memory, Apps, Connectors, Billing,
Screen Context, MCP Access, Export & Artifacts, Privacy, Web Companion,
Onboarding, Proactive Briefs, AI Agent and its two children, and the remaining
nine architecture blueprints hold no contract the recap path touches.
`buildDaylensMemoryPromptBlock` reads memory, but the recap consumes that block
rather than the Search & Memory contract.

The architecture path in the code, unchanged from the original execution:

- `src/main/services/aiOrchestration.ts` — `JOB_DEFINITIONS`, the single place a
  job's budget is expressed, and `jobTimeoutMs()` which reads it.
- `src/main/jobs/aiService.ts` — `generateDaySummary`, the recap call site, and
  `degradedRecapReason`, the honest-failure path.
- `src/main/ai/recapVariants.ts` — the declarative prompt variants and
  `SHIPPED_RECAP_VARIANT_ID`.
- `src/main/lib/daySummaryParse.ts` — the response contract.
- `src/shared/labelVoice.ts` — `recapVoiceFindings`, the prose-quality check.
- `tests/recap-lab/run.ts` — the iteration tool.
- `tests/ai-behaviour/realDb.ts` — read-only staging of the real database.

`docs/codebase/architecture.md` is accurate for navigation on this path and does
not conflict with the nine blueprints above.

## Referenced Blueprints

Resolved through MCP on 2026-08-11. The Day Recap & Analysis blueprint's `@`
mentions and its Component Blueprint Composition section resolve to:

- **Timeline** — composed by name through `#TimelineProjection` and
  `#MeetingResolution`. Read.
- **Corrections** — the correction stores `#DayClarificationService` writes
  through. Read.
- **Day Recap & Analysis requirements** — the `@` mention in its Feature Summary.
  Read.

The Desktop Application container blueprint's diagram references
`Voice & Label Policy`, `Corrected Activity Facts`, and `AI Provider Controls` as
cross-cutting components on the main-process path; all three are read and listed
above.

## Delivery

- Branch: `factory/v2-ship`
- Pull Request: #259
