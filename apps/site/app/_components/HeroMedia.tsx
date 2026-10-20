"use client";

import Image from "next/image";
import { m, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { REEL, SCREENS } from "../_lib/content";

const STEP_MS = 3800;

// Stand-in for the launch video: swap this component for a <video> when it exists.
export function HeroMedia({ sizes = "(min-width: 1240px) 1120px, 94vw" }: { sizes?: string }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(true);
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const running = playing && visible && !reduce;

  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % REEL.length), STEP_MS);
    return () => window.clearTimeout(t);
  }, [running, index]);

  return (
    <div ref={ref} onMouseEnter={() => setPlaying(false)} onMouseLeave={() => setPlaying(true)}>
      <div className="window" aria-roledescription="carousel" aria-label="Daylens screens">
        {REEL.map((item, i) => {
          const s = SCREENS[item.key];
          const active = i === index;
          return (
            <m.div
              key={item.key}
              style={{ position: "absolute", inset: 0 }}
              initial={false}
              animate={{ opacity: active ? 1 : 0, scale: active ? 1 : 1.012, filter: active ? "blur(0px)" : "blur(4px)" }}
              transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
              aria-hidden={!active}
            >
              <Image src={s.src} alt={s.alt} fill sizes={sizes} priority={i === 0} quality={90} />
            </m.div>
          );
        })}
      </div>
      <div className="media-progress" role="tablist" aria-label="Choose a screen">
        {REEL.map((item, i) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={i === index}
            aria-label={item.caption}
            onClick={() => setIndex(i)}
          >
            {i === index && running ? (
              <m.span
                key={`run-${index}`}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: STEP_MS / 1000, ease: "linear" }}
              />
            ) : (
              <span style={{ transform: `scaleX(${i <= index ? 1 : 0})`, transition: "transform 300ms" }} />
            )}
          </button>
        ))}
      </div>
      <p className="media-caption" aria-live="polite">
        {REEL[index].caption}
      </p>
    </div>
  );
}
