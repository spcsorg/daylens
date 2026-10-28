# Privacy and security

Your record stays on your computer, and you decide what Daylens sees. It never records what you type, and it records the screen or audio only if the user turns that on.

## In the beta

This document describes the finished product. The beta differs in these ways:

- **Not notarized, macOS only.** The app is signed with a local identity, so macOS asks the user to choose Open Anyway the first time. Updates are off; new versions come from GitHub releases.
- **No usage analytics.** The beta sends no usage data to Daylens.
- **No Daylens AI and no billing.** AI runs on the user's own API key, or not at all.
- **No log of what was sent to AI yet.** Settings doesn't show it in the beta.
- **The record isn't encrypted by Daylens.** It's a database in the user's Library folder, in a folder only the user's account can open; Daylens makes it owner-only and tightens it on every start. Other accounts on the computer can't open it; any program running as the user can. With FileVault on, macOS encrypts it at rest.

## What Daylens records

- The app in front and its window titles.
- The page in normal browser windows: its title and its address, with tracking codes, tokens and most other parameters removed. Pages from browser history are read from the start of the day Daylens is installed.
- When the computer is idle, locked or asleep.
- The user's own commits in git repositories under the usual code folders in the home folder: message and time. Commits made by coding agents are marked as theirs.
- With permission: calendar events.
- Claude Code and Codex sessions, unless the toggle in onboarding is turned off (it is on by default): when each session ran, its project folder and branch, and when a message was submitted. Never what was said.
- Only if turned on in Settings › Recording and privacy (off by default): screenshots, whose text is read on the computer, and audio, transcribed on the computer.

## What Daylens never records

- Keystrokes or anything typed.
- Screenshots or audio, unless the user turns them on. Even then, never from private windows, excluded apps or sites, or paused time.
- File contents.
- Pages and titles from private and incognito windows.
- Anything in an excluded app or site.

## Where data lives and what can leave the computer

The record is stored in a local database on the user's computer. There is no Daylens cloud copy of anyone's day.

| What | Goes to | When | How to stop it |
|---|---|---|---|
| One hour's facts: window and page titles, addresses, app names and times, agent sessions and their projects, commit messages, calendar events, the previous hour's text, open threads and corrections from nearby hours, plus screen text and transcripts when those are on | The chosen AI provider, directly | Each hour, while AI is on | Choose no AI. Hours stay as facts. |
| The question, and only the excerpts it needs: the hours of the days it names (today, when it names no day and nothing to search for), or else the hours where its words were found, including every hour a matching page was open at the same address, with their apps, gaps and the pages, files and windows seen in them, up to Ask's limits, and the person's own corrections to those hours. Daylens's own written hour text is not sent. A test checks the exact request. | The chosen AI provider, directly | When Ask is used | Choose no AI. Ask then searches instead. |
| What an assistant reads | That assistant's own AI service | When a connected assistant reads days | Disconnect it. Every read is logged in Settings. |
| Account, plan, usage and payments | The Daylens billing service | When the user has an account or plan | Never includes activity, prompts or answers |
| Usage analytics: features and screens used, milestones, errors, speed, AI usage and cost, app version and operating system, under a random install ID | Daylens | On by default | Turn off in Settings › Recording and privacy. Never the record: titles, addresses, file names, commit messages, screen text, transcripts, prompts or answers. |

- With Daylens AI, the billing service issues a short-lived token for one request, and the app calls the model provider directly. An hour's content never passes through Daylens servers.
- What an assistant reads can be kept by that assistant's AI service, and Daylens cannot recall it afterwards. This is stated on the Terms and Privacy page and when connecting.
- Screenshots and audio themselves never leave the computer.
- Nothing else from the record leaves the computer.

## Controls

- Pause for an hour, until tomorrow, or until resumed.
- Exclusions by app or site, applied before storage, with sensible defaults on (password managers, banking).
- Retention: how long history is kept.
- Delete the last ten minutes, an hour, a day, a range, or everything. Deletion reaches observations, hours, the search index, Ask answers that cited the material, and day notes. Tombstones stop deleted material from being imported again.
- Disconnect any assistant.
- Settings shows what was sent to AI and when, and every read by each assistant.

## Security requirements

- **Captured text is untrusted.** Page titles, document names and agent logs can contain instructions. The writer has no tools and no authority, its output is validated in code, and all text is rendered as plain text.
- **No feedback loops.** Daylens's written text is never used as evidence for later writing.
- **Secrets** (API keys, account tokens) are stored in the platform's secure storage and never written to logs or the database.
- **Signing.** Releases are signed on every platform with a stable identity: Developer ID with notarization on macOS, signed packages on Linux. On Windows, Daylens ships through the Microsoft Store, which signs the package and installs its updates. Any Windows build distributed outside the Store is Authenticode-signed (installer, app and helper, timestamped and verified after packaging), and its updates refuse to install when the publisher cannot be verified.
- **Updates** are signed and verified before install.
- **The MCP server** is local to the machine. Assistants can read the record, pause recording and add exclusions; resuming, removing an exclusion, corrections and deletions wait for the user's yes in Daylens.
- **Running the app as Node.** The packaged app lets its binary run as Node (Electron's `runAsNode` fuse), so assistants can start the MCP server without installing Node. On macOS any local program could then run code as Daylens with Daylens's permissions, so the main app holds no macOS privacy permission: Accessibility belongs to the capture helper's own bundle, and any later permission (calendar, for example) goes to a helper too.
- **Payments.** Card data is entered only in the payment provider's hosted checkout.

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

A plain-language page reachable from onboarding and Settings that states the above: what is recorded, what never is, what can leave the computer, and how to control it.
