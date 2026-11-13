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
| Private windows leave no page or title anywhere | In each supported browser and platform, use unique canary pages in private, Guest and permanent-private modes, alongside a normal window showing the same page; check observations, intervals, search, logs and diagnostics while open, after closing and after restart |
| Unknown is never treated as normal | Break the browser bridge and automation mid-session; assert no page or title is stored for that window |
| Exclusions apply before storage | Use an excluded app and site; assert only an "excluded" gap is stored |
| Deletion reaches everything | Delete a source and a range; assert observations, hours, search, Ask answers and day notes no longer contain it, and a re-import does not bring it back |
| A correction wins | Correct an hour, trigger a rewrite, reopen every screen and the MCP server; assert the correction is shown everywhere; undo restores the previous text |
| Pause is exact | Pause for one hour; assert no observations for that hour and capture resumes after |
| Nothing said in an agent session is stored | Read Claude Code and Codex logs whose prompts, replies and command output carry unique canary text; assert it appears nowhere in the database, search, logs or diagnostics |
| Screen and audio are opt-in | With both off, assert no screenshots, audio or transcripts exist; turn screen on, show a private window, an excluded app and a paused span with canary text; assert none of it appears anywhere |
| Nothing is sent with AI off | Turn AI off; assert no network calls to any AI provider |
| Usage is consistent | Use AI answers; assert the same count in Ask, Settings and the billing service |
| Payment states | Simulate success, decline, expiry, cancel and approval-during-cancel; assert the app only shows confirmed states |
| The calendar never waits | Throttle AI and network; assert the day, week and month paint facts within budget |
| Captured text cannot steer the writer | Inject instructions in a page title; assert the hour does not follow them and validation rejects invented claims |

## Platform matrix

Every release is tested on Windows 11, macOS and Linux (X11 and at least one Wayland desktop), from a packaged, signed build, never only from source.

| Environment | Used for |
|---|---|
| Windows 11 on ARM in Parallels on a Mac | Everyday development: interface, Win32 and UI Automation behavior, browser privacy tests, install and update flows |
| A Windows 11 x64 cloud desktop (a client image, not Windows Server) | Native x64 behavior, browser integrations, signed updates |
| CI runners | Builds, unit and contract tests, signature checks, installer automation. GitHub's default Windows runner is Windows Server, so it never counts as client testing |
| A physical Windows 11 x64 laptop | Battery, sleep, Modern Standby, lid close, docking, mixed scaling, antivirus, and the Windows gold day |

A gold day used for capture accuracy also records timestamped markers for app and page switches, so missed short switches and private-window leaks can be found.

Each release covers:

- Permissions denied, granted, revoked, and after an update.
- Sleep, wake, lock and clock changes.
- Multiple displays.
- Each supported browser.
- Budgets in [System design](system-design.md#budgets) measured on each platform.
- Visual comparison of every main screen across platforms: the only differences allowed are listed in [Experience](experience.md#platform-differences).

## Normal checks

```bash
(cd v2 && npm test)
(cd v2/native/macos && swift test)
(cd v2/native/windows && dotnet test)
```

AI evaluations call paid providers. They run on purpose, not on every change.

## End to end

`npm run e2e` in `v2/` drives Daylens with Playwright through every screen and query in `v2/e2e/fixtures.json`: Today's day, a past week and month, an opened hour, four searches and one by keyboard, Apps for a past day and week, Ask without a key on its three examples, every Settings tab, onboarding on an empty record, and the menu bar item's menu: the current hour, the three pauses, Resume, deleting the last 10 minutes, Open Today, Search… and Quit. Each launch gets its own throwaway pricing world at a fixed test time (`DAYLENS_TEST_NOW`), pinned to `America/Phoenix` and `en-US`, at a fixed window size.

- A test fails when its screen doesn't show the expected text where a person can see it (text CSS hides doesn't count), or the window logs a console error or throws. Errors are collected as they happen, so none is lost to Playwright's bounded buffers. The one expected error is an app with no icon: the icon protocol answers 404 by design and the window draws the fallback.
- It runs from source after `npm run app:build`, or on a packaged test build with `DAYLENS_E2E_APP` set to its executable.
- CI (`.github/workflows/e2e.yml`) runs it on the macOS test build, and on Linux from source under `xvfb-run` with Electron's sandbox helper setuid root, never `--no-sandbox`; a test checks Daylens runs without it. The Linux job then breaks a screen three times, logging an error, dropping a line and hiding a list, and checks each run fails.
- Windows doesn't run it yet: there is no Windows test build [G-3], and the app spawns its helper without a shell, so the stand-in helper can't start there [O-18].
- On macOS, Search opens from the Edit menu's Search… item, pressed from the main process: Cmd+K is a menu shortcut a test can't press. Elsewhere the window takes Ctrl+K.
- The menu bar item's menu is native and a test can't open it [O-17]. The test asks main for the menu a click would pop up and clicks its items as the menu would, failing on a disabled one; whether the menu appears on screen stays a manual check. The native confirmation before deleting the last 10 minutes is answered by the test. It runs on macOS only: on Linux the menu never opens [M-1]. Restart to Update and the assistant's question are not covered.

## Invented data and demos

Screens are checked, and Daylens is shown on camera, only on invented data, never on a real record. `v2/app/tools/worlds.ts` holds two worlds, which `v2/app/tools/seed.ts` writes through the engine's own storage:

- **Pricing memo** (the default, the launch film's world): about three weeks of an invented product manager's work on a spring pricing memo, ending today. The days vary, Saturdays are short, browser pages run throughout, and today's early hours and one evening come only from browser history. Every past hour is stored already written, so nothing calls an AI.
- **Bakery**: the same day twice, nothing written. The Ask and hour evaluations are graded on it.

`npm run demo` in `v2/` reseeds the pricing world in a throwaway folder (the system temp folder's `daylens-demo`) and starts the app on it, on macOS and Linux. Every reader of the computer's own files points at an empty folder (`HOME`, browser history, Claude Code and Codex sessions, the browser extension's socket) and a stand-in helper reports invented windows, so nothing real is read or recorded. An AI key saved in Settings stays across runs. The command prints an MCP config, and `claude --mcp-config <file> --strict-mcp-config` lets Claude Code read the same world and nothing else. The world is dated from the moment it's seeded, so today is full only late in the day.
