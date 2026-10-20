"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { SCREENS } from "../../_v2/day";

// Beam's hero phone plays a looping screen recording. Here the Daylens window steps through real app screens instead.
const SLIDES = [SCREENS.today, SCREENS.ask, SCREENS.assistants];
const SIZES = "(min-width: 1024px) min(1080px, 75vw), 160vw";
const STEP = 3500;

export function HeroWindow() {
  const box = useRef<HTMLDivElement>(null);
  const [extra, setExtra] = useState(false);
  const [loaded, setLoaded] = useState(1);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const start = () => setTimeout(() => setExtra(true), 1200);
    if (document.readyState === "complete") {
      const t = start();
      return () => clearTimeout(t);
    }
    let t: ReturnType<typeof setTimeout>;
    const onLoad = () => (t = start());
    window.addEventListener("load", onLoad, { once: true });
    return () => {
      window.removeEventListener("load", onLoad);
      clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    if (!extra || loaded < SLIDES.length || !box.current) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const io = new IntersectionObserver(([e]) => {
      clearInterval(timer);
      if (e.isIntersecting) timer = setInterval(() => setActive((a) => (a + 1) % SLIDES.length), STEP);
    });
    io.observe(box.current);
    return () => {
      io.disconnect();
      clearInterval(timer);
    };
  }, [extra, loaded]);

  return (
    <div ref={box} className="b-hero-window" role="img" aria-label={SLIDES[active].alt}>
      {SLIDES.map((s, i) =>
        i === 0 || extra ? (
          <Image
            key={s.src}
            src={s.src}
            alt=""
            width={s.w}
            height={s.h}
            sizes={SIZES}
            priority={i === 0}
            quality={90}
            className={i === active ? "b-slide is-on" : "b-slide"}
            onLoad={i === 0 ? undefined : () => setLoaded((n) => n + 1)}
          />
        ) : null,
      )}
    </div>
  );
}
