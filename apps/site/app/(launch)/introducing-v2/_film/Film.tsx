import type { ReactNode } from "react";
import { asset } from "../../../_v2/base";
import { cursorAt, SHOTS, type Shot } from "./shots";
import { StepCaption, type Step } from "./steps";
import { clamp, inOut, keys, mix, out, prog, type Key } from "./time";
import { WAITLIST_URL } from "./world";

// The launch film: serif caption cards between oversized crops of the app, on a field that moves through the day.

export const RATIOS = {
  "16x9": { w: 1920, h: 1080, base: 1.16, fit: false, type: 104 },
  // Portrait zooms in until what matters fills the width, so the app reads on a phone.
  "4x5": { w: 1080, h: 1350, base: 1.3, fit: true, type: 92 },
} as const;
export type Ratio = keyof typeof RATIOS;

// V4 sky tokens, dawn to dusk, for the page's single-shot loops.
export const SKY = { dawn: "#f2d2c7", morning: "#f5dca2", noon: "#ccdfee", afternoon: "#f0c397", dusk: "#d7cde6" };

// shift moves the app in the frame, in frame pixels, to clear room for step captions; camera replaces the shot's for one ratio.
export type Beat =
  | { kind: "shot"; shot: Shot; steps?: Step[]; shift?: Partial<Record<Ratio, [number, number]>>; camera?: Partial<Record<Ratio, Key[]>> }
  | { kind: "caption"; text: string; dur: number; small?: string }
  | { kind: "end"; dur: number };

const dur = (b: Beat) => (b.kind === "shot" ? b.shot.dur : b.dur);
const starts = (beats: Beat[]) => beats.reduce<number[]>((a, b, i) => [...a, i ? a[i - 1] + dur(beats[i - 1]) : 0], []);
export const filmLength = (beats: Beat[]) => beats.reduce((n, b) => n + dur(b), 0);
export const startOf = (beats: Beat[], shot: Shot) => starts(beats)[beats.findIndex((b) => b.kind === "shot" && b.shot.id === shot.id)];

// The Launch page's sky: its gradient, and its three blurred clouds drifting a little over the film. Cloud boxes are the Figma frames'.
const CLOUDS = {
  "16x9": [
    { x: -192, y: 837, w: 2304, h: 378, o: 0.45, blur: 130, drift: 3 },
    { x: 1104, y: 162, w: 1056, h: 238, o: 0.22, blur: 120, drift: -5 },
    { x: -192, y: 43, w: 960, h: 216, o: 0.28, blur: 100, drift: 6 },
  ],
  "4x5": [
    { x: -108, y: 1006, w: 1296, h: 473, o: 0.45, blur: 120, drift: 3 },
    { x: 562, y: 270, w: 648, h: 270, o: 0.22, blur: 110, drift: -5 },
    { x: -103, y: 95, w: 594, h: 243, o: 0.28, blur: 90, drift: 6 },
  ],
};

function Sky({ t, ratio }: { t: number; ratio: Ratio }) {
  return (
    <div className="f-sky">
      {CLOUDS[ratio].map((c, i) => (
        <i key={i} style={{ left: c.x, top: c.y, width: c.w, height: c.h, opacity: c.o, filter: `blur(${c.blur}px)`, transform: `translateX(${t * c.drift}px)` }} />
      ))}
    </div>
  );
}

// Duet's caption: each word inks in from faint grey, the line drifts left the whole time.
function Caption({ text, t, d, size, small }: { text: string; t: number; d: number; size: number; small?: string }) {
  const words = text.split(" ");
  const drift = 70 * (1 - out(clamp(t / d)));
  return (
    <div className="f-cap" style={{ fontSize: size, transform: `translateX(${drift}px)` }}>
      <p>
        {words.map((w, i) => {
          const inK = prog(t, 0.28 + i * 0.09, 0.56 + i * 0.09);
          const outK = prog(t, d - 0.62 + i * 0.03, d - 0.32 + i * 0.03);
          return (
            <span key={i} style={{ opacity: (0.25 + 0.75 * inK) * (1 - outK) * prog(t, 0.2, 0.35) }}>
              {w}{" "}
            </span>
          );
        })}
      </p>
      {small ? (
        <small style={{ opacity: prog(t, 0.8, 1.2) * (1 - prog(t, d - 0.5, d - 0.25)) }}>{small}</small>
      ) : null}
    </div>
  );
}

