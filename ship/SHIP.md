# Ship V2

Every item left before Daylens V2 is public, grouped by work stream. An item is done only when its acceptance test passes in CI or on a clean VM and a separate verifier reruns it.

Status as of 7 November 2026, from four spec-against-code audits, a run of every screen in the demo world, and the test suite. Paths are under `v2/`.

**Status:** ✅ done and proven · 🟡 works, not yet proven · 🟠 partial · ❌ missing · 🐞 broken · ⚠️ contradicts the docs · ⛔ blocked on Tonny

**Bar:** every feature works end to end, every AI feature included, on every platform the release ships on.

## Decisions waiting on Tonny

These change what is in scope. See `BLOCKERS.md`.

| ID | Decision | Items it settles |
|---|---|---|
| D1 | Beta gate on 20 November, or the full release checklist | G-3, G-4, F-8, R-1 to R-6 |
| D2 | Accounts, billing and usage analytics in V2 | C-1, S-G7, S-G8 |
| D3 | Windows through the Store only, or a signed installer too | G-3 |
| D5 | Screen and audio capture (build step 1d): in V2 or later | A-12, S-G6 |

## Oracle: tests, CI and harness · stream I

Nothing else is proven until these exist.

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| O-1 | The full suite passes on all three operating systems | `npm test` green on every CI job | 🟡 macOS, 7 November: 827 of 827 passed, 0 skipped, typechecks clean. All three operating systems green in CI on 31 October (run 41226910911) |
| O-2 | CI covers macOS on Apple silicon and Intel, Windows x64 and Ubuntu 24.04 | The matrix lists `macos-15`, `macos-15-intel`, `windows-2025`, `ubuntu-24.04`, all green | 🟠 Today: `macos-latest`, `ubuntu-latest`, `windows-latest` only |
| O-3 | Swift tests run in CI | The macOS job runs `swift test` in `native/macos` | ❌ Not in `.github/workflows/v2.yml`. Locally: 44 of 44 pass |
| O-4 | .NET helper tests run in CI | The Windows job runs `dotnet test native/windows` | ❌ Not in the workflow |
| O-5 | No test is skipped without a SHIP item | A script lists every `skip:` and fails if any lacks a SHIP ID | 🟠 18 platform skips, none linked: `store.test.ts:331`; `service.test.ts:112,133,359,376,380`; `supervisor.test.ts:176`; `agents/host.test.ts:25,42,54,65,88,111`; `agents/reader.test.ts:116`; `agents/memory.test.ts:8`; `mcp/server.test.ts:95,179`; `mcp/clients.test.ts:145`. Plus a runtime skip at `realHelper.test.ts:192` |
| O-6 | No flaky tests | A nightly job runs every test 20 times on each OS, and any failure opens a SHIP item | ❌ |
| O-7 | Electron E2E against the packaged app on the demo world | Playwright drives the packaged build through every screen on three operating systems, in CI | ❌ No E2E exists |
| O-8 | Visual regression | Every screen in light and dark, at 3 window sizes, at 1× and 2×, diffed against stored baselines | ❌ |
| O-9 | Clean-machine install | A fresh VM per OS installs, onboards, records 10 minutes of scripted activity, checks Today, Search and Ask, updates to a newer build, then uninstalls | ❌ |
| O-10 | AI evals run nightly on a real key under a spend cap | `npm run eval:hours` and `npm run eval:ask`, 5 runs each, with pass rate and variance written to STATUS | ❌ No npm scripts, no job. Needs `DAYLENS_TEST_ANTHROPIC_API_KEY` ⛔ B6 |
| O-11 | Network egress with AI off | The packaged app runs a scripted day with AI off behind a recording proxy: zero outbound requests except a signed update check | ❌ |
| O-12 | Performance benches ratchet in CI | Each budget in `BUDGETS.md` has a bench that fails CI above its ceiling, and a daily job lowers the ceiling | 🟠 `app/tools/bench.ts` measures but checks nothing |
| O-13 | CI is hardened | `permissions: contents: read`; `persist-credentials: false`; actions pinned by SHA | ❌ None of the three |

