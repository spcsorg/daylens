"use client";

import { createElement, useCallback, useState, type FormEvent } from "react";
import { asset } from "./base";
import { FORM } from "./copy";

export type WaitlistStatus = "idle" | "sending" | "done" | "error";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function post(email: string, source: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(asset("/api/waitlist"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, source, company: "" }),
    });
  } catch {
    return FORM.errors.network;
  }
  if (res.ok) return null;
  if (res.status === 400) return FORM.errors.invalid;
  if (res.status === 429) return FORM.errors.rateLimited;
  return FORM.errors.server;
}

// The form must contain an input named "email" and <Honeypot />.
export function useWaitlist(source: string) {
  const [status, setStatus] = useState<WaitlistStatus>("idle");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      if (String(data.get("company") ?? "")) return;
      const value = String(data.get("email") ?? "").trim();
      if (!EMAIL.test(value)) {
        setError(FORM.errors.invalid);
        setStatus("error");
        return;
      }
      setEmail(value);
      setError(null);
      setStatus("sending");
      const failure = await post(value, source);
      if (failure) {
        setError(failure);
        setStatus("error");
      } else {
        setStatus("done");
      }
    },
    [source],
  );

  const clearError = useCallback(() => {
    setStatus((s) => (s === "error" ? "idle" : s));
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return { status, email, error, onSubmit, clearError, reset, sending: status === "sending" };
}

export function Honeypot() {
  return createElement("input", {
    name: "company",
    tabIndex: -1,
    autoComplete: "off",
    "aria-hidden": true,
    style: { position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none", left: -9999 },
  });
}
