"use client";

import { useEffect, useRef } from "react";
import { FORM } from "../../_v2/copy";
import { Honeypot, useWaitlist } from "../../_v2/useWaitlist";

export function WaitlistForm({ id }: { id: string }) {
  const { status, email, error, onSubmit, clearError, sending } = useWaitlist("chatgpt");
  const done = useRef<HTMLParagraphElement>(null);
  const inputId = `${id}-email`;
  const errorId = `${id}-error`;

  useEffect(() => {
    if (status === "done") done.current?.focus();
  }, [status]);

  if (status === "done") {
    return (
      <div className="cg-form-wrap" id={id}>
        <p className="cg-done" role="status" tabIndex={-1} ref={done}>
          <strong>{FORM.doneTitle}</strong> {FORM.done(email)}
        </p>
      </div>
    );
  }

  return (
    <div className="cg-form-wrap" id={id}>
      <form className="cg-form" onSubmit={onSubmit} noValidate>
        <label htmlFor={inputId} className="cg-sr">
          {FORM.label}
        </label>
        <input
          id={inputId}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder={FORM.placeholder}
          className="cg-input"
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={clearError}
        />
        <Honeypot />
        <button type="submit" className="cg-btn cg-submit" data-loading={sending || undefined} disabled={sending}>
          <span className="cg-btn-inner">{FORM.button}</span>
          {sending && (
            <>
              <span className="cg-spinner" aria-hidden="true" />
              <span className="cg-sr">{FORM.sending}</span>
            </>
          )}
        </button>
      </form>
      {error && (
        <p id={errorId} className="cg-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
