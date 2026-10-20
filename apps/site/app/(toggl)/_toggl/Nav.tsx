"use client";

import { useEffect, useState } from "react";
import { LABELS } from "../../_v2/copy";

const LINKS = [
  { href: "#how", label: LABELS.how },
  { href: "#features", label: LABELS.features },
  { href: "#privacy", label: LABELS.privacy },
];

export function focusHeroForm() {
  const input = document.getElementById("hero-email") as HTMLInputElement | null;
  if (!input) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  input.focus({ preventScroll: true });
}

export function Nav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const join = () => {
    setOpen(false);
    focusHeroForm();
  };

  return (
    <header className={`t-nav${open ? " is-open" : ""}`}>
      <div className="t-nav_inner">
        <div className="t-nav_left">
          <a className="t-wordmark" href="#top">
            Daylens
          </a>
          <nav className="t-nav_links" aria-label="Sections">
            {LINKS.map((l) => (
              <a key={l.href} className="t-nav_link" href={l.href}>
                <span>{l.label}</span>
              </a>
            ))}
          </nav>
          <button
            className="t-nav_burger"
            type="button"
            aria-expanded={open}
            aria-controls="t-nav-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
        <div className="t-nav_right">
          <button className="t-btn t-btn--dark" type="button" onClick={join}>
            <span className="t-btn_label">{LABELS.join}</span>
          </button>
        </div>
      </div>
      <div className="t-nav_menu" id="t-nav-menu" hidden={!open}>
        {LINKS.map((l) => (
          <a key={l.href} className="t-nav_menu-link" href={l.href} onClick={() => setOpen(false)}>
            {l.label}
          </a>
        ))}
        <button className="t-btn t-btn--dark" type="button" onClick={join}>
          <span className="t-btn_label">{LABELS.join}</span>
        </button>
      </div>
    </header>
  );
}
