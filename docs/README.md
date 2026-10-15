# Daylens V2 documentation

Daylens V2 is a rewrite. These documents describe what V2 is and how it is built. They replace the V1 documents, which are kept in [archive/v1](archive/v1/) for history only. Nothing in the archive is a source of truth.

Read them in this order:

| Document | What it settles |
|---|---|
| [Product](product.md) | What Daylens is, who it is for, the promise, the voice, and what V2 includes |
| [Experience](experience.md) | Every screen and behavior, and the rule that Windows, macOS and Linux get the same experience |
| [System design](system-design.md) | How the app is built: capture, storage, the engine, search, assistants, AI and billing |
| [Engine](engine.md) | How Daylens turns raw activity into a readable day, and how that is measured |
| [Privacy and security](privacy-and-security.md) | What is recorded, what never is, where data goes, and what each promise requires |
| [Billing](billing.md) | Plans, usage, payment methods and the rules payment states follow |
| [Testing](testing.md) | Gold days, acceptance tests for every promise, and the cross-platform test matrix |
| [Build plan](build-plan.md) | The build order, how each step is reviewed, and the release checklist |

Operational runbooks live in [operations](operations/). They were carried over from V1 and must be checked against the code before the V2 release.

## How work happens

1. A change starts from these documents. If a needed product decision is missing, it is asked for and recorded here before code is written.
2. A plan is written and reviewed by a different model or person before implementation. Its only job is to find what is wrong.
3. The change is built and reviewed again the same way.
4. Every change that affects what the user sees is measured: speed against the budgets in [System design](system-design.md), quality against the gold days in [Testing](testing.md).
5. When output is wrong, the process that produced it is fixed, not only the output.

The running app and the code are the truth for current behavior. When a document and the code disagree, the code is checked and the document is corrected.
