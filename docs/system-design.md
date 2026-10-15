# System design

Daylens V2 is one desktop app on Windows, macOS and Linux. A small native helper on each platform records activity. Everything else is shared code: storage, the engine that writes the day, search, the MCP server, AI access, billing and the interface.

## Budgets

These are requirements. Each is measured on every platform before a release.

| Measure | Budget |
|---|---|
| Cold launch to Today on screen | Under 2 seconds |
| Opening Today, any day | First paint under 200 ms, from local facts only |
| Search results | Under 100 ms for typical queries |
| Capture helper, all day | Measured CPU, memory and energy; no growth over a day |
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

Whether the helpers stay as separate native programs (as in V1: Swift on macOS, C# on Windows) or become one Rust program with three back ends is decided at the start of the capture step, based on how much logic each helper needs. The protocol is the same either way.

## Capture

### Signals by platform

| Signal | Windows | macOS | Linux |
|---|---|---|---|
| Front app | Foreground window and its process | Front application | X11 active window; on Wayland, see below |
| Window title | Window text, no permission needed | Accessibility permission | X11 window name; on Wayland, see below |
| Browser page | Address and title through UI Automation | Address and title through browser automation or Accessibility | Browser history files, plus the window title |
| Idle | Time since last input | Time since last input | Idle time from the desktop session |
| Lock and sleep | Session and power notifications | Workspace and power notifications | Session manager signals |
| Calendar (optional) | Account calendar through sign-in | Calendar permission (full access is the only level) | Account calendar through sign-in |
| AI agent sessions | Claude Code and Codex session logs | Same | Same |
| Microphone or speaker in use (later) | Audio session state | Audio process state | Audio server state |

No keystrokes, no screen images and no audio content are captured on any platform.

### Linux

On X11, capture works like the other platforms. On Wayland, apps cannot read the active window without the desktop's help. Daylens supports Wayland desktops through a small desktop extension where one exists (GNOME Shell extension, KWin script, wlroots foreign-toplevel). Where none exists, Daylens records only what it can and says so in Settings. It never pretends to have a full record.

### AI agent sessions

Claude Code and Codex write session logs to the user's home folder on every platform. Two small readers turn them into observations: which project folder, when a turn started and ended, and when the user submitted a message.

- A message with a user role is not proof the user typed it. Injected instructions and system context are excluded.
- Imported turns, aborted turns, missing endings and duplicate records are handled explicitly.
- If a log format changes and parsing degrades, Settings says so. Daylens never silently reports no agent activity.
- Only metadata and short, selected excerpts are read. Full transcripts and command output are not stored.

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
| Your own key | The app calls the provider directly. The key is stored in the platform's secure storage. |
| A CLI on the machine | The app runs Claude Code or Codex headlessly, billed to the user's own subscription. |
| None | Hours stay as facts. Ask searches instead of answering. |

The model used to write hours is chosen by evaluation, not preference. See [Engine](engine.md).

## Billing service

The billing service (`services/billing`) handles accounts, plans, usage and payments. It stores account state, usage metadata and payment events, never activity or prompts. Card payments use the payment provider's hosted checkout; mobile money uses a mobile-money provider. Details and payment-state rules are in [Billing](billing.md).

## Security

See [Privacy and security](privacy-and-security.md). In short: captured text is untrusted input, the writer has no tools, output is validated and rendered as plain text, secrets live in the platform's secure storage, releases are signed on every platform, and every privacy promise has a test.

## Build order

See [Build plan](build-plan.md).
