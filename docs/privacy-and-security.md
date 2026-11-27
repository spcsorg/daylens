# Privacy and security

Your record stays on your computer, and you decide what Daylens sees. It never records what you type, and it records the screen or audio only if the user turns that on.

## In the beta

This document describes the finished product. Where a promise isn't built yet, it says **Not built yet** beside it. The [data inventory](#data-inventory) describes what the code on `main` actually stores and sends. The beta also differs in these ways:

- **Not notarized, macOS only.** The app is signed with a local identity, so macOS asks the user to choose Open Anyway the first time. Updates are off; new versions come from GitHub releases. The Windows package builds and passes certification in CI, but it hasn't been submitted to the Store or tested on a Windows 11 client ([Windows Store package](operations/windows-store.md)).
- **No usage analytics.** The beta sends no usage data to Daylens.
- **No Daylens AI and no billing.** AI runs on the user's own API key, or not at all.
- **No log of what was sent to AI yet.** Settings doesn't show it in the beta.
- **The record isn't encrypted by Daylens.** On macOS it's a database in the user's Library folder, in a folder only the user's account can open; Daylens makes it owner-only and tightens it on every start. Other accounts on the computer can't open it; any program running as the user can. With FileVault on, macOS encrypts it at rest. On Windows the folder isn't tightened (`v2/capture/store.ts:296`): it keeps the access the user profile gives it, so the user, local administrators and any program running as the user can read it, and only BitLocker encrypts it at rest.
- **No commits, calendar, screenshots or audio.** None of these are recorded yet, and the hour writer receives none of them.
- **Browser history is read on macOS only.** On Windows, pages come only from the Daylens browser extension. Linux records nothing yet: it has no capture helper.
- **No Terms and Privacy page yet.**

## What Daylens records

- The app in front and its window titles. On macOS, also the path of the file a window shows, when the app reports one (`AXDocument`), so the window can reopen that file. It is kept only with a title, never for a private or browser window, and never sent to an AI or an assistant.
- The page in normal browser windows: its title and its address, with tracking codes, tokens and most other parameters removed. Pages from browser history are read from the start of the day Daylens is installed. History is read on macOS only so far (`v2/capture/history.ts:1`); on Windows, pages come only from the extension.
- When the computer is idle, locked or asleep.
- The user's own commits in git repositories under the usual code folders in the home folder: message and time. Commits made by coding agents are marked as theirs. **Not built yet:** no commit reader exists, and the hour writer passes no commit source (`v2/engine/hourWriter.ts:119`).
- With permission: calendar events. **Not built yet**, for the same reason.
- Claude Code and Codex sessions, unless the toggle in onboarding is turned off (it is on by default): when each session ran, its project folder and branch, and when a message was submitted. Never what was said.
- Only if turned on in Settings › Recording and privacy (off by default): screenshots, whose text is read on the computer, and audio, transcribed on the computer. **Not built yet:** neither helper has screen or audio capture code, and Settings has no such switch.

## What Daylens never records

- Keystrokes or anything typed.
- Screenshots or audio, unless the user turns them on. Even then, never from private windows, excluded apps or sites, or paused time.
- File contents.
- Pages and titles from private and incognito windows.
- Anything in an excluded app or site.

## Where data lives and what can leave the computer

The record is stored in a local database on the user's computer. There is no Daylens cloud copy of anyone's day. Today the only places anything goes are the AI provider, on the user's own key, and the assistants the user connects; see [What leaves the computer today](#what-leaves-the-computer-today).

