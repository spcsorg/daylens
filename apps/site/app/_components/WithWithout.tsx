"use client";

import { AnimatePresence, m } from "motion/react";
import { useState } from "react";
import { ASK } from "../_lib/content";
import { Reveal } from "./Motion";

const EASE = [0.16, 1, 0.3, 1] as const;

function Row({ icon, name, meta }: { icon: string; name: string; meta: string }) {
  return (
    <div className="row">
      <img src={icon} alt="" width={24} height={24} />
      <div>
        <b>{name}</b>
        <small>{meta}</small>
      </div>
    </div>
  );
}

export function WithWithout() {
  const [withDaylens, setWith] = useState(true);
  const options = [
    { on: true, label: "With Daylens" },
    { on: false, label: "Without" },
  ];

  return (
    <section className="section" id="ask" aria-labelledby="ask-title">
      <div className="wrap compare">
        <Reveal>
          <div className="section-head" style={{ marginBottom: 32 }}>
            <AnimatePresence mode="wait" initial={false}>
              <m.h2
                key={withDaylens ? "with" : "without"}
                id="ask-title"
                className="h2"
                initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -10, filter: "blur(6px)" }}
                transition={{ duration: 0.4, ease: EASE }}
              >
                {withDaylens ? "Your chats start from your day." : "Every new chat starts from zero."}
              </m.h2>
            </AnimatePresence>
            <p className="lead">
              Ask about any day the way you remember it. The answer shows the pages, windows and hours it used, so you
              can open the thing itself.
            </p>
          </div>
          <div className="segment" role="group" aria-label="Compare answers" data-on={withDaylens ? "0" : "1"}>
            <span className="segment-thumb" aria-hidden="true" />
            {options.map((o) => (
              <button key={o.label} type="button" aria-pressed={withDaylens === o.on} onClick={() => setWith(o.on)}>
                {o.label}
              </button>
            ))}
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="chat" aria-live="polite">
            <div className="chat-q">
              <p>{ASK.question}</p>
            </div>
            <AnimatePresence mode="wait" initial={false}>
              {withDaylens ? (
                <m.div key="with" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}>
                  <m.p
                    className="chat-a"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: EASE }}
                  >
                    {ASK.with}
                  </m.p>
                  {[
                    { title: "Pages and windows it used", rows: ASK.pages },
                    { title: "Hours", rows: ASK.hours },
                  ].map((group, gi) => (
                    <m.div
                      key={group.title}
                      className="chat-sources"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.5, delay: 0.18 + gi * 0.12, ease: EASE }}
                    >
                      <p className="chat-sources-title">{group.title}</p>
                      <div className="rows">
                        {group.rows.map((r) => (
                          <Row key={r.name} {...r} />
                        ))}
                      </div>
                    </m.div>
                  ))}
                </m.div>
              ) : (
                <m.p
                  key="without"
                  className="chat-a muted"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={{ duration: 0.45, ease: EASE }}
                >
                  {ASK.without}
                </m.p>
              )}
            </AnimatePresence>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
