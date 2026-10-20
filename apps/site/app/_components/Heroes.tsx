"use client";

import { AnimatePresence, m, useInView, useReducedMotion, useScroll, useTransform } from "motion/react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { SCREENS, SITE, type ScreenKey } from "../_lib/content";
import { HeroMedia } from "./HeroMedia";
import { WaitlistForm } from "./WaitlistForm";

const EASE = [0.16, 1, 0.3, 1] as const;

function IntroWords({ text, start = 0, step = 70 }: { text: string; start?: number; step?: number }) {
  return (
    <>
      {text.split(" ").map((w, i) => (
        <span key={i} className="intro intro-word" style={{ ["--d" as string]: `${start + i * step}ms` }}>
          {w}{" "}
        </span>
      ))}
    </>
  );
}

function HeroForm({ delay, center }: { delay: number; center?: boolean }) {
  return (
    <div className="intro" style={{ ["--d" as string]: `${delay}ms`, marginInline: center ? "auto" : undefined, maxWidth: 460 }}>
      <WaitlistForm source="hero" autoFocusId="hero-email" />
      <p className="wl-note">Coming to {SITE.platforms}. One email to confirm, then one when your invite is ready.</p>
    </div>
  );
}

/* A: three lines, one window */
export function HeroStatements() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "start 0.25"] });
  const rotateX = useTransform(scrollYProgress, [0, 1], [14, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [0.94, 1]);

  return (
    <section className="hero hero-a" id="top">
      <div className="wrap" style={{ textAlign: "center" }}>
        <h1 className="display">
          <IntroWords text="Your day, remembered." start={120} />
        </h1>
        <p className="lead intro" style={{ ["--d" as string]: "380ms", margin: "22px auto 0" }}>
          For you and your AI. Daylens names every hour of your workday from the apps and pages you used, and keeps it on
          your computer.
        </p>
        <div style={{ marginTop: 36 }}>
          <HeroForm delay={520} center />
        </div>
      </div>
      <div className="wrap hero-media rise" ref={ref}>
        <m.div style={{ rotateX, scale, transformPerspective: 1600, transformOrigin: "50% 0%" }}>
          <HeroMedia />
        </m.div>
      </div>
    </section>
  );
}

const LINES: { text: string; screen: ScreenKey }[] = [
  { text: "Your workday, remembered on your computer.", screen: "morning" },
  { text: "Pick up where you left off, every morning.", screen: "today" },
  { text: "Give the AI you choose the context of your day.", screen: "assistants" },
];

