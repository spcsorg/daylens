"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { asset } from "../../_v2/base";
import { ASK, ASSISTANTS, BLOCKS, CALENDAR, COPY, DATE, DAY_MINUTES, HOUR_LABELS, RAW, STEPS } from "./content";
import Signup from "./Signup";

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const pct = (minutes: number) => `${(minutes / DAY_MINUTES) * 100}%`;
const ROW = 100 / RAW.length;

// Scroll windows for each phase, as fractions of the pinned distance; the gaps between them hold the finished state.
const PHASES = { grow: [0, 0.08], morph: [0.1, 0.28], calendar: [0.36, 0.44], search: [0.52, 0.62], assistants: [0.72, 0.8] } as const;
// A caption changes once its phase is mostly drawn.
const STEP_AT = [0.21, 0.41, 0.58, 0.77];

function vars(p: number) {
  return {
    k: seg(p, ...PHASES.grow),
    m: seg(p, ...PHASES.morph),
    c: seg(p, ...PHASES.calendar),
    s: seg(p, ...PHASES.search),
    a: seg(p, ...PHASES.assistants),
  };
}

export default function Stage() {
  const root = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState(0);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");

    const apply = (p: number) => {
      const v = vars(p);
      for (const [key, value] of Object.entries(v)) el.style.setProperty(`--${key}`, value.toFixed(4));
      el.style.setProperty("--hit", String(v.s > 0.55 ? 1 : 0));
      el.dataset.hero = v.k < 0.35 ? "on" : "off";
      setStep(STEP_AT.filter((at) => p >= at).length);
      setTyped(Math.round(clamp(v.s * 1.8) * ASK.question.length));
    };

    if (reduce.matches) {
      el.classList.add("is-static");
      apply(0.95);
      el.style.setProperty("--k", "1");
      return;
    }

    let target = 0;
    let current = 0;
    let last = 0;
    let raf = 0;
    const progress = () => {
      const r = el.getBoundingClientRect();
      return clamp(-r.top / Math.max(1, r.height - window.innerHeight));
    };
    // Eases toward the scroll position so a wheel flick reads as motion, not a jump.
    const loop = (now: number) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      current += (target - current) * (1 - Math.exp(-dt * 9));
      if (Math.abs(target - current) < 0.0004) current = target;
      apply(current);
      raf = current === target ? 0 : requestAnimationFrame(loop);
      if (!raf) last = 0;
    };
    const onScroll = () => {
      document.documentElement.classList.toggle("lx-past", el.getBoundingClientRect().bottom <= 64);
      target = progress();
      if (!raf) raf = requestAnimationFrame(loop);
    };
    target = current = progress();
    apply(current);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  const blockTop = new Map(BLOCKS.map((b) => [b.id, b]));

  return (
    <div className="lx-stage" ref={root} data-hero="on">
      <div className="lx-pin">
        <section className="lx-hero" aria-labelledby="lx-title">
          <h1 className="lx-title" id="lx-title">
            {COPY.title}
          </h1>
          <p className="lx-sub">{COPY.sub}</p>
          <Signup id="lx-email-hero" source="launch-hero" />
        </section>

        <div className="lx-window" role="img" aria-label={`${STEPS.join(" ")} ${DATE}.`}>
          <div className="lx-bar" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div className="lx-head" aria-hidden="true">
            <div className="lx-captions">
              {STEPS.map((s, i) => (
                <p key={s} className={i === step ? "lx-caption is-on" : "lx-caption"}>
                  {s}
                </p>
              ))}
            </div>
            <p className="lx-date">{DATE}</p>
          </div>

          <div className="lx-body" aria-hidden="true">
            <div className="lx-search">
              <svg viewBox="0 0 20 20">
                <path d="m14 14 4 4M15.5 9a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z" />
              </svg>
              <span>{ASK.question.slice(0, typed)}</span>
              <span className="lx-caret" />
            </div>
            <p className="lx-answer">{ASK.answer}</p>

            <div className="lx-labels">
              <span className="lx-label lx-label--daylens">Daylens</span>
              <span className="lx-label lx-label--cal">Your calendar</span>
            </div>

            <div className="lx-grid">
              {HOUR_LABELS.map((h, i) => (
                <div key={h} className="lx-hour" style={{ top: pct(i * 60) }}>
                  <span>{h}</span>
                </div>
              ))}

              {RAW.map((r, i) => {
                const b = r.block ? blockTop.get(r.block) : null;
                const style = {
                  "--d": (i * 0.035).toFixed(3),
                  "--lt": `${i * ROW}%`,
                  "--lh": `${ROW}%`,
                  "--bt": b ? pct(b.start) : `${i * ROW}%`,
                  "--bh": b ? pct(b.end - b.start) : `${ROW}%`,
                } as CSSProperties;
                return (
                  <div key={r.at} className={b ? "lx-raw" : "lx-raw is-dropped"} style={style}>
                    <span className="lx-raw-at">{r.at}</span>
                    {r.icon ? (
                      <img src={asset(r.icon)} alt="" width={16} height={16} />
                    ) : (
                      <svg className="lx-raw-lock" viewBox="0 0 16 16">
                        <rect x="3" y="7" width="10" height="7" rx="1.5" />
                        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
                      </svg>
                    )}
                    <span className="lx-raw-text">{r.text}</span>
                  </div>
                );
              })}

              {BLOCKS.map((b) => (
                <div
                  key={b.id}
                  className={["lx-block", b.match && "is-match", b.end - b.start < 60 && "is-short", b.end - b.start < 30 && "is-tiny"].filter(Boolean).join(" ")}
                  style={{ top: pct(b.start), height: pct(b.end - b.start) }}
                >
                  <p>{b.title}</p>
                  <span className="lx-icons">
                    {b.icons.map((src) => (
                      <img key={src} src={asset(src)} alt="" width={16} height={16} />
                    ))}
                  </span>
                </div>
              ))}

              {CALENDAR.map((e) => (
                <div key={e.title} className="lx-event" style={{ top: pct(e.start), height: pct(e.end - e.start) }}>
                  <p>{e.title}</p>
                </div>
              ))}
            </div>

            <div className="lx-assist">
              {ASSISTANTS.map((a, i) => (
                <div key={a.name} className="lx-assist-row" style={{ "--d": (i * 0.18).toFixed(2) } as CSSProperties}>
                  <img src={asset(a.icon)} alt="" width={22} height={22} />
                  <span className="lx-assist-name">{a.name}</span>
                  <span className="lx-assist-read">{a.asks}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