function End({ t, size }: { t: number; size: number }) {
  const mark = prog(t, 0.05, 0.6, (x) => 1 + 1.4 * Math.pow(x - 1, 3) + 0.4 * Math.pow(x - 1, 2));
  return (
    <div className="f-end">
      <div className="f-lockup" style={{ transform: `scale(${mix(0.9, 1, mark)})`, opacity: clamp(mark * 1.4) }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset("/icons/app-icon.png")} alt="" width={size * 0.95} height={size * 0.95} />
        <span style={{ fontSize: size * 1.1 }}>Daylens</span>
      </div>
      <p style={{ fontSize: size * 0.34, opacity: prog(t, 0.6, 1.0) }}>Beta available early November</p>
      <p className="f-cta" style={{ fontSize: size * 0.3, opacity: prog(t, 0.95, 1.35) }}>
        Sign up for the waitlist
        <b>{WAITLIST_URL}</b>
      </p>
    </div>
  );
}

function ShotFrame({ shot, t, ratio, enter, exit, riseIn = true, riseOut = true, shift = [0, 0] }: { shot: Shot; t: number; ratio: Ratio; enter: number; exit: number; riseIn?: boolean; riseOut?: boolean; shift?: [number, number] }) {
  const { w, h, base, fit } = RATIOS[ratio];
  const c = keys(shot.camera, t);
  const s = fit ? Math.min(c.s * base, (w - 40) / c.w) : c.s * base;
  const dy = (riseIn ? (1 - enter) * 90 : 0) - (riseOut ? exit * 50 : 0);
  return (
    <div className="f-camera" style={{ opacity: Math.min(enter, 1 - exit), transform: `translate(${w / 2 - s * c.x + shift[0]}px, ${h / 2 - s * c.y + dy + shift[1]}px) scale(${s})` }}>
      {shot.view(t)}
      {cursorAt(shot.cursor, t)}
    </div>
  );
}

export function Film({ t, ratio, beats }: { t: number; ratio: Ratio; beats: Beat[] }) {
  const r = RATIOS[ratio];
  const at = starts(beats);
  const layers: ReactNode[] = [<Sky key="sky" t={t} ratio={ratio} />];
  beats.forEach((b, i) => {
    const a = at[i];
    const d = dur(b);
    // Shots overlap their neighbours by a beat so nothing ever cuts hard.
    if (t < a - 0.5 || t > a + d + 0.5) return;
    const lt = t - a;
    if (b.kind === "shot") {
      // Shot into shot is a screen change in place: the next screen fades in over this one.
      const fromShot = beats[i - 1]?.kind === "shot";
      const toShot = beats[i + 1]?.kind === "shot";
      const enter = i === 0 ? prog(lt, 0, 0.9) : fromShot ? prog(lt, -0.08, 0.14) : prog(lt, -0.15, 0.55);
      const exit = toShot ? (lt > d + 0.14 ? 1 : 0) : prog(lt, d - 0.25, d + 0.25, inOut);
      const shot = b.camera?.[ratio] ? { ...b.shot, camera: b.camera[ratio] } : b.shot;
      layers.push(<ShotFrame key={i} shot={shot} t={clamp(lt, 0, d)} ratio={ratio} enter={enter} exit={exit} riseIn={!fromShot} riseOut={!toShot} shift={b.shift?.[ratio]} />);
      b.steps?.forEach((s, j) => layers.push(<StepCaption key={`${i}-${j}`} step={s} t={lt} />));
    } else if (b.kind === "caption") {
      if (lt >= 0 && lt <= d) layers.push(<Caption key={i} text={b.text} t={lt} d={d} size={r.type} small={b.small} />);
    } else if (lt >= 0) {
      layers.push(<End key={i} t={lt} size={r.type * 1.15} />);
    }
  });
  return (
    <div className={`f-stage is-${ratio} is-sky`} style={{ width: r.w, height: r.h }}>
      {layers}
    </div>
  );
}

export const LOOP_HOLD = 1.4;
export type ShotId = keyof typeof SHOTS;

// One shot on its own field, for the page: it plays, holds its last frame, fades, and starts again.
export function ShotStage({ id, t, ratio, sky }: { id: ShotId; t: number; ratio: Ratio; sky: string }) {
  const shot = SHOTS[id];
  const r = RATIOS[ratio];
  return (
    <div className={`f-stage is-${ratio}`} style={{ width: r.w, height: r.h, background: sky }}>
      <ShotFrame shot={shot} t={clamp(t, 0, shot.dur)} ratio={ratio} enter={prog(t, 0, 0.5)} exit={prog(t, shot.dur + LOOP_HOLD - 0.4, shot.dur + LOOP_HOLD, inOut)} />
    </div>
  );
}
