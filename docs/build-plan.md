# Build plan

V2 ships as a stable release on Windows 11 and macOS; Linux ships as a nightly. Speed is checked at every step.

V2 is built one step at a time. Each step is planned, reviewed by a different model or person before and after it is built, and measured. The next step starts only when the current one meets its measure on every platform.

| Step | What | Done when |
|---|---|---|
| 1 | **Capture foundation.** The shared protocol, the helper supervisor with heartbeat and capture health, event-driven app, title, idle, lock and sleep capture on macOS and Windows, title normalization | Kill, hang and sleep tests produce explained gaps and recovery; transitions match timestamped markers; background budgets met |
| 1b | **Browsers.** History readers, the normal/private/unknown gate, the extension and its native messaging host for Chrome, Edge and Firefox, Arc and Dia checks. The extension goes to the stores as soon as it works, because store review can take five weeks | The private-window acceptance suite passes in every supported browser on both platforms; the extension is submitted to all three stores |
| 1c | **Signed packages.** Signed per-user Windows installer and macOS app with the helpers inside, launch at login, and updates from one version to the next | A standard user installs and updates with no warnings beyond first-download reputation; every executable verifies; capture and settings survive the update |
| 2 | **Storage.** The single source of truth and its change announcements | Correction, deletion, pause and exclusion tests pass at the storage level |
| 3 | **Today, facts first.** The shell and Today on real data, on all three platforms | Paint and launch budgets met; screens match the design on every platform |
| 4 | **Agent sessions.** Claude Code and Codex readers | Agent work on gold days is attributed correctly, with no false durations |
| 5 | **Writing hours.** Packets, the chosen model, validation, corrections | Gold-day scores meet the target; cost per day within budget |
| 6 | **Search and Ask** | Search budget met; gold search queries answered |
| 7 | **Assistants.** MCP server, client detection, read log | Each supported client connects and reads on each platform |
| 8 | **Onboarding** | A first-time user reaches their own named morning without help, on each platform |
| 9 | **AI choice, plans and payments** | Payment-state and usage tests pass against the payment providers' test modes |
| 10 | **Release** | The release checklist below is complete |

## Release checklist

- [ ] Every acceptance test in [Testing](testing.md#acceptance-tests) passes on every platform.
- [ ] Gold-day scores meet the target, including the held-out day and the Windows day.
- [ ] Budgets met on every platform from signed, packaged builds.
- [ ] Security review complete; findings fixed or accepted in writing.
- [ ] Terms and Privacy page published and linked from onboarding and Settings.
- [ ] Signed installers for Windows and macOS, a nightly for Linux; updates verified.
- [ ] The browser extension published in the Chrome, Edge and Firefox stores, with privacy disclosures, permission justifications and reviewer test steps that use a downloadable desktop build.
- [ ] A Windows gold day recorded on the physical laptop from the signed build.
- [ ] Billing in production mode with confirmed webhooks, and prices set.
- [ ] Operations runbooks checked against the code.
- [ ] V1 users' existing data opens in V2.
