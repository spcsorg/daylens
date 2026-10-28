# System design

Daylens V2 is one desktop app on Windows, macOS and Linux. A small native helper on each platform records activity. Everything else is shared code: storage, the engine that writes the day, search, the MCP server, AI access, billing and the interface.

## Budgets

Speed is the first requirement. These budgets are ceilings, measured on every platform for every change that could affect them; the goal is to be well under them.

| Measure | Budget |
|---|---|
| Cold launch to the calendar on screen | Under 2 seconds |
| Opening the calendar, any day, week or month | First paint under 200 ms, from local facts only |
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
 (writes hours)        (calendar,    (assistants,   (optional files)
   │                    Ask, Apps)   read only)
   ▼
 AI provider: Daylens AI, own key, local CLI, or none
```

### The shell

The interface is one shared web codebase in a desktop shell. V1 already ships this way on all three platforms; V2 keeps the shell, moves to a supported Electron release (44 or later; V1's 34 is out of support), and rewrites what runs inside it. The interface process only renders and sends user actions. Capture, the engine, search indexing and the MCP server run in separate processes.

Each screen owns its files, so screens change without touching each other: `app/shared/<screen>.ts` (its reads and actions), `app/reader/<screen>.ts` (its reads), `app/main/ipc/<screen>.ts` (its actions) and `app/renderer/src/screens/<screen>/` (its views and stylesheet). Everything more than one screen uses is shared: the record model (`app/reader/queries.ts`), the shared types (`app/shared/types.ts`), the shell (`app/main/main.ts`, `chrome.ts`, the preload, `renderer/src/App.tsx` and `shell/`), and the design system (`renderer/src/ui/`, `styles/`, `lib/`). The design system follows the V4 pages of the design file one to one: the tokens in `styles/tokens.css` carry the design file's variable names, and its components keep their names (Button, Toggle, Hour, Week block and so on).

### Native helpers

Each platform has a small helper that reports what is happening and nothing else. All helpers speak the same protocol: one JSON line per observation, carrying the event time, the platform, the source, and the observation itself. Normalization and every decision live in shared code, so the platforms cannot drift.

The macOS helper is Swift and the Windows helper is C#, published as one native executable (Native AOT, built on Windows) so users install nothing extra and it uses little memory. Both are rebuilt for V2 to be event-driven: they react to foreground, title, session and power changes instead of polling, with a slow reconciliation check for missed events. Any call that can hang (such as UI Automation on Windows) runs on its own thread so it can never stop capture. Each observation carries a protocol version, a sequence number and defined clock units.

### Packages

- **Windows:** a full-trust Microsoft Store package whose only restricted capability is `runFullTrust`. Microsoft signs it and the Store installs updates. Launch at login is the package's startup task, which Windows registers at the first launch; if the user turns it off in Windows Settings, only Windows Settings can turn it back on.
- A packaged app's new files under AppData go to the package's private folder, which processes outside the package cannot see, such as the MCP server an assistant starts or the CLI. The database lives where those processes can read it. V1's database under `%APPDATA%\Daylens` is copied before it is imported, never opened in place.
- The install folder of a Store package changes with every version, so assistants start the MCP server through a path that survives updates.
- **macOS:** a Developer ID–signed, notarized app, downloaded from the website and updated in the app.
- **Linux:** nightly packages.

## Capture

### Signals by platform

| Signal | Windows | macOS | Linux |
|---|---|---|---|
| Front app | Foreground-change events and limited process queries; hosted Store apps resolved to the real app | Front application | X11 active window; on Wayland, see below |
| Window title | Window text and title-change events, no permission needed | Accessibility permission | X11 window name; on Wayland, see below |
| Browser page | See [Browsers](#browsers) | See [Browsers](#browsers) | See [Browsers](#browsers) |
| Idle | Time since last input | Time since last input | Idle time from the desktop session |
| Lock and sleep | Session and power notifications; waking automatically is not the user returning | Screen-lock notifications, display notices (the helper runs as a background application to receive them), and sleep and wake from the power system | Session manager signals |
| Calendar (optional) | Account calendar through sign-in | Calendar permission (full access is the only level) | Account calendar through sign-in |
| AI agent sessions | Claude Code and Codex session logs | Same | Same |
| Commits | Git repositories under the usual code folders | Same | Same |
| Screen (optional, off by default) | Windows Graphics Capture; text read with the built-in OCR | ScreenCaptureKit with the Screen Recording permission; text read with Vision | Desktop portal screencast through PipeWire; text read with an on-device OCR engine |
| Audio (optional, off by default) | Microphone and system audio through WASAPI | Microphone permission; system audio through Core Audio | PipeWire or PulseAudio |
| Microphone or speaker in use (later) | Audio session state | Audio process state | Audio server state |

No keystrokes are captured on any platform. Screen images and audio are captured only when the user turns them on; see [Screen and audio](#screen-and-audio).

### Linux

On X11, capture works like the other platforms. On Wayland, apps cannot read the active window without the desktop's help. Daylens supports Wayland desktops through a small desktop extension where one exists (GNOME Shell extension, KWin script, wlroots foreign-toplevel). Where none exists, Daylens records only what it can and says so in Settings. It never pretends to have a full record.

### Browsers

Every browser window is in one of three states: **normal**, **private** or **unknown**. Unknown is never treated as normal.

- **Window titles in apps with a browser engine.** An app that ships a browser engine (Chromium, Electron, CEF, Gecko) keeps its window titles only if it is on a built-in list of known non-browser apps with a matching OS-verified signer, or if the user chose to keep titles for it in Settings. Every other such app is recorded with no title.
- **Threat model.** In scope is everything an honest user's own machine does: installed, portable and packaged apps, app updates, odd install layouts, filesystem and permission errors, and PID reuse. Out of scope is a local attacker who tampers with or re-signs binaries, or renames a browser to impersonate a trusted app, since same-user code can already read the database directly. Also out of scope: macOS accepting a running bundle whose sealed resources changed after launch, and a process re-signed while it runs keeping its cached signer.

- **Pages come from browser history files.** Browsers do not write private browsing to history. Readers take only real visits from verified profiles, skip Guest profiles, and ignore bookmarks, downloads and other history sources. Visits synced from other devices or added by extensions are kept apart where the browser marks them. A page from history is searchable, but it gets no time on its own: a visit shows that a page was opened, not that it was read.
- **Live window titles and addresses are stored only when the window is confirmed normal** by the browser itself: a browser automation property, or the Daylens browser extension. A title that lacks "Incognito", or that matches a history entry, is not confirmation.
- **The Daylens browser extension** is optional and offered after onboarding, not during it. It is not allowed in private windows, reports the focused tab of normal windows, and gives exact pages and times. It ships at launch for Chrome, Edge and Firefox; Arc and Dia use the Chrome Web Store build, and each is verified on each platform before it is claimed.
  - Permissions: `tabs`, `nativeMessaging` and `alarms` (to retry the connection after the browser suspends the extension), with `"incognito": "not_allowed"`. No content scripts, history or scripting access, and no host permission except `127.0.0.1` where a browser needs it for the Windows connection below.
  - It listens for tab activation, window focus and address or title changes, and forwards only the focused tab of a focused normal window. When focus moves somewhere the extension cannot see, it tells Daylens, and Daylens stops attributing the last page.
  - It talks only to Daylens on the same computer. On macOS and Linux that is a native messaging host the app registers for each browser. Chrome Web Store and Edge Add-ons assign different extension IDs, and Firefox uses its add-on ID, so the host allows each one explicitly.
  - On Windows, Daylens ships as a Microsoft Store package, whose registry writes are private to the package, so browsers can never find a native messaging host. The extension connects to the capture service over `127.0.0.1` instead. Each browser is paired once through a `daylens://` link. Before any page is sent, both sides prove they hold the pairing secret, so another user's process listening on the port receives nothing. Daylens accepts the connection only from a browser process running as the same user.
  - It has a small popup: connection status, pause, and open Daylens. Store policies expect browsing data to serve a visible feature.
  - On Firefox it uses Firefox's built-in data consent, declares browsing activity, and targets Firefox 140 and later.
