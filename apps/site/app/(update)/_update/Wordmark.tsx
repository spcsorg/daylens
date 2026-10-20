"use client";

import { useEffect, useRef, useState } from "react";

// Fixed wordmark fades out linearly over the gap between it and the article (96 px desktop, 64 px phone).
export function Wordmark() {
  const ref = useRef<HTMLAnchorElement>(null);
  const [opacity, setOpacity] = useState(1);

  useEffect(() => {
    const el = ref.current;
    const article = document.getElementById("u-article");
    if (!el || !article) return;
    let gap = Infinity;
    const measure = () => {
      const top = article.getBoundingClientRect().top + window.scrollY;
      gap = Math.max(1, top - (el.getBoundingClientRect().bottom));
    };
    const update = () => setOpacity(Math.max(0, 1 - window.scrollY / gap));
    measure();
    update();
    const ro = new ResizeObserver(() => {
      measure();
      update();
    });
    ro.observe(document.documentElement);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", update);
    };
  }, []);

  const hidden = opacity <= 0;
  return (
    <header className="u-header">
      <a
        ref={ref}
        href="/"
        aria-label="Daylens"
        aria-hidden={hidden}
        tabIndex={hidden ? -1 : 0}
        className="u-wordmark"
        style={{ opacity, pointerEvents: hidden ? "none" : "auto" }}
      >
        Daylens
      </a>
    </header>
  );
}
