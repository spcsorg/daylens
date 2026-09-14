<!--lint disable strong-marker-->

# Implementation Plan: WO-76

**Work Order:** WO-76 — [renderer] Deliver the Context Inspector surface
**Branch:** `wo-76/context-inspector` from `main-wo76` (`cf405e84`)

## The Problem

`ChatAgentResult.evidence` is populated on every chat turn and then thrown
away. `src/main/jobs/aiService.ts` builds the persisted `agent` metadata by
naming fields one at a time — `toolTrace`, `stepCount`, `groundingRetried`,
`fileDisclosures`, `contextPacketId`, `citations` — and `evidence` is simply
not among them. Nothing in `src/renderer`, `src/preload` or `src/main/ipc`
mentions it. A person inspecting an answer sees the packet, the tool names,
the omissions, the conflicts, the gaps and the permissions, but nothing about
which of the answer's own claims rest on what.

So AC-AIA-002.3's first half ("provide its Evidence citations and Tool trace")
is half-built: the tool trace is surfaced, the claim-level evidence is not.

Its second half — the exclusion clause — is the harder problem, and it is a
problem about hops rather than about computation. WO-53 proved the agent's
in-process result is clean. That proof does not transfer: each new hop
(persist → read back → IPC → preload → render) is a fresh opportunity to
widen the payload, and a wholesale `JSON.parse` of a metadata row followed by
"return it" would reintroduce the leak while every upstream test stayed green.

## The Approach

One idea: **the shape is the enforcement.**

Rather than carrying the agent's evidence object and filtering sensitive
things out of it, define a renderer-facing shape that has nowhere to put them,
and rebuild that shape explicitly at each boundary. A projection with no
`systemPrompt` field, no `apiKey` field and no `history` field cannot leak one
regardless of what the source object holds, and it stays that way when someone
later adds a field upstream — the new field is simply not copied.

Two projections, in the two directions:

1. **Write side** (`src/main/agent/answerEvidence.ts`,
   `toAnswerEvidenceRecord`). Turns `ChatAgentResult.evidence` into
   `ContextPacketAnswerEvidence` before it is persisted, so the durable row
   never holds the turn's in-process state (fact ids, dimensions, raw seconds,
   scanner offsets).
2. **Read side** (`contextPacketInspection.ts`, `projectAnswerEvidence`).
   Rebuilds `ContextPacketAnswerEvidence` from the parsed row field by field,
   with union members checked against their member lists, free text bounded,
   and malformed rows dropped. By read time the row is untrusted JSON: it is
   whatever some writer — past, future, or wrong — put there.

The second projection is the one that carries the guarantee. It is why the
exclusion clause is enforced *at* the boundary rather than only upstream of
it.

## Steps

1. **`src/shared/types.ts`** — add the renderer-facing shape:
   `ContextPacketClaimKind`, `ContextPacketEvidenceSource`,
   `ContextPacketSupportedClaim`, `ContextPacketUnsupportedClaim`,
   `ContextPacketComputedFigure`, `ContextPacketAnswerEvidence`. Add
   `answerEvidence: ContextPacketAnswerEvidence | null` to
   `ContextPacketInspection`, and `evidence?: ContextPacketAnswerEvidence` to
   `AIThreadMessageMetadata['agent']`.

2. **`src/main/agent/answerEvidence.ts`** (new) — `toAnswerEvidenceRecord`.
   Each `DeterministicFact` becomes a computed figure; a `DeterministicRepair`
   matching on `factId` supplies its `replaced` value, which is what makes the
   difference between "this figure was checked" and "this figure was
   corrected" visible. `chatAgent.ts` is not touched.

3. **`src/main/jobs/aiService.ts`** — one line in the `agent` metadata object:
   `evidence: toAnswerEvidenceRecord(agentResult.evidence)`. Narrowed here, at
   the write, so the un-narrowed form never reaches the database.

4. **`src/main/services/contextPacketInspection.ts`** — lift the inline
   metadata read out of `toolsConsultedForMessage` into `readTurnMetadata`
   (behaviour unchanged), then add `projectAnswerEvidence` and
   `answerEvidenceForMessage` beside it, and set `answerEvidence` in
   `assembleContextPacketInspection`.

