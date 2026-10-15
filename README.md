# Daylens

> **Remember everything you did.**

Daylens turns everything you do on your computer into a private, organized memory of your work—and gives you an agent that understands that memory.

Daily work is scattered across apps, websites, meetings, clients, and projects. You cannot reliably retrieve information such as how much time you spent on a project, remember what you did at the end of a month, recall which meetings you had during a week, find information you know you saw, or simply explain where your time went.

Right now, your own memory is the only thing connecting all of this. You either reconstruct the day yourself, install another narrow app that remembers only your meetings, or explain the same context to an AI before it can be useful. Daylens creates that missing memory automatically.

## What Daylens is

- **Timeline** turns everything Daylens understands about a day into a calendar-like account of what actually happened.
- **Apps** explains what you did inside each application and how that activity connected to pages, files, meetings, projects, and clients.
- **AI agent** answers questions using the same evidence and memory as the rest of Daylens. It can also connect to tools such as GitHub, Linear, and Granola, giving it enough context to go beyond answers like “you spent two hours in Chrome” or “you spent two hours in Cursor.”

With Daylens, you can finally get answers to questions such as:

- “How much time did I spend on Project X last month?”
- “What did I work on last week besides meetings?”
- “Which meetings did I have with Client X in June?”
- “Remind me which page had the best discount when I was researching that TV upgrade last week.”
- “Where did my time go this month?”
- “How much time did I spend on social media this week, and how much of that time was spent listening to podcasts or watching movie clips?”

Daylens is more than a time tracker. Time is one part of the memory it builds. The larger goal is to make your work understandable and retrievable to both you and the agents working with you.

Daylens should speak as if it understands what happened. It should say that you developed a feature, read a specific article, or reviewed a report with a client—not lead with the applications and telemetry used to reach that conclusion. Supporting evidence remains available, and uncertainty is stated naturally when the record is incomplete.

## Project status

Daylens is a working desktop app on Windows, macOS and Linux. V2 is a rewrite in progress: one experience on every platform, a faster app, and a day you recognize without explaining it.

## Documentation

The V2 documents start at [docs/README.md](docs/README.md):

| Document | Purpose |
|---|---|
| [Product](docs/product.md) | What Daylens is, who it is for, the promise, the voice, and V2 scope |
| [Experience](docs/experience.md) | Every screen and behavior, and the same experience on every platform |
| [System design](docs/system-design.md) | Capture, storage, the engine, search, assistants, AI and billing |
| [Engine](docs/engine.md) | How the day is written and how quality is measured |
| [Privacy and security](docs/privacy-and-security.md) | What is recorded, what never is, and the promises that need proof |
| [Billing](docs/billing.md) | Plans, usage, payment methods and payment-state rules |
| [Testing](docs/testing.md) | Gold days, acceptance tests and the platform matrix |
| [Build plan](docs/build-plan.md) | Build order and the release checklist |

Operations runbooks are in [docs/operations](docs/operations/). V1 documents are kept in [docs/archive/v1](docs/archive/v1/) for history only.

## Run from source

Install Node.js 20 or newer and the native build tools for your platform, then run:

```bash
npm install
npm start
```

Normal verification:

```bash
npm run typecheck
npm test
npm run contract:check
```

Some AI evaluations call paid providers. Read Benchmarks before running them.

Run the web companion with:

```bash
npm run web:dev
```

Platform prerequisites and packaging notes are in [Installation and releases](docs/operations/install.md).

## Install a release

On Apple Silicon macOS:

```bash
brew tap irachrist1/daylens
brew install --cask daylens
```

Installers for macOS, Windows, and Linux are available from [GitHub Releases](https://github.com/irachrist1/daylens/releases/latest).

## Privacy

Daylens is local-first and metadata-first. Activity remains in the local SQLite database unless you explicitly use a feature that sends selected context to a configured model, enable sync, or choose to share information. Incognito activity, exclusions, pauses, retention, model access, and sharing are product boundaries that must remain visible and testable.

Daylens is released under the MIT License.
