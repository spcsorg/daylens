import type { ReactNode } from "react";
import { asset } from "../../../_v2/base";
import { cursorAt, SHOTS, type Shot } from "./shots";
import { clamp, inOut, keys, mix, out, prog } from "./time";
import { WAITLIST_URL } from "./world";

// The launch film: serif caption cards between oversized crops of the app, on a field that moves through the day.

export const RATIOS = {
  "16x9": { w: 1920, h: 1080, base: 1.16, fit: false, type: 104 },
  // Portrait zooms in until what matters fills the width, so the app reads on a phone.
  "4x5": { w: 1080, h: 1350, base: 1.3, fit: true, type: 92 },
} as const;
export type Ratio = keyof typeof RATIOS;

// V4 sky tokens, dawn to dusk.
export const SKY = { dawn: "#f2d2c7", morning: "#f5dca2", noon: "#ccdfee", afternoon: "#f0c397", dusk: "#d7cde6" };

export type Beat =
  | { kind: "shot"; shot: Shot; sky: string }
  | { kind: "caption"; text: string; dur: number; sky: string; small?: string }
  | { kind: "end"; dur: number; sky: string };

const dur = (b: Beat) => (b.kind === "shot" ? b.shot.dur : b.dur);
const starts = (beats: Beat[]) => beats.reduce<number[]>((a, b, i) => [...a, i ? a[i - 1] + dur(beats[i - 1]) : 0], []);
export const filmLength = (beats: Beat[]) => beats.reduce((n, b) => n + dur(b), 0);
export const startOf = (beats: Beat[], shot: Shot) => starts(beats)[beats.findIndex((b) => b.kind === "shot" && b.shot.id === shot.id)];

function sky(beats: Beat[], at: number[], t: number) {
  const i = Math.max(0, at.findLastIndex((s) => s <= t));
  const prev = beats[Math.max(0, i - 1)].sky;
  return mixHex(prev, beats[i].sky, prog(t, at[i] - 0.2, at[i] + 0.9, inOut));
}

// Mixed in OKLab so yellow to blue passes through light, not grey.
function mixHex(a: string, b: string, k: number) {
  const lab = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * q, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * q, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * q];
  };
  const [x, y] = [lab(a), lab(b)];
  const [L, A, B] = x.map((v, i) => mix(v, y[i], k));
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const q = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * q];
  return `rgb(${rgb.map((c) => Math.round(255 * clamp(c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))).join(" ")})`;
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
        <img src={asset("/icons/daylens.svg")} alt="" width={size * 0.95} height={size * 0.95} />
        <span style={{ fontSize: size * 1.1 }}>Daylens</span>
      </div>
      <p style={{ fontSize: size * 0.34, opacity: prog(t, 0.6, 1.0) }}>Mac beta, early November</p>
      <p className="f-url" style={{ fontSize: size * 0.34, opacity: prog(t, 0.9, 1.3) }}>
        {WAITLIST_URL}
      </p>
    </div>
  );
}

function ShotFrame({ shot, t, ratio, enter, exit, riseIn = true, riseOut = true }: { shot: Shot; t: number; ratio: Ratio; enter: number; exit: number; riseIn?: boolean; riseOut?: boolean }) {
  const { w, h, base, fit } = RATIOS[ratio];
  const c = keys(shot.camera, t);
  const s = fit ? Math.min(c.s * base, (w - 40) / c.w) : c.s * base;
  const dy = (riseIn ? (1 - enter) * 90 : 0) - (riseOut ? exit * 50 : 0);
  return (
    <div className="f-camera" style={{ opacity: Math.min(enter, 1 - exit), transform: `translate(${w / 2 - s * c.x}px, ${h / 2 - s * c.y + dy}px) scale(${s})` }}>
      {shot.view(t)}
      {cursorAt(shot.cursor, t)}
    </div>
  );
}

export function Film({ t, ratio, beats }: { t: number; ratio: Ratio; beats: Beat[] }) {
  const r = RATIOS[ratio];
  const at = starts(beats);
  const layers: ReactNode[] = [];
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
      layers.push(<ShotFrame key={i} shot={b.shot} t={clamp(lt, 0, d)} ratio={ratio} enter={enter} exit={exit} riseIn={!fromShot} riseOut={!toShot} />);
    } else if (b.kind === "caption") {
      if (lt >= 0 && lt <= d) layers.push(<Caption key={i} text={b.text} t={lt} d={d} size={r.type} small={b.small} />);
    } else if (lt >= 0) {
      layers.push(<End key={i} t={lt} size={r.type * 1.15} />);
    }
  });
  return (
    <div className={`f-stage is-${ratio}`} style={{ width: r.w, height: r.h, background: sky(beats, at, t) }}>
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
