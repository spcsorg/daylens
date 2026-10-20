"use client";

import { useEffect, useRef, useState } from "react";
import { FORM, UPDATE_POST } from "../../_v2/copy";
import { Honeypot, useWaitlist } from "../../_v2/useWaitlist";
import { SHERBET, ramp, subscribeScroll } from "./scroll";

const PULL = 0.02;
const MAX_PULL = 5;

export function Signup() {
  const { status, error, onSubmit, clearError, sending } = useWaitlist("update");
  const done = status === "done";
  const shown = done || (status === "error" && !!error);
  const text = done ? FORM.doneShort : error ?? "";

  const [msg, setMsg] = useState({ text: "", confirmation: false });
  useEffect(() => {
    if (shown) {
      setMsg({ text, confirmation: done });
      return;
    }
    const t = setTimeout(() => setMsg({ text: "", confirmation: false }), 260);
    return () => clearTimeout(t);
  }, [shown, text, done]);

  const msgRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pull, setPull] = useState({ x: 0, y: 0 });
  const [fill, setFill] = useState<{ image: string; y: number } | null>(null);

  useEffect(() => {
    if (status === "error") inputRef.current?.focus();
  }, [status]);

  useEffect(() => {
    const el = msgRef.current;
    if (!shown || !el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let center: { x: number; y: number } | null = null;
    let pointer: { x: number; y: number } | null = null;
    let raf = 0;
    const clamp = (v: number) => Math.max(-MAX_PULL, Math.min(MAX_PULL, v));
    const frame = () => {
      raf = 0;
      if (!pointer) return;
      if (!center) {
        const r = el.getBoundingClientRect();
        center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      setPull({ x: clamp((pointer.x - center.x) * PULL), y: clamp((pointer.y - center.y) * PULL) });
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      pointer = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const reset = () => {
      center = null;
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("scroll", reset, { passive: true });
    window.addEventListener("resize", reset, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("scroll", reset);
      window.removeEventListener("resize", reset);
      setPull({ x: 0, y: 0 });
    };
  }, [shown]);

  useEffect(() => {
    const el = msgRef.current;
    if (!msg.confirmation || !el) {
      setFill(null);
      return;
    }
    const top = () => el.getBoundingClientRect().top + window.scrollY;
    let docTop = top();
    const ro = new ResizeObserver(() => {
      docTop = top();
    });
    ro.observe(document.documentElement);
    const unsub = subscribeScroll((s) => {
      setFill({ image: `linear-gradient(to bottom, ${ramp(SHERBET, s.progress)})`, y: Math.round(s.y - docTop) });
    });
    return () => {
      unsub();
      ro.disconnect();
    };
  }, [msg.confirmation]);

  const cls = ["u-form", done ? "is-done" : ""].join(" ");
  const msgCls = ["u-message", msg.confirmation ? "is-field" : "", shown ? "is-shown" : ""].join(" ");

  return (
    <section id="mailing-list" className="u-signup">
      <p className="u-signup-title">{UPDATE_POST.formTitle}</p>
      <form className={cls} onSubmit={onSubmit} noValidate>
        <label className="u-sr" htmlFor="email-signup">
          {FORM.label}
        </label>
        <input
          ref={inputRef}
          id="email-signup"
          name="email"
          type="email"
          required
          autoComplete="email"
          spellCheck={false}
          placeholder={FORM.placeholder}
          aria-describedby="email-signup-message"
          aria-invalid={status === "error" || undefined}
          disabled={sending || done}
          onChange={clearError}
          className="u-input"
        />
        <Honeypot />
        <span
          ref={msgRef}
          id="email-signup-message"
          role="status"
          aria-live="polite"
          className={msgCls}
          style={{
            translate: `${pull.x}px ${pull.y}px`,
            backgroundImage: fill?.image,
            backgroundPosition: fill ? `0 ${fill.y}px` : undefined,
          }}
        >
          {msg.text}
        </span>
        <button type="submit" aria-label={FORM.button} disabled={sending || done} className="u-submit">
          <svg aria-hidden="true" className="u-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 6H15.5C17.9853 6 20 8.01472 20 10.5C20 12.9853 17.9853 15 15.5 15H4" />
            <path d="M6.99998 12C6.99998 12 4.00001 14.2095 4 15C3.99999 15.7906 7 18 7 18" />
          </svg>
          <svg aria-hidden="true" className="u-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12Z" />
            <path d="M8 12.5L10.5 15L16 9" />
          </svg>
        </button>
      </form>
    </section>
  );
}
