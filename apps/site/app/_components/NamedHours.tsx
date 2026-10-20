"use client";

import { AnimatePresence, m, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { HOURS, type Hour } from "../_lib/content";

const EASE = [0.16, 1, 0.3, 1] as const;

function Words({ text, delay = 0 }: { text: string; delay?: number }) {
  return (
    <>
      {text.split(" ").map((word, i) => (
        <m.span
          key={`${word}-${i}`}
          style={{ display: "inline-block", whiteSpace: "pre" }}
          initial={{ opacity: 0, y: "0.35em", filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.55, delay: delay + i * 0.045, ease: EASE }}
        >
          {word + " "}
        </m.span>
      ))}
    </>
  );
}

function HourRow({ hour, order }: { hour: Hour; order: number }) {
  const ref = useRef<HTMLLIElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -18% 0px" });
  const reduce = useReducedMotion();
  const [named, setNamed] = useState(false);
  const [fixed, setFixed] = useState(false);

  useEffect(() => {
    if (!inView) return;
    if (reduce || !hour.raw) {
      setNamed(true);
      return;
    }
    const t = window.setTimeout(() => setNamed(true), 900 + order * 120);
    return () => window.clearTimeout(t);
  }, [inView, reduce, hour.raw, order]);

  const cls = hour.kind === "quiet" ? "hour hour-quiet" : hour.kind === "live" ? "hour hour-live" : "hour";

  return (
    <m.li
      ref={ref}
      className={cls}
      initial={{ opacity: 0 }}
      animate={inView ? { opacity: 1 } : {}}
      transition={{ duration: 0.6, ease: EASE }}
    >
      <m.span
        className="hour-time"
        initial={{ ["--rule" as string]: 0 }}
        animate={inView ? { ["--rule" as string]: 1 } : {}}
        transition={{ duration: 0.9, ease: EASE, delay: 0.1 }}
      >
        {hour.time}
      </m.span>
      <div className="hour-body">
        <div className="hour-title" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            {!named && hour.raw ? (
              <m.div
                key="raw"
                className="hour-raw"
                exit={{ opacity: 0, filter: "blur(6px)", y: -4, transition: { duration: 0.28 } }}
              >
                {hour.raw.map((r, i) => (
                  <m.span
                    key={r}
                    initial={{ opacity: 0, x: -6 }}
                    animate={inView ? { opacity: 1, x: 0 } : {}}
                    transition={{ delay: 0.15 + i * 0.12, duration: 0.4, ease: EASE }}
                  >
                    {r}
                  </m.span>
                ))}
              </m.div>
            ) : fixed && hour.fix ? (
              <m.div key="fixed">
                <span className="strike" style={{ display: "block", fontSize: "0.8em", marginBottom: 4 }}>
                  {hour.title}
                </span>
                <Words text={hour.fix} delay={0.25} />
                <m.span
                  className="edited"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.7, type: "spring", stiffness: 500, damping: 26 }}
                >
                  Edited
                </m.span>
              </m.div>
            ) : (
              <m.div key="named">
                {hour.kind === "live" ? <span className="live-dot" aria-hidden="true" /> : null}
                {inView ? <Words text={hour.title} /> : <span style={{ opacity: 0 }}>{hour.title}</span>}
              </m.div>
            )}
          </AnimatePresence>
        </div>
        {hour.facts ? (
          <m.p
            className="hour-facts"
            initial={{ opacity: 0 }}
            animate={named ? { opacity: 1 } : {}}
            transition={{ duration: 0.5, delay: 0.25 }}
          >
            {hour.facts}
          </m.p>
        ) : null}
        {hour.icons ? (
          <div className="hour-icons">
            {hour.icons.map((src, i) => (
              <m.img
                key={src}
                src={src}
                alt=""
                width={20}
                height={20}
                initial={{ opacity: 0, scale: 0.6 }}
                animate={inView ? { opacity: 1, scale: 1 } : {}}
                transition={{ delay: 0.2 + i * 0.07, type: "spring", stiffness: 420, damping: 22 }}
              />
            ))}
          </div>
        ) : null}
      </div>
      {hour.fix && named ? (
        <div className="hour-action">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFixed((f) => !f)}>
            {fixed ? "Undo" : "Fix this hour"}
          </button>
        </div>
      ) : null}
    </m.li>
  );
}

export function NamedHours() {
  return (
    <div>
      <ol className="hours" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {HOURS.map((h, i) => (
          <HourRow key={h.time} hour={h} order={i} />
        ))}
      </ol>
      <p className="demo-note">Example day. Brightside Bakery is made up; your hours come from your own apps and pages.</p>
    </div>
  );
}