- **Addresses** are stored as the page address plus a short list of search and page-identity parameters, each kept by its exact name: search terms, document or video IDs, page numbers and video times, and view settings. Every other query parameter and the fragment are removed. A kept parameter is removed when its value is a recognized credential or token, when a page number or time is not one, or when a view setting looks like a generated key or ID. Click and campaign tracking IDs are removed. Secrets carried in the path itself are not detected.
- **Private windows** are never recorded with a page or title. Few browsers can confirm a private window (Chrome on macOS through its scripting `mode`), so in practice private time is stored the same way as unknown time: browser time with no page.
- **Unknown windows** are recorded as browser time without a page or title. The engine then looks for other evidence of what happened in that time: history visits, commits, agent sessions, files and calendar events. If it still cannot tell, the hour asks the user for context in a few words, the same way a correction works, and offers the extension.
- Browser history files are never changed, and the browser's settings are never changed. Current Chrome holds its history database locked while it runs, so each read copies the database and its write-ahead log into a private temporary folder outside backups, reads it in one short transaction, and deletes the copy. Copies left by a crash are deleted at the next start.
- On first run, history readers start at the beginning of that day, so day one is filled in. After that they read only new visits.

### AI agent sessions

Claude Code and Codex write session logs to the user's home folder on every platform. Two small readers turn them into observations: which project folder and branch, when a turn started and ended, and when the user submitted a message.

