"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export function Toggle({ checked, label, onChange, disabled }: { checked: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean }) {
  return <button type="button" className="toggle" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

/** A modal form: Escape or a click outside closes it, and Enter submits. */
export function Dialog({ title, onClose, onSubmit, children }: { title: string; onClose: () => void; onSubmit: () => void; children: ReactNode }) {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", close);
    ref.current?.querySelector<HTMLElement>("input, select")?.focus();
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        ref={ref}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <h2>{title}</h2>
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
