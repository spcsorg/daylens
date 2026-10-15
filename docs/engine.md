# Engine

The engine writes each hour of the day from what the computer recorded. This document covers what it produces, how it decides, and how its quality is measured.

## What an hour contains

```json
{
  "title": "names the work, not the app",
  "summary": "one or two lines",
  "apps": ["apps involved"],
  "detail": "what happened",
  "outcome": "what was finished, only with proof, or null",
  "sources": ["IDs of the observations every claim rests on"],
  "suggestion": "a repeatable workflow or obvious next step, or null"
}
```

Rules the writer follows:

- The title names the work, not the app.
- It speaks to the user as "you", in plain words and short sentences.
- Something is finished only if the packet proves it: a commit, a published page, a sent message.
- If the packet cannot tell what happened, it says so. It never fills gaps.
- A suggestion only when the hour clearly shows a repeatable workflow or an obvious next step. Most hours get none.
- Every claim traces to IDs in the packet.

## What goes into a packet

- Intervals per app, window and page, merged and with short IDs.
- Page titles are evidence of what was open. The contents of documents are not evidence of what the user did.
- Agent sessions: project folder, turn times, and when the user submitted a message.
- Commits from local repositories in the hour, deduplicated by hash.
- Calendar events, marked as scheduled, not as attended.
- Gaps with their reason, and possibly stale titles flagged as such.
- The previous hour's summary and the open threads, so work that spans hours stays connected.
- The user's corrections for this hour and nearby hours.

Packets are kept small: the cost of naming a day depends mostly on packet size.

## Lessons from the first evaluation

A full day was rebuilt from raw capture by several models, one isolated call per hour, and scored hour by hour against the user's own account of that day. Most errors came from missing or misleading input, not from the model:

| Failure | Fix |
|---|---|
| An hour written alone could not connect to the hour before (installing a tool, then removing it) | Pass the previous hour's summary and open threads |
| A terminal title stayed unchanged for three hours and was taken as the work | Flag stale titles; never treat them as evidence |
| An agent app with no window titles hid the main thread of an evening | Read agent session logs |
| A browser recorded no pages for long stretches | Repair browser capture on every platform |
| A commit made by an agent while the screen was locked was attributed to the user | Packets mark lock periods; the writer never assigns work done while away to the user |
| Some models cited IDs that did not exist | Validate every cited ID in code |
| Visitors and demonstrations could not be known from the computer | A quick way to add context to an hour, which then wins |

## Choosing the model

The model that writes hours is chosen by running candidates on the same frozen packets and scoring every hour against a frozen answer key, with cost and latency recorded per call. A model is chosen for correctness first (no wrong hours, no unsupported claims), then cost, then speed. The choice is revisited whenever the packet format, the gold days or the available models change.

## What is not in V2

Embedding-based boundaries and labels learned from past corrections are not in V2. Each would be added only after a measured gain on held-out gold days that justifies its cost. An automatic "supervising agents" state is not inferred; an agent working while its window is in front is recorded as exactly that.

## Measuring quality

See [Testing](testing.md#gold-days).
