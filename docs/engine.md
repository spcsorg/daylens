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
- Screen text and audio transcripts, when the user turned them on, as evidence of what was on screen and said.
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

## Writing hours

Each hour is written a few minutes after it ends (five, so late lines from capture and agent logs arrive first), by the capture service, one hour at a time. An agent turn still running at the hour's end has nothing logged past its last record, and a written hour isn't rewritten, so the hour waits for that turn's next log record, at most 30 minutes after the hour ends; a turn can end without a closing record, and after the wait the hour is written with what the log shows. With AI off nothing is sent and the hour stays as its facts. An hour with nothing recorded is not sent. A written hour is checked in code before it is stored; one that fails the checks, or whose call fails, stays as facts and is tried again later, three times in all. A spent balance or rate limit pauses writing for an hour. An hour the person corrected is never rewritten. Turning AI on writes the hours of the last day that have no text yet, not older ones.

A written hour reads the way "How Daylens talks" in `experience.md` says: the title names the work, the summary and detail group the hour by the work with how long each piece took, never a walk through the clock or the windows, with times as the app writes them (9:20 AM). The checks reject, besides invented IDs, apps and times, and anything called finished without a commit: "most of the hour", "much of the hour" or "the rest of the hour" about something the hour shows for less than half of it. `node tools/eval/hours.ts` in `v2/` writes the invented seed day's hours through the same path and grades each for that voice; writer prompt changes merge only when every hour passes.

## Choosing the models

The model that writes hours is chosen by running candidates on the same frozen packets and scoring every hour against a frozen answer key, with cost and latency recorded per call. A model is chosen for correctness first (no wrong hours, no unsupported claims), then cost, then speed. The choice is revisited whenever the packet format, the gold days or the available models change.

Current choice, on your own Anthropic key:

| Job | Model | Why |
|---|---|---|
| Writing hours | Claude Opus 5.5 (`claude-opus-5-5`), default effort | Most correct on the gold day: 10 of 16 hours right minus wrong, against 9 for Sonnet 5.5 and 6 for facts alone, with the fewest unsupported claims. About $0.59 for a 16-hour day; it runs in the background, so its 12 s per hour doesn't matter. |
| Answering Ask | Claude Opus 5.5 (`claude-opus-5-5`), low effort | Ask's evaluation (18 questions on the invented day, each asked twice) judges answers the way a person would want to hear them. Opus 5.5 at low effort passes all 18 on most runs where Sonnet 5.5 passes about 11. Before a summary or a how-long answer it lists the pieces of work and their minutes, so the same question gets the same pieces; that puts a summary's first sentence at about 4 to 6 s, other answers at about 2 to 3 s. |

Both choices rest on one gold day and are rerun on the next. The subscription command-line route (Claude Code or Codex run headlessly) was tried and dropped: a call takes several seconds longer, nothing streams, and it needs a signed-in tool on the machine.

## What is not in V2

Embedding-based boundaries and labels learned from past corrections are not in V2. Each would be added only after a measured gain on held-out gold days that justifies its cost. An automatic "supervising agents" state is not inferred; an agent working while its window is in front is recorded as exactly that.

## Measuring quality

See [Testing](testing.md#gold-days).
