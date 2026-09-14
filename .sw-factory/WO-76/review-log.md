<!--lint disable strong-marker-->

# Review Log: WO-76

**Work Order:** WO-76 — [renderer] Deliver the Context Inspector surface
**Initialized At (UTC):** 2026-08-15T12:20:00Z

This file records review and verification rounds. Append new rounds; do not
overwrite prior rounds.

---

## Round 1

One review round was performed, by the implementer, directly on the working
tree. **No second reviewer and no review subagent was used.** Scope: the full
uncommitted WO-76 diff — `src/shared/types.ts`,
`src/main/agent/answerEvidence.ts`, `src/main/jobs/aiService.ts`,
`src/main/services/contextPacketInspection.ts`,
`src/renderer/components/ContextPacketInspector.tsx`,
`tests/answerEvidenceInspection.test.ts`, and `.sw-factory/WO-76/*`.

### Requirements Alignment

**Blocking:**

- None found in this round.

**Advisory:**

- **AC-AIA-RT-005.2 is not met and is not claimed.** The criterion asks the
  inspector to show tool *inputs and outputs*. It still shows tool names,
  call counts, and daylens-vs-MCP provenance only. This was a deliberate stop,
  not an oversight: an existing test in
  `tests/contextPacketInspection.test.ts` ("no credentials, provider system
  prompts, or tool trace payloads appear anywhere in the inspection") asserts
  `!serialized.includes(traceOutput)` and documents in comments that "tool
  trace payloads stay on their own surface". Adding payloads would require
  weakening that test, which this work order is forbidden to do. Whether
  payloads belong on this surface is a privacy-contract decision that deserves
  its own work order.
- **AC-AIA-RT-005.3 is not met and is not claimed.** Provider, model, local vs
  remote execution, usage, allowance and prompt-cache information are not
  shown. None of it is on the inspection's data path today, and none of it is
  needed for AC-AIA-002.3.
- **AC-AIA-RT-005.4 is partially met, as it already was.** The inspector
  identifies which tool calls came from one of the person's own MCP servers
  (the `mcp_` namespace) but does not show the call content, for the same
  reason as RT-005.2.
- **AC-AIA-RT-005.1 was already met before this work order** and is unchanged:
  time range, entities, disclosed facts and excerpts, conflicts, gaps,
  permissions and omissions all already rendered.
- The new section only appears where a context packet was recorded, because
  `ContextPacketInspection` is keyed on the packet. An answer whose packet was
  never recorded (packet ledger unavailable) shows the pre-existing "No
  context record exists for this answer" message and therefore shows no
  evidence either. That is the existing shape of the surface, not a regression,
  but it does mean evidence is not visible for every conceivable answer.

### Blueprint Alignment

**Blocking:**

- None.

**Advisory:**

- **The linked blueprint could not be built to.** Agent Runtime & Context
  Packet (`b3ed6474-…`) is an unfilled template: 34 lines of boilerplate
  prompt text, no summary, no components, no contracts, no ADRs. The work was
  built to the parent AI Agent blueprint (`0bbc0ff1-…`), which carries the real
  contracts, and to the code conventions already present in the two files being
  extended. This is recorded in `context.md` and is stated here rather than
  papered over.
- The AI Agent blueprint's Integration Contract keeps the renderer out of the
  data boundary. Honoured: the renderer gained no new IPC call, no new preload
  surface, and no new data access. It renders a field that arrived on a
  response it was already fetching.

### Code Quality

**Blocking (found and fixed in this round):**

- None. Three non-blocking defects were found and fixed:
  - The new type imports in `contextPacketInspection.ts` were inserted out of
    the file's alphabetical order. Reordered.
  - The doc comment on `projectAnswerEvidence` said it returns null "when the
    record carries no evidence at all", which is wrong: `{}` projects to an
    empty record, and only a non-object projects to null. Reworded to say what
    the code does.
  - The new evidence rows rendered statements and claim text without the
    word-breaking that `PacketItemRow` applies to exactly the same material.
    A recorded statement can contain a file path or a long unspaced
    identifier, which would have widened the fixed 640px dialog. Added a
    shared `wrappingTextStyle` and applied it to the figure, statement and
    claim text, and gave the unsupported-claim badge the same
    `maxWidth`/ellipsis/`title` treatment the identity badges already use.
    Found by reading the new markup against the existing rows, not by
    observation — see Not Verified.

**Advisory:**

- `readTurnMetadata` was extracted from `toolsConsultedForMessage` so the two
  readers share one path to the row. `toolsConsultedForMessage`'s signature and
  behaviour are unchanged, and its existing tests in
  `tests/contextPacketInspection.test.ts` still pass unmodified, which is the
  evidence that the extraction was behaviour-preserving.
- `EVIDENCE_TEXT_MAX` is 400 characters. Chosen to comfortably hold a real
  claim, evidence statement, or computed-figure sentence while making a text
  field useless as a channel for a pasted document. It is a judgement call, not
  a measured bound.
- **A second path carries this data, and it is not re-projected.**
  `src/main/db/queries.ts:666` mirrors `metadata.agent` wholesale onto
  `AIThreadMessage.agent`, so `agent.evidence` also reaches the renderer with
  thread messages. That is safe today for two reasons — the value was already
  narrowed by `toAnswerEvidenceRecord` at write time, and `grep` confirms
  nothing in `src/renderer` reads `agent.evidence` — but it is a pass-through,
  not a projection, exactly as `agent.toolTrace` has always been. If a future
  surface renders evidence from that path, it should re-project first. Noted
  rather than fixed, because changing the metadata mirror is outside this work
  order's scope and would touch every consumer of `AIThreadMessage.agent`.

### Verification

Baseline, on `main-wo76` (`cf405e84`) before implementation:

- `npm test` → **350 files · 2410 pass · 0 fail · 11 skip**, exit 0.

After implementation:

- `npm run typecheck` → clean, no output, exit 0.
- `npm run lint` → **0 errors, 128 warnings**. Byte-identical to the baseline
  count, which was re-measured on a stashed tree in the same session to be
  sure. None of the 128 warnings is in a file this work order touched; all are
  pre-existing `@typescript-eslint/no-explicit-any` warnings elsewhere.
- `npm test` → **350 files · 2410 pass · 0 fail · 11 skip** at baseline,
  **351 files · 2416 pass · 0 fail · 11 skip** after, exit 0. The delta is
  exactly the one new file and its six tests. No existing test file was
  modified, weakened, skipped or deleted (`git diff` touches no file under
  `tests/` other than the new one).
- `npm run timeline:eval -- --strict` → exit 0, unchanged from `main`.

**Mutation check on the test that carries the guarantee.** A clean payload
proves nothing unless the test would notice a dirty one, so the enforcement was
deliberately broken and the suite re-run. `projectAnswerEvidence` was edited to
`return row as unknown as ContextPacketAnswerEvidence` — the exact regression a
future maintainer would introduce by "simplifying" the projection into a cast.
Result: `4 pass, 2 fail`, with "the read projection drops every key it does not
name" failing on `the projection let HIDDEN_PROVIDER_DIRECTIVE_9f2c through`.
The mutation was reverted and the file restored.

This check also established something worth stating plainly: **the end-to-end
test alone would NOT have caught that regression.** It passes either way,
because WO-53 keeps the secrets out of the agent result upstream. Only tests 3
and 4, which plant secrets in the persisted row itself, fail. That is why both
kinds of test are in the file, and it is the honest answer to "is the exclusion
clause enforced at the boundary or only inherited from upstream?" — it is
enforced at the boundary, and there is a failing test to prove it if the
enforcement is removed.

### Not Verified

Recorded honestly rather than claimed:

- **No human has looked at the new section in the running app.** The desktop
  app was not launched. Launching it would read the owner's live database,
  which this work order is forbidden to touch. The rendering is therefore
  verified by type-checking and by reading the code against the surrounding
  file's conventions, not by observation. Layout, spacing, wrapping behaviour
  with long identities, and dark/light appearance of the new amber "replaced"
  and "unbacked" treatments are all unobserved. This is a real coverage gap.
- **There is no renderer unit test.** The repo has no React testing setup
  (`tests/` is all node:test over main-process and shared modules), and adding
  one is out of scope. `AnswerEvidenceBody` is covered only by typecheck.
- **No test drives the real IPC handler or preload.** The claim that the
  inspection object crosses those hops unchanged rests on reading
  `ai.handlers.ts:103` (`return inspectContextPacket(getDb(), payload)`) and
  `preload/index.ts:687` (`ipcRenderer.invoke(...)` with no transform), not on
  executing them. Both are pass-throughs with no projection of their own, so
  there is nothing at those hops that could narrow or widen the payload — but
  that is an argument from reading, not a test.
- **The end-to-end test persists the turn the way `aiService` does rather than
  calling `sendMessage`.** It writes the same `agent` metadata object with the
  same `toAnswerEvidenceRecord` call, but it is a reconstruction of that code
  path, not that code path. If `aiService` later stops passing `evidence`, this
  test would not fail.

### Verdict

**Approved for commit, with the gaps above stated rather than closed.**

AC-AIA-002.3 is met end-to-end: the evidence citations and the tool trace both
reach the person, and the exclusion clause is enforced by a projection at the
boundary the renderer reads, with a test that fails when that projection is
removed.

AC-AIA-RT-005.2, RT-005.3 and RT-005.4 are not met. They are separate scope and
are not claimed.
