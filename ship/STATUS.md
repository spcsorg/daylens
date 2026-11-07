# Status

Updated 7 November 2026, 21:30. Phase 1 started: CI hardened and merged; the 3-item trial is in review.

## Where it stands

| | Count |
|---|---|
| SHIP items | 132, plus 19 budgets in `BUDGETS.md` |
| ✅ Done and proven | 0 |
| 🟡 Works, not yet proven | 22 |
| 🟠 Partial | 28 |
| ❌ Missing | 60 |
| 🐞 Broken | 7 |
| ⚠️ Contradicts the docs | 7 |
| ⛔ Waiting on Tonny | 8 |

**Nothing is ✅ yet, because the oracle doesn't exist:** no packaged E2E, no visual diff, no clean VM, no evals in CI.

## What works today, seen in the demo world

On macOS from source:

- Today, with written hours, browser-history hours, gaps and Where you left off.
- Week and month.
- Search, with results grouped and keyboard hints.
- Apps, with day and week views and the detail card.
- Settings: Recording and privacy, General, Assistants, AI.
- Ask without a key.

No console errors.

## The largest gaps

1. **Windows and Linux don't run as apps.** The Windows helper isn't wired in, there's no Linux helper, and there's no Windows or Linux package (A-1, A-2, G-3, G-4).
2. **No AI feature can be proven** until an API key exists (B6). Ask without a key dead-ends on its own example question (B-8).
3. **Fixing an hour has no UI** (T-1), and the extension can't connect after install (F-2).
4. **Missing settings:** start and end of the day, notifications, the extension's connection status (S-G1, S-G2, S-G5).

## The trial run

All three items went through the full loop: implementer, two adversarial reviewers, fixer, verifier.

- **The loop works, with one fix.** Read-only droid can't run shell commands, so its first three reviews silently didn't happen. Once given a throwaway copy, it reproduced four real defects in B-8 and T-2 that the Claude reviewer and the first fixer had missed or only half-fixed. Retention was ignored on two new read paths, history-only hours were missing, and a deleted hour's correction disappeared.
- **Each verifier proved its new tests fail on `main`**, and every suite ran with 0 failures.
- **CodeRabbit added one more** on B-4: mixed address failures were reported as offline. Fixed, with a test.
- **The new Windows runner exposed one flaky test** (a 3 s wait). Fixed in #57.

## Budgets

See `BUDGETS.md`. There's only a smoke reading so far: dev build, loaded machine, three-week world.

## Evals

Not run. Waiting on B6.

## Open PRs

| Repo | PR | State |
|---|---|---|
| spcsorg/daylens | #57 CI: four runners, Swift and .NET tests, hardened | Merged |
| spcsorg/daylens | #58 Offline says offline (B-4) | Green on all four runners |
| spcsorg/daylens | #59 Ask without a key shows the hours asked about (B-8) | CI running |
| spcsorg/daylens | #60 Corrections show on unwritten hours (T-2) | CI running |
| irachrist1/daylens | #279 Next.js 16.4.5 | Open, mergeable (H-1) |
| spcsorg/daylens | Issue #21, design | Open |

## Spend

$0.
