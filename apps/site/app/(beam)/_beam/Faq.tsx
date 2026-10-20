"use client";

import { useState } from "react";
import { Chevron } from "./icons";

export function FaqItem({ id, q, a }: { id: string; q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? "b-faq is-open" : "b-faq"}>
      <button type="button" id={`${id}-q`} aria-expanded={open} aria-controls={`${id}-a`} className="b-faq-q" onClick={() => setOpen((o) => !o)}>
        {q}
        <span className="b-faq-chev" aria-hidden="true">
          <Chevron className="b-faq-chev-svg" />
        </span>
      </button>
      <div id={`${id}-a`} role="region" aria-labelledby={`${id}-q`} className="b-faq-a" inert={!open}>
        <div className="b-faq-a-inner">
          <div className="b-faq-a-text">{a}</div>
        </div>
      </div>
    </div>
  );
}