- A message with a user role is not proof the user typed it. Injected instructions and system context are excluded.
- Imported turns, aborted turns, missing endings and duplicate records are handled explicitly.
- If a log format changes and parsing degrades, Settings says so. Daylens never silently reports no agent activity.
- Only metadata is kept. Prompts, replies, tool input and command output never leave the reader.
- Log folders are watched for appended data, not rescanned. On Windows, sessions inside WSL are found without waking stopped Linux distributions.

### Commits

Daylens finds git repositories under the usual code folders in the home folder (such as Code, Projects, source and GitHub Desktop's folder) and reads commits by each repository's configured user: message, time and repository. Links are removed from messages before storage. Commits whose author is a coding agent or a bot are marked as the agent's and never credited to the user.

### Screen and audio

Both are off until the user turns each on in Settings › Recording and privacy, which then asks for the platform's permission.

- **Screen.** Screenshots of the front window. Their text is read on the computer and stored as observations. Nothing is captured while the front window is private, unknown, in an excluded app or site, or while Daylens is paused or the computer is locked.
- **Audio.** Microphone and system audio, transcribed on the computer by an on-device speech model. Nothing is captured while Daylens is paused.
- Screenshots, audio and transcripts are stored only on the computer, follow the retention setting, and are covered by deletion like every other observation.
- Screen text and transcripts are evidence of what was on screen and said, like titles. They join the hour's packet; the images and audio never leave the computer.
- The budgets above apply with both off. Their cost with each on is measured on every platform.

### Normalization

Applied once, when observations are written:

- Exclusions are applied before anything is stored. Excluded apps and sites leave only an "excluded" gap.
- Private and incognito windows are never stored.
- Titles are cleaned: spinner and progress characters are removed, so an animated title is one observation, not one per second.
- Repeated identical observations are merged.
- A title is flagged as possibly stale when Daylens loses the ability to read it (permission lost, title reader stalled), so it is never treated as evidence of current work. When reading recovers, the title is read again and stored fresh.
- Media playing while input is idle is not counted as away.
- Every observation keeps its event time, the time it was recorded, and the time zone.

### Capture health

Capture health is tracked separately from activity. A quiet hour can be reading; it must not be confused with a broken helper.

- The helper sends a heartbeat. Missing heartbeats are recorded as a capture gap.
- Permission state is checked continuously. If a permission is revoked, or an update leaves a stale grant behind, the app says so immediately and offers the fix.
- Releases are signed with a stable identity on every platform, so permissions survive updates.
- Until the Developer ID arrives, macOS builds made on the maintainer's Mac are signed with one self-signed certificate kept in its own keychain (`v2/app/package/localSigning.ts`), so the capture helper keeps its Accessibility grant from build to build. Gatekeeper still treats these builds as unidentified, and they don't update themselves.

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

1. **Facts.** Plain code groups observations into intervals per app, window and page. This is what the calendar shows first.
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
- The server has no tools that change anything. Each tool says so to the client (`readOnlyHint`).
- Every read is logged and shown in Settings, under the name the client gives itself when it connects.
- Optional day notes write each finished day as a readable file, for assistants that read files instead of connecting.

### The server

`v2/mcp/main.ts` speaks MCP over stdio, one JSON-RPC message per line, and nothing else ever prints to stdout. Each client starts its own copy.

- **No Node to install.** Packaged, a client runs the app's own binary as Node: `ELECTRON_RUN_AS_NODE=1 <Daylens> <app.asar>/build/app/mcp/main.js`. From source, `node v2/mcp/main.ts`. This needs Electron's `runAsNode` fuse, which the package turns on (`v2/app/package/build.ts`). Started as the full app instead, even with the GPU off, it would be four or five processes and 320 to 460 MB per client, and it would open the window; as Node it is one process of about 115 MB, idle at under 0.2% CPU (measured on Linux).
- **It lives as long as its client.** It exits when stdin ends or closes, when stdout breaks, and when the process that started it is gone (checked every 2 seconds, for a client that dies with stdin still held open). Copies never pile up.
- **It starts before there is anything to read.** The database is opened on the first call. With no database yet, one storage hasn't finished setting up, or a schema newer than the server knows (an update while it runs), a call returns an error the assistant can pass on, and the server keeps running.
- **Where it reads.** `--data-dir`, else `DAYLENS_V2_DATA_DIR`, else the app's data folder: `~/Library/Application Support/Daylens V2` on macOS, `%APPDATA%\Daylens V2` on Windows, `~/.local/share/daylens-v2` on Linux (or `$XDG_DATA_HOME`). Runs from source use `Daylens V2 Dev` (`daylens-v2-dev`).
- **Tools.** Seven reads, one per thing a person looks at in the app. `get_status`: today's date and zone, recording, paused, stopped or not running (Daylens quit, or no heartbeat for 10 minutes), where they left off, the built-in exclusions and how many the person added (never what they excluded), and retention. An hour the retention cutoff falls in is not shown. `list_days`: the week and month views (per day, time, top apps and each hour's title). `get_day`: one day, hour by hour, with each hour's longest windows, pages and files. `get_hour`: one hour in full. `get_apps`: the Apps screen, all apps or one in detail. `search`. `get_agent_work`: Claude Code and Codex sessions. Like every screen, none shows anything past the retention period, even before pruning removes it.
- **Limits.** Search returns up to 10 results per group. A call that reads a span of days (`list_days`, `get_apps`, `get_agent_work`) takes at most 31; search covers every day unless given a span.
- **Protocol.** MCP 2025-06-18, 2025-03-26 and 2024-11-05; a client asking for another version gets the newest.

