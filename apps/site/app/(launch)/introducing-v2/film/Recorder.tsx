"use client";

import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import "../_film/film.css";
import { ASSISTANT_ICONS } from "../_film/assistants";
import { CUTS } from "../_film/cuts";
import { Film, filmLength, type Ratio } from "../_film/Film";
import { serif } from "../_film/fonts";
import { asset } from "../../../_v2/base";
import { APPS } from "../_film/world";

declare global {
  interface Window {
    __film?: { duration: number; seek: (t: number) => void };
  }
}

// ?cut=tour picks the cut, ?ratio=16x9|4x5 the frame, ?t=12 holds a moment. Without ?record it plays in real time.
export default function Recorder() {
  const [state, setState] = useState<{ ratio: Ratio; t: number; cut: string } | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const ratio = (q.get("ratio") === "4x5" ? "4x5" : "16x9") as Ratio;
    const cut = q.get("cut") ?? "tour";
    if (!CUTS[cut]) throw new Error(`no cut named ${cut}`);
    const length = filmLength(CUTS[cut]);
    const hold = q.get("t");
    setState({ ratio, t: Number(hold ?? 0), cut });
    // Every image is decoded before the first frame, so no frame catches an icon half loaded.
    const images = [...Object.values(APPS), ...ASSISTANT_ICONS, asset("/icons/daylens.svg")].map((src) => Object.assign(new Image(), { src }).decode());
    Promise.all([...images, document.fonts.ready]).then(() => {
      window.__film = { duration: length, seek: (t) => flushSync(() => setState({ ratio, t, cut })) };
    });
    if (q.has("record") || hold) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      setState({ ratio, t: ((now - start) / 1000) % length, cut });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!state) return null;
  return (
    <div className={serif.variable}>
      <style>{"body{margin:0}nextjs-portal{display:none}"}</style>
      <Film t={state.t} ratio={state.ratio} beats={CUTS[state.cut]} />
    </div>
  );
}
