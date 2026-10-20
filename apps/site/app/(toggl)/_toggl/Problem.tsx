"use client";

import { useEffect, useRef } from "react";
import { PROBLEMS } from "../../_v2/copy";

const HEADLINE = PROBLEMS[0].body;
const HIGHLIGHT = "every hour";
const [BEFORE, AFTER] = HEADLINE.split(HIGHLIGHT);
const CHIPS = [...PROBLEMS, ...PROBLEMS].map((p) => p.title);

// Reference timeline (GSAP, total 1.55): content scale 1 -> 0.5 and pill flip over 0.3..1.3, overlay fade over 0.55..1.55.
const TOTAL = 1.55;
const SCRUB_S = 1.2;

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICONS = [
  "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  "M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11ZM3 9h18M6.5 6.5h.01M9 6.5h.01",
  "m20 20-4.2-4.2M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z",
  "M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12Z",
];

export function Problem() {
  const wrap = useRef<HTMLDivElement>(null);
  const sec = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const word = useRef<HTMLSpanElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const w = wrap.current;
    const s = sec.current;
    const c = content.current;
    const wd = word.current;
    const p = pill.current;
    const o = overlay.current;
    if (!w || !s || !c || !wd || !p || !o) return;
    const desktop = matchMedia("(min-width: 769px)");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");

    let from = { x: 0, y: 0, w: 0, h: 0 };
    let secH = 0;
    let vh = 0;
    let start = 0;
    let target = 0;
    let current = 0;
    let last = 0;
    let raf = 0;
    let active = false;

    const render = (prog: number) => {
      const t = prog * TOTAL;
      const k = clamp((t - 0.3) / 1);
      const fade = clamp((t - 0.55) / 1);
      const toTop = -0.2 * vh;
      c.style.zIndex = t >= 0.2 ? "-1" : "";
      c.style.transform = `scale(${1 - 0.5 * k})`;
      p.style.left = `${from.x * (1 - k)}px`;
      p.style.top = `${from.y + (toTop - from.y) * k}px`;
      p.style.width = `${from.w + (s.clientWidth - from.w) * k}px`;
      p.style.height = `${from.h + (secH - from.h) * k}px`;
      p.style.borderRadius = `${450 * (1 - k)}px`;
      o.style.opacity = String(fade);
    };

    const loop = (now: number) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      // Exponential catch-up that settles within the reference scrub time.
      current += (target - current) * (1 - Math.exp((-4 * dt) / SCRUB_S));
      if (Math.abs(target - current) < 0.0005) current = target;
      render(current);
      raf = current === target ? 0 : requestAnimationFrame(loop);
      if (!raf) last = 0;
    };

    const onScroll = () => {
      if (!active) return;
      target = clamp((window.scrollY - start) / (2 * vh));
      if (!raf) raf = requestAnimationFrame(loop);
    };

    const teardown = () => {
      active = false;
      cancelAnimationFrame(raf);
      raf = 0;
      w.classList.remove("is-pinned");
      w.style.height = "";
      s.style.top = "";
      c.style.transform = "";
      c.style.zIndex = "";
      p.removeAttribute("style");
      o.style.opacity = "";
    };

    const build = () => {
      teardown();
      if (!desktop.matches || reduce.matches) return;
      active = true;
      vh = window.innerHeight;
      c.style.transform = "";
      secH = s.offsetHeight;
      const sr = s.getBoundingClientRect();
      const r = wd.getBoundingClientRect();
      from = { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height };
      const stickyTop = 0.55 * vh - secH / 2;
      s.style.top = `${stickyTop}px`;
      w.style.height = `${secH + 2 * vh}px`;
      w.classList.add("is-pinned");
      start = w.getBoundingClientRect().top + window.scrollY - stickyTop;
      target = current = clamp((window.scrollY - start) / (2 * vh));
      render(current);
    };


    let resizeTimer = 0;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(build, 150);
    };

    build();
    document.fonts?.ready.then(build);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    desktop.addEventListener("change", build);
    reduce.addEventListener("change", build);
    return () => {
      teardown();
      clearTimeout(resizeTimer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      desktop.removeEventListener("change", build);
      reduce.removeEventListener("change", build);
    };
  }, []);

  return (
    <div className="t-problem-pin" ref={wrap}>
      <section className="t-problem" ref={sec} aria-labelledby="problem-title">
        <div className="t-problem_wrap" ref={content}>
          <div className="t-problem_icons" aria-hidden="true">
            <div className="t-problem_icons-top">
              <span className="t-problem_icon">
                <Icon d={ICONS[0]} />
              </span>
              <span className="t-problem_icon">
                <Icon d={ICONS[1]} />
              </span>
            </div>
            <div className="t-problem_icons-bot">
              <span className="t-problem_icon">
                <Icon d={ICONS[2]} />
              </span>
              <span className="t-problem_icon">
                <Icon d={ICONS[3]} />
              </span>
            </div>
          </div>
          <div className="t-problem_content">
            <h2 className="t-title-3 t-problem_title" id="problem-title">
              {BEFORE}
              <span className="t-problem_gap" ref={word}>
                {HIGHLIGHT}
              </span>
              {AFTER}
            </h2>
          </div>
          <div className="t-marquee">
            <div className="t-marquee_track">
              {[0, 1].map((set) => (
                <ul className="t-marquee_set" key={set} aria-hidden={set === 1 ? true : undefined}>
                  {CHIPS.map((text, i) => (
                    <li className="t-chip" key={i} aria-hidden={set === 0 && i >= PROBLEMS.length ? true : undefined}>
                      <svg viewBox="0 0 24 24" className="t-chip_ic" aria-hidden="true">
                        <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                      <span>{text}</span>
                    </li>
                  ))}
                </ul>
              ))}
            </div>
          </div>
        </div>
        <div className="t-problem_pill" ref={pill} aria-hidden="true">
          <div className="t-problem_pill-overlay" ref={overlay} />
        </div>
      </section>
    </div>
  );
}