## A · Capture engine

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| A-1 | The Windows helper runs inside the Windows app | The packaged Windows app records app, title, idle, lock and sleep on the Windows 11 VM; E2E reads them back | ❌ `app/main/paths.ts:30` always starts `daylens-capture-macos` |
| A-2 | A Linux capture helper for X11 and Wayland, with limits documented | On Ubuntu 24.04 under X11 and under GNOME Wayland, the app records the active app and title (or documents in `docs/system-design.md` exactly what Wayland withholds) | ❌ `native/` has macOS and Windows only |
| A-3 | Browser history readers work on Windows and Linux | Fixture history databases for Chrome, Edge and Firefox at each OS's real paths are read correctly in CI on that OS | 🟡 Tested on macOS paths only |
| A-4 | Private windows leave no trace | The canary suite from `docs/testing.md` passes in every browser on every platform | 🟠 Storage-level tests only |
| A-5 | Unknown windows are never treated as normal | A test breaks the bridge mid-session, then asserts no page or title is stored | 🟡 Needs a per-platform run |
| A-6 | Exclusions apply before storage, and pause is exact | Property-based tests across every capture path store 0 bytes while paused, excluded or past retention | 🟠 `storage/acceptance.test.ts:222,248,385,401` cover examples, not properties |
| A-7 | Deletion is gone from disk | After deleting, a disk scan finds no canary in the database, WAL, FTS shadow tables or free pages | ❌ No disk scan |
| A-8 | `writeHour` tells apart visits before and after a deletion in the same hour | A test deletes mid-hour, then rewrites; no visit from before the deletion returns | 🟡 Reported limitation, unverified |
| A-9 | No misattributed app switches | A replay corpus of recorded event streams with timestamped markers gives 0 misattributions | ❌ No corpus |
| A-10 | Gaps name "permission lost" | Revoking Accessibility mid-session shows a "permission lost" gap | 🟠 Reasons in `queries.ts:217-236` lack it |
| A-11 | Default exclusions match the docs | Either banking sites are seeded or `docs/privacy-and-security.md` stops promising them | ⚠️ `capture/defaults.ts:11` |
| A-12 | Screen and audio capture, off by default | The acceptance test in `docs/testing.md` passes on every platform | ❌ Not built. ⛔ D5 |
| A-13 | Agent sessions never store what was said | The canary test passes on all three operating systems | 🟠 6 tests skipped on Windows (`agents/host.test.ts`) |

## B · AI on the person's own key

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| B-1 | Add, test and remove a key in onboarding and Settings | E2E with a real key: add, test and remove each succeed, and Ask and hours stop on removal | 🟡 `ipc/ai.ts:53-75`; IPC and UI untested ⛔ B6 |
| B-2 | Replace a key in one step | E2E: paste a new key over the saved one | 🟠 Needs Remove first (`AiTab.tsx:91-125`) |
| B-3 | A key with no credit is caught when saved | A stubbed no-credit response at save shows the no-credit message | 🐞 The check calls `models.list`, which passes (`backends.ts:91-97`) |
| B-4 | Offline says offline | With the network cut, Ask and key save both say you're offline | 🐞 The "Connection error." message misses the regex at `Ask.tsx:70`; key save shows the raw error |
| B-5 | Rate limit and no credit are told apart | Each stubbed response shows its own message | 🟠 One message for both (`Ask.tsx:69`) |
| B-6 | Hour-writing failures reach the UI | A failing write shows a quiet status on Today with what to do | ❌ Log only (`hourWriter.ts:125-128`) |
| B-7 | An AI error still shows search results | Stub an error; the matching results show under the message | ❌ `Ask.tsx:192-198` |
| B-8 | Ask without a key is useful for its own examples | With no key, "What did I do this morning?" lists this morning's hours | 🐞 Seen in the demo: "No page, file or hour matched those words." |
| B-9 | Example questions lead with finding things | The examples follow `docs/experience.md` | ⚠️ All three are summaries (`Ask.tsx:15`) |
| B-10 | Timesheets and reports | "my hours on the pricing memo this week" drafts time per piece of work, with its hours, ready to copy; an eval case | ❌ No code |
| B-11 | Every citation opens | File and window citations open like pages | 🟠 Dropped at `Ask.tsx:266-269` |
| B-12 | Usage and token spend in Settings › AI | This month's usage split by hours and Ask, with spend, matching the ledger | ❌ `AiTab.tsx` shows the key only |
| B-13 | "Things you told Daylens", each removable | Shown in Settings › AI; removing one changes the next answer | ❌ |
| B-14 | The in-app AI disclosure matches the docs exactly | A test compares the Settings text with the table in `docs/privacy-and-security.md` | ⚠️ Settings names apps, titles and times. The docs also send addresses, agent sessions, commit messages, calendar events and the previous hour's text |
| B-15 | AI-written hours meet the bar | Hour eval ≥ 95% pass across 5 runs; 0 unsupported claims on the gold set; every statement cited | 🟡 18 cases (`tools/eval/hours.ts`); not run ⛔ B6, T1 |
| B-16 | Ask meets the bar | Ask eval 100% grounded across 5 runs; correct refusal without evidence | 🟡 18 questions × 2 (`tools/eval/ask.ts`); no timesheet or find-a-page cases ⛔ B6 |
| B-17 | The eval set grows from real failures | Each real failure gets a gold case before its fix | ❌ No process |

