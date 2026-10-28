# Daylens

**A calendar of what you did.**

Daylens records the apps, windows and pages you use and turns them into a calendar of what you did, one you can ask anything.

## The problem

Most work now happens on a computer, spread across a browser, a handful of apps and dozens of windows. By evening, you can't pin down where your day went or what you actually did.

That matters whenever you look back or plan ahead. We misjudge how long things take, and we forget what we did, even on our busiest days.

## Solution

Daylens puts that context in an interface everyone already knows: a calendar. It does a few things exceptionally well.

1. **A calendar of where your time went.** See your days, weeks and months as they actually happened. Open any hour to see what you worked on, what you finished and where you left off. You see how long things really took, not how long they felt.
2. **Ask about any of it.** "When did I work on that forecasting report?" Answers come from the record of what you did and when, and show the hours they came from. Describe a page the way you remember it, and Daylens brings it back. Draft anything from a status update to a client report, with billable hours filled in from what you actually did. No notes on every hour, no timesheets the old way.
3. **Your AI gets the same context.** Daylens connects to Claude, ChatGPT, Codex and Cursor, so your favorite AI tools start every chat knowing your days.

## The browser extension

Daylens fills in pages from browser history on its own, but history can't say which tab was in front or for how long. The Daylens extension for Chrome, Edge and Firefox can: it reports the page you were on and nothing from private windows.

It is optional, so nobody is asked for it during onboarding. People find it in two places: in Settings, which lists each supported browser on the computer and whether its extension is connected, and in any hour where Daylens couldn't tell which page you were on. Adding it is one click per browser, and it connects on its own; only the Microsoft Store build on Windows asks for one Connect, and Firefox for one Allow in Daylens. See [Experience](experience.md#browser-extension).

## Why let your AI read your day?

Agents now do real work for you, and they do it better when they know how you work. With Daylens connected, your assistant sees what you worked on, how long things take and where you left off, and acts on it. It reads your record but never changes it.

| You ask | Your assistant uses |
|---|---|
| "When did I work on the forecasting report?" | Your hours, found by what the work was about |
| "Write my standup from yesterday." | What you actually did yesterday, commits included |
| "Pick up where I left off on the login bug." | Your last session on that project: pages, files, commits and agent sessions |
| "Draft this week's client report." | Every hour you spent on that client this week |
| "How long will this take me?" | How long similar work took you before |
| "Plan my week." | How your recent weeks actually went |

It works with the assistant you already use: Claude, ChatGPT, Codex, Cursor and any app that supports MCP. Daylens is the context that makes your AI a real copilot.

## Why Daylens, and not Toggl, Clockify or another time tracker?

| Others | Daylens |
|---|---|
| Ask you to start timers or pick a project | Records on its own. You never start anything. |
| Show minutes per app: "Excel, 42 min" | Writes each hour as what you did: "Finished the budget review" |
| Keep screenshots, audio or what you type | Keeps app names, window titles and pages. Screenshots and audio only if you turn them on. Never what you type. |
| Guess what you finished | Calls something finished only with proof: a commit, a published page, a sent message. Says so when it can't tell. |
| Work with one company's AI | Works with Claude, ChatGPT, Codex, Cursor and any MCP app. You pick the AI that writes your hours, or none. |
| See a coding agent as a terminal window | Knows when your Claude Code and Codex sessions ran, and on which project |
| Run on Mac only | Runs on Windows and Mac, with Linux as a nightly build |

## Who it's for

Anyone whose work is spread across apps, sites, documents and AI tools, and who wants to know where their time actually goes.

| Who | What you'd use it for | What you'd type into it |
|---|---|---|
| Student | Finding the lecture video, article or PDF you saw last week. Seeing where study time actually went. Picking an assignment back up. | "the article about photosynthesis i read on tuesday" |
| Consultant | Billable hours and client reports, written from what you actually did instead of from memory. | "what did i work on for the bank project this week?" |
| Developer | Seeing which projects your Claude Code and Codex sessions worked on, beside your commits and pages. Giving a new AI chat today's context. | "where did i leave off on the login bug?" |
| Anyone on a laptop | An end-of-day summary that writes itself. Finding a page or file you lost track of. Opening the last thing you were doing. | "that spreadsheet with the q4 costs" |

## Privacy

Your record stays on your computer, and you decide what Daylens sees. It never records what you type, and it records your screen or audio only if you turn that on.

### Does it track everything?

No. By default it knows where you were, not what you said. It notes which app was in front, the window's title, and the page in a normal browser window. It never sees what you type, what's inside your files, or private windows. It sees your screen or hears audio only if you turn that on. Anything you keep out, it never stores.

| It records | It never records |
|---|---|
| The app in front and its window titles | What you type, or any keystrokes |
| The page in normal browser windows | Screenshots or audio, unless you turn them on |
| When your computer is idle, locked or asleep | What's inside your files |
| Your own commits in the code folders on your computer: message and time | Pages and titles from private and incognito windows |
| If you allow it: calendar events | Anything in an app or site you excluded |
| Unless you turn it off in setup: when your Claude Code and Codex sessions ran, in which project folder and branch. Never what was said. | |
| If you turn it on in Settings: screenshots, with their text read on your computer, and audio, transcribed on your computer | |

**What you control:**

