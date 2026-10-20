"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { fxStore } from "./store";

// Timings from Superlogical's slot component (interval, duration, reveal, delay, wideDelay, stagger, pause, compactPause).
const INTERVAL = 1500;
const DURATION = 620;
const REVEAL = 1000;
const DELAY = 1000;
const WIDE_DELAY = 300;
const STAGGER = 80;
const PAUSE = 1000;
const COMPACT_PAUSE = 400;
const REST = 4000;
const SNAP = 0.002;
const STILL = 0.05;
const DRAG_FREE = 0.75;
const DRAG_BASE = 1.35;
const COLOR_FLOOR = 0.08;
const COMPACT_QUERY = "(max-width: 47.999rem)";

function geometry(rows: number) {
  const step = 360 / Math.max(rows, 1);
  const r = 1.3 / ((step * Math.PI) / 180);
  const half = r * 1.04;
  const lip = Math.min(2.08, 0.58 + (half - 0.58) * 0.6);
  const reach = Math.min(Math.max(half * 0.4, lip + 0.6), lip + (half - lip) * 0.75);
  return { step, r, half, lip, reach };
}

const mod = (a: number, m: number) => ((a % m) + m) % m;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function revealOrder(index: number, count: number, compact: boolean) {
  const n = index % count;
  const mid = Math.floor(count / 2);
  if (compact) return n >= 1 && n <= mid ? n - 1 : 0;
  return (n <= mid ? n : n - count) + mid;
}

type Departing = { text: string; index: number; duration: number; key: number };

