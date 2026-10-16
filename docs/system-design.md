# System design

Daylens V2 is one desktop app on Windows, macOS and Linux. A small native helper on each platform records activity. Everything else is shared code: storage, the engine that writes the day, search, the MCP server, AI access, billing and the interface.

## Budgets

Speed is the first requirement. These budgets are ceilings, measured on every platform for every change that could affect them; the goal is to be well under them.

| Measure | Budget |
|---|---|
| Cold launch to Today on screen | Under 2 seconds |
| Opening Today, any day | First paint under 200 ms, from local facts only |
| Search results | Under 100 ms for typical queries |
| Everything Daylens runs in the background | Event-driven, never busy polling. Averages under 0.5% CPU on a mid-range laptop, under 150 MB of memory combined, no growth over a day, and no measurable battery drop over a working day |
| A user action (open an hour, save a fix, switch day) | Visible response under 100 ms |
| An hour written after it ends | Within a few minutes, in the background |
| AI cost of naming one day | Within the per-day budget set in [Billing](billing.md) |

The interface never waits on AI, the network, or a long query. Background work runs outside the interface process.

## Shape

```text
 Native capture helper (one per platform)
        │  observations, one shared protocol
        ▼
 Capture service ── normalizes, applies exclusions, writes
        │
        ▼
 Local database (SQLite) ── single source of truth
        │
   ┌────┼──────────────┬─────────────┬──────────────┐
   ▼    ▼              ▼             ▼              ▼
 Engine  Search index  Interface    MCP server     Day notes
 (writes hours)        (Today, Ask,  (assistants,   (optional files)
   │                    Apps)        read only)
   ▼
 AI provider: Daylens AI, own key, local CLI, or none
```

### The shell

The interface is one shared web codebase in a desktop shell. V1 already ships this way on all three platforms; V2 keeps the shell and rewrites what runs inside it. The interface process only renders and sends user actions. Capture, the engine, search indexing and the MCP server run in separate processes.

### Native helpers

Each platform has a small helper that reports what is happening and nothing else. All helpers speak the same protocol: one JSON line per observation, carrying the event time, the platform, the source, and the observation itself. Normalization and every decision live in shared code, so the platforms cannot drift.

The macOS helper is Swift and the Windows helper is C#, published self-contained so users install nothing extra. Both are rebuilt for V2 to be event-driven: they react to foreground, title, session and power changes instead of polling, with a slow reconciliation check for missed events. Any call that can hang (such as UI Automation on Windows) runs on its own thread so it can never stop capture. Each observation carries a protocol version, a sequence number and defined clock units.

## Capture

### Signals by platform

