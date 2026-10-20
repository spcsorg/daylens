"use client";

import { useEffect, useRef, useState } from "react";
import { noiseProgram } from "./noise";
import { SHERBET, SHERBET_DARK, subscribeScroll } from "./scroll";

const OPTS = { frequency: 1.5, warp: 0.34, wave: 0.06, travel: 1, loop: false, angle: 90, renderScale: 0.25 };
const GRAIN_ALPHA = 0.16;
const GRAIN_DEPTH = 80;

function grainTile() {
  const c = document.createElement("canvas");
  c.width = c.height = 200;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(200, 200);
  for (let y = 0; y < 200; y++)
    for (let x = 0; x < 200; x++) {
      let n = ((x + 4096) * 374761393 + (y + 4096) * 668265263) | 0;
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      n ^= n >>> 16;
      const v = 128 + ((n >>> 0) / 4294967296 - 0.5) * 2 * GRAIN_DEPTH;
      const i = (y * 200 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

type Port = { postMessage: (m: unknown) => void; terminate: () => void };

function openPort(onFrame: (d: { bitmap: CanvasImageSource & { close?: () => void }; width: number; height: number; dpr: number }) => void): Port {
  if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
    const src = `(${noiseProgram.toString()})(self,(w,h)=>new OffscreenCanvas(w,h));`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = ({ data }) => onFrame(data);
    return { postMessage: (m) => worker.postMessage(m), terminate: () => worker.terminate() };
  }
  const scope: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: never) => void } = {
    onmessage: null,
    postMessage: (m) => onFrame(m),
  };
  noiseProgram(scope, (w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  });
  return { postMessage: (m) => scope.onmessage?.({ data: m }), terminate: () => scope.onmessage?.({ data: { state: { visible: false } } }) };
}

export function NoiseGradient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [grain, setGrain] = useState<{ url: string; dpr: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const p3 = CSS.supports("color", "color(display-p3 1 0 0)");
    const ctx = canvas.getContext("2d", p3 ? { colorSpace: "display-p3" } : undefined);
    if (!ctx) return;
    const space = ctx.getContextAttributes().colorSpace === "display-p3" ? "display-p3" : "srgb";
    const url = grainTile();
    if (url) setGrain({ url, dpr: window.devicePixelRatio || 1 });

    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = true;
    let progress = 0;

    const port = openPort((d) => {
      const w = canvas.clientWidth, h = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
      if (d.width !== w || d.height !== h || d.dpr !== dpr) {
        d.bitmap.close?.();
        return;
      }
      const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      ctx.setTransform(pw / w, 0, 0, ph / h, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "low";
      ctx.drawImage(d.bitmap, 0, 0, (d.bitmap as HTMLCanvasElement).width, (d.bitmap as HTMLCanvasElement).height, 0, 0, w, h);
      d.bitmap.close?.();
    });

    const send = () => {
      const width = canvas.clientWidth, height = canvas.clientHeight;
      if (!width || !height) return;
      port.postMessage({
        type: "state",
        state: {
          width,
          height,
          dpr: window.devicePixelRatio || 1,
          colorSpace: space,
          stops: dark.matches ? SHERBET_DARK : SHERBET,
          ...OPTS,
          progress,
          visible,
          reducedMotion: reduce.matches,
        },
      });
    };

    let resizeTimer = 0;
    let lastResize = -1000;
    const onResize = () => {
      if (resizeTimer) return;
      resizeTimer = window.setTimeout(() => {
        resizeTimer = 0;
        lastResize = performance.now();
        send();
      }, Math.max(0, 1000 / 30 - (performance.now() - lastResize)));
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      send();
    });
    io.observe(canvas);
    dark.addEventListener("change", send);
    reduce.addEventListener("change", send);
    const unsub = subscribeScroll((s) => {
      if (s.progress === progress) return;
      progress = s.progress;
      send();
    });
    send();

    return () => {
      unsub();
      ro.disconnect();
      io.disconnect();
      dark.removeEventListener("change", send);
      reduce.removeEventListener("change", send);
      if (resizeTimer) clearTimeout(resizeTimer);
      port.terminate();
    };
  }, []);

  return (
    <div aria-hidden="true" className="u-noise">
      <canvas ref={canvasRef} className="u-noise-canvas" />
      {grain ? (
        <div
          className="u-grain"
          style={{ backgroundImage: `url(${grain.url})`, backgroundSize: `${200 / grain.dpr}px ${200 / grain.dpr}px`, opacity: GRAIN_ALPHA }}
        />
      ) : null}
    </div>
  );
}
