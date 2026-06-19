# Daylens — how agents work here

Read this before you touch the repo. Then read [`PRODUCT.md`](PRODUCT.md) (the vision),
[`docs/plans/DAYLENS-V2-PLAN.md`](docs/plans/DAYLENS-V2-PLAN.md) (the 12 invariants), the
specs in [`docs/specs/`](docs/specs/), and
[`docs/plans/AGENT-EXECUTION-PLAN.md`](docs/plans/AGENT-EXECUTION-PLAN.md) (the packet
order). The invariants are physics — never break one to ship a feature.

## The goal

Daylens is broken in the ways listed in the plan. Your job is to take it from there to the
PMF vision by completing the Linear issues in the "Daylens v2" project. One issue at a time
turns into one tested feature. You are done when the issues are done and the user has
confirmed each one works on a real day.

## The loop

You run this loop without stopping to ask questions:

1. **Branch from `main`.** One branch per packet: `agent/<packet-name>`. Never commit to
   `main`. Always `git fetch` and branch from the latest `main`.
2. **Pick the lowest-numbered packet whose dependencies are all merged.** The execution
   plan says what depends on what. If nothing is unblocked, say so and stop.
3. **Build it.** Make reasonable decisions when the spec is silent — document them in the
   PR, don't stop to ask. Be ruthless about deleting legacy code; if you're not adding it
   back, it wasn't needed.
4. **Verify it for real** (quality gate below).
5. **Open a PR.** Move the Linear issues to In Review and comment on each (format below).
6. **Repeat** with the next unblocked packet.

The user's only job is to test. Everything up to the test is yours. Never ask the user a
question mid-run — make the call, write down why, and surface it when the packet is ready.

## Work in packets, never micro-PRs

A packet is **two or more related issues that add up to one testable feature = one PR.** A
PR the user can open the app and check. Never a PR per file or per function. If a change
can't be tested on its own, it belongs in a bigger packet.

## The quality gate — green tests are not truth

`npm run typecheck` must pass. That's the floor, not the proof.

**Green `npm test` does not mean the feature works.** The only proof is the running app.
For every packet:

- Drive the real Electron app (`npm start`).
- Take screenshots of what you actually see — the timeline, the block, the chat answer.
- Attach them to the Linear issue as evidence.
- If you can't visually verify something, **say so plainly.** Never claim a screen works
  when you haven't seen it work. "I couldn't reproduce this on a live day" is a real,
  acceptable answer. A false "it works" is not.

## Linear protocol

- Move an issue to **In Progress** when you start it.
- Move it to **In Review** when the PR is open.
- **Never set an issue to Done.** Only the user does that, after testing. Done means a human
  confirmed it on a real day.
- Comment on each issue when the PR is ready, in exactly this shape:
  - **What changed for you** — the user-visible difference, plain English.
  - **What to test** — numbered steps the user follows to verify.
  - **Evidence** — the screenshots you took driving the app.

## Commands that need human approval

These cost money, mutate data, or hit the AI providers. **Never run them without explicit
human approval:**

- `npm run test:behaviour`
- `npm run ai:bench`
- `npm run test:toolcalls`
- `npm run test:entity-prompts`
- Report regeneration (day/week/month recaps, wraps)
- Work-memory backfills / rebuilds

These are always safe and need no approval: `npm run typecheck`, `npm start` (running the
app), reading code, taking screenshots. `npm run timeline:eval` is safe to read; it is a
scored baseline, not a pass/fail gate.

## Language

Plain English. No role honorifics ("as requested, sir"), no agent-speak ("I shall now
proceed to..."), no walls of text. Write like the specs are written — short, specific,
grounded. Say what changed and what to test. That's it.
