"use client";

import { AnimatePresence, m, useScroll, useSpring, useTransform } from "motion/react";
import { useState } from "react";
import { ASSISTANTS, FAQ, KEEP_OUT, NEVER, RECORDS, SITE } from "../_lib/content";
import { Reveal } from "./Motion";
import { NamedHours } from "./NamedHours";
import { WaitlistForm } from "./WaitlistForm";
import { Window } from "./Window";

const EASE = [0.16, 1, 0.3, 1] as const;

export function HoursSection() {
  return (
    <section className="section" id="hours" aria-labelledby="hours-title">
      <div className="wrap">
        <Reveal className="section-head">
          <h2 id="hours-title" className="h2">
            Every hour, in plain words.
          </h2>
          <p className="lead">
            Daylens sees which apps, windows and pages you used, then names the hour for you. Wrong name? Fix it, and
            your words stick everywhere.
          </p>
        </Reveal>
        <NamedHours />
      </div>
    </section>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 20 20" className="check" aria-hidden="true">
      <circle cx="10" cy="10" r="10" fill="var(--live)" />
      <path d="M6 10.4l2.6 2.6L14 7.6" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AssistantsSection() {
  const [connected, setConnected] = useState(0);
  return (
    <section className="section" id="assistants" aria-labelledby="assistants-title">
      <div className="wrap split">
        <Reveal>
          <div className="section-head" style={{ marginBottom: 0 }}>
            <h2 id="assistants-title" className="h2">
              Give your AI the same picture.
            </h2>
            <p className="lead">
              Connect Claude, Codex, Cursor or any MCP app. Once connected, they can read your days. They can&rsquo;t
              change anything.
            </p>
            <p className="caption">What an assistant reads can go to its own AI service.</p>
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <m.div
            className="rows"
            style={{ boxShadow: "0 24px 48px -28px rgba(20,33,61,.35)" }}
            onViewportEnter={() => {
              ASSISTANTS.forEach((_, i) => window.setTimeout(() => setConnected((c) => Math.max(c, i + 1)), 500 + i * 420));
            }}
            viewport={{ once: true, margin: "0px 0px -20% 0px" }}
          >
            {ASSISTANTS.map((a, i) => (
              <div className="row" key={a.name} style={{ padding: "16px 18px" }}>
                <img src={a.icon} alt="" width={28} height={28} style={{ width: 28, height: 28 }} />
                <div>
                  <b>{a.name}</b>
                  <AnimatePresence mode="wait" initial={false}>
                    <m.small
                      key={i < connected ? "on" : "off"}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.25 }}
                    >
                      {i < connected ? "Connected · can read your days" : "Found on this computer"}
                    </m.small>
                  </AnimatePresence>
                </div>
                <AnimatePresence>
                  {i < connected ? (
                    <m.span
                      style={{ marginLeft: "auto", display: "flex" }}
                      initial={{ scale: 0.4, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 520, damping: 22 }}
                    >
                      <Check />
                    </m.span>
                  ) : null}
                </AnimatePresence>
              </div>
            ))}
          </m.div>
        </Reveal>
      </div>
    </section>
  );
}

