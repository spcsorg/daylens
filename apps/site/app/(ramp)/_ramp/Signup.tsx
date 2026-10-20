"use client";

import { useEffect, useRef, type FormEvent } from "react";
import { FORM, LABELS } from "../../_v2/copy";
import { Honeypot, useWaitlist } from "../../_v2/useWaitlist";

export default function Signup() {
  const { status, email, error, onSubmit, clearError, sending } = useWaitlist("ramp");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const done = status === "done";
  const submit = (e: FormEvent<HTMLFormElement>) => {
    if (sending) {
      e.preventDefault();
      return;
    }
    onSubmit(e);
  };

  useEffect(() => {
    if (!done) return;
    const id = requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [done]);

  return (
    <section className="rp-signup-box" aria-labelledby="rp-signup-title">
      <h2 className="rp-sr" id="rp-signup-title">
        {LABELS.join}
      </h2>
      {done ? (
        <div className="rp-done">
          <span className="rp-done__mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <h3 ref={titleRef} tabIndex={-1}>
              {FORM.doneTitle}
            </h3>
            <p>{FORM.done(email)}</p>
          </div>
        </div>
      ) : (
        <form className="rp-form" onSubmit={submit}>
          <div className="rp-field">
            <label className="rp-sr" htmlFor="rp-email">
              {FORM.label}
            </label>
            <div className="rp-field__input">
              <input
                id="rp-email"
                type="email"
                name="email"
                required
                autoComplete="email"
                placeholder={FORM.placeholderAlt}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "rp-error" : undefined}
                onChange={clearError}
              />
            </div>
            <div className="rp-field__action">
              <button type="submit" className="rp-solar" aria-disabled={sending || undefined}>
                {sending ? FORM.sending : FORM.button}
              </button>
            </div>
          </div>
          <Honeypot />
          {error ? (
            <p className="rp-error" id="rp-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      )}
      <span className="rp-sr" role="status">
        {done ? FORM.doneShort : ""}
      </span>
    </section>
  );
}
