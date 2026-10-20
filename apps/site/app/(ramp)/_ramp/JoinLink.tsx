"use client";

import type { MouseEvent, ReactNode } from "react";

export default function JoinLink({ className, children }: { className?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    const input = document.getElementById("rp-email");
    if (!input) return;
    e.preventDefault();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    input.focus({ preventScroll: true });
  };
  return (
    <a href="#join" className={className} onClick={onClick}>
      {children}
    </a>
  );
}
