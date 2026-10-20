"use client";

import { useEffect, useRef, useState } from "react";

type Beam = { top: number; d: number; r: number };

// Port of Beam's hover "cover": a light box with corner handles, light streaks that cross it on a loop, and on hover a dark box with drifting sparkles.
export function Cover({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState(false);
  const [beams, setBeams] = useState<Beam[]>([]);

  useEffect(() => {
    const el = ref.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const h = el.clientHeight;
    const n = Math.floor(h / 10);
    setBeams(Array.from({ length: n }, (_, i) => ({ top: (h / (n + 1)) * (i + 1), d: 1 + ((0.47 * i) % 2), r: 1 + ((0.71 * i) % 2) })));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const anims: Animation[] = [];
    el.querySelectorAll<HTMLElement>(".b-beam i").forEach((streak, i) => {
      const b = beams[i];
      if (!b) return;
      const dur = hovered ? 0.5 : b.d;
      const rep = hovered ? (b.d % 1) + 1 : b.r;
      const delay = hovered ? (b.r % 0.8) + 0.2 : 0;
      const end = hovered ? "1000%" : "2100%";
      streak.style.width = hovered ? "10%" : "5%";
      anims.push(
        streak.animate(
          [
            { transform: "translateX(-100%)", offset: 0 },
            { transform: `translateX(${end})`, offset: dur / (dur + rep) },
            { transform: `translateX(${end})`, offset: 1 },
          ],
          { duration: (dur + rep) * 1000, delay: delay * 1000, iterations: Infinity, easing: "linear" },
        ),
      );
    });
    return () => anims.forEach((a) => a.cancel());
  }, [beams, hovered]);

  useEffect(() => {
    const c = canvas.current;
    if (!hovered || !c || beams.length === 0) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    ctx.scale(dpr, dpr);
    const count = Math.round(((w * h) / 160000) * 500);
    const dots = Array.from({ length: count }, () => {
      const a = Math.random() * Math.PI * 2;
      const s = 0.1 + Math.random() * 0.9;
      return { x: Math.random() * w, y: Math.random() * h, r: 0.4 + Math.random() * 0.6, vx: Math.cos(a) * s, vy: Math.sin(a) * s, o: 0.1 + Math.random() * 0.9, vo: (Math.random() < 0.5 ? -1 : 1) * 0.04 };
    });
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const k = Math.min((now - last) / 16.67, 3);
      last = now;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#fff";
      for (const p of dots) {
        p.x += (p.vx + w / 600) * k;
        p.y += p.vy * k;
        if (p.x > w) p.x -= w;
        if (p.x < 0) p.x += w;
        if (p.y > h) p.y -= h;
        if (p.y < 0) p.y += h;
        p.o += p.vo * k;
        if (p.o > 1 || p.o < 0.1) p.vo *= -1;
        ctx.globalAlpha = Math.max(0.1, Math.min(1, p.o));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
    };
  }, [hovered, beams.length]);

  return (
    <span
      ref={ref}
      className={hovered ? "b-cover is-on" : "b-cover"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => setHovered(true)}
    >
      {beams.length > 0 ? <canvas ref={canvas} className="b-cover-sparks" aria-hidden="true" /> : null}
      {beams.map((b, i) => (
        <span key={i} className="b-beam" style={{ top: b.top }} aria-hidden="true">
          <i />
        </span>
      ))}
      <span className="b-cover-text">{children}</span>
      <span className="b-dot b-dot-tr" aria-hidden="true" />
      <span className="b-dot b-dot-br" aria-hidden="true" />
      <span className="b-dot b-dot-tl" aria-hidden="true" />
      <span className="b-dot b-dot-bl" aria-hidden="true" />
    </span>
  );
}
