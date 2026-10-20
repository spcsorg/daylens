"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { FORM } from "../../_v2/copy";
import { NAV_LINKS } from "./links";

function focusJoin(event: MouseEvent<HTMLAnchorElement>) {
  const input = document.querySelector<HTMLInputElement>("#join input[name=email]");
  if (!input) return;
  event.preventDefault();
  document.getElementById("join")?.scrollIntoView({ block: "center" });
  input.focus({ preventScroll: true });
  history.replaceState(null, "", "#join");
}

export function Nav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <nav className="rz-nav" aria-label="Main">
        <div className="rz-nav-in">
          <div className="rz-nav-row">
            <a className="rz-wordmark" href="#top" onClick={() => setOpen(false)}>
              Daylens
            </a>
            <div className="rz-nav-links">
              {NAV_LINKS.map((l) => (
                <a key={l.href} className="rz-nav-link" href={l.href}>
                  {l.label}
                </a>
              ))}
            </div>
            <div className="rz-nav-right">
              <a className="rz-nav-cta rz-nav-cta--wide" href="#join" onClick={focusJoin}>
                {FORM.button}
              </a>
              <a
                className="rz-nav-cta rz-nav-cta--narrow"
                href="#join"
                onClick={(e) => {
                  setOpen(false);
                  focusJoin(e);
                }}
              >
                {FORM.buttonShort}
              </a>
              <button
                type="button"
                className={`rz-burger${open ? " is-open" : ""}`}
                aria-label="Toggle menu"
                aria-expanded={open}
                aria-controls="rz-menu"
                onClick={() => setOpen((o) => !o)}
              >
                <span />
                <span />
                <span />
              </button>
            </div>
          </div>
        </div>
      </nav>
      <div id="rz-menu" className={`rz-menu${open ? " is-open" : ""}`} inert={!open}>
        <div className="rz-menu-in">
          {NAV_LINKS.map((l) => (
            <a key={l.href} className="rz-menu-link" href={l.href} onClick={() => setOpen(false)}>
              {l.label}
            </a>
          ))}
        </div>
      </div>
    </>
  );
}
