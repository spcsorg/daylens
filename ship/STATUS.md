# Status

Updated 7 November 2026, 16:10. SHIP.md has had two adversarial reviews, and their findings are applied.

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

## Budgets

See `BUDGETS.md`. There's only a smoke reading so far: dev build, loaded machine, three-week world.

## Evals

Not run. Waiting on B6.

## Open PRs

| Repo | PR | State |
|---|---|---|
| irachrist1/daylens | #279 Next.js 16.4.5 | Open, mergeable (H-1) |
| spcsorg/daylens | Issue #21, design | Open |

## Spend

$0.
