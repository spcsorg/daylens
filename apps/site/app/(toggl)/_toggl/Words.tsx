"use client";

import { Fragment, useEffect, useRef, useState, type ElementType } from "react";

// Reference: the last 25% of words start 20px low and transparent, then rise when 75% of the heading is visible (1s each, 0.25s stagger).
export function Words({ text, as: Tag = "h2", className, id }: { text: string; as?: ElementType; className?: string; id?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [state, setState] = useState<"idle" | "armed" | "shown">("idle");
  const words = text.split(" ");
  const count = Math.max(1, Math.ceil(words.length * 0.25));
  const first = words.length - count;

  useEffect(() => {
    const el = ref.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setState("armed");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          requestAnimationFrame(() => setState("shown"));
          io.disconnect();
        }
      },
      { threshold: 0.75 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag ref={ref} id={id} className={`${className ?? ""} t-words is-${state}`} aria-label={text}>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span aria-hidden="true" className={i >= first ? "t-word t-word--late" : "t-word"} style={i >= first ? { transitionDelay: `${(i - first) * 0.25}s` } : undefined}>
            {w}
          </span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </Tag>
  );
}
