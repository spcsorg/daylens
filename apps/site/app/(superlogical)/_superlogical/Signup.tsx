"use client";

import { useEffect, useRef, useState } from "react";
import { FORM, SUPERLOGICAL } from "../../_v2/copy";
import { Honeypot, useWaitlist } from "../../_v2/useWaitlist";

export default function Signup() {
  const { status, error, onSubmit, clearError, sending } = useWaitlist("superlogical");
  const done = status === "done";
  const failed = status === "error" && !!error;
  const shown = done || failed;
  const text = done ? FORM.doneShort : (error ?? "");

  const [message, setMessage] = useState({ text: "", confirmation: false });
  const [nudge, setNudge] = useState({ x: 0, y: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLSpanElement>(null);

  // The bubble keeps its text while it fades out.
  useEffect(() => {
    if (shown) {
      setMessage({ text, confirmation: done });
      return;
    }
    const t = window.setTimeout(() => setMessage({ text: "", confirmation: false }), 260);
    return () => clearTimeout(t);
  }, [shown, text, done]);

  useEffect(() => {
    if (status === "error") inputRef.current?.focus();
  }, [status]);

  // The bubble leans up to 5px toward a mouse pointer, as on the reference.
  useEffect(() => {
    const el = messageRef.current;
    if (!shown || !el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let center: { x: number; y: number } | null = null;
    let pointer: { x: number; y: number } | null = null;
    let frame = 0;
    const lim = (v: number) => Math.max(-5, Math.min(5, v));
    const apply = () => {
      frame = 0;
      if (!pointer) return;
      if (!center) {
        const r = el.getBoundingClientRect();
        center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      setNudge({ x: lim((pointer.x - center.x) * 0.02), y: lim((pointer.y - center.y) * 0.02) });
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      pointer = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const reset = () => (center = null);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("scroll", reset, { passive: true });
    window.addEventListener("resize", reset, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", reset);
      window.removeEventListener("resize", reset);
      setNudge({ x: 0, y: 0 });
    };
  }, [shown]);

  const messageCls = ["sl-message", message.confirmation ? "is-field" : "is-inverted", shown && "is-shown"].filter(Boolean).join(" ");

  return (
    <section id="mailing-list" className="sl-section sl-mail">
      <p className="sl-mail-title">{SUPERLOGICAL.formTitle}</p>
      <form className={`sl-form${done ? " is-done" : ""}`} onSubmit={onSubmit} noValidate>
        <label className="sr-only" htmlFor="sl-email">
          {FORM.label}
        </label>
        <input
          ref={inputRef}
          id="sl-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          spellCheck={false}
          placeholder={FORM.placeholder}
          aria-describedby="sl-email-message"
          aria-invalid={failed || undefined}
          disabled={sending || done}
          onChange={() => failed && clearError()}
          className="sl-input"
        />
        <Honeypot />
        <span ref={messageRef} id="sl-email-message" role="status" aria-live="polite" className={messageCls} style={{ translate: `${nudge.x}px ${nudge.y}px` }}>
          {message.text}
        </span>
        <button type="submit" aria-label={FORM.button} disabled={sending || done} className="sl-submit">
          <svg aria-hidden="true" className="sl-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 6H15.5C17.9853 6 20 8.01472 20 10.5C20 12.9853 17.9853 15 15.5 15H4" />
            <path d="M6.99998 12C6.99998 12 4.00001 14.2095 4 15C3.99999 15.7906 7 18 7 18" />
          </svg>
          <svg aria-hidden="true" className="sl-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12Z" />
            <path d="M8 12.5L10.5 15L16 9" />
          </svg>
        </button>
      </form>
    </section>
  );
}
