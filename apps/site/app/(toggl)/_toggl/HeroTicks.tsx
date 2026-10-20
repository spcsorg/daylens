"use client";

import { useEffect, useRef } from "react";

const MAJOR = Array.from({ length: 8 }, (_, i) => i * 45);
const MINOR = MAJOR.flatMap((a) => [a + 11.25, a + 22.5, a + 33.75]);

// Same cadence as the reference ring: 2deg wind-up, 11.25deg snap, 1.3s rest.
const STEP = 11.25;
const WINDUP_DEG = 2;
const WINDUP_MS = 180;
const SNAP_MS = 500;
const PAUSE_MS = 1300;

export function HeroTicks() {
  const ring = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ring.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let angle = 0;
    let timers: number[] = [];
    let inView = false;
    let running = false;

    const set = (deg: number, dur: number, ease: string) => {
      el.style.transition = `transform ${dur}ms ${ease}`;
      el.style.transform = `rotate(${deg}deg)`;
    };
    const clear = () => {
      timers.forEach(clearTimeout);
      timers = [];
    };
    const tick = () => {
      set(angle - WINDUP_DEG, WINDUP_MS, "cubic-bezier(0.55, 0, 1, 0.45)");
      timers[0] = window.setTimeout(() => {
        angle += STEP;
        set(angle, SNAP_MS, "cubic-bezier(0.34, 1.56, 0.64, 1)");
      }, WINDUP_MS + 10);
      timers[1] = window.setTimeout(tick, WINDUP_MS + SNAP_MS + PAUSE_MS);
    };
    const update = () => {
      const run = inView && !document.hidden;
      if (run && !running) {
        running = true;
        timers[1] = window.setTimeout(tick, PAUSE_MS);
      } else if (!run && running) {
        running = false;
        clear();
        set(angle, 200, "ease-out");
      }
    };
    const io = new IntersectionObserver((entries) => {
      inView = entries[0].isIntersecting;
      update();
    });
    io.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => {
      clear();
      io.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return (
    <div className="t-ticks" ref={ring} aria-hidden="true">
      {MAJOR.map((a) => (
        <span key={a} className="t-tick" style={{ ["--a" as string]: `${a}deg` }} />
      ))}
      {MINOR.map((a, i) => (
        <span key={a} className={`t-tick t-tick--minor${i % 3 === 1 ? " t-tick--mid" : ""}`} style={{ ["--a" as string]: `${a}deg` }} />
      ))}
    </div>
  );
}
