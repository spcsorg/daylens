# Build plan

V2 ships as a stable release on Windows 11 and macOS; Linux ships as a nightly. Speed is checked at every step.

## How work happens

1. A change starts from these documents. If a needed decision is missing, it follows what established apps do and is recorded here before code is written. A decision is asked for only when no common practice exists or it cannot be undone.
2. A plan is written and reviewed by a different model or person before implementation. Its only job is to find what is wrong.
3. The change is built and reviewed again the same way.
4. Every change that affects what the user sees is measured: speed against the budgets in [System design](system-design.md), quality against the gold days in [Testing](testing.md).
5. When output is wrong, the process that produced it is fixed, not only the output.

## Build order

V2 is built one step at a time. Each step is planned, reviewed by a different model or person before and after it is built, and measured. A step is accepted when it meets its measure on macOS; work that does not depend on platform behavior can then begin. Windows must meet the measure for steps 1, 1b and 1c before step 3 begins, and every step must pass on every platform before release.

| Step | What | Done when |
|---|---|---|
| 1 | **Capture foundation.** The shared protocol, the helper supervisor with heartbeat and capture health, event-driven app, title, idle, lock and sleep capture on macOS and Windows, title normalization | Kill, hang and sleep tests produce explained gaps and recovery; transitions match timestamped markers; background budgets met |
| 1b | **Browsers.** History readers, the normal/private/unknown gate, the extension and its connection to Daylens (native messaging on macOS and Linux, a paired local connection on Windows) for Chrome, Edge and Firefox, Arc and Dia checks. The extension goes to the stores as soon as it works, because store review can take five weeks | The private-window acceptance suite passes in every supported browser on both platforms; the extension is submitted to all three stores |
| 1c | **Packages.** The Windows Store package and the signed, notarized macOS app, with the helpers inside, launch at login, and updates from one version to the next | A standard user installs and updates with no warnings; the Windows package passes the Windows App Certification Kit and a private Store submission; every executable verifies; capture and settings survive the update; the MCP server and CLI find the database from outside the package |
| 1d | **Screen and audio.** Optional screenshot and audio capture with on-device text reading and transcription, off by default | The screen and audio acceptance test passes on every platform; background budgets met with both off; their cost with each on is measured |
| 2 | **Storage.** The single source of truth and its change announcements | Correction, deletion, pause and exclusion tests pass at the storage level |
| 3 | **The calendar, facts first.** The shell and the day, week and month views on real data, on all three platforms | Paint and launch budgets met; screens match the design on every platform |
| 4 | **Agent sessions.** Claude Code and Codex readers | Agent work on gold days is attributed correctly, with no false durations |
| 5 | **Writing hours.** Packets, the chosen model, validation, corrections | Gold-day scores meet the target; cost per day within budget |
| 6 | **Search and Ask** | Search budget met; gold search queries answered |
| 7 | **Assistants.** MCP server, client detection, read log | Each supported client connects and reads on each platform |
| 8 | **Onboarding** | A first-time user reaches their own named morning without help, on each platform |
| 9 | **AI choice, plans and payments** | Payment-state and usage tests pass against the payment providers' test modes |
| 10 | **Release** | The release checklist below is complete |

## Release checklist

V2 is released only when every item below is done and proven. No item is skipped, deferred or ticked without its proof.

- [ ] Every acceptance test in [Testing](testing.md#acceptance-tests) passes on every platform.
- [ ] Gold-day scores meet the target, including the held-out day and the Windows day.
- [ ] Budgets met on every platform from signed, packaged builds.
- [ ] Security review complete; findings fixed or accepted in writing.
- [ ] Terms and Privacy page published and linked from onboarding and Settings.
- [ ] The Windows package published in the Microsoft Store, the signed and notarized macOS app, a nightly for Linux; updates verified.
- [ ] The Microsoft Store listing passes certification: privacy policy, the `runFullTrust` justification, and any disclosure Store policy requires for AI features.
- [ ] A public privacy policy page that the Microsoft Store listing, the extension stores and the Terms & Privacy screen all link to.
- [ ] Two-factor authentication is on for every account that can publish a release.
- [ ] The browser extension published in the Chrome, Edge and Firefox stores, offered in Settings and in hours Daylens couldn't read, connecting right after a fresh install on every platform, with privacy disclosures, permission justifications and reviewer test steps that use a downloadable desktop build.
- [ ] A Windows gold day recorded on the physical laptop from the Store build.
- [ ] Billing in production mode with confirmed webhooks, and prices set.
- [ ] Operations runbooks checked against the code.
- [ ] V1 users' existing data opens in V2.
- [ ] V2 is published from a new public repo that starts from a clean copy of the code with no earlier history, so nothing from past commits is public. The current repo is made private before the new one is made public.
