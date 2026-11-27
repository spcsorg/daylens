"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export function Toggle({ checked, label, onChange, disabled }: { checked: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean }) {
  return <button type="button" className="toggle" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

const FOCUSABLE = "input:not([disabled]), select:not([disabled]), textarea, button:not([disabled]), [href]";

/** A modal form: Escape or a click outside closes it, Enter submits, Tab stays inside it, and focus goes back where it was. */
export function Dialog({ title, heading, wide, onClose, onSubmit, children }: { title: string; heading?: ReactNode; wide?: boolean; onClose: () => void; onSubmit: () => void; children: ReactNode }) {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>("input, select, textarea") ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab" || !ref.current) return;
      const inside = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = inside[0];
      const last = inside.at(-1);
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        ref={ref}
        className={wide ? "dialog wide" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {heading ?? <h2>{title}</h2>}
        {children}
      </form>
    </div>
  );
}

export function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="field-label">
      {label}
      {children}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export type Toast = { text: string; error?: boolean };

export function useToast(): [Toast | null, (t: Toast) => void] {
  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);
  return [toast, setToast];
}

export function ToastView({ toast }: { toast: Toast | null }) {
  if (!toast) return null;
  return (
    <div className={`toast${toast.error ? " error" : ""}`} role={toast.error ? "alert" : "status"} aria-live="polite">
      {toast.error ? <Icon name="alert" /> : <span className="ok"><Icon name="check" /></span>}
      {toast.text}
    </div>
  );
}
