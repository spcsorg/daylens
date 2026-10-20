"use client";

import { useState } from "react";
import { FAQ } from "../../_v2/copy";

export function Faq() {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div className="rz-faq-list">
      {FAQ.map((item, i) => {
        const isOpen = open === i;
        return (
          <div key={item.q} className="rz-faq-item" data-state={isOpen ? "open" : "closed"}>
            <h3 className="rz-faq-h">
              <button
                type="button"
                id={`rz-faq-q${i}`}
                className="rz-faq-btn"
                aria-expanded={isOpen}
                aria-controls={`rz-faq-a${i}`}
                onClick={() => setOpen(isOpen ? null : i)}
              >
                {item.q}
                <svg className="rz-faq-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </h3>
            <div id={`rz-faq-a${i}`} role="region" aria-labelledby={`rz-faq-q${i}`} className="rz-faq-panel" inert={!isOpen}>
              <div className="rz-faq-clip">
                <p className="rz-faq-a">{item.a}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
