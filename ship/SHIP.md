# Ship V2

Every item left before Daylens V2 is public, grouped by work stream. An item is done only when its acceptance test passes in CI or on a clean VM and a separate verifier reruns it.

Status as of 7 November 2026, from four spec-against-code audits, a run of every screen in the demo world, and the test suite. Paths are under `v2/`.

**Status:** ✅ done and proven · 🟡 works, not yet proven · 🟠 partial · ❌ missing · 🐞 broken · ⚠️ contradicts the docs · ⛔ blocked on Tonny

**Bar:** every feature works end to end, every AI feature included, on every platform the release ships on.

## Decisions waiting on Tonny

These change what is in scope. See `BLOCKERS.md`.

| ID | Decision | Items it settles |
|---|---|---|
| D1 | Beta gate on 20 November, or the full release checklist | A-1, A-2, G-1 to G-5, F-8, S-G7, S-G9, R-1 to R-3 |
| D2 | Accounts, billing and usage analytics in V2 | C-1, S-G7, S-G8 |
| D3 | Windows through the Store only, or a signed installer too | G-3 |
| D4 | Domain | J-6 |
| D5 | Screen and audio capture (build step 1d): in V2 or later | A-12, S-G6 |

## Oracle: tests, CI and harness · stream I

Nothing else is proven until these exist.

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| O-1 | The full suite passes on all three operating systems | `npm test` green on every CI job | 🟡 Green on all four runners, CI run 42401866370 (PR #57, merged). Skips: 10 on macOS, 14 on Ubuntu, 27 on Windows (O-5) |
| O-2 | CI covers macOS on Apple silicon and Intel, Windows x64 and Ubuntu 24.04 | The matrix lists `macos-15`, `macos-15-intel`, `windows-2025`, `ubuntu-24.04`, all green | ✅ macos-15, macos-15-intel, ubuntu-24.04, windows-2025 all green, CI run 42401866370 (PR #57, merged) |
| O-3 | Swift tests run in CI | The macOS job runs `swift test` in `native/macos` | ✅ 50 Swift tests on both Macs, CI run 42401866370 (PR #57, merged) |
| O-4 | .NET helper tests run in CI | The Windows job runs `dotnet test native/windows` | ✅ 338 .NET tests on Windows, the first run in CI, CI run 42401866370 (PR #57, merged) |
| O-5 | No test is skipped without a SHIP item | A script lists every `skip:` and fails if any lacks a SHIP ID | 🟠 18 platform skips, none linked: `store.test.ts:331`; `service.test.ts:112,133,359,376,380`; `supervisor.test.ts:176`; `agents/host.test.ts:25,42,54,65,88,111`; `agents/reader.test.ts:116`; `agents/memory.test.ts:8`; `mcp/server.test.ts:95,179`; `mcp/clients.test.ts:145`. Plus a runtime skip at `realHelper.test.ts:192` |
| O-6 | No flaky tests | A nightly job runs every test 20 times on each OS, and any failure opens a SHIP item | ❌ Two flakes found so far, both on Windows Server 2025, both fixed: a 3 s resumed-purge wait (#57) and a 5 s lock-error deletion guard (#61). The 20-run nightly doesn't exist yet |
| O-7 | Electron E2E against the packaged app on the demo world | Playwright drives the packaged build through every screen and query listed in `e2e/fixtures.json` (Today day/week/month, open hour, Search ×4 named queries, Apps day/week, Ask, every Settings tab, onboarding, tray) on three operating systems, in CI | ❌ No E2E exists |
| O-8 | Visual regression | Every screen in `e2e/fixtures.json` in light and dark, at 3 window sizes, at 1× and 2×; CI fails above 0.1% changed pixels per screen; screens compared across platforms differ only as `docs/experience.md#platform-differences` allows | ❌ |
| O-9 | Clean-machine install and uninstall | A fresh VM per OS installs, onboards, records 10 minutes of scripted activity, checks Today, Search and Ask, updates N → N+1, then uninstalls. After uninstall: no native-host manifests, MCP config entries or login items point at the removed app; the data folder is kept and the install docs say so | ❌ |
| O-10 | A nightly eval job | The job runs B-15 and B-16 under the spend cap and writes pass rate and variance to STATUS | ❌ No npm scripts, no job. Needs `DAYLENS_TEST_ANTHROPIC_API_KEY` ⛔ B6 |
| O-11 | Network egress, measured at the packet level | The packaged app runs a scripted day under pf/tcpdump (macOS, Linux) or pktmon (Windows). AI off: 0 connections except the update host. AI on: only `api.anthropic.com` and the update host. Never an analytics endpoint | ❌ |
| O-12 | Performance benches ratchet in CI | Each budget in `BUDGETS.md` has a bench that fails CI above its ceiling, and a daily job lowers the ceiling | 🟠 `app/tools/bench.ts` measures but checks nothing |
| O-13 | CI is hardened | `permissions: contents: read`; `persist-credentials: false`; actions pinned by SHA | ✅ Read-only token, `persist-credentials: false`, actions pinned to the SHAs of checkout v7.0.1, setup-node v7.1.0 and setup-dotnet v6.1.0, CI run 42401866370 (PR #57, merged) |
| O-14 | The demo world loads in the packaged app for testing, and never in a release | A test-only build flag loads the demo world; the release build refuses it and CI checks the release asar has no seed code | ❌ |
| O-15 | A VM harness with a scripted activity driver | One command boots a clean VM per OS, grants Accessibility where the OS allows it by MDM profile, and replays scripted app, window and page activity | ❌ |
| O-16 | The reference machines run as CI runners | An M1 Air, a 4-core Windows 11 laptop and a 4-vCPU Ubuntu box run the benches as self-hosted runners; wall-clock benches run only there | ❌ ⛔ B7 |

## A · Capture engine

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| A-1 | The Windows helper runs inside the Windows app | The packaged Windows app records app, title, idle, lock and sleep on the Windows 11 VM; E2E reads them back | ❌ `app/main/paths.ts:30` always starts `daylens-capture-macos` |
| A-2 | A Linux capture helper for X11 and Wayland | On Ubuntu 24.04 under X11 and GNOME Wayland, the packaged app records the active app and title through the GNOME extension; where a desktop can't, Settings says so in one line, as `docs/system-design.md#linux` promises | ❌ `native/` has macOS and Windows only |
| A-3 | Browser history readers work on Windows and Linux | Fixture history databases for Chrome, Edge and Firefox at each OS's real paths are read correctly in CI on that OS | 🟡 Tested on macOS paths only |
| A-4 | Private windows leave no trace | The canary suite from `docs/testing.md` passes in every browser on every platform | 🟠 Storage-level tests only |
| A-5 | Unknown windows are never treated as normal | A test breaks the bridge mid-session, then asserts no page or title is stored | 🟡 Needs a per-platform run |
| A-6 | Exclusions apply before storage, and pause is exact | Property-based tests across every capture path store 0 bytes while excluded or past retention. With a fake clock, a 1-hour pause stores nothing in [t, t+60 min) and an observation within 5 s after | 🟠 `storage/acceptance.test.ts:222,248,385,401` cover examples, not properties |
| A-7 | Deletion reaches every copy and stays deleted | Delete a canary page; rerun the Chrome history reader over the same fixture; a scan of the database, WAL, FTS shadow tables and free pages, cited Ask answers and day notes finds no canary | 🟠 Tombstones tested (`acceptance.test.ts:172`); no disk scan |
| A-8 | `writeHour` tells apart visits before and after a deletion in the same hour | A test deletes mid-hour, then rewrites; no visit from before the deletion returns | 🟡 Reported limitation, unverified |
| A-9 | No misattributed app switches | A replay corpus of recorded event streams with timestamped markers gives 0 misattributions | ❌ No corpus |
| A-10 | Gaps name "permission lost" | Revoking Accessibility mid-session shows a "permission lost" gap | 🟠 Reasons in `queries.ts:217-236` lack it |
| A-11 | Default exclusions match the docs | Either banking sites are seeded or `docs/privacy-and-security.md` stops promising them | ⚠️ `capture/defaults.ts:11` |
| A-12 | Screen and audio capture, off by default | The acceptance test in `docs/testing.md` passes on every platform | ❌ Not built. ⛔ D5 |
| A-13 | Agent sessions never store what was said | The canary test passes on all three operating systems | 🟠 6 tests skipped on Windows (`agents/host.test.ts`) |
| A-14 | Commits: agents' marked as theirs, links removed | Fixture repos with an agent-authored commit and a commit message with a URL: the agent commit is marked, and no URL is stored | 🟡 Unverified |
| A-15 | A changed agent log format says so | A malformed Claude Code log shows the notice in Settings and stores nothing from it | 🟡 Unverified |
| A-16 | Calendar events, with permission | Granting calendar access records an event fixture; denying records none | ❌ Not found in code |
| A-17 | Addresses are trimmed before storage | A table of ≥ 50 named URLs (utm, gclid, `token=`, a JWT in a kept parameter, a page number that must stay) asserts each stored address exactly | 🟡 `normalize.test.ts`, `scrub.test.ts`; coverage unmeasured |
| A-18 | Survives the bad days | Fixture tests: a full disk, a force-quit mid-write (the database opens clean), a time-zone change, and a Windows profile with non-ASCII characters redirected to OneDrive | ❌ |
| A-19 | The platform matrix holds | On each OS: sleep and wake, a clock change, two displays, and permission revoked mid-session (the gap says so and Settings offers the fix) | 🟠 Sleep and lock tested on macOS |

## B · AI on the person's own key

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| B-1 | Add, test and remove a key in onboarding and Settings | E2E with a real key: add, test and remove each succeed, and Ask and hours stop on removal | 🟡 `ipc/ai.ts:53-75`; IPC and UI untested ⛔ B6 |
| B-2 | Replace a key in one step | E2E: paste a new key over the saved one | 🟠 Needs Remove first (`AiTab.tsx:91-125`) |
| B-3 | A key with no credit is caught when saved | Replaying Anthropic's recorded 400 `invalid_request_error` credit body at save shows the no-credit message | 🐞 The check calls `models.list`, which passes (`backends.ts:91-97`) |
| B-4 | Offline says offline | With the network cut, Ask and key save both say you're offline | ✅ Merged in #58: green on all four runners; verifier showed the tests fail on `main`; reviewed by Claude, droid, CodeRabbit and Bugbot |
| B-5 | Every API failure says what happened, including a connection dropped mid-answer | Recorded real bodies for 400 credit, 401 revoked key, 429, 529 overload and a mid-stream `error` event each show their own message in Ask and in Settings | 🟠 One message for credit and rate limit (`Ask.tsx:69`) |
| B-6 | Hour-writing failures reach the UI | A failing write shows a quiet status on Today with what to do | ❌ Log only (`hourWriter.ts:125-128`) |
| B-7 | An AI error still shows search results | Stub an error; the matching results show under the message | ❌ `Ask.tsx:192-198` |
| B-8 | Ask without a key is useful for its own examples | With no key, "What did I do this morning?" lists this morning's hours | 🟡 PR #59: verified, review fixed, rebased on #58; combined Ask tests 49 of 49 locally; CI rerunning |
| B-9 | Example questions lead with finding things | The examples follow `docs/experience.md` | ⚠️ All three are summaries (`Ask.tsx:15`) |
| B-10 | Timesheets and reports | "my hours on the pricing memo this week" drafts time per piece of work, with its hours, ready to copy; an eval case | ❌ No code |
| B-11 | Every citation opens | File and window citations open like pages | 🟠 Dropped at `Ask.tsx:266-269` |
| B-12 | Usage and token spend in Settings › AI | This month's usage, split by hours and Ask, equals the sum of the API's `usage` fields for the calls made in the test | ❌ `AiTab.tsx` shows the key only |
| B-13 | "Things you told Daylens", each removable | Shown in Settings › AI; after removing one, the next request body no longer contains it | ❌ |
| B-14 | What goes to AI is exactly what the docs say | Capture the outgoing request bodies for one hour and one Ask on the bakery world: the field set equals the table in `docs/privacy-and-security.md`, with no written hour text, no `AXDocument` path and no excluded item; the Settings text names the same fields | ⚠️ Settings names apps, titles and times. The docs also send addresses, agent sessions, commit messages, calendar events and the previous hour's text |
| B-15 | AI-written hours meet the bar | `npm run eval:hours`, 5 runs: ≥ 95% pass, 0 unsupported claims, every statement cited. Grader is a fixed model and rubric (claude-opus-5-5, `tools/eval/`); Tonny spot-checks 20% of graded hours | 🟡 18 cases (`tools/eval/hours.ts`); not run ⛔ B6 |
| B-16 | Ask meets the bar | `npm run eval:ask`, 5 runs: 100% grounded, correct refusal without evidence; same grader and spot check as B-15; adds timesheet and find-a-page cases | 🟡 18 questions × 2 (`tools/eval/ask.ts`); no timesheet or find-a-page cases ⛔ B6 |
| B-17 | The eval set grows from real failures | Each real failure gets a gold case before its fix | ❌ No process |
| B-18 | Captured text can't steer the writer | 10 eval cases whose titles carry instructions ("ignore previous…", "call tool…") and `<img onerror>`: across 5 runs 0 instructions followed, the validator rejects invented IDs, no DOM element is built from captured text, and MCP replies mark recorded text as data | ❌ Not in either eval |
| B-19 | Credit runs out mid-day and comes back | Credit fails at 11:00: ≤ 3 calls an hour while failing, Today shows facts and one status line. Credit returns at 15:00: hours 11–14 are written within 10 minutes, no duplicate calls | ❌ |
| B-20 | A retired model doesn't break AI | A recorded `not_found_error` for the model shows "Update Daylens"; the model ID can change without a rebuild | ❌ |
| B-21 | Gold-day scores meet the target | Each gold day meets the target Tonny sets (proposed: ≥ 90% of hours right or partly right, 0 unsupported claims), including the held-out day and the Windows day | ❌ No gold days yet ⛔ T1 |
| B-22 | The key never leaks | Grep the database, logs and diagnostics for a canary key prefix after a full day: 0 hits. On Linux with no keyring, saving refuses and says why | 🟠 Refusal tested (`retrieval/apiKey.test.ts:36`); no grep |

## C · Accounts

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| C-1 | Accounts decided, then shipped fully or left out | `ship/ACCOUNTS.md` decided by Tonny. If they're in: Playwright covers sign up, verify, sign in, sign out (every token cleared), reset, expiry, deletion and multi-device, plus rate limits and abuse tests | ⛔ D2 |

## D · App screens

### Today, week and month

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| T-1 | Fix an hour | E2E: open an hour, Edit, "What were you doing?", save, then force a rewrite. The correction shows on Today, Search, Ask and MCP `get_hour`; "Edited" shows; Undo restores | ❌ No UI (`Today.tsx:176-198`); storage and undo exist |
| T-2 | Corrections show on facts-only hours | A correction to an unwritten hour shows on Today and in the week view | ✅ Merged in #60: green on all four runners; verifier showed the tests fail on `main`; reviewed by Claude, droid, CodeRabbit and Bugbot |
| T-3 | The open hour shows its outcome and suggestion | A written hour with an outcome and a suggestion shows both, with the checklist | ❌ Stored, never read |
| T-4 | Remove one source, not its whole site | Removing one page leaves other pages from that site | ⚠️ `records.tsx:175-177` removes the site or app |
| T-5 | Ask about unreadable browser time | A 20-minute unexplained browser span offers the question, "Leave it" and the extension | ❌ |
| T-6 | The current hour shows live facts | The current hour's summary is its two longest titles, updating live | 🟠 Seen in the demo: "Recording now." |
| T-7 | Week and month show time per piece of work | Labeled time per piece of work, where a piece of work is the writer's named thread for written hours and the facts title for the rest | ⚠️ Seen in the demo: "Time by app" |
| T-8 | Month days show their main pieces of work | Each day lists work, not apps | ⚠️ Seen in the demo: two app names per day |
| T-9 | The week keeps the repeated hour at a clock change | A fall-back day's week view shows both 1 AM hours | 🐞 Matched by `getHours()` (`Today.tsx:258`) |
| T-10 | Every app shows its icon | Apps that aren't installed get a fallback icon, never a blank square | 🐞 Seen in the demo: `daylens-icon://app/com.google.Chrome` returns 404 and renders grey |
| T-11 | Files reopen on Windows and Linux | Clicking a file source reopens the file there | 🟠 macOS only (`ipc/core.ts:33-44`) |
| T-12 | The interface rules hold | Destructive confirms are one line; busy buttons spin at the same width; no menu repeated on every row | 🟠 `records.tsx:131-138,194-222` |
| T-13 | What already works on Today stays working | E2E covers the Left off card, day-one fill from history, facts-first titles and merged gap ranges | 🟡 `app/reader.test.ts:327-409`, `history.test.ts:185`, `app/todayRows.test.ts` |

### Search

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| Q-1 | Search works end to end | E2E opens Search with Cmd+K or Ctrl+K and runs the four queries in `e2e/fixtures.json`; checks recents, keyboard, Show more to 25, nothing-found text and Escape | 🟡 Seen working in the demo; no E2E |
| Q-2 | Each result shows its hour | The hour title shows under every result | 🟠 Only kind, app and time (`Search.tsx:142`) |
| Q-3 | The example uses everyday words | The placeholder is a lowercase, half-remembered search | ❌ `Search.tsx:151` |
| Q-4 | Ask's working rules stay working | Tests cover morning until noon, the card built in code, and the same question giving the same answer | 🟡 `retrieval/ask.test.ts:899-967`; `app/reader/ask.ts:17-37` |

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
| N-3 | One calm privacy line linking to Terms and Privacy | The link opens the page from H-7 | ❌ No link |
| N-4 | Assistants found and connected, with the session-log toggle | Claude Code and Codex are detected, connected in one click, and the toggle is on by default | ❌ |
| N-5 | Ends on the person's own morning, named | A new install with history ends on a named morning, then opens Today | 🟠 Facts titles only; "Hours appear here from now on" when empty |
| N-6 | First launch to recording within 2 minutes | Timed on the clean VM on every OS | ❌ Unmeasured |
| N-7 | Eight moments or fewer | E2E counts onboarding steps | 🟡 Two steps |

### Tray, menu bar and accessibility

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| M-1 | The tray menu opens on Linux | On Ubuntu with AppIndicator, a click opens the full menu | 🟠 `tray.ts:80-81` never calls `setContextMenu` |
| M-2 | The tray shows each platform's shortcuts | Quit shows Ctrl+Q off macOS | 🐞 `tray.ts:77` is Command+Q everywhere |
| M-3 | Installed builds have no Reload or developer tools | The packaged app's View menu has neither | 🟡 `main.ts:184`; check in the packaged build |
| M-4 | Accessible | axe-core in E2E finds 0 serious or critical issues on every screen; a written VoiceOver and Narrator script passes; every action works keyboard-only | ❌ Not audited |
| M-5 | Every control works on every OS | E2E on each OS: the tray menu (current hour, three pauses, delete last 10 minutes, Today, Search, Quit); delete an hour, day, range and everything; retention prunes, and shortening it confirms | 🟠 Storage tests; no E2E |

## E · Assistants over MCP

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| E-1 | Installed apps serve MCP without Node | From the installed, signed macOS app and the installed Store MSIX: Claude Code, Claude Desktop, Codex, Cursor, VS Code, Windsurf and Gemini CLI, configured by Daylens, each read a demo-world day; a non-JSON config is reported and never rewritten | 🟡 `runAsNode` at `package/build.ts:127`; unproven installed |
| E-2 | Windows paths and permissions | The MCP tests pass on Windows without skips | 🟠 `mcp/server.test.ts:95,179` and `mcp/clients.test.ts:145` skip on Windows |
| E-3 | Reads are logged and filtered by retention | E2E: reads show in Settings; days past retention aren't served | 🟡 Logged; retention filter unproven |
| E-4 | Writes wait for a yes | Over stdio, `correct_hour`, `delete_records`, `set_retention`, resume and removing an exclusion change nothing until the card is answered; at 10 minutes the request lapses; a request whose title says "delete today" renders quoted; pausing runs at once | 🟡 `tests/mcp/writes.test.ts:52-180`; no E2E of the card |

## F · Browser extension

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| F-1 | Built for Chrome, Edge and Firefox | `node browser/build.ts` produces three packages; `web-ext lint` and Chrome `--load-extension` show 0 errors in CI | 🟠 Source and manifests exist; no build output |
| F-2 | Installing Daylens registers the native host with every browser | Run from the installed DMG, MSIX and deb, not from source: each browser's host manifest or registry key is visible to the browser (MSIX virtualizes HKCU and AppData), and the extension connects with no prompt | ❌ Only a dev tool (`browser/tools/register.ts`) |
| F-3 | Store IDs allowed | The Chrome and Edge store IDs are in all four allowlists | ❌ Dev ID only (`capture/pairing.ts:12-14`) ⛔ B3, B4 |
| F-4 | The Windows paired connection | `daylens://` is registered; the extension shows Connect once and pairs | 🟠 No `setAsDefaultProtocolClient`; `LOCAL_EVERYWHERE = false` |
| F-5 | Firefox's one Allow on Windows | The Allow prompt shows in Daylens and connects | ❌ Decided in `browserLocal.ts:88-104`, no UI |
| F-6 | Offered in the app | After onboarding, in Settings, and from an unreadable hour | ❌ Nowhere in the renderer |
| F-7 | Store listings ready | Copy, screenshots, privacy disclosures, permission reasons and reviewer steps for each store, reviewed | 🟠 `browser/store/` drafts |
| F-8 | Live in all three stores | Each listing is public, and the shipped app's allowlists hold those IDs | ⛔ T4, after B3 and B4 |
| F-9 | The extension connection is safe and versioned | A manifest test asserts exactly `tabs`, `nativeMessaging`, `alarms` and `"incognito": "not_allowed"`; a wrong pairing secret on Windows gets 0 bytes; old extension with new app and new extension with old app either connect or say "Update" | 🟠 Pairing tests exist; no version handshake |

## G · Packaging, signing, updates

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| G-1 | A notarized universal macOS DMG | `lipo -archs` shows arm64 and x86_64 for every binary; a browser-downloaded, quarantined copy passes `spctl -a -vvv` and `stapler validate`, and opens with only the standard first-open dialog | 🟡 `package/build.ts` is ready ⛔ B1 |
| G-2 | Signed updates on macOS, safely | On the clean VM as a standard user in `/Applications`: N → N+1 updates, Accessibility still works, capture and settings survive. Run from the mounted DMG, the app asks to move to Applications. Denying Accessibility shows the fix | ❌ Unproven |
| G-3 | Windows Store package with the helper inside | MSIX passes the App Certification Kit and certification, with the privacy policy, the `runFullTrust` reason and the AI disclosure | ❌ No Windows target (`package/build.ts:193`) ⛔ B3, D3 |
| G-4 | Linux AppImage and deb | On an untouched Ubuntu 24.04 image with no added packages and no `--no-sandbox`, both start and record; the deb ships an AppArmor profile | ❌ No Linux target |
| G-5 | Updates on Windows and Linux | Store updates on Windows; Linux nightly update path documented and tested | ❌ `updates.ts:26` returns early off macOS |
| G-6 | A GitHub Release with checksums, an SBOM and build notes | The release on `spcsorg/daylens` lists SHA-256 for each artifact, a CycloneDX SBOM and reproducible build steps | ❌ No releases yet |
| G-7 | V1 users' data opens in V2 | A V1 database fixture opens in V2 with its days, exclusions and settings | 🟡 Exclusion carry-over tested (`service.test.ts:359-380`); full import unverified |
| G-8 | The public repo has no earlier history | `spcsorg/daylens`'s first commit is the clean import, the archive repo is private, and gitleaks on the public history finds nothing | 🟡 Created 28 October with no earlier history; archive private |
| G-9 | A bad build can be stopped | A drill pulls build N+1 from the update feed and halts the Store rollout; "Copy diagnostics" in Settings produces a report with no key and no record content | ❌ |
| G-10 | Electron fuses are set as the docs decide | `npx @electron/fuses read` on the packaged app: RunAsNode on (MCP needs it; the docs accept it because the main bundle holds no privacy permission), node CLI inspect and `NODE_OPTIONS` off, asar-only loading and asar integrity on; `codesign -d --entitlements` and a TCC check show the main bundle holds no privacy permission; CI fails on drift | ❌ Unchecked |

## H · Security and privacy

| ID | Item | Acceptance test | Status · evidence |
|---|---|---|---|
| H-1 | The web app's Next.js advisories are fixed and live | PR #279 merged in `irachrist1/daylens`, and the deployed version reads ≥ 16.4.5 | 🟠 Open and mergeable |
| H-2 | No critical or high advisories in shipped dependencies | `npm audit --omit=dev --audit-level=high` exits 0 in `v2/` and `apps/web`, in CI | 🟠 `v2/`: 0 vulnerabilities, 7 November. `apps/web` not run |
| H-3 | No secrets in the code, its history or the shipped files | `gitleaks detect` over every public repo's history and over the unpacked DMG, MSIX and AppImage finds nothing; no source maps ship | ❌ Not run |
| H-4 | Claude Code security review resolved | Every finding fixed or accepted in writing | ❌ Not run |
| H-5 | The data folder is owner-only on every OS | The test passes on Windows too | 🟠 Skipped on Windows (`store.test.ts:331`) |
| H-6 | The website's privacy page matches behavior | A claims file maps every sentence on the page to a passing test ID; CI fails on an unmapped claim | ❌ |
| H-7 | A Terms and Privacy page, linked from onboarding, Settings and every store listing | The page is live, and each link opens it | ❌ |
| H-8 | Two-factor authentication and repo security settings | `gh api orgs/spcsorg` shows 2FA required; secret scanning and push protection on for `spcsorg/daylens`; `main` requires a PR and the four CI checks | ⛔ S1–S4 |

## I · Performance

Each budget in `BUDGETS.md` is one item, I-0 to I-18, proven by its bench on the packaged app on every reference machine.

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
| J-8 | Supported platforms stated | A table on the site and in the docs: minimum macOS, Windows 11 on x64 and ARM, Ubuntu versions, and each supported browser, each covered by A-3 fixtures | ❌ |
| J-9 | The docs agree on ChatGPT | `docs/product.md` stops promising ChatGPT, or MCP gains a remote option; `docs/system-design.md:194` says ChatGPT can't connect | ⚠️ |

## Release checklist items owned by Tonny

| ID | Item | Status |
|---|---|---|
| R-1 | Gold days labeled, one held out, one on Windows | ⛔ T1 |
| R-2 | Windows gold day on the physical laptop from the Store build | ⛔ T2 |
| R-3 | Billing in production | ⛔ D2 |
| R-6 | Release notes approved | ⛔ T3 |
