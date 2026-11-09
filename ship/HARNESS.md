# The test harness

The rules for building the oracle: E2E, visual diff, skip linking, flake detection and the heavy-user world. Every harness agent reads this and `RULES.md` first. Where this file and the code disagree, the code is checked and this file is fixed.

## What already exists

- The app takes its data folder, shell folder, browser-history home, agent folders and capture helper from the environment: `DAYLENS_V2_DATA_DIR`, `DAYLENS_SHELL_DIR`, `DAYLENS_V2_HISTORY_HOME`, `HOME`/`XDG_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `DAYLENS_V2_BROWSER_SOCKET` and `DAYLENS_HELPER`. `app/tools/demo.ts` sets all of them. A release build honours them too today.
- `app/tools/seed.ts --data-dir <dir> [--world pricing|bakery] [--now <ISO>]` writes an invented world through the engine's own storage. It reads the host's timezone and stamps `written_at` and the change log with the real time.
- `app/tools/demoHelper.ts` (run through `demo-helper.sh`) stands in for the native helper. It stamps every line with the real time and switches windows every 90 s.
- The capture service takes its wall time from the helper's lines.
- `app/package/build.ts` packages macOS only, as a universal app, with the Node inspector fuse off. Windows and Linux have no package yet (G-3, G-4).
- `app/tools/bench.ts` launches the app with `DAYLENS_BENCH=1` and reads timing marks; `--app` points it at a packaged build. It doesn't isolate the app from the real home folder, and it reports success when marks are missing or the app exits with an error.

## Decisions

1. **One way to launch Daylens on an invented world.** A shared module (`app/tools/world.ts`) seeds a world into a throwaway folder and returns the environment to launch with. `demo.ts`, the E2E fixtures and `bench.ts` all use it, so they never drift.
   - It sets every variable `demo.ts` sets today, and on Windows also `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and a `\\.\pipe\` name for the browser socket.
   - It removes `ELECTRON_RUN_AS_NODE`, as `bench.ts` does.
   - It pins `TZ=America/Phoenix` (no daylight saving) and `LANG`/`LC_ALL=en_US.UTF-8` for the seed and the app. E2E passes the same `timezoneId` and `locale` to Playwright.
   - It takes the app's starting state (onboarded or not, appearance, paused) and writes it into `shell.json`, so E2E needs no seed changes for onboarding, paused or empty screens.
2. **A test clock.** `DAYLENS_TEST_NOW=<ISO time>` moves every process's now to that moment, and time moves forward from there.
   - Main reads it once and computes one offset (`test now − Date.now()`). It hands the offset, not the time, to the capture service and the reader by argv, to the renderer through `webPreferences.additionalArguments` read synchronously in the preload, and to the stand-in helper through its environment. No process computes its own offset.
   - The stand-in helper adds the offset to every time it writes.
   - The renderer's first paint already uses the test clock.
3. **Test builds and release builds.** `app:package --test --dir` makes a test build for the host's architecture only. `app:package` makes a release build.
   - Only a test build or a run from source honours `DAYLENS_TEST_NOW`, `DAYLENS_V2_DATA_DIR`, `DAYLENS_SHELL_DIR` and `DAYLENS_HELPER`. A release build deletes all four from its environment before anything reads them or any process starts.
   - A test build turns the Node inspector fuse on, so Playwright can attach. A release build keeps it off.
   - A test build never imports V1's settings, never registers a login item, and never looks up icons on the host (`mdfind`, `getFileIcon`): every app shows its fallback icon.
   - The release package has no `app/tools/` code in its `app.asar`.
   - `app/package/checkRelease.ts` proves all of this on a release build: `@electron/fuses read` shows the inspector off, `@electron/asar list` shows no `app/tools/`, and the app launched with the world environment, `DAYLENS_TEST_NOW=2001-01-01T12:00:00Z` and `DAYLENS_BENCH=1` reports the real time and its default data folder on its bench line. It runs in `e2e.yml`. G-3 and G-4 run it on their packages.
4. **E2E runs on Playwright.** It uses the latest stable `@playwright/test` with `_electron.launch`:
   - The tests live in `v2/e2e/`. `npm run e2e` runs them.
   - Screens and queries are listed in `v2/e2e/fixtures.json`, not inside the tests.
   - The window size is set with `BrowserWindow.setContentSize` through `electronApp.evaluate`, and checked before each test.
   - One test launches with `DAYLENS_TEST_NOW`, waits for one stand-in focus line, and asserts its stored wall time falls in the test hour. Another asserts the login item stays off.
   - **macOS (`macos-15`):** the packaged test build.
   - **Linux (`ubuntu-24.04`):** from source under `xvfb-run -a -s '-screen 0 3200x2000x24'`, after `npm run app:build`, with Electron's `chrome-sandbox` made setuid root, never `--no-sandbox`. This is a named gap in O-7 until G-4 adds a package.
   - **Windows:** skipped, with the reasons and their SHIP IDs: no package (G-3), and the stand-in helper can't start there, because the app spawns its helper without a shell (new SHIP item).
   - **The tray** is a native menu Playwright can't open. It's a named gap in O-7, under its own new SHIP item.
   - The PR marks O-7 as partial and lists these gaps.
   - The tests run in their own workflow file, `.github/workflows/e2e.yml`, never in `v2.yml`. It leaves Electron's binary download on.
5. **Visual diff.** Playwright `toHaveScreenshot`, after E2E is green:
   - `maxDiffPixelRatio: 0.001`, `threshold: 0.05`, `scale: 'device'`, animations and the caret disabled, and `updateSnapshots: 'none'` in CI, so a missing baseline fails.
   - Every fixture also asserts its key text through the DOM.
   - Light and dark through `emulateMedia({ colorScheme })` with Appearance set to Match system.
   - Window sizes 900×640, 1120×720 and 1440×900, at 1× and 2× through `--force-device-scale-factor`.
   - Fixtures show past days and past weeks of the world. Only the Today day fixture shows today, with the stand-in in `DEMO_STILL=1` (no timed window switches) and every `[data-live]` element (the live hour and its durations, marked by the foundation) masked.
   - Visual tests run on `macos-15` and `ubuntu-24.04`. Baselines live in `v2/e2e/__screenshots__/<runner label>/`, set through `snapshotPathTemplate`.
   - A manual `workflow_dispatch` job renders new baselines and uploads them as an artifact. The stream agent commits them to its branch and pushes to `spcsorg`, so the checks run as usual.
   - Every PR that adds or changes baselines shows each fixture's macOS and Linux shots side by side. Each difference is either listed in `docs/experience.md#platform-differences` or fixed.
   - The demo world is invented, so the baselines are safe to commit.
