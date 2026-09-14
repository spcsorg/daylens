<!--lint disable strong-marker-->

# Work Order Entity Index: WO-76

**Initialized At (UTC):** 2026-08-15T12:20:00Z
**Current Status:** in_review

## Work Order

- WO-76: [renderer] Deliver the Context Inspector surface
  (`d9f73d68-95f3-44a2-918c-ed29c850fea2`)
  Phase 3, type `build`, read through the software-factory MCP
  `read_work_order(76)`.

The work order carries one comment, flagged, recording that WO-76 was not
started in the 2026-08-11 six-lane sprint and that its backend dependency is
merged on `main` in `f4cb36ce`. The comment points at PR #122 (WO-53) noting
that `ChatAgentResult.evidence` is populated but no UI consumes it, and that
AC-AIA-002.3 is therefore "not verified end-to-end". That is the gap this work
order closes.

## Requirements

- REQ-AIA-RT-005: Inspect the context and execution of an agent answer. Read
  from the work order description returned by MCP `read_work_order(76)`. No
  separate requirements document ID was linked, so `read_requirement` was not
  called.
- REQ-AIA-002 (from WO-53) supplies the criterion this work order is graded
  against, AC-AIA-002.3, quoted below.

## Blueprints

- Agent Runtime & Context Packet (`b3ed6474-1327-4b15-b0fe-6fdb956f9868`), the
  blueprint linked on the work order. Read in full via MCP `read_blueprint`:
  all 34 lines. **It is an unfilled template.** Every section is boilerplate
  prompt text ("Summarize what this feature does from the user's perspective",
  "ADR-001: Decision Title", "**Context:** Why this decision was needed"). It
  has no feature summary, no components, no contracts and no ADRs. Nothing in
  it constrains this work order, and no contract could be built to it.

## Referenced Blueprints

Blueprints reached through links while reading the linked blueprint.

- AI Agent (`0bbc0ff1-fccd-4b18-bf28-50d0b08b67cf`), the parent named in the
  linked blueprint's frontmatter. Read in full via MCP: 152 lines. This is the
  document that actually carries the contracts, so it is what the work was
  built to. It carries six unresolved comment threads; they were listed in the
  read output but their contents were not fetched, so no claim is made about
  them.
- Corrections & Actions in Chat (`952e0de6-63d8-4c1b-a84f-518cc548064a`), the
  other child named in the AI Agent summary. Not read: the AI Agent blueprint
  states it owns confirmation and mutation mechanics, which this work order
  does not touch.

## Acceptance Criteria

The criterion this work order is graded against, from REQ-AIA-002:

- **AC-AIA-002.3:** When the person inspects an Agent answer, the AI Agent
  shall provide its Evidence citations and Tool trace **without exposing
  provider instructions, credentials, or unrelated conversation content.**

The work order's own criteria, from REQ-AIA-RT-005:

- **AC-AIA-RT-005.1:** The Context inspector shall show the resolved time
  range, entities, disclosed facts and excerpts, conflicts, gaps, permissions,
  and omitted information.
- **AC-AIA-RT-005.2:** The Context inspector shall show tool inputs, outputs,
  call provenance, and connected-source identity, subject to the same privacy
  controls as the disclosure.
- **AC-AIA-RT-005.3:** The Context inspector shall show the provider, model,
  local or remote execution status, usage, allowance, and prompt-cache
  information.
- **AC-AIA-RT-005.4:** When the Context inspector shows MCP activity, it shall
  identify the connected server and the actual call content.
- **AC-AIA-RT-005.5:** The Context inspector shall not show provider
  credentials, hidden provider instructions, security instructions, or hidden
  model reasoning.

Which of these this work order met, partially met, and did not attempt is
graded in `review-log.md`. RT-005.2, RT-005.3 and RT-005.4 are not fully met
and are not claimed.

## Blueprint Contracts This Work Order Implements

From the AI Agent blueprint's Key Contracts:

- "A `ChatAgentResult` shall retain the final answer, tool trace, citations,
  artifacts, usage, and evidence-disclosure references for the completed turn."
  WO-53 satisfied the producing half. This work order carries the
  evidence-disclosure references from that result to a durable row and then to
  the person, which is what makes "retain" observable.
- "An answer claim with a citation marker shall retain only a citation that
  resolves to a recorded evidence item for that exchange." Unchanged; the new
  surface renders bindings that were already resolved this way.

From the AI Agent blueprint's Integration Contracts:

- "`AIWorkspace` uses the desktop AI IPC handlers…" — the new data rides the
  existing `IPC.CONTEXT_PACKETS.INSPECT` handler rather than adding a channel,
  so the renderer stays a display surface and not a data boundary.

From ADR-004 ("Bind citations to the exchange evidence record"): "Displayed
citations are reliable references." This work order is the first code that
makes the word "displayed" true for non-marker claim bindings.

## Architecture Path

The existing inspection chain is already end to end and was extended rather
than duplicated:

`src/main/services/contextPacketInspection.ts`
→ `IPC.CONTEXT_PACKETS.INSPECT` handler (`src/main/ipc/ai.handlers.ts:103`)
→ `contextPackets.inspect` (`src/preload/index.ts:687`)
→ `ContextPacketInspector` (`src/renderer/components/ContextPacketInspector.tsx`)

The handler returns `inspectContextPacket(getDb(), payload)` verbatim and
preload resolves it untouched, so `ContextPacketInspection` **is** the wire
shape. Adding a field to that interface carries it the whole way with no new
channel, no new preload surface, and no second inspector. Both existing
entry points into the inspector (`AIWorkspace.tsx:642` and settings'
`ContextPacketSection.tsx:79`) pick the new section up for free.

The precedent followed for the exclusion clause is `toolsConsultedForMessage`
in the same file: it reads the persisted `ai_messages.metadata_json` for the
bound message and returns tool names and counts only, never the traced
payloads. The new `answerEvidenceForMessage` sits directly beside it and works
the same way.

## Existing Infrastructure Reused

- `src/main/agent/evidenceCoverage.ts` — `SupportedClaim`, `FactualClaim`,
  `EvidenceEntryKind`. Read, not changed. These are the in-process bindings
  WO-53 already produces.
- `src/main/agent/deterministicFacts.ts` — `DeterministicFact`,
  `DeterministicRepair`. Read, not changed.
- `src/main/agent/factClaims.ts` — read to confirm claim kinds; not changed.
- `src/main/agent/chatAgent.ts` — read; `ChatAgentResult.evidence` is consumed
  as-is. **Not changed.**
- `src/main/services/contextPacketInspection.ts` — extended, not replaced. The
  metadata read that `toolsConsultedForMessage` performed inline was lifted
  into a shared `readTurnMetadata` so the second reader does not open a second
  path to the row. `toolsConsultedForMessage`'s behaviour is unchanged.
- `src/renderer/components/ContextPacketInspector.tsx` — extended, not
  replaced. The new section reuses the file's own `sectionTitleStyle`,
  `quietTextStyle` and `badgeStyle` and its `useState`/`useEffect` +
  inline-style convention. No new state library, no new styling approach, no
  new component file.
- `src/main/jobs/aiService.ts` — one field added to the `agent` metadata the
  turn already persists. `persistTurn` and the metadata mirror in
  `src/main/db/queries.ts:666` needed no change.

## Delivery

- Branch: `wo-76/context-inspector`, based on `main-wo76` (`cf405e84`), which
  is `main` fetched from `/Users/tonny/Dev-Personal/daylens`.
- Worktree: `/Users/tonny/Dev-Personal/dl-2-entities`.