| What | Goes to | When | How to stop it |
|---|---|---|---|
| One hour's facts: window and page titles, addresses, app names and times, agent sessions and their projects, commit messages, calendar events, the previous hour's text, open threads and corrections from nearby hours, plus screen text and transcripts when those are on. Commits, calendar events, screen text and transcripts aren't built yet, so none are sent today. | The chosen AI provider, directly | Each hour, while AI is on | Choose no AI. Hours stay as facts. |
| The question, and only the excerpts it needs: the hours of the days it names (today, when it names no day and nothing to search for), or else the hours where its words were found, including every hour a matching page was open at the same address, with their apps, gaps and the pages, files and windows seen in them, up to Ask's limits, and the person's own corrections to those hours. Daylens's own written hour text is not sent. A test checks the exact request. For a follow-up, a request before it holds the question and its last three earlier questions and answers in the thread, each cut to 600 characters and with when it was asked, and gets back the question rewritten to stand on its own, which is what the excerpts are then chosen for. No answer from before a correction is sent, and nothing of the conversation after a deletion. Settings › Assistants logs each such request with its question; earlier answers are never stored. | The chosen AI provider, directly | When Ask is used | Choose no AI. Ask then searches instead. |
| What an assistant reads | That assistant's own AI service | When a connected assistant reads days | Disconnect it. Every read is logged in Settings. |
| Account, plan, usage and payments. **Not built yet:** there is no billing service ([Billing](billing.md)). | The Daylens billing service | When the user has an account or plan | Never includes activity, prompts or answers |
| Usage analytics: features and screens used, milestones, errors, speed, AI usage and cost, app version and operating system, under a random install ID. **Not built yet:** the app has no analytics or crash reporting code. | Daylens | On by default | Turn off in Settings › Recording and privacy. Never the record: titles, addresses, file names, commit messages, screen text, transcripts, prompts or answers. |

- With Daylens AI (**not built yet**), the billing service issues a short-lived token for one request, and the app calls the model provider directly. An hour's content never passes through Daylens servers.
- What an assistant reads can be kept by that assistant's AI service, and Daylens cannot recall it afterwards. This is to be stated on the Terms and Privacy page (not built yet) and when connecting.
- Screenshots and audio themselves never leave the computer.
- Nothing else from the record leaves the computer.

## Controls