export default function Wheel({ selected, phrases }: { selected: string; phrases: string[] }) {
  const [compact, setCompact] = useState<boolean | null>(null);
  const [measured, setMeasured] = useState(false);
  const [shown, setShown] = useState(false);
  const [hiding, setHiding] = useState(false);
  const [entered, setEntered] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [departing, setDeparting] = useState<Departing | null>(null);

  const slotRef = useRef<HTMLSpanElement>(null);
  const drumRef = useRef<HTMLSpanElement>(null);
  const rulerRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const colorRefs = useRef<(HTMLSpanElement | null)[]>([]);

  const items = useMemo(() => (compact ? [selected, ...phrases] : phrases), [compact, selected, phrases]);
  const rows = useMemo(() => items.concat(items), [items]);
  const geo = useMemo(() => geometry(rows.length), [rows.length]);

  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY);
    const update = () => setCompact(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot || compact === null) return;
    const measure = () => {
      const widths = rulerRefs.current.map((el) => el?.getBoundingClientRect().width ?? 0);
      const own = widths[0] ?? 0;
      const widest = Math.max(...widths);
      slot.style.width = `${own}px`;
      const panelLeft = document.querySelector("[data-field-panel]")?.getBoundingClientRect().left ?? window.innerWidth;
      const h1Right = slot.closest("h1")?.getBoundingClientRect().right ?? panelLeft;
      const left = slot.getBoundingClientRect().left;
      const visible = Math.max(0, Math.min(widest, panelLeft - left));
      const fade = Math.max(0, Math.min(visible, h1Right - left));
      slot.style.setProperty("--wheel-width", `${widest}px`);
      slot.style.setProperty("--visible-wheel-width", `${visible}px`);
      slot.style.setProperty("--wheel-fade-start", `${fade}px`);
      setMeasured(true);
    };
    measure();
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), measure()));
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(slot.closest("h1") ?? slot);
    document.fonts?.ready.then(measure);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [compact]);

  useEffect(() => {
    const slot = slotRef.current;
    const drum = drumRef.current;
    if (!measured || compact === null || !slot || !drum) return;

    const count = items.length;
    const total = count * 2;
    const { step } = geometry(total);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let angle = 0;
    let raf = 0;
    let vel = 0;
    let damp = 1;
    let isEntered = false;
    let resting = false;
    let hover = false;
    let moving = false;
    let isDragging = false;
    let isInteractive = false;
    let inView = true;
    let docVisible = document.visibilityState === "visible";
    let departIndex = -1;
    let departTimer = 0;
    let departKey = 0;
    let restAt: number | null = null;
    let auto = 0;
    let settleTimer = 0;
    const timers: number[] = [];
    const restTimers: number[] = [];
    const later = (fn: () => void, ms: number, bag = timers) => bag.push(window.setTimeout(fn, ms));

    const maxOrder = Math.max(...rows.map((_, i) => revealOrder(i, count, compact)));
    const revealTotal = () => (reduced ? 0 : REVEAL + maxOrder * STAGGER);

    const lineHeight = () => {
      const cs = getComputedStyle(slot);
      const fs = Number.parseFloat(cs.fontSize) || 16;
      return Number.parseFloat(cs.lineHeight) || fs * 1.2;
    };

    const colorAt = (i: number) => {
      if (departIndex >= 0 && i % count === departIndex) return 0;
      const t = mod(angle - i * step + 180, 360) - 180;
      const k = Math.max(0, 1 - Math.abs(t) / step);
      const r = clamp01((k - COLOR_FLOOR) / (0.4 - COLOR_FLOOR));
      return r * r * (3 - 2 * r);
    };

    const paint = () => {
      drum.style.transform = `translateZ(calc(-1 * var(--r))) rotateX(${angle}deg)`;
      if (compact) for (let i = 0; i < total; i++) colorRefs.current[i]?.style.setProperty("opacity", String(colorAt(i)));
      const e = angle / step;
      const t = Math.round(e);
      if (Math.abs(e - t) >= 1e-4 || mod(t, count) !== 0) restAt = null;
    };

    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    const clearDepart = () => {
      clearTimeout(departTimer);
      departIndex = -1;
      setDeparting(null);
    };

    const depart = (duration: number) => {
      if (!compact || reduced || duration <= 0) return;
      const index = mod(Math.round(angle / step), count);
      clearTimeout(departTimer);
      departIndex = index;
      departKey += 1;
      setDeparting({ text: items[index], index, duration: Math.min(duration, 180), key: departKey });
      departTimer = window.setTimeout(clearDepart, duration);
    };

    const sync = () => {
      const next = isEntered && !reduced && inView && !fxStore.obscured;
      if (next !== isInteractive) {
        isInteractive = next;
        setInteractive(next);
      }
      const canAuto = isInteractive && !resting && !hover && !moving && docVisible;
      if (canAuto && !auto) auto = window.setInterval(() => spin(angle + step, DURATION), INTERVAL);
      else if (!canAuto && auto) {
        clearInterval(auto);
        auto = 0;
      }
    };

    const setEnteredBoth = (v: boolean) => {
      isEntered = v;
      setEntered(v);
    };

    const endRest = () => {
      if (!resting) return;
      restTimers.forEach(clearTimeout);
      restTimers.length = 0;
      resting = false;
      setHiding(false);
      setShown(true);
      setEnteredBoth(true);
      sync();
    };

    const rest = () => {
      if (resting || !compact) return;
      restTimers.forEach(clearTimeout);
      restTimers.length = 0;
      clearDepart();
      resting = true;
      setHiding(true);
      setEnteredBoth(false);
      sync();
      later(
        () => {
          setShown(false);
          setHiding(false);
          later(
            () => {
              setShown(true);
              later(
                () => {
                  resting = false;
                  setEnteredBoth(true);
                  sync();
                  spin(angle + step, DURATION);
                },
                revealTotal() + COMPACT_PAUSE,
                restTimers,
              );
            },
            REST,
            restTimers,
          );
        },
        reduced ? 0 : 200,
        restTimers,
      );
    };

    const maybeRest = () => {
      const e = angle / step;
      const t = Math.round(e);
      if (Math.abs(e - t) >= 1e-4 || mod(t, count) !== 0) return;
      if (!compact || !isEntered || moving || resting || raf !== 0 || restAt === t) return;
      restAt = t;
      rest();
    };

    function spin(target: number, duration: number) {
      stop();
      if (reduced || duration <= 0 || Math.abs(target - angle) < 1e-4) {
        angle = target;
        paint();
        maybeRest();
        return;
      }
      depart(duration);
      const from = angle;
      const delta = target - from;
      const t0 = performance.now();
      const tick = (now: number) => {
        const c = Math.min(1, (now - t0) / duration);
        angle = from + delta * (1 - (1 - c) ** 3);
        if (c < 1) {
          paint();
          raf = requestAnimationFrame(tick);
        } else {
          raf = 0;
          angle = target;
          paint();
          maybeRest();
        }
      };
      raf = requestAnimationFrame(tick);
    }

    const settle = () => {
      clearTimeout(settleTimer);
      stop();
      moving = true;
      sync();
      const e0 = angle;
      const v0 = vel;
      const base = Math.sqrt(120) / damp;
      const coast = Math.abs(v0) >= step * 0.75;
      const projected = coast ? e0 + v0 / base : e0;
      const target = Math.round(projected / step) * step;
      const dist = target - e0;
      const rate = coast && Math.abs(dist) > SNAP && Math.sign(dist) === Math.sign(v0) ? Math.abs(v0 / dist) : base * 2;
      const u = e0 - target;
      const d = v0 + rate * u;
      const t0 = performance.now();
      const tick = (now: number) => {
        const t = (now - t0) / 1000;
        const k = Math.exp(-rate * t);
        angle = target + (u + d * t) * k;
        vel = (d - rate * (u + d * t)) * k;
        if (Math.abs(target - angle) <= SNAP && Math.abs(vel) <= STILL) {
          raf = 0;
          angle = target;
          vel = 0;
          paint();
          moving = false;
          sync();
          maybeRest();
          return;
        }
        paint();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    const enter = () => {
      setShown(true);
      setEnteredBoth(true);
      sync();
      // With reduced motion the wheel stays on the resting word instead of jumping one step.
      if (!reduced) spin(angle + step, DURATION);
    };

    const lift = () =>
      new Promise<void>((resolve) => {
        const hero = slot.closest<HTMLElement>(".sl-hero");
        if (!hero || hero.classList.contains("lifted")) return resolve();
        hero.classList.add("lifted");
        if (reduced) return resolve();
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          hero.removeEventListener("transitionend", onEnd);
          clearTimeout(fallback);
          fxStore.remeasure();
          resolve();
        };
        const onEnd = (e: TransitionEvent) => {
          if (e.target === hero && e.propertyName === "transform") finish();
        };
        hero.addEventListener("transitionend", onEnd);
        const fallback = window.setTimeout(finish, 700);
      });

    paint();
    if (compact) {
      later(async () => {
        await lift();
        setShown(true);
        later(enter, revealTotal() + COMPACT_PAUSE);
      }, DELAY);
    } else {
      later(() => {
        setShown(true);
        later(enter, revealTotal() + PAUSE);
      }, WIDE_DELAY);
    }

    // Wheel and drag input, ported from the reference's gesture handling.
    let wheelActive = false;
    let trailing = false;
    let trailTimer = 0;
    let lastAt = 0;
    let lastSign = 0;
    let lastMag = 0;
    let lastWheel = 0;
    let pid = -1;
    let startY = 0;
    let lastY = 0;
    let travel = 0;
    let samples: { time: number; y: number }[] = [];

    const sampleWheel = (g: number, dt: number) => {
      const r = Math.min(Math.max(dt, 8), 80) / 1000;
      const cap = step * 8;
      const a = Math.max(-cap, Math.min(cap, g / r));
      vel = vel === 0 || Math.sign(a) !== Math.sign(vel) ? a : vel * 0.55 + a * 0.45;
    };

    const pushSample = (e: PointerEvent) => {
      const list = e.getCoalescedEvents?.() ?? [];
      for (const ev of list.length ? list : [e]) {
        const last = samples[samples.length - 1];
        if (!last || ev.timeStamp > last.time || (ev.timeStamp === last.time && ev.clientY !== last.y)) samples.push({ time: ev.timeStamp, y: ev.clientY });
      }
      const newest = samples[samples.length - 1]?.time ?? e.timeStamp;
      const first = samples.findIndex((s) => s.time >= newest - 100);
      if (first > 1) samples = samples.slice(first - 1);
    };

    const dragVelocity = () => {
      if (samples.length < 2) return 0;
      const end = samples[samples.length - 1];
      const from = end.time - 100;
      let t0 = samples[0].time;
      let y0 = samples[0].y;
      for (let i = 1; i < samples.length; i++) {
        const s = samples[i];
        if (s.time < from) continue;
        const prev = samples[i - 1];
        if (prev.time < from && s.time > prev.time) {
          const k = (from - prev.time) / (s.time - prev.time);
          t0 = from;
          y0 = prev.y + (s.y - prev.y) * k;
        } else {
          t0 = s.time;
          y0 = s.y;
        }
        break;
      }
      const dt = Math.max((end.time - t0) / 1000, 0.016);
      const v = (-((end.y - y0) / dt) / lineHeight()) * step;
      const cap = step * 48;
      return Math.max(-cap, Math.min(cap, v));
    };

    const endWheel = () => {
      if (!wheelActive) return;
      wheelActive = false;
      if (performance.now() - lastWheel < 140) {
        trailing = true;
        lastAt = lastWheel;
        clearTimeout(trailTimer);
        trailTimer = window.setTimeout(() => (trailing = false), 140);
      }
      if (!isDragging && moving && raf === 0) settle();
    };

    const onWheel = (ev: WheelEvent) => {
      const d = ev.deltaY || ev.deltaX;
      if (!d) return;
      const inside = ev.composedPath().includes(slot);
      const now = performance.now();
      if (inside && isInteractive && !isDragging) {
        trailing = false;
        clearTimeout(trailTimer);
        wheelActive = true;
      } else if (wheelActive) endWheel();
      if (!wheelActive) {
        if (!trailing) return;
        if (now - lastAt > 55 || Math.sign(d) !== lastSign || Math.abs(d) > Math.max(1, lastMag * 1.35)) {
          trailing = false;
          clearTimeout(trailTimer);
          return;
        }
        ev.preventDefault();
        lastAt = now;
        lastSign = Math.sign(d);
        lastMag = Math.abs(d);
        clearTimeout(trailTimer);
        trailTimer = window.setTimeout(() => (trailing = false), 140);
        return;
      }
      ev.preventDefault();
      hover = slot.matches(":hover");
      damp = 1;
      clearTimeout(settleTimer);
      clearDepart();
      stop();
      moving = true;
      sync();
      const lh = lineHeight();
      const px = ev.deltaMode === 1 ? d * lh : ev.deltaMode === 2 ? d * window.innerHeight : d;
      const g = (px / lh) * step;
      const dt = lastWheel ? now - lastWheel : 40;
      if (dt > 120) vel = 0;
      sampleWheel(g, dt);
      lastWheel = now;
      lastAt = now;
      lastSign = Math.sign(d);
      lastMag = Math.abs(d);
      angle += g;
      paint();
      settleTimer = window.setTimeout(settle, 55);
    };

    const onEnter = () => {
      if (!isInteractive) return;
      hover = true;
      sync();
    };
    const onLeave = () => {
      hover = false;
      endWheel();
      sync();
    };
    const onDown = (e: PointerEvent) => {
      if (!isInteractive || !e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      clearTimeout(settleTimer);
      clearDepart();
      stop();
      slot.setPointerCapture(e.pointerId);
      isDragging = true;
      setDragging(true);
      hover = true;
      moving = true;
      vel = 0;
      damp = DRAG_BASE;
      pid = e.pointerId;
      startY = e.clientY;
      lastY = e.clientY;
      travel = 0;
      samples = [{ time: e.timeStamp, y: e.clientY }];
      sync();
    };
    const onMove = (e: PointerEvent) => {
      if (!isDragging || e.pointerId !== pid) return;
      e.preventDefault();
      const dy = lastY - e.clientY;
      if (!dy) return;
      angle += (dy / lineHeight()) * step;
      travel = Math.max(travel, Math.abs(e.clientY - startY));
      lastY = e.clientY;
      pushSample(e);
      vel = dragVelocity();
      paint();
    };
    const release = (e?: PointerEvent, cancel = false) => {
      if (!isDragging || (e && e.pointerId !== pid)) return;
      const last = samples[samples.length - 1];
      const gap = e && last ? Math.max(0, e.timeStamp - last.time) : Infinity;
      vel = cancel || gap > 80 ? 0 : dragVelocity();
      if (Math.abs(vel) <= STILL) {
        vel = 0;
        damp = 1;
      } else {
        const t = clamp01((travel / lineHeight() - DRAG_FREE) / (6 - DRAG_FREE));
        damp = DRAG_BASE + t * t * (3 - 2 * t) * (3 - DRAG_BASE);
      }
      isDragging = false;
      setDragging(false);
      const id = pid;
      pid = -1;
      if (slot.hasPointerCapture(id)) slot.releasePointerCapture(id);
      hover = !!e && e.pointerType === "mouse" && slot.matches(":hover");
      settle();
    };
    const onUp = (e: PointerEvent) => release(e, e.type === "pointercancel");
    const onBlur = () => {
      wheelActive = false;
      trailing = false;
      clearTimeout(trailTimer);
      release(undefined, true);
    };
    const onVisibility = () => {
      docVisible = document.visibilityState === "visible";
      sync();
    };

    const io = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      sync();
    });
    io.observe(slot);
    const unsub = fxStore.subscribe(sync);

    slot.addEventListener("pointerenter", onEnter);
    slot.addEventListener("pointerleave", onLeave);
    slot.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      timers.forEach(clearTimeout);
      restTimers.forEach(clearTimeout);
      clearTimeout(departTimer);
      clearTimeout(settleTimer);
      clearTimeout(trailTimer);
      clearInterval(auto);
      io.disconnect();
      unsub();
      endRest();
      slot.removeEventListener("pointerenter", onEnter);
      slot.removeEventListener("pointerleave", onLeave);
      slot.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("wheel", onWheel, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      setShown(false);
      setHiding(false);
      setEntered(false);
      setInteractive(false);
      setDragging(false);
      setDeparting(null);
    };
  }, [measured, compact, items, rows]);

  const slotStyle = {
    "--step": `${geo.step}deg`,
    "--r": `${geo.r}em`,
    "--half": `${geo.half}em`,
    "--reach": `${geo.reach}em`,
    "--gap": "0.58em",
    "--lip": `${geo.lip}em`,
  } as CSSProperties;

  const cls = ["sl-slot", interactive && "interactive", dragging && "dragging", entered && "entered"].filter(Boolean).join(" ");
  const entranceCls = ["sl-entrance", shown && "is-shown", hiding && "is-hiding", entered && "entered"].filter(Boolean).join(" ");

  return (
    <span ref={slotRef} className={cls} style={slotStyle}>
      <span className="sr-only">{selected}</span>
      <span className="sl-sizer" aria-hidden="true">
        {selected}
      </span>
      <span className="sl-rulers" aria-hidden="true">
        {[selected, ...phrases].map((p, i) => (
          <span key={p} ref={(el) => void (rulerRefs.current[i] = el)}>
            {p}
          </span>
        ))}
      </span>
      {measured && compact !== null && (
        <>
          <span className="sl-wheel" aria-hidden="true">
            <span className="sl-edge">
              <span className={entranceCls}>
                <span className="sl-stage">
                  <span ref={drumRef} className="sl-drum">
                    {rows.map((text, i) => {
                      const rowCls = [
                        "sl-row",
                        departing && i % items.length === departing.index && "departing",
                        compact && i % items.length === 0 && "initial",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      return (
                        <span key={i} className={rowCls} style={{ "--i": i } as CSSProperties}>
                          <span className="sl-line" style={{ "--reveal-order": revealOrder(i, items.length, compact) } as CSSProperties}>
                            <span>{text}</span>
                            {compact && (
                              <span className="sl-row-color" ref={(el) => void (colorRefs.current[i] = el)}>
                                {text}
                              </span>
                            )}
                          </span>
                        </span>
                      );
                    })}
                  </span>
                </span>
              </span>
            </span>
          </span>
          <span className="sl-hit" aria-hidden="true" />
          {departing && (
            <span className="sl-departing" aria-hidden="true">
              <span key={departing.key} className="sl-departing-active" style={{ "--departure-duration": `${departing.duration}ms` } as CSSProperties}>
                {departing.text}
              </span>
            </span>
          )}
        </>
      )}
      <span className="sl-selected" aria-hidden="true">
        {selected}
      </span>
    </span>
  );
}
