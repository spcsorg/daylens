"use client";

import { useEffect, useRef, useState } from "react";
import { CUTS } from "./cuts";
import { Film, filmLength, LOOP_HOLD, RATIOS, ShotStage, type Ratio, type ShotId } from "./Film";
import { SHOTS } from "./shots";

// Plays the film, or one shot of it, live: only while on screen, scaled to its box, portrait on narrow screens.
// Reduced motion holds one finished frame.
export default function Player({ cut = "tour", shot, sky = "", still, label, controls }: { cut?: string; shot?: ShotId; sky?: string; still: number; label: string; controls?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState<Ratio>("16x9");
  const [k, setK] = useState(0);
  const [t, setT] = useState(still);
  const [paused, setPaused] = useState(false);
  const [seen, setSeen] = useState(false);
  const length = shot ? SHOTS[shot].dur + LOOP_HOLD : filmLength(CUTS[cut]);

  useEffect(() => {
    const el = box.current!;
    const narrow = matchMedia("(max-width: 640px)");
    const fit = () => {
      const r: Ratio = narrow.matches ? "4x5" : "16x9";
      setRatio(r);
      setK(el.clientWidth / RATIOS[r].w);
    };
    const size = new ResizeObserver(fit);
    size.observe(el);
    const view = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { threshold: 0.35 });
    view.observe(el);
    return () => {
      size.disconnect();
      view.disconnect();
    };
  }, []);

  const playing = seen && !paused;
  const clock = useRef({ t: 0, at: 0 });
  useEffect(() => {
    if (!playing || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    clock.current.at = performance.now();
    const tick = (now: number) => {
      clock.current.t = (clock.current.t + (now - clock.current.at) / 1000) % length;
      clock.current.at = now;
      setT(clock.current.t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, length]);

  const r = RATIOS[ratio];
  return (
    <figure className={`iv-player is-${ratio}`} ref={box} aria-label={label}>
      <div className="iv-player-stage" style={{ transform: `scale(${k})`, opacity: k ? 1 : 0 }} aria-hidden="true">
        {shot ? <ShotStage id={shot} t={t} ratio={ratio} sky={sky} /> : <Film t={t} ratio={ratio} beats={CUTS[cut]} />}
      </div>
      {controls ? (
        <div className="iv-controls">
          <button type="button" onClick={() => setPaused((p) => !p)} aria-label={paused ? "Play" : "Pause"}>
            <svg viewBox="0 0 16 16" aria-hidden="true">{paused ? <path d="M5 3.5v9l7.5-4.5z" /> : <path d="M5.5 3.5v9M10.5 3.5v9" />}</svg>
          </button>
          <span className="iv-progress">
            <i style={{ transform: `scaleX(${t / length})` }} />
          </span>
        </div>
      ) : null}
      <span className="iv-ratio" style={{ paddingTop: `${(r.h / r.w) * 100}%` }} />
    </figure>
  );
}
