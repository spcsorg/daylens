# Experience

Daylens is a calendar of what you did. This document describes every screen and behavior in V2. The design file is the visual reference; when the two disagree, this document records the decision and the design is updated.

## Platform differences

Windows, macOS and Linux share one design. These are the only differences, each forced by the operating system:

| Area | Windows | macOS | Linux |
|---|---|---|---|
| Window controls | Right side; native Windows caption buttons drawn in Daylens colors, so Snap layouts work | Left side, traffic lights | Follows the desktop |
| Background menu | System tray icon | Menu bar icon | Tray where the desktop supports it |
| Shortcut modifier | Ctrl | Cmd | Ctrl |
| Permissions in onboarding | None needed for window titles | One step: Accessibility, plus browser access | Depends on the desktop; see [System design](system-design.md#linux) |
| Sign-in options | Google, email | Apple, Google, email | Google, email |
| Install and updates | Microsoft Store | Download from the website; updates in the app | Nightly packages |
| Browser extension | Each browser is paired once, with one confirmation | Connects without a prompt | Connects without a prompt |

Everything else is identical: layout, type, color, motion, copy, features, and performance budgets. Copy never names a platform-specific mechanism ("Keychain", "Full Disk Access") on a shared screen; where a platform needs its own step, that step is drawn separately for that platform.

## Navigation

A sidebar with Today, Apps and Ask, and Settings at the bottom. Search opens from anywhere with Ctrl+K or Cmd+K.

There is no permanent "Recording" indicator. Recording status appears in the app only when Daylens is paused or something is broken. Pausing lives in the tray or menu bar menu and in Settings.

## Today

Today is home.

- **Order.** Hours run from the start of the day down to now, like a calendar. Today opens scrolled to the current hour.
- **An hour, closed.** A title that names the work, one or two lines of summary, and the icons of the apps involved. Clicking anywhere on the row opens it.
- **An hour, open.** What happened, the outcome (only when proven), and the sources. Each source opens the page, file or window it refers to. Sometimes there is a suggestion with a short checklist; most hours have none. Edit lives inside the open hour.
- **Facts first.** Before AI has written an hour, it shows recorded facts: apps, durations, window and page titles. Its title is its three longest apps and its summary its two longest window or page titles. The written version replaces it when ready. The current hour is always facts, updating live.
- **Fixing an hour.** "What were you doing?" takes a few words. The recorded facts for that hour are shown underneath. Saving replaces the title and summary everywhere: Today, Search, Ask, assistants and day files. A small "Edited" mark appears beside the title. Undo is available for a few seconds after saving and from the hour afterwards.
- **Removing a source.** Removes every record of that page or file for that day and rewrites the hour from what is left. Optionally, never record that site again.
- **Gaps.** Time with nothing recorded says why: asleep, idle, locked, paused, excluded, or permission lost.
- **Browser time Daylens could not read.** Unknown browser time may be private browsing, so Daylens never presses for it. Spans under 15 minutes are simply shown as browser time. For a longer span that nothing else explains, the open hour offers "What were you doing in Chrome from 2:00 to 2:20?" with a one-tap "Leave it" that never asks about that span again. Nothing is shown as a notification or on the closed hour. An answer works like a correction. The same place offers the browser extension.
- **Left off.** A card at the current hour shows the last thing you were doing. Each item in it opens that thing directly.
- **Day one.** No empty states and no "come back tomorrow". Earlier today is filled in automatically from browser history and anything else already allowed. Filled-in hours are marked as having less detail.
- **Other days.** Previous and next buttons and a calendar picker. Days with records are marked.
- **Day, week, month.** One control at the top switches Today between the day, its week and its month.

## Week and month

The week and the month are the same calendar, stepped back.

- **Week.** Seven days side by side, hours running down like a calendar week. Each hour is a block titled by its work. Clicking a block opens that hour.
- **Month.** Each day shows its main pieces of work and its recorded time. Clicking a day opens it.
- **Facts first.** Hours AI has not written yet show their facts, as on Today. A week or month never waits on AI.
- **Time per piece of work.** Each view shows how long each piece of work took across that week or month, labeled, so it can be compared with how long it felt.

## Search

Search finds anything you saw, across every day.

- Searches page titles and addresses, file names, window titles, and hour text.
- Results show the actual page, file or window first, with the app icon and when you saw it, and open directly. The hour each result belongs to is shown under it.
- Works without AI.
- Pages, files and windows are listed together and hours apart. Each kind shows its five best matches, and Show more lists up to 25 of each.
- Example searches in the product are written the way people type them: lowercase, half-remembered, everyday. For example, "the google doc someone shared with me monday about the budget".

## Ask

Ask answers questions about any day from the same record.

- An answer cites the hours and sources it used, and each one opens.
- Asking for a timesheet or a report ("my hours on the bank project this week") drafts it from the recorded hours, with time per piece of work and the hours it came from, ready to copy.
- Example questions lead with finding things and picking up work, then summaries and time.
- With no AI, or at the free limit, Ask still searches and shows matching results.
- The usage counter appears only when the user is close to their limit.

## Apps

- Day and week views.
- Each app shows its total time, the hours it appeared in, and the pages, documents or windows used in it. Each opens.
- A breakdown bar is used only if each segment is labeled.
- Removing an app's records for a day is one action in the app's detail view, not a menu on every row.

## Settings

- **General:** start and end of the day, notification times, launch at login, appearance.
- **Recording and privacy:** recording status and permissions, pause, how long history is kept, what is sent to AI and when, exclusions (apps and sites, with sensible defaults on), private windows (always skipped), apps whose window titles are kept (for apps with a built-in browser engine that Daylens does not already trust; adding one says in one line that its private windows could then be recorded), screen recording and audio recording (each off until turned on, asking for its permission when turned on), browsers (each supported browser found on the computer, whether its extension is connected, and one click to add it), usage analytics (on, with an off switch), and delete history.
- **Assistants:** every MCP app found on the machine, connect and disconnect, a test, a log of what each one read, and setup for any other MCP app.
- **AI:** the current choice (Daylens AI, your own key, a CLI on the machine, or none), usage this month split by naming hours and Ask, what each assistant read, and token spend when using your own key. Things you told Daylens, each removable.
- **Plan:** current plan, usage, renewal or end date, payment method, cancel and resume.
- **Data:** save each day as a note in a folder you choose, let coding agents read those notes, and export everything.

## Browser extension

Offered after onboarding, from Settings and from an hour Daylens could not read, never as an onboarding step. One click per browser, with a one-line explanation: it lets Daylens see which page you were on, never in private windows. Installing Daylens registers it with every supported browser, so the extension connects the moment it's added. The one exception is the Microsoft Store build on Windows, which can't register it: there the extension shows Connect once, and Firefox also asks for one Allow in Daylens. Settings shows each browser's connection, and an extension that can't reach Daylens says so in its popup.

The extension's own popup shows whether it is connected to Daylens, a pause for that browser only, and a link that opens Daylens. Nothing else. On Windows, before the first connection, it shows one button to connect. The browser's toolbar hides the extension in private windows, so the popup has no private-window state.

## Tray and menu bar

The current hour's title, pause options (one hour, until tomorrow, until resumed), delete the last ten minutes, open Today, and quit. The same menu on every platform.

## Notifications

A morning note to pick up where you left off and an evening note when the day is written up. Times follow the day's start and end and can be changed in Settings.

## Onboarding

Onboarding is where Daylens wins or loses a user. It must feel effortless and polished.

- Eight moments or fewer.
- The first thing people see is Daylens doing something useful, such as a search that finds something real, not a form.
- Permissions are one step with one button. On macOS, the step opens System Settings with a small floating window to drag the Daylens icon into, and turns green on its own when access is granted. Browser access is part of the same step.
- Privacy is one calm line with a link to the Terms and Privacy page.
- Assistants on the machine are found automatically and connected with one button, plus setup for any other MCP app. When Claude Code or Codex is found, the same step has one toggle to read their session logs, on by default, with one line saying only times, project folders and branches are read, never what was said.
- AI defaults to Daylens AI. Other choices are one click away.
- Onboarding ends on the user's own morning, already filled in and named, then opens Today.
- No pricing, no "what happens next" lists, no questions Daylens can answer by observing.

## Plans and payment screens

- Choose a plan, then pay by card or mobile money.
- Card payment goes through the payment provider's hosted checkout. Card numbers never pass through the Daylens interface.
- Prices show in the user's local currency.
- Every waiting, failed, expired, cancelled and successful state is drawn. A state is shown only after the payment provider confirms it. See [Billing](billing.md).

## Interface rules

- One main action per screen. Other actions sit next to the thing they change.
- No icon or menu repeated on every row when one place will do.
- Say where you are once.
- Don't repeat a fact already on screen.
- No instructions explaining how to use the screen.
- Errors say what happened and what to do next.
- Destructive actions confirm in one line.
- Corrections, edits and successes are quiet; red is reserved for destructive actions and real errors.
