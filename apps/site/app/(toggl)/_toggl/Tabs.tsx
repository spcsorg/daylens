"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

// Reference tab switch: items scale/fade out (0.3s power2.in), pane swaps, items scale/fade in (0.4s power2.out), 0.05s stagger.
const OUT = { duration: 300, easing: "cubic-bezier(0.55, 0.085, 0.68, 0.53)" };
const IN = { duration: 400, easing: "cubic-bezier(0.25, 0.46, 0.45, 0.94)" };
const STAGGER = 50;

type Panel = { id: string; label: string; content: ReactNode };

function run(items: HTMLElement[], frames: Keyframe[], opts: { duration: number; easing: string }) {
  return Promise.all(
    items.map((el, i) => el.animate(frames, { ...opts, delay: i * STAGGER, fill: "both" }).finished.catch(() => undefined)),
  );
}

export function Tabs({ panels }: { panels: Panel[] }) {
  const [active, setActive] = useState(0);
  const busy = useRef(false);
  const paneRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const select = async (next: number) => {
    if (busy.current || next === active) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof Element.prototype.animate !== "function") {
      setActive(next);
      return;
    }
    busy.current = true;
    const from = paneRefs.current[active];
    const outItems = from ? [...from.querySelectorAll<HTMLElement>("[data-tab-item]")] : [];
    await run(outItems, [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(0)", opacity: 0 }], OUT);
    const to = paneRefs.current[next];
    const inItems = to ? [...to.querySelectorAll<HTMLElement>("[data-tab-item]")] : [];
    inItems.forEach((el) => {
      el.style.opacity = "0";
      el.style.transform = "scale(0)";
    });
    setActive(next);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    outItems.forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
    const done = run(inItems, [{ transform: "scale(0)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], IN);
    inItems.forEach((el) => {
      el.style.opacity = "";
      el.style.transform = "";
    });
    await done;
    inItems.forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
    busy.current = false;
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = (active + dir + panels.length) % panels.length;
    tabRefs.current[next]?.focus();
    select(next);
  };

  return (
    <div className="t-tabs">
      <div className="t-tabs_menu" role="tablist" aria-label="Features" onKeyDown={onKey}>
        {panels.map((p, i) => (
          <button
            key={p.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            className={`t-tabs_link${i === active ? " is-current" : ""}`}
            role="tab"
            type="button"
            id={`tab-${p.id}`}
            aria-selected={i === active}
            aria-controls={`pane-${p.id}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => select(i)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="t-tabs_content">
        {panels.map((p, i) => (
          <div
            key={p.id}
            ref={(el) => {
              paneRefs.current[i] = el;
            }}
            className="t-tabs_pane"
            role="tabpanel"
            id={`pane-${p.id}`}
            aria-labelledby={`tab-${p.id}`}
            hidden={i !== active}
          >
            {p.content}
          </div>
        ))}
      </div>
    </div>
  );
}
