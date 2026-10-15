# Testing

## Gold days

A gold day is a real day that the user labeled before any AI wrote it: one line per hour, in their own words. Gold days measure whether the engine writes days people recognize.

- **The set.** At least five days of different kinds: a busy building day, a meeting-heavy day, a quiet reading or writing day, a day with lots of agent work, and at least one recorded on Windows. One whole day is held out from all tuning.
- **Freezing.** The answer key is frozen before any model runs. Packets are frozen with hashes. Corrections to a key are recorded as a new version; scores always state which version they used.
- **Scoring.** Every hour gets right, partly right, wrong, or only-the-user-could-know, with a one-line reason. Also counted: unsupported claims, invented IDs, wrong attribution (work done by an agent while the user was away), and how much correction the day needed.
- **Rerunning.** Every candidate engine and model runs on the same frozen packets before it ships. A change that lowers the score on any gold day does not ship without an explanation.

Gold-day data is personal and is kept outside this repository.

## Acceptance tests

Every promise the product makes has an automated test that fails if the promise breaks.

| Promise | Test |
|---|---|
| Private windows are never stored | Open private windows in each supported browser on each platform; assert nothing is stored |
| Exclusions apply before storage | Use an excluded app and site; assert only an "excluded" gap is stored |
| Deletion reaches everything | Delete a source and a range; assert observations, hours, search, Ask answers and day notes no longer contain it, and a re-import does not bring it back |
| A correction wins | Correct an hour, trigger a rewrite, reopen every screen and the MCP server; assert the correction is shown everywhere; undo restores the previous text |
| Pause is exact | Pause for one hour; assert no observations for that hour and capture resumes after |
| Nothing is sent with AI off | Turn AI off; assert no network calls to any AI provider |
| Usage is consistent | Use AI answers; assert the same count in Ask, Settings and the billing service |
| Payment states | Simulate success, decline, expiry, cancel and approval-during-cancel; assert the app only shows confirmed states |
| Today never waits | Throttle AI and network; assert Today paints facts within budget |
| Captured text cannot steer the writer | Inject instructions in a page title; assert the hour does not follow them and validation rejects invented claims |

## Platform matrix

Every release is tested on Windows, macOS and Linux (X11 and at least one Wayland desktop), from a packaged, signed build, never only from source.

- Permissions denied, granted, revoked, and after an update.
- Sleep, wake, lock and clock changes.
- Multiple displays.
- Each supported browser.
- Budgets in [System design](system-design.md#budgets) measured on each platform.
- Visual comparison of every main screen across platforms: the only differences allowed are listed in [Experience](experience.md#platform-differences).

## Normal checks

```bash
npm run typecheck
npm test
npm run contract:check
```

AI evaluations call paid providers. They run on purpose, not on every change.
