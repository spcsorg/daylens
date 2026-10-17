---
name: Daylens public site
description: The V2 landing, privacy policy, devlog and press kit, built as a kitchen order rail.
colors:
  ground: "#f3f5f4"
  ground-deep: "#e7ebe9"
  paper: "#eef5e8"
  paper-rule: "#d3e3c8"
  paper-edge: "#c9dabd"
  steel-light: "#dfe4e6"
  steel: "#a7b0b5"
  steel-dark: "#6b757b"
  ink: "#17233a"
  ink-soft: "#46526a"
  ink-faint: "#5a6477"
  check-red: "#b8302a"
  line: "#cfd6d3"
  white: "#ffffff"
typography:
  display:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "clamp(2.5rem, 5.6vw, 4.25rem)"
    fontWeight: 760
    lineHeight: 0.98
    letterSpacing: "-0.012em"
    fontVariation: "'wdth' 74"
  headline:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "clamp(2rem, 4.2vw, 3.25rem)"
    fontWeight: 740
    lineHeight: 1.04
    letterSpacing: "-0.012em"
    fontVariation: "'wdth' 76"
  title:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "1.12rem"
    fontWeight: 700
    lineHeight: 1.15
    fontVariation: "'wdth' 84"
  body:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
    fontVariation: "'wdth' 100"
  label:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "0.88rem"
    fontWeight: 700
    letterSpacing: "0.02em"
    fontFeature: "'tnum'"
    fontVariation: "'wdth' 80"
rounded:
  ticket: "2px"
  control: "10px"
  check: "12px"
  pill: "999px"
spacing:
  gutter: "clamp(16px, 4vw, 40px)"
  measure: "1200px"
  section: "clamp(64px, 11vw, 128px)"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    height: "52px"
    padding: "0 20px"
  button-primary-hover:
    backgroundColor: "#24365a"
  button-quiet:
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "48px"
  input-text:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "52px"
    padding: "0 16px"
  chip-example:
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
    height: "40px"
  ticket:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.ticket}"
    padding: "26px 16px 16px"
  check:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.check}"
    padding: "clamp(28px, 5vw, 64px)"
---

# Design System: Daylens public site

## Overview

**Creative North Star: "The Order Rail"**

Your day hangs in order like tickets on a kitchen order rail: each hour is a guest-check slip, numbered in red, written in plain blue-black ink and clipped to one steel bar. The page is the counter the rail hangs over: cool, clean, lit for working, never cream. Every container that matters is a sheet of the same pale green guest-check paper, so the site reads as one object seen at one scale, not a template with a theme.

Density is moderate. Headlines are condensed and heavy, set like the printed heading on a check pad; everything else is the same family at normal width. Color is restrained to neutrals tinted from the world, with check red as the one accent. Motion is a single authored moment: tickets swing once into place as they're hung, and a found ticket is pulled down off the rail.

This system covers the public pages under `app/(site)`. The V1 web companion under `app/(v1)` keeps its own older system.

**Key Characteristics:**
- One steel rail, flat, with a single highlight edge.
- Guest-check paper for every meaningful container, ruled where text is written.
- Check numbers and header rules in red; all text in ink.
- One variable face, Archivo, whose width axis carries the hierarchy.

## Colors

Neutrals from a working counter and a check pad, with red ink as the only accent.

### Primary
- **Check Red** (check-red): check numbers, the rule under a check's header, "Now" and "Left off" on the live ticket, the found source after a search, error text. Never a fill.

### Neutral
- **Counter White** (ground): the page field. Cool, not cream.
- **Counter Shadow** (ground-deep): the footer band and inline code.
- **Guest-Check Green** (paper): tickets, the trust check, the closing check, the success note, the table of contents.
- **Ruling Green** (paper-rule): ruled lines under written text and between check lines.
- **Paper Edge** (paper-edge): the 1px lower edge of paper, and dashed perforations.
- **Rail Steel** (steel, steel-light, steel-dark): the rail and its clips, idle input borders, dashed chips.
- **Ballpoint Ink** (ink): all headings and body text, primary buttons, focus rings.
- **Faded Ink** (ink-soft, ink-faint): supporting text and meta lines. Faded ink passes 4.5:1 on both ground and paper.
- **Counter Line** (line): hairline dividers on the ground.

### Named Rules
**The Red Ink Rule.** Red marks numbers, header rules and "now"; it never fills a surface or a button.

**The Cool Counter Rule.** The ground stays cool off-white. Never cream, never beige.

## Typography

**Display, body and label font:** Archivo variable (weight and width axes), self-hosted through next/font, with an Arial-based size-adjusted fallback.

**Character:** One face throughout. Condensed and heavy for the printed check heading, normal width for anything read.

