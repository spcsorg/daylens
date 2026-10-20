"use client";

import { useEffect, useRef, useState } from "react";
import { FORM, LABELS } from "../../_v2/copy";
import { Close, Menu, Moon, Sun } from "./icons";

const LINKS = [
  { href: "#features", label: LABELS.features },
  { href: "#privacy", label: LABELS.privacy },
];

export function focusForm() {
  const input = document.querySelector<HTMLInputElement>("#hero input[name=email]");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  input?.focus({ preventScroll: true });
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const set = (d: boolean) => {
    document.documentElement.classList.toggle("dark", d);
    try {
      localStorage.setItem("daylens-beam-theme", d ? "dark" : "light");
    } catch {}
    setDark(d);
  };
  return (
    <div className="b-switch" role="group" aria-label="Theme">
      <span className="b-switch-thumb" aria-hidden="true" />
      <button type="button" aria-pressed={!dark} aria-label="Light mode" onClick={() => set(false)}>
        <Sun className="b-switch-icon" />
      </button>
      <button type="button" aria-pressed={dark} aria-label="Dark mode" onClick={() => set(true)}>
        <Moon className="b-switch-icon" />
      </button>
    </div>
  );
}

export function Nav() {
  const menu = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.("a[data-join]");
      if (!a) return;
      e.preventDefault();
      focusForm();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return (
    <header className="b-header">
      <nav className="b-nav">
        <div className="b-nav-left">
          <a href="#hero" className="b-logo" aria-label="Daylens">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icons/daylens.svg" alt="" width={32} height={32} />
          </a>
          <div className="b-nav-links">
            {LINKS.map((l) => (
              <a key={l.href} href={l.href} className="b-nav-link">
                {l.label}
              </a>
            ))}
          </div>
        </div>
        <div className="b-nav-right">
          <div className="b-nav-actions">
            <ThemeToggle />
            <a href="#hero" data-join="" className="b-btn b-btn-dark b-nav-cta">
              {FORM.buttonShort}
            </a>
          </div>
          <button type="button" className="b-menu-btn" aria-label="Open menu" onClick={() => menu.current?.showModal()}>
            <Menu className="b-menu-icon" />
          </button>
        </div>
      </nav>
      <dialog ref={menu} className="b-menu" aria-label="Menu">
        <div className="b-menu-top">
          <button type="button" className="b-menu-btn" aria-label="Close menu" onClick={() => menu.current?.close()}>
            <Close className="b-menu-icon" />
          </button>
        </div>
        <div className="b-menu-links">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="b-menu-link" onClick={() => menu.current?.close()}>
              {l.label}
              <span aria-hidden="true" className="b-menu-arrow">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="m9 5 7 7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </a>
          ))}
        </div>
      </dialog>
    </header>
  );
}