6. **Skips point to SHIP items.** Checked at run time, not by reading the source. Each `v2.yml` job runs `npm test` with a TAP reporter written to a file, and `tools/skips.ts` fails on any SKIP or TODO whose reason lacks a SHIP ID in brackets (`'no SIGSTOP on Windows [A-19]'`). A boolean `skip` has no reason, so it fails too. Environmental skips, such as a locked screen, need an ID like any other.
   - CI builds the macOS helper before `npm test`. The PR first runs the helper tests on the CI images. A test that then fails only for something a runner lacks (the window-title grant, installed apps) gets a precise skip condition and a linked reason. Its assertions don't change.
7. **Flakes are found every night.** `.github/workflows/nightly.yml` runs on a schedule and on `workflow_dispatch`.
   - A matrix of the four runners × 20 run numbers, each job running `npm test` once with `timeout-minutes: 30`.
   - A final job merges the results, writes each failing test's name and count to the job summary, and opens or updates one GitHub issue per failing test, titled with its name and labelled `flake`. Any failure fails the run.
   - It copies `v2.yml`'s setup steps after the Skips stream merges. It doesn't call `v2.yml`, which runs the whole check suite.
8. **A heavy-user world for speed.** `seed.ts --world heavy` writes 90 days ending at `--now`: 12 hours a day, 40 apps, 3,000 page visits a day, agent sessions, and written hours for past days.
   - It is deterministic. The seed gives `Storage` a clock derived from `--now` and stores the pinned timezone. Two runs with the same `--now`, on two machines, give the same SHA-256 of `sqlite3 <db> .dump | sort`.
   - It seeds in under 5 minutes on an M-series Mac.
   - The bench runs a packaged test build on the world, with `DAYLENS_TEST_NOW` set to the world's `--now`, through `world.ts`'s environment.
   - `bench.ts` defaults to 100 runs and reports p50, p95 and p99 for every mark. It fails when a mark is missing, not a finite non-negative number, or the app exits with an error. `--json <file>` writes the results.
   - `.github/workflows/bench.yml` runs the packaged bench in CI.

## Who owns which files

Parallel streams never edit the same file. The foundation, Skips, Flakes and heavy world run in parallel. E2E and visual is one stream: it starts when the foundation merges and does O-7, then O-8. Flakes starts its workflow after Skips merges. The heavy world does `seed.ts` first and moves `bench.ts` onto `world.ts` after the foundation merges.

| Stream | Owns |
|---|---|
| E2E foundation (O-14, the clock) | `app/tools/world.ts`, `app/tools/demo.ts`, `app/tools/demoHelper.ts`, `app/tools/demo-helper.sh`, `app/package/build.ts`, `app/package/checkRelease.ts`, the clock module and its call sites in `app/main`, `app/preload`, `capture`, `app/reader`, `app/renderer`, `docs/system-design.md` |
| E2E (O-7), then visual (O-8) | `v2/e2e/**`, `.github/workflows/e2e.yml`, `v2/package.json`, `v2/package-lock.json`, `docs/testing.md`, `docs/experience.md` |
| Skips (O-5) | `v2/tools/skips.ts`, the skip reasons and conditions in `v2/tests/**`, `.github/workflows/v2.yml` |
| Flakes (O-6) | `.github/workflows/nightly.yml` |
| Heavy world (I-0) | `app/tools/seed.ts`, `app/tools/worlds.ts`, `app/tools/bench.ts`, `.github/workflows/bench.yml` |

Only the E2E stream adds dependencies. Each stream lists its decisions in its PR; the owner of the matching doc records them there.

If a stream needs a file another stream owns, it stops and reports. It doesn't edit.

## What counts as done

- Every new script runs in CI and fails when it should. Each PR shows a deliberate failure and the passing run.
- No test is skipped, weakened or deleted.
- Each PR description lists what was tested on each OS and what's left for later, with the SHIP IDs.
