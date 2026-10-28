import { SKY, type Beat } from "../Film";
import { A_SEND, SHOTS, type Shot } from "../shots";
import { PRIVACY } from "../world";

// Ask first, at a glance: the question lands and the answer starts, faster than life.
const askOpen: Shot = {
  id: "ask-open",
  dur: 3.8,
  view: (t) => SHOTS.ask.view(A_SEND - 0.15 + t * 1.65),
  camera: [
    { t: 0, s: 1.62, x: 620, y: 170, w: 680 },
    { t: 3.8, s: 1.45, x: 620, y: 270, w: 680 },
  ],
};

// Duet's grammar: serif caption cards between oversized crops of the app, Ask as the long beat.
export const duet: Beat[] = [
  { kind: "shot", shot: askOpen, sky: SKY.dusk },
  { kind: "caption", text: "Introducing Daylens V2", dur: 2.1, sky: SKY.dawn },
  { kind: "shot", shot: SHOTS.welcome, sky: SKY.dawn },
  { kind: "caption", text: "It writes down your day, hour by hour.", dur: 2.1, sky: SKY.morning },
  { kind: "shot", shot: SHOTS.morning, sky: SKY.morning },
  { kind: "shot", shot: { ...SHOTS.today, dur: 6.2 }, sky: SKY.noon },
  { kind: "caption", text: "Find a page the way you remember it.", dur: 2.2, sky: SKY.noon },
  { kind: "shot", shot: { ...SHOTS.search, dur: 5.4 }, sky: SKY.noon },
  { kind: "caption", text: "Or just ask.", dur: 1.8, sky: SKY.dusk },
  { kind: "shot", shot: { ...SHOTS.ask, dur: SHOTS.ask.dur - 0.4 }, sky: SKY.dusk },
  { kind: "caption", text: "Pause it. Delete any of it.", dur: 2.0, sky: SKY.afternoon },
  { kind: "shot", shot: { ...SHOTS.trust, dur: 5.0 }, sky: SKY.afternoon },
  { kind: "caption", text: "Your record stays on this computer.", dur: 3.2, sky: SKY.dusk, small: PRIVACY.slice(PRIVACY.indexOf("With AI")) },
  { kind: "end", dur: 3.8, sky: SKY.dusk },
];