## C · Accounts

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| C-1 | Accounts decided, then shipped fully or left out | `ship/ACCOUNTS.md` decided by Tonny. If they're in: Playwright covers sign up, verify, sign in, sign out (every token cleared), reset, expiry, deletion and multi-device, plus rate limits and abuse tests | ⛔ D2 |

## D · App screens

### Today, week and month

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| T-1 | Fix an hour | E2E: open an hour, Edit, "What were you doing?", save. The title changes in Today, Search, Ask and over MCP; "Edited" shows; Undo restores | ❌ No UI (`Today.tsx:176-198`); storage and undo exist |
| T-2 | Corrections show on facts-only hours | A correction to an unwritten hour shows on Today and in the week view | 🐞 `queries.ts:225` skips hours that aren't written |
| T-3 | The open hour shows its outcome and suggestion | A written hour with an outcome and a suggestion shows both, with the checklist | ❌ Stored, never read |
| T-4 | Remove one source, not its whole site | Removing one page leaves other pages from that site | ⚠️ `records.tsx:175-177` removes the site or app |
| T-5 | Ask about unreadable browser time | A 20-minute unexplained browser span offers the question, "Leave it" and the extension | ❌ |
| T-6 | The current hour shows live facts | The current hour's summary is its two longest titles, updating live | 🟠 Seen in the demo: "Recording now." |
| T-7 | Week and month show time per piece of work | Labeled time per piece of work | ⚠️ Seen in the demo: "Time by app" |
| T-8 | Month days show their main pieces of work | Each day lists work, not apps | ⚠️ Seen in the demo: two app names per day |
| T-9 | The week keeps the repeated hour at a clock change | A fall-back day's week view shows both 1 AM hours | 🐞 Matched by `getHours()` (`Today.tsx:258`) |
| T-10 | Every app shows its icon | Apps that aren't installed get a fallback icon, never a blank square | 🐞 Seen in the demo: `daylens-icon://app/com.google.Chrome` returns 404 and renders grey |
| T-11 | Files reopen on Windows and Linux | Clicking a file source reopens the file there | 🟠 macOS only (`ipc/core.ts:33-44`) |
| T-12 | The interface rules hold | Destructive confirms are one line; busy buttons spin at the same width; no menu repeated on every row | 🟠 `records.tsx:131-138,194-222` |

### Search

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| Q-1 | Search works end to end | E2E opens with Cmd+K or Ctrl+K and runs four queries; keyboard, Show more and Escape work | 🟡 Seen working in the demo; no E2E |
| Q-2 | Each result shows its hour | The hour title shows under every result | 🟠 Only kind, app and time (`Search.tsx:142`) |
| Q-3 | The example uses everyday words | The placeholder is a lowercase, half-remembered search | ❌ `Search.tsx:151` |

### Apps

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| P-1 | Apps works end to end | E2E: day and week views, detail card, hour strip, week bars that open days, remove an app's day with a confirm | 🟡 Seen working in the demo; no E2E |

