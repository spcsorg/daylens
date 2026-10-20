"use client";

// Smoothed page scroll progress shared by the hero gradient and the signup message (time constant 260 ms).
type State = { progress: number; y: number };
const TAU = 260;
const EPS = 4e-4;

const state: State = { progress: 0, y: 0 };
const listeners = new Set<(s: State) => void>();
let stop: (() => void) | null = null;

function start() {
  let max = 0;
  const measure = () => {
    max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  };
  const target = () => (max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  measure();
  state.progress = target();
  state.y = window.scrollY;

  let raf = 0;
  let last = -1;
  const emit = () => listeners.forEach((fn) => fn(state));
  const step = (now: number) => {
    raf = 0;
    const dt = last < 0 ? 1000 / 60 : now - last;
    last = now;
    state.y = window.scrollY;
    const delta = target() - state.progress;
    if (delta === 0) {
      last = -1;
      emit();
      return;
    }
    state.progress =
      reduce.matches || Math.abs(delta) < EPS ? state.progress + delta : state.progress + delta * (1 - Math.exp(-Math.min(dt, 250) / TAU));
    emit();
    if (state.progress === target()) last = -1;
    else raf = requestAnimationFrame(step);
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(step);
  };
  const onResize = () => {
    measure();
    kick();
  };
  window.addEventListener("scroll", kick, { passive: true });
  window.addEventListener("resize", onResize);
  const ro = new ResizeObserver(onResize);
  ro.observe(document.documentElement);
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener("scroll", kick);
    window.removeEventListener("resize", onResize);
  };
}

export function subscribeScroll(fn: (s: State) => void) {
  listeners.add(fn);
  if (listeners.size === 1) stop = start();
  fn(state);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
    }
  };
}

export type Stop = [number, [number, number, number]];

export const SHERBET: Stop[] = [
  [0, [209, 182, 254]],
  [0.165, [255, 145, 105]],
  [0.87, [214, 248, 126]],
  [1, [225, 251, 150]],
];

// The reference darkens the last two stops in OKLab (L 0.42 and 0.3) for dark mode.
export const SHERBET_DARK: Stop[] = [
  [0, [209, 182, 254]],
  [0.165, [255, 145, 105]],
  [0.87, [64, 88, 0]],
  [1, [38, 53, 0]],
];

const smooth = (t: number) => t * t * (3 - 2 * t);

function sample(stops: Stop[], t: number): [number, number, number] {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [p, c] = stops[i];
    if (t <= p) {
      const [p0, c0] = stops[i - 1];
      const f = (t - p0) / (p - p0);
      return [c0[0] + (c[0] - c0[0]) * f, c0[1] + (c[1] - c0[1]) * f, c0[2] + (c[2] - c0[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}

// 25-step vertical ramp of the gradient at the current scroll progress (travel 1).
export function ramp(stops: Stop[], progress: number) {
  const parts: string[] = [];
  for (let i = 0; i <= 24; i++) {
    const d = i / 24;
    const c = sample(stops, smooth(0.5 * progress + 0.5 * d));
    parts.push(`rgb(${Math.round(c[0])} ${Math.round(c[1])} ${Math.round(c[2])}) ${(d * 100).toFixed(1)}%`);
  }
  return parts.join(", ");
}
