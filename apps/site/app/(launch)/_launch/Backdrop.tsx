"use client";

import { useEffect, useRef } from "react";
import { DEFAULT_FIELD, makeGrains, paint, retarget, type Grains } from "./field";

const TRAVEL = 1.09;
const CHUNK = 12000;
const IGNORE = ".lx-form, button, a, input";

function whenIdle(fn: () => void) {
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 1200 });
  else window.setTimeout(fn, 200);
}

function easeOut(t: number) {
  return 1 - (1 - t) ** 3;
}

export default function Backdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement?.parentElement;
    if (!canvas || !host) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let disposed = false;
    let w = 0;
    let h = 0;
    let grains: Grains | null = null;
    let image: ImageData | null = null;
    let buf: Uint32Array | null = null;
    let field = DEFAULT_FIELD;
    let quadrant: number | null = null;
    let raf = 0;
    let t0 = 0;
    let filled = 0;

    const draw = () => {
      if (!grains || !buf || !image) return;
      paint(grains, buf, w, h);
      ctx.putImageData(image, 0, 0);
    };

    const build = () => {
      w = Math.max(1, Math.round(window.innerWidth));
      h = Math.max(1, Math.round(window.innerHeight));
      canvas.width = w;
      canvas.height = h;
      image = ctx.createImageData(w, h);
      buf = new Uint32Array(image.data.buffer);
      grains = makeGrains(w, h, field);
      draw();
      canvas.dataset.ready = "true";
    };

    const step = (now: number) => {
      if (disposed || !grains) return;
      if (filled < grains.n) {
        const to = Math.min(grains.n, filled + CHUNK);
        retarget(grains, w, h, field, filled, to);
        filled = to;
      }
      const t = (now - t0) / 1000;
      let moving = filled < grains.n;
      for (let i = 0; i < grains.n; i++) {
        if (!grains.ready[i]) continue;
        const p = (t - grains.delay[i]) / TRAVEL;
        if (p <= 0) {
          moving = true;
          continue;
        }
        const k = p >= 1 ? 1 : easeOut(p);
        if (p < 1) moving = true;
        grains.x[i] = grains.sx[i] + (grains.tx[i] - grains.sx[i]) * k;
        grains.y[i] = grains.sy[i] + (grains.ty[i] - grains.sy[i]) * k;
      }
      draw();
      raf = moving ? requestAnimationFrame(step) : 0;
    };

    const switchTo = (next: number) => {
      if (!grains || next === field) return;
      field = next;
      grains.ready.fill(0);
      filled = 0;
      t0 = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(step);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.buttons !== 0) return;
      if (e.target instanceof Element && e.target.closest(IGNORE)) return;
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const col = quadrant !== null && Math.abs(e.clientX - cx) < 16 ? quadrant % 2 : Number(e.clientX >= cx);
      const row = quadrant !== null && Math.abs(e.clientY - cy) < 16 ? Math.floor(quadrant / 2) : Number(e.clientY >= cy);
      const q = row * 2 + col;
      if (q !== quadrant) {
        quadrant = q;
        switchTo(q);
      }
    };

    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const dw = Math.abs(window.innerWidth - w);
        const dh = Math.abs(window.innerHeight - h);
        if (dw < 1 && dh < 120) return;
        cancelAnimationFrame(raf);
        build();
      }, 200);
    };

    const start = () => {
      if (disposed) return;
      build();
      window.addEventListener("resize", onResize, { passive: true });
      if (!reduced && matchMedia("(hover: hover) and (pointer: fine)").matches) {
        host.addEventListener("pointermove", onMove, { passive: true });
      }
    };

    const kick = () => whenIdle(start);
    if (document.readyState === "complete") kick();
    else window.addEventListener("load", kick, { once: true });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("load", kick);
      window.removeEventListener("resize", onResize);
      host.removeEventListener("pointermove", onMove);
    };
  }, []);

  return (
    <div className="rp-backdrop" aria-hidden="true">
      <canvas ref={canvasRef} className="rp-backdrop__canvas" />
    </div>
  );
}
