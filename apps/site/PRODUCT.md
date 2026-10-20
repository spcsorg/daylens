# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js (App Router, React) on Vercel. The owner prefers a modern React stack. Signups go through one route handler that adds a Resend contact; the API key comes from an environment variable and is never committed.

## Users

Anyone who works at a computer all day and wants to learn from, document, and reuse what they did, especially in AI tools. Time-tracking and productivity people are a core group. Many already use assistants such as Claude, Codex, and Cursor.

## Product Purpose

Daylens V2 remembers the workday on the person's own computer. It records which apps, windows, and pages were used, names each hour in plain words, and lets the person search their day, ask about it, and give that context to the AI assistants they choose. This site is the V2 launch waitlist: success is an email on the list.

## Positioning

The day is named hour by hour from what actually happened, stored on the person's own computer, and readable by the assistants they connect (Claude, Codex, Cursor, any MCP app). Time trackers count minutes; Daylens remembers what the minutes were.

## Operating Context

- Desktop app for Mac, Windows, and Linux.
- Onboarding: search browser history before setup ("Find it"), one permission step, connect assistants, then "Your morning, remembered".
- Main screens: Today (hours with names, sources, Fix this hour, Edited tag), Ask (answers cite the pages, windows, and hours they used), Apps (time per app for a day or week), Settings.
- AI naming choices: Daylens AI, your own key, Claude Code or Codex on this computer, or no AI (titles only).

## Capabilities and Constraints

- Records: apps and window titles, pages in normal browser windows, when the computer is idle, locked, or asleep.
- Never records: screenshots, screen video or audio, keystrokes or typed text, file contents, private or incognito windows.
- Recorded and stored on the computer. Pause or delete any time. Exclusions ("Keep these out") are set before recording starts.
- Assistants can read days once connected; they cannot change anything. What an assistant reads can go to its own AI service.
- With permission, Daylens reads calendar events, so a day shows what was planned next to what was done.
- The waitlist is the invite list: people on it get one email when their invite is ready.
- Deletion runs from one page in one hour up to everything; exclusions cover apps and sites.
- Undecided: prices, free allowance, and launch date. Do not state them.

## Brand Commitments

- Name: Daylens. Version: V2.
- Retired taglines, never to be used: "Your day, remembered.", "For you and your AI.", "Find anything you saw. So can your AI." and "Pick up where you left off." Copy says what Daylens does, in the voice of the Superlogical version: plain, concrete, talking to the reader.
- Voice: second person, plain, concrete, short sentences. No em dashes.
- Visual system lives in the Figma file Daylens-V2 (yMCl1HweFTKE0F3hk3O0wh): Ship's log mode tokens, Geist text styles, Button and Text field components.

## Evidence on Hand

- App screens exported from Figma in `figma/` (Find it, Your morning remembered, Today with an hour open, Ask answer, Assistants connected). Their data is an illustrative persona (owner of Brightside Bakery, Wednesday 14 October), not real users.
- No testimonials, customer logos, user counts, or press. Do not invent any.
- The Daylens app icon in Figma is a 64px placeholder.

## Product Principles

- Show the day, not a dashboard.
- Privacy is stated as exact lists, never as vague reassurance.
- The person chooses which AI gets the context.
- Nothing is claimed that the app does not do.