| Signal | Windows | macOS | Linux |
|---|---|---|---|
| Front app | Foreground-change events and limited process queries; hosted Store apps resolved to the real app | Front application | X11 active window; on Wayland, see below |
| Window title | Window text and title-change events, no permission needed | Accessibility permission | X11 window name; on Wayland, see below |
| Browser page | See [Browsers](#browsers) | See [Browsers](#browsers) | See [Browsers](#browsers) |
| Idle | Time since last input | Time since last input | Idle time from the desktop session |
| Lock and sleep | Session and power notifications; waking automatically is not the user returning | Workspace and power notifications | Session manager signals |
| Calendar (optional) | Account calendar through sign-in | Calendar permission (full access is the only level) | Account calendar through sign-in |
| AI agent sessions | Claude Code and Codex session logs | Same | Same |
| Microphone or speaker in use (later) | Audio session state | Audio process state | Audio server state |

No keystrokes, no screen images and no audio content are captured on any platform.

### Linux

On X11, capture works like the other platforms. On Wayland, apps cannot read the active window without the desktop's help. Daylens supports Wayland desktops through a small desktop extension where one exists (GNOME Shell extension, KWin script, wlroots foreign-toplevel). Where none exists, Daylens records only what it can and says so in Settings. It never pretends to have a full record.

### Browsers

Every browser window is in one of three states: **normal**, **private** or **unknown**. Unknown is never treated as normal.

- **Pages come from browser history files.** Browsers do not write private browsing to history. Readers take only real visits from verified profiles, skip Guest profiles, and ignore bookmarks, downloads and other history sources. Visits synced from other devices or added by extensions are kept apart where the browser marks them. A page from history is searchable, but it gets no time on its own: a visit shows that a page was opened, not that it was read.
- **Live window titles and addresses are stored only when the window is confirmed normal** by the browser itself: a browser automation property, or the Daylens browser extension. A title that lacks "Incognito", or that matches a history entry, is not confirmation.
- **The Daylens browser extension** is optional and offered after onboarding, not during it. It is not allowed in private windows, reports the focused tab of normal windows, and gives exact pages and times. It ships at launch for Chrome, Edge and Firefox; Arc and Dia use the Chrome Web Store build, and each is verified on each platform before it is claimed.
  - Permissions: `tabs` and `nativeMessaging` only, with `"incognito": "not_allowed"`. No host permissions, content scripts, history or scripting access.
  - It listens for tab activation, window focus and address or title changes, and forwards only the focused tab of a focused normal window. When focus moves somewhere the extension cannot see, it tells Daylens, and Daylens stops attributing the last page.
  - It talks only to the Daylens app on the same computer, through a native messaging host that the installer registers for each browser. Chrome Web Store and Edge Add-ons assign different extension IDs, and Firefox uses its add-on ID, so the host allows each one explicitly.
  - It has a small popup: connection status, pause, and open Daylens. Store policies expect browsing data to serve a visible feature.
  - On Firefox it uses Firefox's built-in data consent, declares browsing activity, and targets Firefox 140 and later.
- **Private windows** are never recorded with a page or title. Few browsers can confirm a private window (Chrome on macOS through its scripting `mode`), so in practice private time is stored the same way as unknown time: browser time with no page.
- **Unknown windows** are recorded as browser time without a page or title. The engine then looks for other evidence of what happened in that time: history visits, commits, agent sessions, files and calendar events. If it still cannot tell, the hour asks the user for context in a few words, the same way a correction works, and offers the extension.
- Browser history files are read with short read transactions while the browser runs, never by copying the database files, and never by changing the browser's settings.

### AI agent sessions

Claude Code and Codex write session logs to the user's home folder on every platform. Two small readers turn them into observations: which project folder, when a turn started and ended, and when the user submitted a message.

- A message with a user role is not proof the user typed it. Injected instructions and system context are excluded.
- Imported turns, aborted turns, missing endings and duplicate records are handled explicitly.
- If a log format changes and parsing degrades, Settings says so. Daylens never silently reports no agent activity.
- Only metadata and short, selected excerpts are read. Full transcripts and command output are not stored.
- Log folders are watched for appended data, not rescanned. On Windows, sessions inside WSL are found without waking stopped Linux distributions.

### Normalization

Applied once, when observations are written:

- Exclusions are applied before anything is stored. Excluded apps and sites leave only an "excluded" gap.
- Private and incognito windows are never stored.
- Titles are cleaned: spinner and progress characters are removed, so an animated title is one observation, not one per second.
- Repeated identical observations are merged.
- A title that stays the same for a long time while input happens elsewhere is flagged as possibly stale, so it is never treated as evidence of current work.
- Media playing while input is idle is not counted as away.
- Every observation keeps its event time, the time it was recorded, and the time zone.

### Capture health

Capture health is tracked separately from activity. A quiet hour can be reading; it must not be confused with a broken helper.

- The helper sends a heartbeat. Missing heartbeats are recorded as a capture gap.
- Permission state is checked continuously. If a permission is revoked, or an update leaves a stale grant behind, the app says so immediately and offers the fix.
- Releases are signed with a stable identity on every platform, so permissions survive updates.

## Storage

One SQLite database on the user's machine is the single source of truth. Every screen, Ask, the MCP server and day notes read from it. No screen keeps its own copy of any state.

| Data | Notes |
|---|---|
| Observations | Raw, append-only, with event time, recorded time, time zone and source |
| Intervals | Derived from observations; can always be rebuilt |
| Hours | Title, summary, detail, outcome, sources, suggestion, status (facts or written), writer, version |
| Threads | Ongoing pieces of work across hours, with stable IDs owned by the database |
| Corrections | What the user said about an hour. Always wins over written text |
| Deletions | Tombstones, so deleted material is never imported again |
| Exclusions and settings | Including retention and AI choice |
| Usage ledger | Every AI answer and hour written, with its cost |
| Plan cache | Entitlement as last confirmed by the billing service |
| Assistant reads | What each assistant read and when |
| Search index | Full-text index over titles, addresses, file names and hour text |

A change to any shared state (a correction, deletion, exclusion, AI choice, plan, usage, pause) is written once and announced to every reader. This is how a correction appears everywhere and a deletion reaches every copy.

## Engine

The engine turns observations into hours. Details and evaluation are in [Engine](engine.md).

1. **Facts.** Plain code groups observations into intervals per app, window and page. This is what Today shows first.
2. **Packet.** When an hour ends, the engine builds a compact packet: merged intervals, short IDs, page and window titles, agent sessions, calendar events, gaps with reasons, the previous hour's summary, open threads, and any corrections.
3. **Writing.** The chosen AI writes the hour from the packet as structured output. The writer has no tools and can take no actions.
4. **Validation.** Code checks the output: valid structure, every cited ID exists in the packet, times are within the hour, and nothing is marked finished without proof. Invalid output is rejected and the hour stays as facts.
5. **Storage.** The hour is stored with its sources. Corrections override it. A deletion triggers a rewrite from what is left.

Labels come from layers, and the layer used is recorded: the user's own rules and corrections first, then anchors (repository, file, address, calendar event, agent project folder) as hints, then the AI, otherwise unassigned. An anchor suggests a thread but never forces two pieces of work together.

Daylens's own written text is never used as evidence for later writing, except corrections from the user.

## Search

Search runs on the local full-text index and works without AI. Results are grouped into pages, files, windows and hours, each with an open action. Searching by meaning ("the doc about the budget" finding a sheet titled "Q4 costs") is measured with real queries during the search step. If full-text search misses too many of them, a small on-device embedding model is added for search only.

## Assistants

A read-only MCP server lets any MCP app read days, hours, search results and sources.

- Known clients on the machine (Claude, Claude Code, Codex, Cursor, ChatGPT, VS Code and others) are detected and connected by writing their configuration. Any other MCP app can be set up by copying a snippet.
- The server has no tools that change anything.
- Every read is logged and shown in Settings.
- Optional day notes write each finished day as a readable file, for assistants that read files instead of connecting.

## AI access

| Choice | How it works |
|---|---|
| Daylens AI | The billing service checks the plan, meters usage and forwards to the model provider. Default. |
| Your own key | The app calls the provider directly. The key is stored in the platform's secure storage: Keychain on macOS, Credential Manager on Windows (user-scoped DPAPI for larger records), the Secret Service on Linux. The interface never receives a stored secret. |
| A CLI on the machine | The app runs Claude Code or Codex headlessly, billed to the user's own subscription. |
| None | Hours stay as facts. Ask searches instead of answering. |

The model used to write hours is chosen by evaluation, not preference. See [Engine](engine.md).

## Billing service

The billing service (`services/billing`) handles accounts, plans, usage and payments. It stores account state, usage metadata and payment events, never activity or prompts. Card payments use the payment provider's hosted checkout; mobile money uses a mobile-money provider. Details and payment-state rules are in [Billing](billing.md).

## Security

See [Privacy and security](privacy-and-security.md). In short: captured text is untrusted input, the writer has no tools, output is validated and rendered as plain text, secrets live in the platform's secure storage, releases are signed on every platform, and every privacy promise has a test.

## Build order

See [Build plan](build-plan.md).
