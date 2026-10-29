import { type Beat, type Ratio } from "../Film";
import { HANDSON_SHOTS } from "../handson-shots";
import { cam, SHOTS } from "../shots";

// Option C, a hands-on tour: the app full frame the whole way, with a small numbered caption naming each step.

const { welcome, morning, today, search, assistants, trust } = SHOTS;
const { askThread } = HANDSON_SHOTS;

// Room for the caption, in frame pixels: the app moves right of it in 16:9 and above it in 4:5.
const room = (x: number, y = -30, y45 = -120): Record<Ratio, [number, number]> => ({ "16x9": [x, y], "4x5": [0, y45] });
const ROOM = room(150);

export const handson: Beat[] = [
  {
    kind: "shot",
    shot: welcome,
    shift: room(60, -30, -40),
    steps: [{ at: 0.2, to: welcome.dur + 0.1, n: 1, label: "Turn it on" }],
  },
  {
    kind: "shot",
    shot: morning,
    shift: ROOM,
    steps: [{ at: 0.6, to: morning.dur + 0.1, n: 2, label: "Work as usual", hint: "Each hour is written down as it ends." }],
  },
  {
    kind: "shot",
    shot: today,
    shift: ROOM,
    steps: [{ at: 0.3, to: today.dur + 0.1, n: 3, label: "Look back by day, week or month" }],
  },
  {
    kind: "shot",
    shot: { ...search, dur: 5.2 },
    shift: room(200, 0),
    // The whole panel and the day's title stay in frame.
    camera: {
      "16x9": [cam(0, 1.0, 590, 360, 740), cam(0.8, 1.0, 590, 360, 740), cam(1.8, 1.18, 640, 320, 860), cam(5.2, 1.22, 640, 330, 860)],
      "4x5": [cam(0, 1.0, 590, 360, 740), cam(0.8, 1.0, 590, 360, 740), cam(1.8, 1.5, 668, 230, 840), cam(5.2, 1.5, 668, 260, 840)],
    },
    steps: [{ at: 0.3, to: 5.3, n: 4, label: "Search the way you remember it" }],
  },
  {
    kind: "shot",
    shot: askThread,
    shift: room(230, -10),
    camera: { "16x9": [cam(0, 1.0, 590, 360, 740), cam(0.9, 1.18, 650, 362, 680), cam(askThread.dur, 1.2, 650, 358, 680)] },
    steps: [
      { at: 0.3, to: 7.2, n: 5, label: "Ask about any day", hint: "In plain words." },
      { at: 7.4, to: askThread.dur + 0.1, n: 5, label: "Every answer shows its pages and hours" },
    ],
  },
  {
    kind: "shot",
    shot: { ...assistants, dur: 6.9 },
    shift: room(310, -20),
    // 16:9 keeps both columns whole; 4:5 settles on the Claude Code chat.
    camera: {
      "16x9": [cam(0, 0.92, 560, 380, 1120), cam(2.2, 0.92, 560, 380, 1120), cam(3.0, 1.0, 620, 390, 1120), cam(6.9, 1.02, 620, 392, 1120)],
      "4x5": [cam(0, 1.0, 560, 380, 1120), cam(2.2, 1.0, 560, 380, 1120), cam(3.0, 1.3, 824, 388, 580), cam(6.9, 1.34, 824, 392, 580)],
    },
    steps: [{ at: 0.3, to: 7.0, n: 6, label: "Let your assistants ask too", hint: "Claude Code, Codex and Cursor, over MCP." }],
  },
  {
    kind: "shot",
    shot: { ...trust, dur: 5.0 },
    shift: room(150, -30, -80),
    camera: {
      "16x9": [cam(0, 1.0, 590, 360, 740), cam(0.6, 1.18, 650, 300, 900), cam(5.0, 1.2, 650, 300, 900)],
      "4x5": [cam(0, 1.0, 590, 360, 740), cam(0.6, 1.42, 650, 330, 900), cam(3.0, 1.42, 650, 330, 900), cam(3.6, 1.3, 650, 280, 900), cam(5.0, 1.3, 650, 280, 900)],
    },
    steps: [{ at: 0.3, to: 5.1, n: 7, label: "Remove a page, or pause" }],
  },
  { kind: "end", dur: 3.8 },
];