### Settings

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| S-G1 | Start and end of the day | Settings changes them; Today, "until tomorrow" pause and notifications follow | ❌ `storage/index.ts:50` |
| S-G2 | Morning and evening notifications, with times | Both fire at their set times on every OS | ❌ Only assistant-request notifications exist |
| S-G3 | Launch at login on every OS | On, it starts at login to the tray on macOS, Windows and Linux | 🟠 Linux refused; Windows always opens the window |
| S-G4 | Apps whose window titles are kept | The row exists and adding an app says its private windows could be recorded | ❌ Storage only (`keptTitles.test.ts`) |
| S-G5 | Browsers and their extension connection | Each browser found, its connection, and one click to add | ❌ History row only (`RecordingTab.tsx:84`) |
| S-G6 | Screen and audio switches | Off by default, asking for permission when turned on | ❌ ⛔ D5 |
| S-G7 | Usage analytics switch | Matches whatever D2 decides is promised | ⚠️ The docs say on by default; the beta promises none. ⛔ D2 |
| S-G8 | Plan tab | Only if D2 brings billing in | ⛔ D2 |
| S-G9 | Log of what was sent to AI | Each AI call listed with time and purpose | ❌ The beta excuses it in the docs. ⛔ D1 |

### Onboarding

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| N-1 | Opens on Daylens doing something useful | E2E: the first screen shows a real result from the person's own day | ❌ Opens on permissions (`Onboarding.tsx:60`) |
| N-2 | Browser access is part of the permission step | One step grants Accessibility and browser access | ❌ |
| N-3 | One calm privacy line linking to Terms and Privacy | The link opens the published page | ❌ No link, no page |
| N-4 | Assistants found and connected, with the session-log toggle | Claude Code and Codex are detected, connected in one click, and the toggle is on by default | ❌ |
| N-5 | Ends on the person's own morning, named | A new install with history ends on a named morning, then opens Today | 🟠 Facts titles only; "Hours appear here from now on" when empty |
| N-6 | First launch to recording within 2 minutes | Timed on the clean VM on every OS | ❌ Unmeasured |

### Tray, menu bar and accessibility

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| M-1 | The tray menu opens on Linux | On Ubuntu with AppIndicator, a click opens the full menu | 🟠 `tray.ts:80-81` never calls `setContextMenu` |
| M-2 | The tray shows each platform's shortcuts | Quit shows Ctrl+Q off macOS | 🐞 `tray.ts:77` is Command+Q everywhere |
| M-3 | Installed builds have no Reload or developer tools | The packaged app's View menu has neither | 🟡 `main.ts:184`; check in the packaged build |
| M-4 | Accessible | Every screen passes VoiceOver, Narrator, keyboard-only use and WCAG AA contrast | ❌ Not audited |

## E · Assistants over MCP

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| E-1 | The installed app serves MCP without Node | Claude Code and Claude Desktop, configured by Daylens, read a demo-world day from the installed, signed app | 🟡 `runAsNode` at `package/build.ts:127`; unproven installed |
| E-2 | Windows paths and permissions | The MCP tests pass on Windows without skips | 🟠 `mcp/server.test.ts:95,179` and `mcp/clients.test.ts:145` skip on Windows |
| E-3 | Reads are logged and filtered by retention | E2E: reads show in Settings; days past retention aren't served | 🟡 Logged; retention filter unproven |

## F · Browser extension

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| F-1 | Built for Chrome, Edge and Firefox | `node browser/build.ts` produces three loadable packages, and CI checks them | 🟠 Source and manifests exist; no build output |
| F-2 | Installing Daylens registers the native host with every browser | After install, each browser's host manifest or registry key exists, and the extension connects with no prompt | ❌ Only a dev tool (`browser/tools/register.ts`) |
| F-3 | Store IDs allowed | The Chrome and Edge store IDs are in all four allowlists | ❌ Dev ID only (`capture/pairing.ts:12-14`) ⛔ B3, B4 |
| F-4 | The Windows paired connection | `daylens://` is registered; the extension shows Connect once and pairs | 🟠 No `setAsDefaultProtocolClient`; `LOCAL_EVERYWHERE = false` |
| F-5 | Firefox's one Allow on Windows | The Allow prompt shows in Daylens and connects | ❌ Decided in `browserLocal.ts:88-104`, no UI |
| F-6 | Offered in the app | After onboarding, in Settings, and from an unreadable hour | ❌ Nowhere in the renderer |
| F-7 | Store listings ready | Copy, screenshots, privacy disclosures, permission reasons and reviewer steps for each store, reviewed | 🟠 `browser/store/` drafts |
| F-8 | Submitted to all three stores | Each store shows "in review" | ⛔ T4, after B3 and B4 |