5. **`src/renderer/components/ContextPacketInspector.tsx`** — a "What backed
   the answer" section between "Tools consulted" and "Considered and not
   sent". Four subsections, each shown only when it has content: figures
   Daylens computed (with what the model wrote first, when it was replaced),
   claims traced to evidence (with the statement each resolves to and its
   identity), claims nothing backs, and what the answer admitted. Honest
   absence in both directions: `null` says no turn record carries evidence;
   an all-empty record says the answer stated nothing to trace.

6. **No new IPC.** `IPC.CONTEXT_PACKETS.INSPECT` returns
   `inspectContextPacket(...)` verbatim and preload resolves it untouched, so
   the field rides the existing channel.

## What Was Deliberately Not Done

- **Raw tool inputs and outputs are not added to the inspector** (AC-AIA-RT-005.2).
  An existing test —
  `tests/contextPacketInspection.test.ts`, "no credentials, provider system
  prompts, or tool trace payloads appear anywhere in the inspection" —
  asserts `!serialized.includes(traceOutput)` and states in comments that
  "tool trace payloads stay on their own surface — the inspection carries tool
  NAMES only". Adding payloads here would require weakening that test, which
  this work order is forbidden to do, and is a decision about the privacy
  contract rather than about the inspector's layout. Left for its own work
  order.
- **Provider, model, usage, allowance, prompt cache** (AC-AIA-RT-005.3) are
  not added. Out of scope for AC-AIA-002.3 and none of it is on the
  inspection's data path today.
- **`chatAgent.ts` is not modified.** The evidence it produces was already
  correct; this work order is the carry, not the computation.

## Testing

New file `tests/answerEvidenceInspection.test.ts`, six tests.

The subject is the carry, so the tests plant secrets at the top of the chain
and look for them at the bottom. Every planted value is synthetic; the
key-shaped ones are deliberately key-shaped so a substring search would find a
real leak, and deliberately not real keys.

1. **The end-to-end exclusion test.** Run a real turn through
   `runChatAgentTurn` with a system directive in `extraSystem`, a
   credential-shaped `config.apiKey`, a credential-shaped key in settings, and
   unrelated prior thread history. Persist it exactly as `aiService` does, plus
   a *sibling* assistant message in the same conversation holding unrelated
   content — inspection addresses one message and must not sweep the thread.
   Link the packet, inspect, and assert the serialized inspection contains none
   of the six planted values, no `sk-ant` fragment, and none of the system
   prompt's distinctive lines. Then assert it is not vacuously clean: the
   computed figure survived, and it records that the model's "6 hours" was
   replaced.
2. **The bindings are real.** A second turn, asserting every bound claim names
   an identity, carries the statement it resolves to, and has a source and
   kind from the expected member lists; and that the tool trace is still
   alongside it (AC-AIA-002.3 asks for both).
3. **The read projection drops every key it does not name.** Feed
   `projectAnswerEvidence` a row with `providerInstructions`, `credentials`,
   `conversationHistory`, and extra keys nested *inside* otherwise-valid rows.
   Assert none survive and that the named fields still come through intact.
4. **The read projection drops malformed rows** rather than rendering them
   half-built: missing required fields, non-member union values, blank text,
   a non-list where a list belongs, and a 5,000-character text field that must
   come back bounded. `undefined`, a string, and an array all project to
   `null`.
5. **A turn with no evidence recorded reads as `null`**, not as empty
   coverage — a pre-WO-53 answer must not look like an answer with nothing to
   back.
6. **The write projection** pairs each repair with its figure and leaves
   internal working state (`id`, `dimension`, `value`, `seconds`, `factId`)
   inside the turn.

Tests 3 and 4 are the ones that carry the guarantee, because they plant
secrets *in the persisted row itself*. Test 1 would still pass if both
projections were deleted, since WO-53 keeps the secrets out upstream; tests 3
and 4 would not. This was verified by mutation, recorded in `review-log.md`.