## AI access

| Choice | How it works |
|---|---|
| Daylens AI | The billing service checks the plan and issues a short-lived token scoped to one request and its cost; the app calls the model provider directly with it, so the hour's content never passes through Daylens servers. Usage is metered from the token's spend. Default. |
| Your own key | The app calls the provider directly. The key is stored in the platform's secure storage: Keychain on macOS, Credential Manager on Windows (user-scoped DPAPI for larger records), the Secret Service on Linux. The interface never receives a stored secret. |
| A CLI on the machine | The app runs Claude Code or Codex headlessly, billed to the user's own subscription. |
| None | Hours stay as facts. Ask searches instead of answering. |

The model used to write hours is chosen by evaluation, not preference. See [Engine](engine.md).

## Billing service

The billing service handles accounts, plans, usage and payments. It stores account state, usage metadata and payment events, never activity or prompts. Card payments use the payment provider's hosted checkout; mobile money uses a mobile-money provider. Details and payment-state rules are in [Billing](billing.md).

## Security

See [Privacy and security](privacy-and-security.md). In short: captured text is untrusted input, the writer has no tools, output is validated and rendered as plain text, secrets live in the platform's secure storage, releases are signed on every platform, and every privacy promise has a test.

## Build order

See [Build plan](build-plan.md).
