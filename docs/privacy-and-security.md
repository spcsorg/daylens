# Privacy and security

## What Daylens records

- The app in front, its window titles, and the pages open in browsers.
- When the computer is idle, locked or asleep.
- With permission: calendar events, and AI agent session metadata.

## What Daylens never records

- Keystrokes or anything typed.
- Screen images, video or audio.
- File contents.
- Pages and titles from private and incognito windows.
- Anything in an excluded app or site.

## Where data lives and goes

- Everything is stored in a local database on the user's machine.
- When AI is on, the packet for an hour (titles, addresses, app names, times) is sent to the chosen provider to write that hour, and the relevant hours are sent to answer a question in Ask. Nothing else is sent.
- Assistants the user connects can read days through the MCP server. What an assistant reads can be sent to that assistant's own AI service, and Daylens cannot recall it afterwards. This is stated on the Terms and Privacy page and when connecting.
- The billing service stores account, plan, usage and payment records. It never receives activity, prompts or answers.

## Controls

- Pause for an hour, until tomorrow, or until resumed.
- Exclusions by app or site, applied before storage, with sensible defaults on (password managers, banking).
- Retention: how long history is kept.
- Delete the last ten minutes, an hour, a day, a range, or everything. Deletion reaches observations, hours, the search index, Ask answers that cited the material, and day notes. Tombstones stop deleted material from being imported again.
- Disconnect any assistant.

## Security requirements

- **Captured text is untrusted.** Page titles, document names and agent logs can contain instructions. The writer has no tools and no authority, its output is validated in code, and all text is rendered as plain text.
- **No feedback loops.** Daylens's written text is never used as evidence for later writing.
- **Secrets** (API keys, account tokens) are stored in the platform's secure storage and never written to logs or the database.
- **Signing.** Releases are signed on every platform with a stable identity: Developer ID with notarization on macOS, Authenticode on Windows (installer, app and helper, timestamped and verified after packaging), signed packages on Linux.
- **Updates on Windows** refuse to install when the publisher cannot be verified; a missing publisher setting fails the release.
- **Updates** are signed and verified before install.
- **The MCP server** is read-only and local to the machine.
- **Payments.** Card data is entered only in the payment provider's hosted checkout.

## Promises that need proof

Each of these has an automated test before release. See [Testing](testing.md#acceptance-tests).

- Pages and titles from private windows are never stored on any platform, including while the window is open, after it closes and after a restart.
- A browser window not confirmed normal never has its page or title stored.
- Exclusions apply before storage.
- Deletion reaches every copy and is not re-imported.
- Pausing stops capture for exactly the chosen time.
- Nothing is sent to an AI provider when AI is off.
- The billing service never receives activity.

## Terms and Privacy page

A plain-language page reachable from onboarding and Settings that states the above: what is recorded, what never is, where data goes, and how to control it.