- **Pause** for an hour, until tomorrow, or until you resume. Paused time records nothing.
- **Keep things out.** Exclude any app or site before anything is stored. Password managers and banking are excluded from the start.
- **Delete** the last ten minutes, an hour, a day, a range, or everything. Deletion reaches every copy, and deleted material never comes back.

**Titles can be personal.** A window title can hold an email subject or a document's name. Exclude any app and its titles are never stored.

### Does it track my Chrome tabs?

Only the tab you're looking at, in a normal window: its title and its address. Not your other open tabs, not what's on the page, not what you type into it. Never incognito.

- **Without the extension,** Daylens reads the pages you visited from Chrome's own history file, starting from the beginning of the day you install it. Chrome never writes incognito browsing there. A page found this way is searchable, but it gets no time: opening a page doesn't prove you read it.
- **A window Daylens can't confirm is normal** is recorded as "browser time" with no page and no title. Private time looks the same, so it's never exposed.
- **The optional extension** gives the exact page and time of the tab you're on. It's offered after setup, never forced. It can't run in incognito, can't read pages, and has no history access. It talks only to Daylens on your own computer.
- **Addresses are trimmed.** Tracking codes, tokens and most other parameters are cut before anything is stored.

### Where is my information saved, and is it sent to you?

On your computer, in a database on your own disk. There's no Daylens cloud copy of your day. When AI writes an hour, only that hour's facts go to the AI you picked, as the table below lists. They go straight there, not through our servers. Turn AI off and Daylens sends nothing to an AI. Assistants you connected keep reading until you disconnect them.

**Everything that can leave your computer:**

| What | Goes to | When | How to stop it |
|---|---|---|---|
| One hour's facts: window and page titles, addresses, app names and times, agent sessions and their projects, commit messages, calendar events, the previous hour's text, open threads and corrections from nearby hours, plus screen text and transcripts if you turned them on | The AI you chose, directly | Each hour, while AI is on | Choose no AI. Hours stay as plain facts. |
| The hours relevant to a question | The AI you chose, directly | When you use Ask | Choose no AI. Ask then searches instead. |
| What an assistant reads | That assistant's own AI service | When an assistant you connected reads your days | Disconnect it. Every read is logged in Settings. |
| Account, plan, usage and payments | Daylens billing | If you have a plan | Never includes activity, prompts or answers |
| How you use the app: features and screens used, errors, speed, AI usage, app version and system, under a random ID | Daylens | On by default | Turn it off in Settings. Never your record: titles, addresses, file names, screen text, transcripts, prompts or answers. |

**How you know:** Settings shows what was sent to AI and when, and every read by each assistant. Each privacy promise has an automated test before release, including "nothing is sent to an AI provider when AI is off".

The full rules behind these answers: [Privacy and security](privacy-and-security.md).

## One experience on every platform

Windows, macOS and Linux get the same Daylens: the same screens, layout, words, features, speed and quality. A feature does not ship on one platform and wait on another.

Differences are allowed only where the operating system forces them, and each one is listed in [Experience](experience.md#platform-differences). Anything not on that list must look and behave the same everywhere.

**Releases:** V2 ships as a stable release on Windows 11 and macOS. Linux ships as a nightly until it meets the same bar. Most users are on Windows.

## Principles

1. **Fast above everything.** Every screen opens instantly and every action responds immediately. In the background, Daylens uses as little CPU, memory and battery as possible; a user should never notice it running. Speed is checked on every change, not optimized later.
2. **The calendar never waits on AI.** Every screen shows recorded facts the moment it opens. AI writing replaces facts when it is ready.
3. **Never claim more than the record shows.** Something is finished only when there is proof: a commit, a published page, a sent message. Opening something is not finishing it. When Daylens cannot tell what happened, it says so.
4. **Corrections win.** A correction takes a few words, changes the hour everywhere, survives every rewrite, and can be undone.
5. **You control what it sees.** Exclusions apply before anything is stored. Pages and titles from private windows are never recorded. Pause and delete are always one step away.
6. **It pays for itself.** AI that costs money to run is covered by plans, and no plan promises more than the costs allow.
7. **Nothing here is new.** Activity trackers, time trackers, screen recorders and AI assistants have been built many times. When a decision isn't written down, Daylens does what established apps do, and the choice is recorded in these documents.

## Voice

Daylens speaks to the user as "you", in plain words and short sentences.

- Titles name the work, not the app: "Finished the budget review with class running alongside", not "Excel".
- Status and errors say what happened and what to do, without system language ("interpretation agent", "re-analysis", "Markdown day files").
- Privacy is stated plainly and calmly, once, with details one tap away. It never opens with a list of warnings.

## V2 scope

| In V2 | Later |
|---|---|
| The calendar: day, week and month, with hours named as they finish, facts first | Learned labels and embedding-based boundaries (only if measured to help) |
| Search across every day | Web companion and sync |
| Ask, answering from the same record, including timesheets and reports | Organization sharing |
| Apps, by day and week | Wrapped-style recaps |
| Fixing an hour, deleting a source, exclusions, pause | |
| Screen and audio recording, off unless turned on in Settings | |
| Menu bar and tray menu, morning and evening notifications | |
| Assistants over MCP | |
| AI choice: Daylens AI, your own key, a CLI on the machine, or none | |
| Plans and payments by card and mobile money | |
| The browser extension for Chrome, Edge and Firefox | |
| Onboarding | |
