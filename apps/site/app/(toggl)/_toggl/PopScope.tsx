"use client";

import { useEffect, useRef, type ReactNode } from "react";

// Reference pop-reveal: each [data-pop] scales from 0.25 when 15% visible; [data-deco] fades 1 -> 0.5 while the section scrolls from top 50% to center.
export function PopScope({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const items = [...root.querySelectorAll<HTMLElement>("[data-pop]")];
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add("is-revealed");
          io.unobserve(e.target);
        });
      },
      { threshold: 0.15 },
    );
    const vh = window.innerHeight;
    items.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < vh && r.bottom > 0) el.classList.add("is-revealed");
      else io.observe(el);
    });
    root.classList.add("is-armed");

    const deco = [...root.querySelectorAll<HTMLElement>("[data-deco]")];
    const wide = matchMedia("(min-width: 768px)");
    let raf = 0;
    const update = () => {
      raf = 0;
      if (!wide.matches) {
        deco.forEach((d) => (d.style.opacity = ""));
        return;
      }
      const r = root.getBoundingClientRect();
      const h = window.innerHeight;
      const k = Math.min(1, Math.max(0, (h * 0.5 - r.top) / (r.height / 2 || 1)));
      deco.forEach((d) => (d.style.opacity = String(1 - 0.5 * k)));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div className={className} ref={ref}>
      {children}
    </div>
  );
}
