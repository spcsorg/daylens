"use client";

import { useId } from "react";
import { FORM } from "../../_v2/copy";
import { Honeypot, useWaitlist } from "../../_v2/useWaitlist";

type Variant = "hero" | "block" | "cta";

export function WaitlistForm({ variant, inputId }: { variant: Variant; inputId?: string }) {
  const { status, email, error, onSubmit, clearError, sending } = useWaitlist("rize");
  const auto = useId();
  const id = inputId ?? `rz-email-${auto}`;
  const errId = `${id}-error`;

  if (status === "done") {
    return (
      <div className={`rz-done rz-done--${variant}`} role="status">
        <p className="rz-done-title">{FORM.doneTitle}</p>
        <p className="rz-done-body">{FORM.done(email)}</p>
      </div>
    );
  }

  return (
    <div className={`rz-formwrap rz-formwrap--${variant}`}>
      <form className={`rz-form rz-form--${variant}`} onSubmit={onSubmit} noValidate>
        <label htmlFor={id} className="rz-sr">
          {FORM.label}
        </label>
        <input
          id={id}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          spellCheck={false}
          placeholder={FORM.placeholder}
          className="rz-input"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          onChange={error ? clearError : undefined}
          disabled={sending}
        />
        <Honeypot />
        <button type="submit" className="rz-btn" disabled={sending}>
          {sending ? FORM.sending : FORM.button}
        </button>
      </form>
      {error ? (
        <p id={errId} className="rz-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