### Hierarchy
- **Display** (760, clamp 2.5–4.25rem, 0.98, width 74): the landing headline only.
- **Headline** (740, clamp 2–3.25rem, width 72–76): section and page headings, check headings.
- **Title** (700, about 1.1–1.85rem, width 82–86): ticket titles, step titles, belief lines, check line names.
- **Body** (400, 1.0625rem, 1.55, width 100): everything read. Prose measure 34em, about 70–80 characters per line in this narrow face.
- **Label** (700, 0.88rem, tabular numerals, width 80): check numbers and ticket times.

### Named Rules
**The Width Axis Rule.** Hierarchy comes from width and weight in one family. No second display face.

**The Measure Rule.** Prose stops at 34em, because Archivo is narrow and rem-based widths hold too many characters.

## Layout

Single column inside a 1200px measure with a fluid 16–40px gutter. Sections are separated by large vertical space (64–128px). The hero is two columns from 1000px up (headline 3fr, lede and form 2fr) so the rail stays in the first viewport; below that it stacks. The rail always runs full bleed across the gutter. On phones the rail comes before the search, and tickets and example searches scroll sideways with snap points rather than wrapping. Definition lists switch to a name/detail two-column grid from 760px.

## Elevation & Depth

Depth comes from paper sitting on the counter, not from layered UI. Paper gets a 1px lower edge in paper-edge and one soft drop shadow. Steel gets a 1px inset highlight and a 1px dark lower edge, never a gradient.

### Shadow Vocabulary
- **Hanging slip** (`0 1px 0 #c9dabd, 0 12px 22px -16px rgba(23, 35, 58, 0.55)`): tickets.
- **Pulled slip** (`0 1px 0 #c9dabd, 0 22px 30px -18px rgba(23, 35, 58, 0.6)`): the ticket a search found.
- **Sheet on the counter** (`0 1px 0 #c9dabd, 0 30px 50px -36px rgba(23, 35, 58, 0.55)`): the trust check and the closing check.
- **Steel** (`inset 0 1px 0 #dfe4e6, 0 1px 0 #6b757b`): the rail and clips.

### Named Rules
**The One Sheet Rule.** Paper never sits inside paper. Content inside a check is written on it, not carded.

## Shapes

Tickets have nearly square tops (2px) where they hang and slightly softer bottoms (6px). Checks are square at the top and rounded at the bottom (4px top, 12px bottom). Controls use 10px corners; only the small example-search chips are pills. Perforations are 1.5–2px dashed lines in paper-edge or steel-dark.

## Components

### Buttons
- **Shape:** 10px corners, 48–52px tall.
- **Primary:** ink fill, paper text, weight 650 at width 92. Hover lightens the ink; press moves down 1px.
- **Quiet:** ink outline on transparent; hover fills with ink.
- **Disabled / loading:** 70% opacity and a progress cursor; the label changes to "Joining…".

### Chips
- **Style:** dashed steel-dark outline, faded ink text, 40px tall.
- **State:** hover and pressed become a solid ink outline on white.

### Inputs / Fields
- **Style:** white field, 1.5px steel border, 10px corners, 52px tall.
- **Focus:** a 2px ink outline offset by 3px, the same focus ring used everywhere.
- **Error:** a red border and a red message under the form with `role="alert"`.

### The ticket (signature)
A guest-check slip clipped to the rail. Its header row holds "No. n" in red and the time range in tabular numerals, over a red rule; then the title, the summary on ruled lines, and its sources with 14px line icons. The live ticket is white with a dashed steel outline inset 6px. A found ticket rotates to 0°, drops 10px and takes the pulled shadow; the others fade to 42%.

### The check (signature)
A full sheet of guest-check paper with a "No. n" header and a red rule. Line items are name/detail rows ruled in paper-rule; written paragraphs sit on ruled lines; a dashed perforation separates the foot.

### Navigation
A sticky header on solid ground with a hairline below. Links are faded ink, and the current page gets a 2px red underline. Below 720px "How it works" drops out, and below 480px only the logo and "Join the beta" remain.

## Do's and Don'ts

### Do:
- **Do** put anything that holds Daylens content on guest-check paper, numbered in red, when it is a primary block.
- **Do** rule the paper only where text is written on it, with the rule period equal to the line height.
- **Do** keep tilt at ±0.3° or less, so ticket text stays crisp.
- **Do** label example content as an example.

### Don't:
- **Don't** draw steel or paper with gradients that imitate material; flat values with a 1px edge only.
- **Don't** nest a white card or a second sheet inside a check.
- **Don't** put a kicker or eyebrow above a heading; a check number belongs to the check's own header row.
- **Don't** use a dark slab for a call to action; the close is a blank check.
- **Don't** add a second typeface or a cream ground.