- Pause for an hour, until tomorrow, or until resumed.
- Exclusions by app or site, applied before storage, with sensible defaults on (password managers, banking).
- Retention: how long history is kept.
- Delete the last ten minutes, an hour, a day, a range, or everything. Deletion reaches observations, hours, the search index, Ask answers that cited the material, and day notes (day notes aren't built yet). Tombstones stop deleted material from being imported again.
- Disconnect any assistant.
- Settings shows what was sent to AI and when, and every read by each assistant. **Partly built:** Settings › Assistants shows assistant reads and requests, and each Ask question with its time. No log shows what was sent to write each hour.
- Answer what an assistant asks to change: delete, resume, record an app again, correct an hour, or change retention. Nothing happens without a yes.

## Security requirements

- **Captured text is untrusted.** Page titles, document names and agent logs can contain instructions. The writer has no tools and no authority, its output is validated in code, and all text is rendered as plain text.
- **No feedback loops.** Daylens's written text is never used as evidence for later writing.
- **Secrets** (API keys, account tokens) are stored in the platform's secure storage and never written to logs or the database.
- **Signing.** Releases are signed on every platform with a stable identity: Developer ID with notarization on macOS, signed packages on Linux. The macOS beta is signed with a local identity, and no Windows or Linux release exists yet. On Windows, Daylens ships through the Microsoft Store, which signs the package and installs its updates. Any Windows build distributed outside the Store is Authenticode-signed (installer, app and helper, timestamped and verified after packaging), and its updates refuse to install when the publisher cannot be verified.
- **Updates** are signed and verified before install.
- **The MCP server** is local to the machine. Its reads change nothing. Its writes only file requests: an assistant can pause recording or exclude an app or site on its own, and anything that deletes, records more or changes the record waits for the person's yes on a card in Daylens, which an assistant can't give. See [System design](system-design.md#assistants).
- **Running the app as Node.** The packaged app lets its binary run as Node (Electron's `runAsNode` fuse), so assistants can start the MCP server without installing Node. On macOS any local program could then run code as Daylens with Daylens's permissions, so the main app holds no macOS privacy permission: Accessibility belongs to the capture helper's own bundle, and any later permission (calendar, for example) goes to a helper too.
- **Payments.** Card data is entered only in the payment provider's hosted checkout. Not built yet.

## Promises that need proof

Each of these has an automated test before release. See [Testing](testing.md#acceptance-tests).

- Pages and titles from private windows are never stored on any platform, including while the window is open, after it closes and after a restart.
- A browser window not confirmed normal never has its page or title stored.
- Exclusions apply before storage.
- Deletion reaches every copy and is not re-imported.
- Pausing stops capture for exactly the chosen time.
- Screen and audio recording capture nothing until turned on, and never capture private windows or excluded apps and sites.
- Nothing is sent to an AI provider when AI is off.
- The billing service never receives activity.
- Nothing said in a Claude Code or Codex session is stored.

## Terms and Privacy page

**Not built yet:** onboarding and Settings link to no such page.

A plain-language page reachable from onboarding and Settings that states the above: what is recorded, what never is, what can leave the computer, and how to control it.

## Data inventory

What the code on `main` stores and sends today, table by table. When this section and the code disagree, the code is right and this section is corrected. Every path below is relative to the repository.

Everything lives on the user's own computer, in the data folder: `~/Library/Application Support/Daylens V2` on macOS, `%APPDATA%\Daylens V2` on Windows, and `daylens-v2` under `$XDG_DATA_HOME` (or `~/.local/share`) on Linux (`v2/app/main/paths.ts:22-27`). Inside the Store package, Windows redirects that folder into the package's private folder under `%LOCALAPPDATA%\Packages`, and uninstalling the package removes it.

Daylens encrypts none of the record. Protection at rest comes only from the folder's permissions and from FileVault or BitLocker, if they are on. On macOS the folder is owner-only (`v2/capture/store.ts:294-296`). On Windows it keeps the user profile's access, so local administrators can read it too.

### The database

One SQLite file, `daylens-v2.sqlite` (`v2/capture/store.ts:10`), in WAL mode (`v2/capture/store.ts:306`) with `secure_delete` on (`v2/storage/index.ts:199`). After a deletion or a retention pass, a scrub also clears the freed pages, so removed text is gone from the file on disk.

**Retention** is set by the user, and its default is to keep everything (`v2/storage/rules.ts:100`). Material older than the retention period is never written, and older rows are pruned in the background (`v2/storage/deletion.ts:392`). **Delete** means deletion by range, app, site or everything (`v2/storage/index.ts:386-403,488`). Rows go at once; the scrub that clears their pages on disk can finish later. Rows of the record that go are covered by a tombstone, which stops them from being imported again.

| Table | What it holds | Retention | Deleted by | Code |
|---|---|---|---|---|
| `observations` | Each focus change, history visit, and idle, session and power event: app ID, name and path, process ID, window title (cleaned and raw), page address, document path, event and recorded times, time zone | Pruned past retention | Delete by range, app, site or everything | `v2/capture/store.ts:125` |
| `capture_gaps` | Times with no activity recorded, and why: a pause, an exclusion, lock or sleep, or a capture problem | Pruned past retention | Delete | `v2/capture/store.ts:155` |
| `capture_runs` | Each helper run: platform, helper version, process ID, OS version, boot ID, heartbeats, permission state, configuration | Kept | Not removed by delete or retention | `v2/capture/store.ts:107` |
| `meta` | Internal markers: schema state, pending scrub and purge work, browser pairings (ID, browser origin, time paired; never the secret) | Kept | Entries are removed when their work is done | `v2/capture/store.ts:106`, `v2/capture/browserLocal.ts:40` |
| `exclusions` | Excluded apps, programs and sites, including the defaults | Kept | Removed in Settings | `v2/capture/store.ts:169` |
| `exclusion_periods` | When each exclusion was in force, so excluded time stays out after the exclusion is removed | Kept | Not removed | `v2/storage/schema.ts:358` |
| `intervals` | Time per app, window and page, derived from observations | Pruned past retention | Delete | `v2/storage/schema.ts:12` |
| `hours` | Each hour's title, summary, detail, outcome, sources and suggestion, written by AI or left as facts | Pruned past retention | Delete clears or removes the hour | `v2/storage/schema.ts:36` |
| `threads`, `thread_hours` | Titles of ongoing work across hours, and which hours belong to each | Links go with their hours; a thread title can outlive its hours after retention pruning | Delete | `v2/storage/schema.ts:61,67` |
| `corrections` | The user's own text for an hour | Go with their hour | Delete | `v2/storage/schema.ts:80` |
| `search_docs`, `search` (FTS5) | Searchable copies of titles, addresses, file names and hour text | Pruned past retention | Delete | `v2/storage/schema.ts:171,190` |
| `deletions` | Tombstones: the deleted range, app ID or site, and when. Never the deleted material | Kept, so nothing deleted comes back | Not removed | `v2/storage/schema.ts:97` |
| `deletion_work`, `deletion_fence`, `deletion_rows`, `deletion_agent` | Row IDs and spans a deletion still has to remove | Removed when the deletion finishes | Itself | `v2/storage/schema.ts:302,317,393,375` |
| `deleted_seqs` | Per capture run, the last sequence number "delete everything" refused | Kept | Not removed | `v2/storage/schema.ts:408` |
| `pauses` | When recording was paused and until when | Kept | Not removed | `v2/storage/schema.ts:227` |
| `settings` | Retention, AI choice and other preferences | Kept | Changed in Settings | `v2/storage/schema.ts:111` |
| `usage_ledger` | Per AI call: time, kind (hour or answer), provider, model, tokens, cost and a reference to the hour or Ask read it was for. No prompt or answer text | Kept | Not removed | `v2/storage/schema.ts:118` |
| `plan_cache` | The plan last confirmed by the billing service. Unused while there is no billing service | Kept | Not removed | `v2/storage/schema.ts:137` |
| `assistant_reads`, `assistant_read_items` | Each read by a connected assistant or by Ask: its name, tool, time span and search words or question, and the hours, apps and sites it read | Pruned past retention | Delete covering what was read | `v2/storage/schema.ts:152,255` |
| `assistant_requests` | Changes an assistant asked for, including proposed correction text, and how each ended | Settled requests older than a day are removed when the next request is filed | Itself | `v2/storage/assistantRequests.ts:10,42` |
| `change_log` | Announcements of changes for other processes: IDs, ranges and keys. Never titles or addresses | Pruned in the background | Itself | `v2/storage/changes.ts:25` |
| `migrations` | Names of applied schema changes | Kept | Not removed | `v2/storage/migrations.ts:15` |
| `agent_sessions`, `agent_turns`, `agent_events` | Claude Code and Codex sessions: project folder, branch, turn times, and keyed fingerprints of submitted messages. Never what was said | Pruned past retention | Delete | `v2/capture/agents/store.ts:71,85,103` |
| `agent_sources`, `agent_hosts`, `agent_health` | Which session logs were read and how far, where each session ran (WSL included), and reader health | `agent_sources` read state is cleared and `agent_hosts` trimmed past retention; `agent_health` is kept | Delete, except `agent_health` | `v2/capture/agents/store.ts:118,270,135` |
| `agent_deleted_sessions`, `agent_deleted_spans`, `agent_deleted_records` | Tombstones for deleted agent sessions, so they aren't read in again | Kept | Not removed | `v2/capture/agents/store.ts:164,194,243` |

SQLite also keeps its own tables beside these: `search_data`, `search_idx`, `search_docsize` and `search_config` hold the FTS5 index's copy of the searchable text and follow `search`, and `sqlite_sequence` holds only ID counters.

### Other files

| Item | What it holds | Encryption at rest | Retention and deletion | Code |
|---|---|---|---|---|
| `daylens-v2.sqlite-wal`, `-shm` | The write-ahead log, with recent changes, and its shared-memory index | None | The log is checkpointed into the database | `v2/capture/store.ts:306` |
| `anthropic-key` | The user's own Anthropic API key | Encrypted with Electron's `safeStorage`: Keychain on macOS, user-scoped DPAPI on Windows | Removed when the user removes the key | `v2/app/main/ipc/ai.ts:16`, `v2/retrieval/apiKey.ts:1-3` |
| `agent-fingerprint.key` | 32 random bytes used to fingerprint agent messages | None. Owner-only on macOS and Linux; inherits the folder's access on Windows | Kept for the install | `v2/capture/agents/store.ts:15-37` |
| `agent-backfill.sqlite` | A staging copy of agent metadata during the first read | None | Removed after the run | `v2/capture/agents/store.ts:14,41-45` |
| `capture-writer.lock`, `changes.signal` | A lock so only one writer runs, and a counter that tells readers to look for changes. No record data | None | Kept | `v2/capture/store.ts:80`, `v2/storage/changes.ts:20` |
| Browser history copies (macOS only) | A copy of a browser's history database while it is read | None; in an owner-only private temporary folder | Deleted after each read; leftovers deleted at the next start | `v2/capture/history.ts:174-176` |
| Browser pairing secrets | One secret per paired browser | Keychain on macOS; Windows Credential Manager (`CRED_PERSIST_LOCAL_MACHINE`) | Removed when the pairing is removed. Uninstalling the Windows package does not remove them | `v2/capture/secrets.ts:1-2`, `v2/native/windows/Daylens.Capture.Windows/SecretTool.cs:13,47` |
| Browser extension storage | In each paired browser: the pairing secret, a random profile ID and the pause state | The browser's own extension storage | Removed with the extension | `v2/browser/extension/src/background.ts:302-305,369-373` |
| `Daylens V2 Shell` folder | Electron's own data (Chromium cache) and `shell.json` preferences. No record data | None | Kept | `v2/app/main/main.ts:36`, `v2/app/main/paths.ts:38,50` |
| Logs | Lines on stderr: mostly fixed codes, plus error messages from the MCP server and the updater. No log files are written | n/a | n/a | `v2/app/main/main.ts:33` |
| Ask conversation | The current conversation | n/a: memory only | Answers are returned, never stored | `v2/retrieval/ask.ts:5` |

There is no crash reporting, analytics, telemetry or embedding store in the code.

### What leaves the computer today

| Flow | What is sent | To | When | Code |
|---|---|---|---|---|
| Hour writing | One hour's packet: window and page titles, addresses, apps and times, agent projects, gaps, the previous hour's text, open threads and corrections | Anthropic's API, on the user's own key, with `claude-opus-5-5` | Each finished hour with activity that isn't written or corrected yet, while a key is saved | `v2/engine/hourWriter.ts:11,119` |
| Ask | The question and the excerpts it needs; for a follow-up, also the earlier questions and answers, to rewrite it | Same | When Ask is used with a key saved | `v2/retrieval/anthropicApi.ts:9`, `v2/retrieval/ask.ts:534` |
| Key check | A minimal request that proves the key works | Same | When the user saves or tests a key | `v2/app/main/ipc/ai.ts:49-65` |
| Connected assistants | Whatever an assistant reads through the MCP server; the assistant decides where it goes next | That assistant's own AI service | When the assistant reads, with or without an AI key | `v2/mcp/server.ts` |
| Website waitlist | An email address, platform and signup source, from the marketing site, not the app | Resend | When someone joins the waitlist | `apps/site/app/api/waitlist/route.ts:4,72-80` |

Nothing else leaves the computer. **Not built yet:** a log in Settings of what was sent to AI and when.