## G · Packaging, signing, updates

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| G-1 | A notarized universal macOS DMG | `spctl -a -vvv` accepts the app and every helper; `stapler validate` passes | 🟡 `package/build.ts` is ready ⛔ B1 |
| G-2 | Signed updates on macOS, including a standard user in `/Applications` | The clean VM updates from build N to N+1 as a non-admin user; capture and settings survive | ❌ Unproven |
| G-3 | Windows Store package with the helper inside | MSIX passes the App Certification Kit and a private Store submission | ❌ No Windows target (`package/build.ts:193`) ⛔ B3, D3 |
| G-4 | Linux AppImage and deb | Both install and record on Ubuntu 24.04 | ❌ No Linux target |
| G-5 | Updates on Windows and Linux | Store updates on Windows; Linux nightly update path documented and tested | ❌ `updates.ts:26` returns early off macOS |
| G-6 | A GitHub Release with checksums, an SBOM and build notes | The release on `spcsorg/daylens` lists SHA-256 for each artifact, a CycloneDX SBOM and reproducible build steps | ❌ No releases yet |
| G-7 | V1 users' data opens in V2 | A V1 database fixture opens in V2 with its days, exclusions and settings | 🟡 Exclusion carry-over tested (`service.test.ts:359-380`); full import unverified |

## H · Security and privacy

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| H-1 | The web app's Next.js advisories are fixed and live | PR #279 merged in `irachrist1/daylens`, and the deployed version reads ≥ 16.4.5 | 🟠 Open and mergeable |
| H-2 | No critical or high advisories in shipped dependencies | `npm audit --omit=dev --audit-level=high` exits 0 in `v2/` and `apps/web` | ❌ Not run |
| H-3 | No secrets in the code or its history | `gitleaks detect` over the full history of every public repo finds nothing | ❌ Not run |
| H-4 | Claude Code security review resolved | Every finding fixed or accepted in writing | ❌ Not run |
| H-5 | The data folder is owner-only on every OS | The test passes on Windows too | 🟠 Skipped on Windows (`store.test.ts:331`) |
| H-6 | The website's privacy page matches behavior | Each claim on the page maps to a passing test | ❌ |
| H-7 | A Terms and Privacy page, linked from onboarding, Settings and every store listing | The page is live, and each link opens it | ❌ |
| H-8 | Two-factor authentication and repo security settings | S1 to S3 done | ⛔ S1–S3 |

## I · Performance

Each budget in `BUDGETS.md` is one item, I-1 to I-16, proven by its bench on the packaged app on every reference machine.

## J · Website and launch

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| J-1 | The download page serves signed builds per OS | Each OS's link downloads the release artifact, and its checksum matches | ❌ |
| J-2 | Accurate install docs | A fresh person follows them on the clean VM with no deviation | ❌ |
| J-3 | The "beta is out" broadcast drafted | A draft in Resend, unsent, linked in STATUS | ❌ ⛔ T3 to send |
| J-4 | A signup count you can trust | One number from the waitlist's source of record, readable by Tonny | ❌ |
| J-5 | Launch posts checked against the build | Every claim in each post maps to a passing item here | ❌ |
| J-6 | The domain | `daylens.app` resolves to the site | ⛔ B2 |
| J-7 | Runbooks match the code | Install and update runbooks in `docs/operations/` are checked against the shipped build | ❌ Only `windows-signing.md`, which describes builds outside the Store |

## Release checklist items owned by Tonny

| ID | Item | Status |
|---|---|---|
| R-1 | Gold days labeled, one held out, one on Windows | ⛔ T1 |
| R-2 | Windows gold day on the physical laptop from the Store build | ⛔ T2 |
| R-3 | Billing in production | ⛔ D2 |
| R-4 | Extension published in three stores | ⛔ F-8 |
| R-5 | Store certification with privacy policy, `runFullTrust` reason and AI disclosure | ⛔ G-3 |
| R-6 | Release notes approved | ⛔ T3 |
