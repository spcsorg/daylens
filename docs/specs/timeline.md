# Timeline — build spec

## 1. What the Timeline is

The home screen. Your day from midnight to now, as a vertical list of **blocks**, newest
work readable at a glance. Each block is named for **what you did** and sized by **how long
it took**. To the right, a short, honest recap of the day. That is the whole screen.

## 2. What's broken now and how it should work

- Blocks named after a page or app — "Ubiquiti Account", "UOS Server",
  "Cross-platform activity tracker", raw YouTube video titles.
- The same activity split into duplicate blocks (two "UOS Server" back-to-back).
- Wrong categories — network work tagged **SOCIAL** because one X.com tab was open.
- A right-side recap that is usually wrong, and totals that disagree (42h 2m vs 46h 19m).
- **Score / Focused / Drift** grades.
- Not responsive; the left column has to be scrolled from the view to the left column to work.
- The detail panel shows **"Apps used"** and **"Key artifacts"** — two lists for one idea.
- Fix controls named badly: "Fix this episode", "Not right?" and "Edit this block" should
  be renamed to "Rename", "Merge with above/below". Remove the "Split" and "Hide" options
  and get rid of the "episode" wording everywhere.

## 3. How blocks are built (the engine)

This is the heart of the work. Today the engine builds a block whenever you stay in one
app for a while, then tries to patch the result with ~5,000 lines of rules. On a real day
that yields **53 blocks for a ~8-block day**. We replace the approach, not patch it.

### 3.1 Block boundaries — what starts a new block

A new block starts only on a strong signal:

- A real gap — idle, asleep, or locked for roughly **15+ minutes**.
- A meeting starts or ends.
- You clearly switch to a **different goal** (different subject/project).
- A user correction says "cut here".

A new block does **not** start just because you switched apps, opened a new tab, or glanced
at something for a minute or 5 minutes or even 10 minutes. Apps are *evidence*, not
boundaries.

### 3.2 Brief detours are absorbed

A short off-task moment inside a work stretch folds into that block — it does not rename it
or split it. Your X.com peek during network setup is absorbed, not a SOCIAL block.

> **DECISION (you): the cutoff.** I propose **under 10 minutes = absorbed; 10 minutes or
> more = its own block.** OK, or a different number?

### 3.3 Same-intent neighbors merge

Two adjacent blocks that are the same thing become one. The two "UOS Server" and
"Configuring the work network" and "Ubiquiti dashboard" blocks are one block — and the AI
should understand that and merge them. The name of the merged block should combine all three
into one coherent title, for example "Configuring the work network using the Ubiquiti
dashboard" or "Setting up the work network using the Ubiquiti dashboard and the Terminal."

### 3.4 Size = real duration

A 3-hour block is drawn 3× the height of a 1-hour block, always. It's a calendar-like view
so the blocks should be of different sizes based on how long the block is.

### 3.5 How a block gets its name

- Code assembles the block and its evidence (apps, sites, documents, timing). The **AI reads
  only that one block's evidence** and proposes a human title + subject. A **validator**
  checks the title is actually supported by the evidence. If it isn't, fall back to a plain
  evidence-based title.
- **Never** use a raw page title, app name, or video title as the block name. No "Ubiquiti
  Account", no "Codex", no video titles.
- Style: short, says what you were *doing* — usually verb + object. Bad: "Ubiquiti Account".
  Good: **"Configuring the work network using the Ubiquiti dashboard and the Ghostty Terminal"**.
- Prioritize naming blocks after useful activities instead of streaming or social media
  activities — most users multi-task with social media on the side but they were actually
  working.

### 3.6 How a block gets its category

From the block's **overall intent**, never from a single tab. Network admin work keeps its
real category; one open X.com tab can never flip a work block to SOCIAL.

### 3.7 Understanding human behavior

We need to study human behavior and ensure we provide the best experience and block names
that are actually closer to what the user was doing, not just the apps they were using.
We need to bring and use all meaningful data available to make blocks coherent and
meaningful — the AI analyzing the block needs to understand what each app does, not just
its name and title, but which app does what and how it contributes to the block.

We need to spend a little more tokens to let the AI prompt the user for more information to
make blocks more coherent — BUT only bring this option when the AI couldn't really figure
out the user's intent.

## 4. The live view (before recap)

When the user is live on the Today view, make that one big block and only recompute at the
end of the day or the next day when the user opens their laptop again.

That giant block visible before you generate a daily recap needs to have breaks where the
laptop was locked or the user was idle for more than 15 minutes. The title given to that
block should be the name of the thread that was most active during that time. When opened it
should show the threads that were active during that time with the time spent on each
thread — the "Apps used" and "Key artifacts" sections should be shown together in one view
instead of being separated. The "Not right?" button should be removed from this view.

## 5. Generating the recap

When the user clicks the button that splits that giant block into smaller blocks, we use AI
to split the day into blocks that are coherent and meaningful. This is currently called the
"Re-analyze with AI" button — it doesn't work at all right now.

This needs to be done right because it's the foundation of the app. We need to define what
makes a block coherent and meaningful based on the evidence and the user's intent.

**Notifications:** We can send a notification the next day that yesterday's recap is ready,
which opens on yesterday's Timeline view. We can also give the user an option to generate a
recap on the same day with a button called "Analyze Day."

## 6. Distractions / off-track time

- Brief detours are absorbed into the surrounding block (section 3.2) — they never appear
  as work.
- A **sustained** off-task stretch (≥ the section 3.2 cutoff) becomes its own small section
  in the detail panel of the block, visually distinct.

> **DECISION (you): distraction placement.** Should distractions show inline-dimmed in the
> main timeline or only inside the detail panel? Current proposal: detail panel only.

## 7. The day recap (right-hand panel)

Replace "The shape of the day" + Score/Focused/Drift with an honest recap built from the
**same blocks**.

Keep the tracked hours section on the top along with how many blocks and apps and sites were
used during that day. Remove everything else from "The shape of the day" section — the date,
the score, the focused hours, the drift hours. Remove the "What mattered" section.

What stays: a "Generate Recap" button and a summary of the day generated by the AI, based on
the blocks and the apps and the sites that were used during that day.

## 8. Invariants (rules this view must always obey)

1. A block's on-screen height is proportional to its duration.
2. No block is named after a raw app, page, or video title.
3. A single off-task tab never sets a block's category.
4. Adjacent same-intent blocks are merged.
5. Every number on the screen comes from the same blocks — the recap total equals the sum of
   the blocks. No two parts of the screen disagree.
6. A user correction always wins and always survives a rebuild.
7. The view never shows a Score, a Focus rating, or a Drift number.
8. When Daylens doesn't know, it says so — it never fills the gap with a guess.

## 9. Future integrations

In the future Daylens will be able to connect to tools you use — calendar, files on your
laptop, and other tools — to make blocks more coherent and meaningful. For now we need to
ensure Daylens can accurately track the user's activity and the AI can understand and infer
the user's intent from what was tracked.
