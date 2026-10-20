"use client";

import { getImageProps } from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { EXAMPLE_LABEL, FORM, PHRASES } from "../../_v2/copy";
import { SCREENS } from "../../_v2/day";

type Shot = { src: keyof typeof SCREENS; rx: number; rw: number; cy: number; label: boolean; clip?: [number, number] };
type Scene = { kind: "phrase"; text: string } | { kind: "shot"; shot: Shot } | { kind: "end" } | { kind: "mark" };

const RATIO = 2244 / 1444;
const TYPE_MS = 55;
const HOLD_MS = 900;
const POSTER_HOLD_MS = 1400;
const SHOT_MS = 2400;
const END_MS = 1600;
const MARK_MS = 1800;

const SCENES: Scene[] = [
  { kind: "phrase", text: PHRASES[0] },
  { kind: "shot", shot: { src: "today", rx: 0.2, rw: 0.78, cy: 0.4, label: true } },
  { kind: "phrase", text: PHRASES[1] },
  // The search screen's heading uses retired wording, so only the search box and result are shown.
  { kind: "shot", shot: { src: "find", rx: 0.19, rw: 0.62, cy: 0.35, label: true, clip: [0.25, 0.455] } },
  { kind: "phrase", text: PHRASES[2] },
  { kind: "shot", shot: { src: "ask", rx: 0.2, rw: 0.8, cy: 0.4, label: true } },
  { kind: "phrase", text: PHRASES[3] },
  { kind: "shot", shot: { src: "today", rx: 0.25, rw: 0.62, cy: 0.55, label: true } },
  { kind: "phrase", text: PHRASES[4] },
  { kind: "shot", shot: { src: "assistants", rx: 0.19, rw: 0.62, cy: 0.36, label: false } },
  { kind: "phrase", text: PHRASES[5] },
  { kind: "end" },
  { kind: "mark" },
];

function phraseSize(text: string) {
  return `${Math.min(9.6, 77 / (text.length * 0.5)).toFixed(2)}cqw`;
}

const frames = new Map<string, Promise<HTMLImageElement>>();

// Shots are drawn like video frames: a canvas fed by the optimised next/image srcset.
function loadFrame(key: keyof typeof SCREENS) {
  const cached = frames.get(key);
  if (cached) return cached;
  const img = SCREENS[key];
  const { props } = getImageProps({ src: img.src, alt: "", width: img.w, height: img.h, sizes: "(max-width: 600px) 160vw, 1240px", quality: 80 });
  const el = new window.Image();
  el.decoding = "async";
  if (props.sizes) el.sizes = props.sizes;
  if (props.srcSet) el.srcset = props.srcSet;
  el.src = props.src;
  const ready = el.decode().then(() => el);
  frames.set(key, ready);
  return ready;
}

function drawShot(canvas: HTMLCanvasElement, img: HTMLImageElement, shot: Shot) {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (!cw || !ch) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fafaf7";
  ctx.fillRect(0, 0, cw, ch);
  const w = cw / shot.rw;
  const h = w / RATIO;
  const left = -shot.rx * w;
  if (shot.clip) {
    const [y0, y1] = shot.clip;
    const top = ch / 2 - ((y1 - y0) * h) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, cw, (y1 - y0) * h);
    ctx.clip();
    ctx.drawImage(img, left, top - y0 * h, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(img, left, ch / 2 - shot.cy * h, w, h);
  }
}

function ShotView({ shot, active }: { shot: Shot; active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let img: HTMLImageElement | null = null;
    let alive = true;
    loadFrame(shot.src)
      .then((el) => {
        if (!alive) return;
        img = el;
        drawShot(canvas, el, shot);
      })
      .catch(() => {});
    const ro = new ResizeObserver(() => img && drawShot(canvas, img, shot));
    ro.observe(canvas);
    return () => {
      alive = false;
      ro.disconnect();
    };
  }, [shot]);
  return (
    <div className="rp-scene rp-shot" data-active={active || undefined} aria-hidden={!active}>
      <canvas ref={ref} className="rp-shot__push" role="img" aria-label={SCREENS[shot.src].alt} />
      {shot.label ? <span className="rp-shot__label">{EXAMPLE_LABEL}</span> : null}
    </div>
  );
}

export default function Film() {
  const ref = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);
  const [typed, setTyped] = useState(PHRASES[0].length);
  const [played, setPlayed] = useState(false);
  const [ready, setReady] = useState(false);
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0;
    const arm = () => {
      timer = window.setTimeout(() => setReady(true), Math.max(0, 1400 - performance.now()));
    };
    if (document.readyState === "complete") arm();
    else window.addEventListener("load", arm, { once: true });
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    const el = ref.current;
    const io = el ? new IntersectionObserver(([e]) => setInView(e.isIntersecting)) : null;
    if (el && io) io.observe(el);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("load", arm);
      document.removeEventListener("visibilitychange", onVis);
      io?.disconnect();
    };
  }, []);

  const playing = ready && inView && visible;

  const advance = useCallback(() => {
    setPlayed(true);
    setIdx((i) => (i + 1) % SCENES.length);
    setTyped(0);
  }, []);

  useEffect(() => {
    if (!playing) return;
    const scene = SCENES[idx];
    let ms: number;
    let next: () => void = advance;
    if (scene.kind === "phrase") {
      if (typed < scene.text.length) {
        ms = TYPE_MS;
        next = () => setTyped((t) => t + 1);
      } else ms = played ? HOLD_MS : POSTER_HOLD_MS;
    } else ms = scene.kind === "shot" ? SHOT_MS : scene.kind === "end" ? END_MS : MARK_MS;
    const id = window.setTimeout(next, ms);
    return () => window.clearTimeout(id);
  }, [playing, idx, typed, played, advance]);

  const scene = SCENES[idx];
  const ahead = [...SCENES.keys()].map((k) => (idx + 1 + k) % SCENES.length);
  const nextShot = ahead.find((i) => SCENES[i].kind === "shot");
  const mounted = [...new Set([idx, nextShot])].filter((i): i is number => i !== undefined && SCENES[i].kind === "shot");

  return (
    <div className="rp-film" ref={ref}>
      <div className="rp-reel">
        {scene.kind === "phrase" ? (
          <div className="rp-scene rp-phrase" key={`p${idx}`}>
            <p style={{ fontSize: phraseSize(scene.text) }}>
              <span>{scene.text.slice(0, typed)}</span>
              {played ? <span className="rp-caret" aria-hidden="true" /> : null}
              <span className="rp-phrase__rest" aria-hidden="true">
                {scene.text.slice(typed)}
              </span>
            </p>
          </div>
        ) : null}
        {played
          ? mounted.map((i) => {
              const s = SCENES[i];
              return s.kind === "shot" ? <ShotView key={`shot${i}`} shot={s.shot} active={i === idx} /> : null;
            })
          : null}
        {scene.kind === "end" ? (
          <div className="rp-scene rp-end" key="end">
            <p className="rp-end__line">{FORM.button}</p>
          </div>
        ) : null}
        {scene.kind === "mark" ? (
          <div className="rp-scene rp-end" key="mark">
            <p className="rp-end__mark">Daylens</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
