import { SKY, type Beat, type Ratio } from "../Film";
import { HANDSON_SHOTS } from "../handson-shots";
import { cam, SHOTS } from "../shots";

// Option C, a hands-on tour: the app full frame the whole way, with a small numbered caption naming each step.

const { welcome, morning, today, search, assistants, trust } = SHOTS;
const { askThread, privacy } = HANDSON_SHOTS;

// Room for the caption, in frame pixels: the app moves right of it in 16:9 and above it in 4:5.
const room = (x: number, y = -30): Record<Ratio, [number, number]> => ({ "16x9": [x, y], "4x5": [0, -120] });
const ROOM = room(150);

export const handson: Beat[] = [
  {
    kind: "shot",
    shot: welcome,
    sky: SKY.dawn,
    shift: room(60),
    steps: [{ at: 0.2, to: welcome.dur + 0.1, n: 1, kicker: "Daylens V2, a quick tour", label: "Turn it on" }],
  },
  {
    kind: "shot",
    shot: morning,
    sky: SKY.morning,
    shift: ROOM,
    steps: [{ at: 0.6, to: morning.dur + 0.1, n: 2, label: "Work as usual", hint: "Each hour is written down as it ends." }],
  },
  {
    kind: "shot",
    shot: today,
    sky: SKY.morning,
    shift: ROOM,
    steps: [{ at: 0.3, to: today.dur + 0.1, n: 3, label: "Look back by day, week or month" }],
  },
  {
    kind: "shot",
    shot: { ...search, dur: 5.2 },
    sky: SKY.noon,
    shift: room(0, 0),
    steps: [{ at: 0.3, to: 5.3, n: 4, label: "Search the way you remember it" }],
  },
  {
    kind: "shot",
    shot: askThread,
    sky: SKY.noon,
    shift: room(250, -10),
    steps: [
      { at: 0.3, to: 7.2, n: 5, label: "Ask about any day", hint: "In plain words. Ask is in the beta." },
      { at: 7.4, to: askThread.dur + 0.1, n: 5, label: "Every answer shows its pages and hours" },
    ],
  },
  {
    kind: "shot",
    shot: { ...assistants, dur: 6.9 },
    sky: SKY.afternoon,
    shift: ROOM,
    // 16:9 keeps both columns whole; 4:5 settles on the Claude Code chat.
    camera: {
      "16x9": [cam(0, 1.0, 560, 380, 1120), cam(2.4, 1.0, 560, 380, 1120), cam(3.3, 1.22, 600, 330, 1080), cam(6.9, 1.25, 600, 332, 1080)],
      "4x5": [cam(0, 1.0, 560, 380, 1120), cam(2.4, 1.0, 560, 380, 1120), cam(3.3, 1.3, 850, 300, 620), cam(6.9, 1.34, 850, 305, 620)],
    },
    steps: [{ at: 0.3, to: 7.0, n: 6, label: "Let your assistants ask too", hint: "Claude Code, Codex and Cursor, over MCP." }],
  },
  {
    kind: "shot",
    shot: { ...trust, dur: 5.2 },
    sky: SKY.afternoon,
    shift: ROOM,
    steps: [{ at: 0.3, to: 5.3, n: 7, label: "Remove a page, or pause" }],
  },
  {
    kind: "shot",
    shot: privacy,
    sky: SKY.dusk,
    shift: ROOM,
    steps: [{ at: 0.3, to: privacy.dur + 0.1, label: "You choose what AI sees" }],
  },
  { kind: "end", dur: 3.2, sky: SKY.dusk },
];
