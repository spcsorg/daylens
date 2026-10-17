"use client";

import { useId, useState } from "react";
import { CONTACT_EMAIL, SITE_URL, convexSiteUrl } from "../_lib/site";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done"; email: string }
  | { kind: "error"; message: string };

const SHARE_LABEL = SITE_URL.replace(/^https:\/\//, "");

async function joinWaitlist(email: string, platform: string, source: string): Promise<Status> {
  const base = convexSiteUrl();
  if (!base) {
    return {
      kind: "error",
      message: `The waitlist can't be reached from here right now. Email ${CONTACT_EMAIL} and you'll be added by hand.`,
    };
  }

  let response: Response;
  try {
    response = await fetch(`${base}/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, platform: platform || undefined, source }),
    });
  } catch {
    return { kind: "error", message: "Couldn't reach the waitlist. Check your connection and try again." };
  }

  if (response.ok) return { kind: "done", email };
  if (response.status === 429) {
    return { kind: "error", message: "Too many sign-ups from this network in the last hour. Try again later." };
  }
  if (response.status === 400) {
    return { kind: "error", message: "That email doesn't look right. Check it and try again." };
  }
  return { kind: "error", message: "Something went wrong on our side. Try again in a minute." };
}

export function WaitlistForm({ source }: { source: "hero" | "closing" }) {
  const id = useId();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [copyNote, setCopyNote] = useState<string | null>(null);

  if (status.kind === "done") {
    return (
      <div className="waitlist-done" role="status">
        <p className="waitlist-done-title">You&rsquo;re on the list.</p>
        <p>
          When your wave opens, the invite goes to <strong>{status.email}</strong>. Waves start in November, on
          Windows and Mac. Nothing else is sent before then.
        </p>
        <p className="waitlist-share">
          <button
            type="button"
            className="button button-quiet"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(SITE_URL);
                setCopyNote("Link copied. Send it to someone whose day is spread across too many apps.");
              } catch {
                setCopyNote(`Copying didn't work here. The link is ${SHARE_LABEL}`);
              }
            }}
          >
            Copy the link to share
          </button>
          {copyNote ? <span role="status">{copyNote}</span> : null}
        </p>
      </div>
    );
  }

  const sending = status.kind === "sending";
  const errorId = `${id}-error`;

  return (
    <form
      className="waitlist"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const email = String(form.get("email") ?? "").trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          setStatus({ kind: "error", message: "Enter your email address, like name@example.com." });
          return;
        }
        setStatus({ kind: "sending" });
        setStatus(await joinWaitlist(email, String(form.get("platform") ?? ""), source));
      }}
    >
      <div className="waitlist-row">
        <label htmlFor={`${id}-email`} className="visually-hidden">
          Email address
        </label>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
          aria-invalid={status.kind === "error" ? true : undefined}
          aria-describedby={status.kind === "error" ? errorId : undefined}
          disabled={sending}
        />
        <button type="submit" className="button button-primary" disabled={sending}>
          {sending ? "Joining…" : "Join the beta"}
        </button>
      </div>
      <fieldset className="waitlist-platform" disabled={sending}>
        <legend>Your computer, if you want to say</legend>
        <label>
          <input type="radio" name="platform" value="windows" />
          Windows
        </label>
        <label>
          <input type="radio" name="platform" value="macos" />
          Mac
        </label>
      </fieldset>
      {status.kind === "error" ? (
        <p id={errorId} className="waitlist-error" role="alert">
          {status.message}
        </p>
      ) : null}
    </form>
  );
}