function Mark({ ok }: { ok: boolean }) {
  return ok ? (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <path d="M2.5 7.4l2.8 2.8L11.5 4" fill="none" stroke="var(--live)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" fill="none" stroke="var(--danger)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function PrivacySection() {
  const [kept, setKept] = useState<string[]>(["Messages", "WhatsApp", "1Password"]);
  return (
    <section className="section" id="privacy" aria-labelledby="privacy-title">
      <div className="wrap">
        <Reveal className="section-head">
          <h2 id="privacy-title" className="h2">
            Recorded and stored on your computer.
          </h2>
          <p className="lead">Here is exactly what Daylens keeps, and what it never touches. Pause or delete any time.</p>
        </Reveal>
        <div className="ledger">
          {[
            { title: "What Daylens records", items: RECORDS, ok: true },
            { title: "Never records", items: NEVER, ok: false },
          ].map((col, ci) => (
            <div key={col.title}>
              <Reveal delay={ci * 0.08}>
                <h3>{col.title}</h3>
              </Reveal>
              <ul>
                {col.items.map((item, i) => (
                  <Reveal as="li" key={item} delay={ci * 0.08 + i * 0.06} y={10}>
                    <Mark ok={col.ok} />
                    {item}
                  </Reveal>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <Reveal className="keepout" delay={0.1}>
          <p>Window titles can include sensitive words. Keep these out before recording starts:</p>
          {KEEP_OUT.map((k) => {
            const on = kept.includes(k);
            return (
              <button
                key={k}
                type="button"
                className="chip"
                aria-pressed={on}
                onClick={() => setKept((list) => (on ? list.filter((x) => x !== k) : [...list, k]))}
              >
                <AnimatePresence initial={false} mode="popLayout">
                  <m.svg
                    key={on ? "on" : "off"}
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                    initial={{ scale: 0.5, opacity: 0, rotate: on ? -40 : 40 }}
                    animate={{ scale: 1, opacity: 1, rotate: 0 }}
                    exit={{ scale: 0.5, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 600, damping: 30 }}
                  >
                    {on ? (
                      <path d="M2 6.4l2.4 2.4L10 3.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    ) : (
                      <path d="M6 2v8M2 6h8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    )}
                  </m.svg>
                </AnimatePresence>
                {k}
              </button>
            );
          })}
        </Reveal>
      </div>
    </section>
  );
}

export function FaqSection() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className="section" id="faq" aria-labelledby="faq-title">
      <div className="wrap faq">
        <Reveal>
          <h2 id="faq-title" className="h2">
            Questions
          </h2>
        </Reveal>
        <div className="faq-list">
          {FAQ.map((item, i) => {
            const expanded = open === i;
            return (
              <Reveal key={item.q} className="faq-item" delay={i * 0.04} y={10}>
                <h3 style={{ margin: 0, fontWeight: 500 }}>
                  <button
                    type="button"
                    className="faq-q"
                    aria-expanded={expanded}
                    aria-controls={`faq-${i}`}
                    id={`faq-q-${i}`}
                    onClick={() => setOpen(expanded ? null : i)}
                  >
                    {item.q}
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M8 2.5v11M2.5 8h11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                </h3>
                <AnimatePresence initial={false}>
                  {expanded ? (
                    <m.div
                      id={`faq-${i}`}
                      role="region"
                      aria-labelledby={`faq-q-${i}`}
                      className="faq-a"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.38, ease: EASE }}
                    >
                      <p>{item.a}</p>
                    </m.div>
                  ) : null}
                </AnimatePresence>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function ClosingSection({ title }: { title: string }) {
  return (
    <section className="section closing" id="join" aria-labelledby="join-title">
      <div className="wrap">
        <Reveal>
          <h2 id="join-title" className="display" style={{ marginBottom: 20 }}>
            {title}
          </h2>
          <p className="lead" style={{ margin: "0 auto 36px" }}>
            For you and your AI. Coming to {SITE.platforms}.
          </p>
        </Reveal>
        <Reveal delay={0.1}>
          <WaitlistForm source="closing" />
          <p className="wl-note" style={{ textAlign: "center" }}>
            One email to confirm, then one when your invite is ready.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

export function ScreenSection({ screen, title, body, id }: { screen: "today" | "ask" | "morning"; title: string; body: string; id: string }) {
  return (
    <section className="section" id={id} aria-labelledby={`${id}-title`}>
      <div className="wrap">
        <Reveal className="section-head">
          <h2 id={`${id}-title`} className="h2">
            {title}
          </h2>
          <p className="lead">{body}</p>
        </Reveal>
        <Reveal delay={0.1}>
          <Window screen={screen} />
        </Reveal>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <span className="wordmark" style={{ fontSize: 15 }}>
          <img src="/icons/daylens.png" alt="" width={20} height={20} style={{ width: 20, height: 20 }} />
          Daylens
        </span>
        <span>Your day, remembered. For you and your AI.</span>
        <span>© 2026 Daylens</span>
      </div>
    </footer>
  );
}

const MARKS = ["8 AM", "10 AM", "12 PM", "2 PM", "4 PM", "6 PM"];

export function LogRule() {
  const { scrollYProgress } = useScroll();
  const scaleY = useSpring(scrollYProgress, { stiffness: 140, damping: 30, mass: 0.3 });
  const labelY = useTransform(scaleY, (v) => `${v * 206}px`);
  const label = useTransform(scaleY, (v) => MARKS[Math.min(MARKS.length - 1, Math.floor(v * MARKS.length))]);
  return (
    <div className="logrule" aria-hidden="true">
      <div className="logrule-track" />
      <m.div className="logrule-fill" style={{ scaleY }} />
      <m.span className="logrule-label" style={{ y: labelY }}>
        {label}
      </m.span>
    </div>
  );
}
