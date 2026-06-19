# Daylens v2 — agent execution plan (packets, models, order)

The packet order. Read [`AGENTS.md`](../../AGENTS.md) first for how the loop works. Pick the
lowest-numbered packet whose dependencies are all merged, build it, PR it, move its Linear
issues to In Review.

## Which model does which work

Match the model to the risk and shape of the work:

- **Opus 4.8** — risky cross-surface rewrites where one mistake breaks the invariants: the
  block engine (P0), corrections + invalidation (P2). When in doubt, this one.
- **GPT-5.5** — backend, aggregation, resolvers, SQL: AI resolver layer (P4), frozen
  snapshots and wrap math (P5).
- **Sonnet 4.6** — frontend and React: Timeline/Apps/AI views, the wrap carousel, Settings UI.
- **Composer 2.5** — mechanical, well-specified patches: renames, prop plumbing, deleting
  dead code, label string changes.

## The build order spine

**Trustworthy blocks first, then everything fans out.** Nothing is trustworthy until P0 is
merged — every other view reads the same blocks (invariant 7), so a bad engine poisons all
of them. After P0: the day view (P1) and corrections (P2) form the spine; Apps, AI, briefs,
settings hang off it.

```
P0 blocks ──┬── P1 day view ──┬── P2 corrections
            │                 ├── P4 AI ──── P5 briefs+wraps ──── P7 monthly/annual
            ├── P3 apps        │
            └────────────────── P6 settings+trust
```

## The packets

| # | Packet | Depends on | What the user tests |
|---|--------|-----------|---------------------|
| **P0** | **Trustworthy blocks** — intent-based segmentation: 15-min idle boundaries, detours under 10m absorbed, same-intent neighbors merge, system noise invisible, session definition (merge < 2m, 30s floor), day-boundary + DST, lazy re-derive per day. | — | A real day shows ~8 blocks not 50; no `loginwindow`; Safari sessions are tens not thousands; a 42s Netflix peek doesn't flip a coding block. |
| **P1** | **Day view** — block height = duration, AI title + validator (evidence-based fallback), recap panel replaces Score/Focus/Drift, live giant block + "Analyze Day". | P0 | Blocks are sized by time, named for what you did; no grades; recap total = sum of blocks; Analyze Day splits the live block. |
| **P2** | **Corrections that stick** — rename + merge above/below, corrections-always-win across rebuilds, audit trail ("renamed from X") + undo, downstream cache invalidation. | P1 | Rename a block, rebuild the day, the name survives; undo restores it; the recap that named the old label refreshes. |
| **P3** | **Apps view** — real app name as title always, domain attributed to the hosting browser, deduped pages, work-first ordering, delete page/domain + confirm, category override propagates. | P0 | Safari reads "Safari · Browsing" every period; Netflix sits under Safari not Dia; each page appears once; a relabel shows everywhere. |
| **P4** | **AI that answers** — resolver-first (app fetches, AI phrases), Daylens voice, tables/CSV, no-credits rule, model-from-Settings, chat persists across tabs, link/artifact recall, project attribution, exclusions stripped pre-call. | P0, P1 | "What did I work on today?" answers with real times; numbers match the Timeline; chat survives a tab switch; "that link about X" resolves. |
| **P5** | **Briefs & wraps** — morning brief (2 notifications, firing rules), evening wrap (≤5 cards, 2 on a rest day), weekly wrap from frozen daily snapshots. | P1, P4 | Morning brief catches you up in one screen; weekly totals agree everywhere; "Main mode" reflects work not Netflix. |
| **P6** | **Settings & trust** — one AI model everywhere, work memory learns real varied categories, label overrides propagate, MCP off by default in packaged builds, dev-vs-packaged behavior, exclusion at resolver boundary, trust affordances. | P0 | The Settings model is used by re-analyze; memory isn't all "browsing @ 65%"; packaged build has MCP off and no dev paths. |
| **P7** | **Monthly & annual wraps** — built from frozen monthly/yearly snapshots, same voice. Sequenced last. | P5 | A month and a year wrap exist, read well, and their numbers match the weeks they sum. |

Accessibility (keyboard + screen-reader path) and the visual quality gate are **not** a
separate packet — every packet ships keyboard-completable and screenshot-verified. See
[`docs/research/open-questions.md`](../research/open-questions.md) for the reasoning behind
the cross-cutting decisions baked into P0/P2/P4/P6.
