"use client";

import { FORM } from "../../_v2/copy";
import { Honeypot, useWaitlist } from "../../_v2/useWaitlist";
import { ArrowRight, Check } from "./icons";

export function WaitlistForm() {
  const { status, error, onSubmit, clearError, sending } = useWaitlist("beam");
  const done = status === "done";

  return (
    <div className="b-signup">
      <form className={done ? "b-form is-done" : "b-form"} onSubmit={onSubmit} noValidate>
        {done ? (
          <div className="b-form-done" role="status">
            <Check className="b-form-check" />
            <span>{FORM.doneShort}</span>
          </div>
        ) : (
          <>
            <Honeypot />
            <input
              className="b-input"
              type="email"
              name="email"
              placeholder={FORM.placeholderAlt}
              aria-label={FORM.label}
              aria-invalid={status === "error" || undefined}
              aria-describedby={error ? "b-form-error" : undefined}
              autoComplete="email"
              disabled={sending}
              onChange={clearError}
            />
            <button type="submit" className="b-submit" disabled={sending}>
              <span key={sending ? "s" : "i"} className="b-submit-label">
                {sending ? `${FORM.sending}…` : FORM.buttonShort}
              </span>
              {sending ? null : (
                <span className="b-submit-arrow">
                  <ArrowRight className="b-arrow" />
                </span>
              )}
            </button>
          </>
        )}
      </form>
      {status === "error" && error ? (
        <p id="b-form-error" className="b-form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
