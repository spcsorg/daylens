"use client";

import { FORM } from "../../_v2/copy";
import { Honeypot, useWaitlist } from "../../_v2/useWaitlist";

export function WaitlistForm({ id, variant }: { id: string; variant: "hero" | "cta" }) {
  const { status, email, error, onSubmit, clearError, sending } = useWaitlist("toggl");

  if (status === "done") {
    return (
      <div className={`t-done t-done--${variant}`} role="status" aria-live="polite">
        <p className="t-done_title">{FORM.doneTitle}</p>
        <p className="t-done_body">{FORM.done(email)}</p>
      </div>
    );
  }

  return (
    <form className={`t-form t-form--${variant}`} onSubmit={onSubmit} noValidate>
      <div className="t-form_row">
        <label className="t-sr" htmlFor={id}>
          {FORM.label}
        </label>
        <input
          id={id}
          className="t-input"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder={FORM.placeholder}
          aria-invalid={status === "error"}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={clearError}
          required
        />
        <Honeypot />
        <button className={`t-btn ${variant === "cta" ? "t-btn--lighter-l" : "t-btn--dark"}`} type="submit" disabled={sending}>
          <span className="t-btn_label">{sending ? FORM.sending : FORM.button}</span>
        </button>
      </div>
      {error ? (
        <p className="t-form_error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
