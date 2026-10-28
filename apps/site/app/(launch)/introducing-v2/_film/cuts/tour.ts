import { SKY, type Beat } from "../Film";
import { SHOTS } from "../shots";
import { PRIVACY } from "../world";

// The hands-on tour: every feature in onboarding order, a serif caption card between each.
export const tour: Beat[] = [
  { kind: "shot", shot: SHOTS.welcome, sky: SKY.dawn },
  { kind: "caption", text: "It writes down your day,", dur: 2.0, sky: SKY.dawn },
  { kind: "shot", shot: SHOTS.morning, sky: SKY.morning },
  { kind: "caption", text: "so you can look back at any of it.", dur: 2.2, sky: SKY.noon },
  { kind: "shot", shot: SHOTS.today, sky: SKY.noon },
  { kind: "caption", text: "Find a page the way you remember it.", dur: 2.3, sky: SKY.noon },
  { kind: "shot", shot: SHOTS.search, sky: SKY.noon },
  { kind: "caption", text: "Or just ask.", dur: 1.9, sky: SKY.dusk },
  { kind: "shot", shot: SHOTS.ask, sky: SKY.dusk },
  { kind: "caption", text: "Pause it. Delete any of it.", dur: 2.1, sky: SKY.afternoon },
  { kind: "shot", shot: SHOTS.trust, sky: SKY.afternoon },
  { kind: "caption", text: "Your record stays on this computer.", dur: 3.6, sky: SKY.dusk, small: PRIVACY.slice(PRIVACY.indexOf("With AI")) },
  { kind: "end", dur: 4.4, sky: SKY.dusk },
];