export function Statements() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const [step, setStep] = useState(0);
  useEffect(() => scrollYProgress.on("change", (v) => setStep(Math.min(LINES.length - 1, Math.floor(v * LINES.length * 0.999)))), [scrollYProgress]);
  const fill = useTransform(scrollYProgress, [0, 1], [0, 1]);

  return (
    <section ref={ref} className="statements" aria-label="What Daylens does">
      <div className="statements-pin">
        <div className="wrap statements-grid">
          <div className="statements-copy">
            <div className="statements-rule" aria-hidden="true">
              <m.span style={{ scaleY: fill }} />
            </div>
            <ol>
              {LINES.map((l, i) => (
                <m.li
                  key={l.text}
                  animate={{ color: i === step ? "#14213d" : "#6b7287", x: i === step ? 0 : -4 }}
                  transition={{ duration: 0.5, ease: EASE }}
                  className="h2"
                >
                  {l.text}
                </m.li>
              ))}
            </ol>
          </div>
          <div className="statements-window">
            <div className="window">
              {LINES.map((l, i) => (
                <m.div
                  key={l.screen}
                  style={{ position: "absolute", inset: 0 }}
                  initial={false}
                  animate={{ opacity: i === step ? 1 : 0, y: i === step ? 0 : i < step ? -16 : 16, scale: i === step ? 1 : 0.985 }}
                  transition={{ duration: 0.7, ease: EASE }}
                >
                  <Image src={SCREENS[l.screen].src} alt={SCREENS[l.screen].alt} fill sizes="(min-width: 960px) 620px, 94vw" quality={90} />
                </m.div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* B: search your day */
const QUERY = "that sourdough hydration thing i read last night";

export function HeroSearch() {
  const reduce = useReducedMotion();
  const [typed, setTyped] = useState(reduce ? QUERY.length : 0);
  const done = typed >= QUERY.length;

  useEffect(() => {
    if (reduce) return;
    let i = 0;
    let t: number;
    const tick = () => {
      i += 1;
      setTyped(i);
      if (i < QUERY.length) t = window.setTimeout(tick, 34 + Math.random() * 46);
    };
    t = window.setTimeout(tick, 1100);
    return () => window.clearTimeout(t);
  }, [reduce]);

  return (
    <section className="hero hero-b" id="top">
      <div className="wrap hero-b-grid">
        <div>
          <h1 className="display">
            <IntroWords text="Find anything you saw." start={120} />
            <span className="display-sub">
              <IntroWords text="So can your AI." start={420} />
            </span>
          </h1>
          <p className="lead intro" style={{ ["--d" as string]: "560ms", marginTop: 24 }}>
            Daylens remembers your workday, hour by hour, on your computer. Search it the way you remember it.
          </p>
          <div style={{ marginTop: 36 }}>
            <HeroForm delay={700} />
          </div>
        </div>
        <div className="search-demo intro" style={{ ["--d" as string]: "820ms" }} aria-label="Example search">
          <div className="search-q">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>
              {QUERY.slice(0, typed)}
              <span className="caret" data-done={done} aria-hidden="true" />
            </span>
          </div>
          <AnimatePresence>
            {done ? (
              <m.div
                className="search-r"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                transition={{ duration: 0.5, ease: EASE, delay: 0.25 }}
              >
                <div className="row" style={{ padding: "16px 20px" }}>
                  <img src="/icons/chrome.svg" alt="" width={32} height={32} style={{ width: 32, height: 32 }} />
                  <div>
                    <b style={{ fontSize: 15 }}>Sourdough hydration, explained</b>
                    <small>Page in Chrome · Last night, 12:04 AM</small>
                  </div>
                  <svg viewBox="0 0 14 14" style={{ marginLeft: "auto", width: 14, height: 14, color: "var(--text-2)" }} aria-hidden="true">
                    <path d="M4 10L10 4M5 4h5v5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </m.div>
            ) : null}
          </AnimatePresence>
          <p className="caption search-note">Example search. Daylens searches your own history, on your computer.</p>
        </div>
      </div>
    </section>
  );
}

export function ReelSection() {
  return (
    <section className="section reel" aria-label="Daylens screens" style={{ paddingTop: 0 }}>
      <div className="wrap">
        <HeroMedia />
      </div>
    </section>
  );
}

/* C: letter and live window */
const LETTER: { screen: ScreenKey; title: string; body: string }[] = [
  {
    screen: "find",
    title: "Find anything you saw.",
    body: "That page from last night, the file from Tuesday, the thread you meant to answer. Search the way you remember it, and Daylens finds it in your own history.",
  },
  {
    screen: "morning",
    title: "Your morning, remembered.",
    body: "Each hour gets a name in plain words, from the apps, windows and pages you used. Not a chart of minutes. What you actually did.",
  },
  {
    screen: "ask",
    title: "Ask about any day.",
    body: "Where did I leave the order form? The answer comes from your day, with the pages and hours it used, so you can open the thing itself.",
  },
  {
    screen: "assistants",
    title: "Give your AI the same picture.",
    body: "Connect Claude, Codex, Cursor or any MCP app. They can read your days. They can't change anything.",
  },
];

function LetterPart({ part, i, onActive }: { part: (typeof LETTER)[number]; i: number; onActive: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "-45% 0px -45% 0px" });
  useEffect(() => {
    if (inView) onActive(i);
  }, [inView, i, onActive]);
  return (
    <div ref={ref} className="letter-part" data-active={inView}>
      <h2 className="h3">{part.title}</h2>
      <p>{part.body}</p>
      <div className="letter-mobile-window">
        <div className="window">
          <Image src={SCREENS[part.screen].src} alt={SCREENS[part.screen].alt} fill sizes="94vw" quality={90} />
        </div>
      </div>
    </div>
  );
}

export function HeroLetter() {
  const [active, setActive] = useState(0);
  return (
    <section className="hero hero-c" id="top">
      <div className="wrap letter-grid">
        <div className="letter-col">
          <div className="letter-intro">
            <h1 className="display letter-display">
              <IntroWords text="Pick up where you left off." start={120} />
            </h1>
            <p className="lead intro" style={{ ["--d" as string]: "380ms", marginTop: 22 }}>
              You and your AI. Daylens names every hour of your workday from the apps and pages you used, and keeps
              it on your computer.
            </p>
            <div style={{ marginTop: 32 }}>
              <HeroForm delay={520} />
            </div>
          </div>
          <div className="letter-parts">
            {LETTER.map((p, i) => (
              <LetterPart key={p.screen} part={p} i={i} onActive={setActive} />
            ))}
          </div>
        </div>
        <div className="letter-sticky intro" style={{ ["--d" as string]: "640ms" }}>
          <div className="window">
            {LETTER.map((p, i) => (
              <m.div
                key={p.screen}
                style={{ position: "absolute", inset: 0 }}
                initial={false}
                animate={{ opacity: i === active ? 1 : 0, scale: i === active ? 1 : 1.015, filter: i === active ? "blur(0px)" : "blur(4px)" }}
                transition={{ duration: 0.7, ease: EASE }}
              >
                <Image
                  src={SCREENS[p.screen].src}
                  alt={SCREENS[p.screen].alt}
                  fill
                  priority={i === 0}
                  sizes="(min-width: 1100px) 640px, 50vw"
                  quality={90}
                />
              </m.div>
            ))}
          </div>
          <div className="letter-steps" aria-hidden="true">
            {LETTER.map((p, i) => (
              <m.span key={p.screen} animate={{ scaleX: i === active ? 1 : 0.35, opacity: i === active ? 1 : 0.4 }} transition={{ duration: 0.4, ease: EASE }} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
