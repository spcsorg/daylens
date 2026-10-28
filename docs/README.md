# Daylens V2 documentation

**A calendar of what you did.**

Daylens records the apps, windows and pages you use and turns them into a calendar of what you did, one you can ask anything.

These documents describe what V2 is and how it is built. They replace the V1 documents, which are kept in [archive/v1](archive/v1/) for history only. Nothing in the archive is a source of truth.

Nothing in Daylens is new. Where these documents are silent, Daylens does what established apps do, and the choice is added here.

## What Daylens is

| Document | What it settles |
|---|---|
| [Product](product.md) | What Daylens is, the problem it solves, who it is for, privacy, principles, voice, and what V2 includes |
| [Privacy and security](privacy-and-security.md) | What is recorded, what never is, what can leave the computer, and what each promise requires |

## How it works

| Document | What it settles |
|---|---|
| [Experience](experience.md) | Every screen and behavior, and the rule that Windows, macOS and Linux get the same experience |
| [System design](system-design.md) | How the app is built: capture, storage, the engine, search, assistants, AI and billing |
| [Engine](engine.md) | How Daylens turns raw activity into a readable day, and how that is measured |

## Shipping

| Document | What it settles |
|---|---|
| [Billing](billing.md) | Plans, usage, payment methods and the rules payment states follow |
| [Testing](testing.md) | Gold days, acceptance tests for every promise, and the cross-platform test matrix |
| [Build plan](build-plan.md) | How work happens, the build order, how each step is reviewed, and the release checklist |

Operational runbooks live in [operations](operations/). They were carried over from V1 and must be checked against the code before the V2 release.

The running app and the code are the truth for current behavior. When a document and the code disagree, the code is checked and the document is corrected.
