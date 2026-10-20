"use client";

import { useEffect, useState } from "react";

export function Nav() {
  const [hidden, setHidden] = useState(false);
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    let last = window.scrollY;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        setSolid(y > 8);
        setHidden(y > 240 && y > last + 2);
        if (y < last - 2) setHidden(false);
        last = y;
        ticking = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="nav intro" data-hidden={hidden} data-solid={solid} style={{ ["--d" as string]: "0ms" }}>
      <div className="wrap nav-inner">
        <a className="wordmark" href="#top" aria-label="Daylens, back to top">
          <img src="/icons/daylens.png" alt="" width={26} height={26} />
          Daylens
        </a>
        <nav className="nav-links" aria-label="Page">
          <a className="link" href="#hours">
            How it works
          </a>
          <a className="link" href="#privacy">
            Privacy
          </a>
          <a className="link" href="#faq">
            Questions
          </a>
          <a
            className="btn btn-primary btn-sm"
            href="#join"
            onClick={(e) => {
              const input = document.getElementById("hero-email") as HTMLInputElement | null;
              if (!input) return;
              e.preventDefault();
              input.scrollIntoView({ behavior: "smooth", block: "center" });
              window.setTimeout(() => input.focus({ preventScroll: true }), 450);
            }}
          >
            Join the waitlist
          </a>
        </nav>
      </div>
    </header>
  );
}
