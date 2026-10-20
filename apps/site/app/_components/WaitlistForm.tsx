"use client";

import { AnimatePresence, m, useAnimationControls } from "motion/react";
import { useId, useRef, useState } from "react";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done"; email: string }
  | { kind: "error"; message: string };

const PLATFORMS = [
  { value: "mac", label: "Mac" },
  { value: "windows", label: "Windows" },
  { value: "linux", label: "Linux" },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function join(email: string, platform: string, source: string): Promise<Status> {
  let res: Response;
  try {
    res = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, platform: platform || undefined, source, company: "" }),
    });
  } catch {
    return { kind: "error", message: "Couldn't reach the waitlist. Check your connection and try again." };
  }
  if (res.ok) return { kind: "done", email };
  if (res.status === 400) return { kind: "error", message: "That email doesn't look right. Check it and try again." };
  if (res.status === 429) return { kind: "error", message: "Too many tries from this network. Wait a minute and try again." };
  return { kind: "error", message: "Something went wrong on our side. Try again in a minute." };
}

export function WaitlistForm({ source, autoFocusId }: { source: string; autoFocusId?: string }) {
  const id = useId();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const shake = useAnimationControls();
  const inputRef = useRef<HTMLInputElement>(null);
  const sending = status.kind === "sending";
  const errorId = `${id}-error`;

  async function fail(message: string) {
    setStatus({ kind: "error", message });
    await shake.start({ x: [0, -6, 6, -4, 4, 0], transition: { duration: 0.36, ease: "easeOut" } });
    inputRef.current?.focus();
  }

  return (
    <div className="wl">
      <AnimatePresence mode="wait" initial={false}>
        {status.kind === "done" ? (
          <m.div
            key="done"
            className="wl-done"
            role="status"
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          >
            <svg className="wl-done-mark" viewBox="0 0 28 28" aria-hidden="true">
              <circle cx="14" cy="14" r="14" fill="var(--live)" />
              <m.path
                d="M8.5 14.5l3.6 3.6 7.4-8"
                fill="none"
                stroke="#fff"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ delay: 0.18, duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
              />
            </svg>
            <div>
              <h3>You&rsquo;re on the list</h3>
              <p>
                We&rsquo;ll email <strong>{status.email}</strong> when your invite is ready.
              </p>
              <button type="button" className="btn-link" onClick={() => setStatus({ kind: "idle" })}>
                Use a different email
              </button>
            </div>
          </m.div>
        ) : (
          <m.form
            key="form"
            noValidate
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.18 } }}
            onSubmit={async (event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              if (String(data.get("company") ?? "")) return;
              const email = String(data.get("email") ?? "").trim();
              if (!EMAIL.test(email)) {
                await fail("Enter your email address, like you@example.com.");
                return;
              }
              setStatus({ kind: "sending" });
              const next = await join(email, String(data.get("platform") ?? ""), source);
              if (next.kind === "error") await fail(next.message);
              else setStatus(next);
            }}
          >
            <m.div className="wl-field" data-error={status.kind === "error"} animate={shake}>
              <label htmlFor={autoFocusId ?? `${id}-email`} className="sr-only">
                Email address
              </label>
              <input
                ref={inputRef}
                id={autoFocusId ?? `${id}-email`}
                className="wl-input"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="you@example.com"
                aria-invalid={status.kind === "error" || undefined}
                aria-describedby={status.kind === "error" ? errorId : undefined}
                disabled={sending}
                onInput={() => status.kind === "error" && setStatus({ kind: "idle" })}
              />
              <input className="sr-only" tabIndex={-1} autoComplete="off" name="company" aria-hidden="true" />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={sending}
              >
                {sending ? (
                  <>
                    <svg className="spinner" viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" />
                      <path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    Joining
                  </>
                ) : (
                  <>
                    Join the waitlist
                    <svg className="arrow" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                      <path d="M2 7h9.5M7.5 3l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </>
                )}
              </button>
            </m.div>
            <AnimatePresence initial={false}>
              {status.kind === "error" ? (
                <m.p
                  id={errorId}
                  className="wl-error"
                  role="alert"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                >
                  {status.message}
                </m.p>
              ) : null}
            </AnimatePresence>
            <fieldset className="wl-platforms" disabled={sending}>
              <legend>Your computer</legend>
              {PLATFORMS.map((p) => (
                <label key={p.value} className="chip">
                  <input type="radio" name="platform" value={p.value} />
                  {p.label}
                </label>
              ))}
            </fieldset>
          </m.form>
        )}
      </AnimatePresence>
    </div>
  );
}
