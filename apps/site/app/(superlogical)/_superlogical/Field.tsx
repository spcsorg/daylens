"use client";

import { useEffect, useRef } from "react";
import { SHERBET, SHERBET_DARK } from "./ramp";
import { fxStore } from "./store";

const SMOOTH_MS = 260;
const ACTIVE_MS = 700;

function hash(x: number, y: number) {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

function grainUrl(depth: number) {
  const c = document.createElement("canvas");
  c.width = c.height = 200;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(200, 200);
  for (let y = 0; y < 200; y++)
    for (let x = 0; x < 200; x++) {
      const i = (y * 200 + x) * 4;
      const v = 128 + (hash(x + 4096, y + 4096) - 0.5) * 2 * depth;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

const idle = (fn: () => void) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 1500 });
  else window.setTimeout(fn, 200);
};

// The fixed gradient panel, its scrollbar, and every scroll-linked effect on the page.
export default function Field() {
  const panelRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const grainRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    const panel = panelRef.current;
    const canvas = canvasRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!panel || !canvas || !track || !thumb) return;
    const hero = document.querySelector<HTMLElement>(".sl-hero");
    const heroWrap = hero?.parentElement ?? null;
    const logo = document.querySelector<HTMLElement>(".sl-logo");
    const banner = document.querySelector<HTMLElement>(".sl-banner");
    const reducedMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
    const coarseMq = window.matchMedia("(pointer: coarse)");
    const narrowMq = window.matchMedia("(width < 40rem)");

    let max = 0;
    let vh = window.innerHeight;
    let heroBox = { top: 0, bottom: 0 };
    let logoBox = { top: 0, bottom: 0 };
    let bannerTop = Infinity;
    let trackH = 0;
    let thumbH = 0;
    let progress = 0;
    let progressRaf = 0;
    let lastT = -1;
    let activeTimer = 0;
    let lastY = window.scrollY;
    let worker: Worker | null = null;
    let canvasVisible = true;

    const target = () => (max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0);

    const sendState = () => {
      if (!worker) return;
      worker.postMessage({
        type: "state",
        state: {
          width: canvas.clientWidth,
          height: canvas.clientHeight,
          dpr: window.devicePixelRatio || 1,
          renderScale: 0.25,
          stops: darkMq.matches ? SHERBET_DARK : SHERBET,
          frequency: 1.5,
          warp: 0.34,
          wave: 0.06,
          travel: 1,
          angle: 90,
          progress,
          visible: canvasVisible && document.visibilityState === "visible",
          reducedMotion: reducedMq.matches,
        },
      });
    };
    let stateTimer = 0;
    let lastSent = -Infinity;
    const queueState = () => {
      if (stateTimer) return;
      const wait = Math.max(0, 1000 / 30 - (performance.now() - lastSent));
      stateTimer = window.setTimeout(() => {
        stateTimer = 0;
        lastSent = performance.now();
        sendState();
      }, wait);
    };

    const stepProgress = (now: number) => {
      progressRaf = 0;
      const dt = lastT < 0 ? 1000 / 60 : now - lastT;
      lastT = now;
      const goal = target();
      const u = goal - progress;
      if (u === 0) {
        lastT = -1;
        return;
      }
      progress = reducedMq.matches || Math.abs(u) < 4e-4 ? goal : progress + u * (1 - Math.exp(-Math.min(dt, 250) / SMOOTH_MS));
      root.style.setProperty("--p", progress.toFixed(4));
      queueState();
      if (progress === goal) lastT = -1;
      else progressRaf = requestAnimationFrame(stepProgress);
    };
    const kickProgress = () => {
      if (!progressRaf) progressRaf = requestAnimationFrame(stepProgress);
    };

    const fade = (n: number, top: number, full: number) => (n >= full ? 1 : n <= top ? 0 : (n - top) / (full - top));

    const updateScroll = () => {
      const y = window.scrollY;
      const n = bannerTop - y;
      if (hero) {
        const o = fade(n, heroBox.top, bannerTop);
        hero.style.opacity = String(o);
        hero.style.pointerEvents = o > 0 ? "" : "none";
        fxStore.setObscured(o === 0);
      }
      if (logo) {
        const o = fade(n, logoBox.top, logoBox.bottom + vh * 0.15);
        logo.style.opacity = String(o);
        logo.setAttribute("aria-hidden", o <= 0 ? "true" : "false");
      }
      const room = Math.max(0, trackH - thumbH);
      const pos = max ? room * Math.min(1, Math.max(0, y / max)) : 0;
      thumb.style.transform = `translateY(${pos}px)`;
      if (y !== lastY) {
        lastY = y;
        track.classList.add("active");
        clearTimeout(activeTimer);
        activeTimer = window.setTimeout(() => track.classList.remove("active"), ACTIVE_MS);
      }
    };

    const measure = () => {
      vh = window.innerHeight;
      max = Math.max(0, root.scrollHeight - vh);
      if (hero && heroWrap) {
        const top = Number.parseFloat(getComputedStyle(heroWrap).top) || 0;
        const w = heroWrap.getBoundingClientRect();
        const h = hero.getBoundingClientRect();
        heroBox = { top: top + h.top - w.top, bottom: top + h.bottom - w.top };
      }
      if (logo) {
        const r = logo.getBoundingClientRect();
        logoBox = { top: r.top, bottom: r.bottom };
      }
      if (banner) bannerTop = banner.getBoundingClientRect().top + window.scrollY;
      trackH = track.clientHeight;
      thumbH = trackH ? Math.min(trackH, Math.max(coarseMq.matches ? 48 : 32, trackH * (vh / (vh + max)))) : 0;
      thumb.style.height = `${thumbH}px`;
      track.classList.toggle("scrollable", max > 0);
      updateScroll();
      kickProgress();
    };

    progress = 0;
    measure();
    progress = target();
    root.style.setProperty("--p", progress.toFixed(4));

    const onScroll = () => {
      updateScroll();
      kickProgress();
    };
    let measureFrame = 0;
    const scheduleMeasure = () => {
      if (!measureFrame) measureFrame = requestAnimationFrame(() => ((measureFrame = 0), measure()));
    };
    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(root);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    const unRemeasure = fxStore.onRemeasure(scheduleMeasure);

    // Scrollbar drag.
    let dragging = false;
    let dragStartY = 0;
    let dragStartScroll = 0;
    const clampScroll = (v: number) => Math.min(max, Math.max(0, v));
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !max || !e.isPrimary) return;
      e.preventDefault();
      let start = window.scrollY;
      if (e.target === track && trackH > thumbH) {
        const r = track.getBoundingClientRect();
        start = clampScroll(((e.clientY - r.top - thumbH / 2) / (trackH - thumbH)) * max);
        window.scrollTo({ top: start, behavior: "auto" });
      }
      dragging = true;
      dragStartY = e.clientY;
      dragStartScroll = start;
      track.classList.add("dragging");
      if (coarseMq.matches && narrowMq.matches) panel.classList.add("expanded");
      track.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging || trackH <= thumbH) return;
      window.scrollTo({ top: clampScroll(dragStartScroll + ((e.clientY - dragStartY) / (trackH - thumbH)) * max), behavior: "auto" });
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      track.classList.remove("dragging");
      panel.classList.remove("expanded");
      if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
    };
    track.addEventListener("pointerdown", onDown);
    track.addEventListener("pointermove", onMove);
    track.addEventListener("pointerup", onUp);
    track.addEventListener("pointercancel", onUp);

    // The warped canvas and grain start after load so they never compete with first paint.
    let started = false;
    let canvasRo: ResizeObserver | null = null;
    let io: IntersectionObserver | null = null;
    const onVisibility = () => sendState();
    const onScheme = () => sendState();
    const start = () => {
      if (started) return;
      started = true;
      const url = grainUrl(80);
      const grain = grainRef.current;
      if (url && grain) {
        grain.style.backgroundImage = `url(${url})`;
        grain.style.backgroundSize = `${200 / (window.devicePixelRatio || 1)}px`;
      }
      if (!("transferControlToOffscreen" in canvas) || typeof Worker === "undefined") return;
      try {
        const off = canvas.transferControlToOffscreen();
        worker = new Worker(new URL("./noise.worker.ts", import.meta.url), { type: "module" });
        worker.postMessage({ type: "init", canvas: off }, [off]);
      } catch {
        worker = null;
        return;
      }
      canvas.dataset.live = "true";
      sendState();
      canvasRo = new ResizeObserver(queueState);
      canvasRo.observe(canvas);
      io = new IntersectionObserver(([entry]) => {
        canvasVisible = entry.isIntersecting;
        sendState();
      });
      io.observe(canvas);
      document.addEventListener("visibilitychange", onVisibility);
      darkMq.addEventListener("change", onScheme);
      reducedMq.addEventListener("change", onScheme);
    };
    const onLoad = () => idle(start);
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });

    return () => {
      cancelAnimationFrame(progressRaf);
      cancelAnimationFrame(measureFrame);
      clearTimeout(activeTimer);
      clearTimeout(stateTimer);
      ro.disconnect();
      canvasRo?.disconnect();
      io?.disconnect();
      unRemeasure();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("load", onLoad);
      document.removeEventListener("visibilitychange", onVisibility);
      darkMq.removeEventListener("change", onScheme);
      reducedMq.removeEventListener("change", onScheme);
      track.removeEventListener("pointerdown", onDown);
      track.removeEventListener("pointermove", onMove);
      track.removeEventListener("pointerup", onUp);
      track.removeEventListener("pointercancel", onUp);
      worker?.terminate();
    };
  }, []);

  return (
    <>
      <div ref={panelRef} data-field-panel="" className="sl-field" aria-hidden="true">
        <div className="sl-field-canvas">
          <div className="sl-field-ramp" />
          <canvas ref={canvasRef} className="sl-field-noise" />
          <div ref={grainRef} className="sl-grain" />
        </div>
        <div className="sl-field-shadow" />
      </div>
      <div className="sl-scroll-wrap" aria-hidden="true">
        <div ref={trackRef} className="sl-scrollbar">
          <div ref={thumbRef} className="sl-thumb" />
        </div>
      </div>
    </>
  );
}
