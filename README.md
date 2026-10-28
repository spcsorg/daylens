# Daylens

**A calendar of what you did.**

Daylens records the apps, windows and pages you use and turns them into a calendar of what you did, one you can ask anything.

Most work now happens on a computer, spread across a browser, a handful of apps and dozens of windows. By evening, you can't pin down where your day went or what you actually did.

## What it does

- **A calendar of where your time went.** See your days, weeks and months as they actually happened. Open any hour to see what you worked on, what you finished and where you left off.
- **Ask about any of it.** "When did I work on that forecasting report?" Answers show the hours they came from. Describe a page the way you remember it, and Daylens brings it back.
- **Your AI gets the same context.** Claude, ChatGPT, Codex, Cursor and any app that supports MCP can read your days.

Your record stays on your computer, and you decide what Daylens sees. See [Privacy and security](docs/privacy-and-security.md).

## Install the beta (Mac)

This is the first beta. It runs on Macs with Apple silicon or Intel, macOS 13 or later. Windows and Linux follow.

1. Download `Daylens-2.0.0-beta.1-mac.dmg` from [Releases](https://github.com/spcsorg/daylens/releases), open it and drag Daylens to Applications.
2. Open Daylens. macOS says it can't check it for malicious software. Click **Done**.
3. Open **System Settings › Privacy & Security** and scroll to Security. Next to "Daylens was blocked", click **Open Anyway** and enter your password. Click **Open Anyway** once more.
4. To see window titles, Daylens asks for Accessibility. Allow it in **System Settings › Privacy & Security › Accessibility**.

The beta isn't notarized by Apple yet, which is why macOS asks. Every beta build is signed with the same certificate, so the Accessibility permission stays when you install the next one. The beta doesn't update itself: download each new build from Releases. The first notarized build needs one more install by hand and asks for Accessibility once more; after that, Daylens updates itself.

## Run from source

You need Node.js 24 or later and, on a Mac, Xcode 16 or later with its command line tools (Swift 6; `swift --version` shows yours).

```bash
npm --prefix v2 ci
npm --prefix v2 run build:sqlite
swift build -c release --package-path v2/native/macos
npm start
```

`build:sqlite` rebuilds SQLite with the option Daylens needs to erase deleted data for good; run it after every `npm ci`. The `swift` line builds the Mac capture helper. A run from source keeps its data apart from the installed app, and its helper needs its own Accessibility permission.

Before you open a pull request, run these in `v2/`:

```bash
npm run typecheck
npm run app:typecheck
npm test
```

## Documentation

The documents start at [docs/README.md](docs/README.md):

| Document | What it settles |
|---|---|
| [Product](docs/product.md) | What Daylens is, the problem it solves, who it is for, privacy, principles, voice, and what V2 includes |
| [Privacy and security](docs/privacy-and-security.md) | What is recorded, what never is, what can leave the computer, and what each promise requires |
| [Experience](docs/experience.md) | Every screen and behavior, and the same experience on every platform |
| [System design](docs/system-design.md) | Capture, storage, the engine, search, assistants, AI and billing |
| [Engine](docs/engine.md) | How the day is written and how quality is measured |
| [Billing](docs/billing.md) | Plans, usage, payment methods and payment-state rules |
| [Testing](docs/testing.md) | Gold days, acceptance tests and the platform matrix |
| [Build plan](docs/build-plan.md) | How work happens, the build order and the release checklist |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities as [SECURITY.md](SECURITY.md) describes, not in public issues.

Daylens is released under the [MIT License](LICENSE).
