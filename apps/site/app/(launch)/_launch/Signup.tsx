"use client";

import { Honeypot, useWaitlist } from "../../_v2/useWaitlist";
import { COPY } from "./content";

export default function Signup({ id, source }: { id: string; source: string }) {
  const { status, error, onSubmit, clearError, sending } = useWaitlist(source);

  if (status === "done") {
    return (
      <p className="lx-done" role="status">
        {COPY.done}
      </p>
    );
  }

  return (
    <form className="lx-form" onSubmit={onSubmit} noValidate>
      <label className="lx-sr" htmlFor={id}>
        {COPY.email}
      </label>
      <div className={error ? "lx-field is-error" : "lx-field"}>
        <input
          id={id}
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder={COPY.email}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={clearError}
          required
        />
        <button type="submit" disabled={sending}>
          {sending ? COPY.joining : COPY.join}
        </button>
      </div>
      <Honeypot />
      {error ? (
        <p className="lx-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
