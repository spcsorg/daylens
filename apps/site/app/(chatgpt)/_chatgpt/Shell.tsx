"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { DOCS, FORM, LABELS } from "../../_v2/copy";
import { MenuIcon, MoonIcon, SunIcon } from "./icons";

const OFFSET = 110;
const CLICK_LOCK_MS = 700;
const SECTIONS = DOCS.sections.map((s) => ({ id: s.id, title: s.title }));

const TABS = [
  { label: LABELS.features, target: "how-daylens-helps", ids: ["how-daylens-helps", "search-and-ask"] },
  { label: LABELS.how, target: "how-daylens-works", ids: ["how-daylens-works"] },
  { label: LABELS.privacy, target: "what-is-recorded", ids: ["what-is-recorded", "control-what-is-included"] },
  { label: LABELS.assistants, target: "connect-assistants", ids: ["connect-assistants", "choose-the-ai"] },
];

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function activeFrom(headings: HTMLElement[]) {
  let id = "";
  for (const h of headings) {
    if (!h.getClientRects().length) continue;
    id ||= h.id;
    if (h.getBoundingClientRect().top <= OFFSET + 1) id = h.id;
  }
  return id;
}

export function Shell({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(SECTIONS[0].id);
  const [drawer, setDrawer] = useState(false);
  const lockUntil = useRef(0);
  const tocList = useRef<HTMLUListElement>(null);
  const tocBar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const headings = SECTIONS.map((s) => document.getElementById(s.id)).filter((h): h is HTMLElement => !!h);
    let frame = 0;
    const update = () => {
      if (performance.now() < lockUntil.current) return;
      setActive(activeFrom(headings) || SECTIONS[0].id);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    const hash = location.hash.slice(1);
    if (hash && headings.some((h) => h.id === hash)) setActive(hash);
    else update();
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  useLayoutEffect(() => {
    const list = tocList.current;
    const bar = tocBar.current;
    if (!list || !bar) return;
    const place = () => {
      const li = list.querySelector<HTMLLIElement>(`li[data-id="${active}"]`);
      if (!li) return;
      bar.style.transform = `translateY(${li.offsetTop}px)`;
      bar.style.height = `${li.offsetHeight}px`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(list);
    return () => ro.disconnect();
  }, [active]);

  useEffect(() => {
    document.body.style.overflow = drawer ? "hidden" : "";
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  useEffect(() => {
    const onClick = (e: globalThis.MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-anchor-id]");
      if (!btn) return;
      const id = btn.dataset.anchorId!;
      history.replaceState(null, "", `#${id}`);
      navigator.clipboard?.writeText(`${location.origin}${location.pathname}#${id}`).catch(() => {});
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const go = useCallback((e: MouseEvent, id: string) => {
    e.preventDefault();
    lockUntil.current = performance.now() + CLICK_LOCK_MS;
    setActive(id);
    setDrawer(false);
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
    });
    history.replaceState(null, "", `#${id}`);
  }, []);

  const join = useCallback(() => {
    setDrawer(false);
    requestAnimationFrame(() => {
      const target = document.getElementById("waitlist-email") ?? document.getElementById("waitlist");
      target?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    });
  }, []);

  const toggleTheme = useCallback(() => {
    const root = document.documentElement;
    const dark = !root.classList.contains("dark");
    root.classList.toggle("dark", dark);
    root.dataset.theme = dark ? "dark" : "light";
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {}
  }, []);

  const tabActive = TABS.find((t) => t.ids.includes(active))?.label;

  return (
    <>
      <header className="cg-header">
        <div className="cg-header-row">
          <a href="#" className="cg-logo" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" }); }}>
            <Image src="/icons/daylens.svg" alt="" width={24} height={24} unoptimized priority />
            <span>Daylens</span>
          </a>
          <div className="cg-header-actions">
            <button type="button" className="cg-btn cg-header-cta" onClick={join}>
              <span className="cg-btn-inner">{FORM.button}</span>
            </button>
            <button type="button" className="cg-theme" onClick={toggleTheme} aria-label="Dark theme">
              <SunIcon className="cg-sun" />
              <MoonIcon className="cg-moon" />
            </button>
            <button
              type="button"
              className="cg-menu"
              aria-label="Menu"
              aria-controls="cg-drawer"
              aria-expanded={drawer}
              onClick={() => setDrawer((d) => !d)}
            >
              <MenuIcon />
            </button>
          </div>
        </div>
      </header>

      <div className="cg-subnav">
        <nav className="cg-tabs" aria-label={DOCS.title}>
          {TABS.map((t) => (
            <a key={t.label} href={`#${t.target}`} className="cg-tab" aria-current={tabActive === t.label ? "true" : undefined} onClick={(e) => go(e, t.target)}>
              <span>{t.label}</span>
              <span className="cg-tab-ind" hidden={tabActive !== t.label} aria-hidden="true" />
            </a>
          ))}
        </nav>
      </div>

      <div id="cg-drawer" className="cg-drawer" data-open={drawer} inert={!drawer}>
        <div className="cg-drawer-top">
          <nav className="cg-pills" aria-label={DOCS.title}>
            {TABS.map((t) => (
              <a key={t.label} href={`#${t.target}`} className="cg-pill" data-selected={tabActive === t.label} onClick={(e) => go(e, t.target)}>
                {t.label}
              </a>
            ))}
          </nav>
          <button type="button" className="cg-theme-round" onClick={toggleTheme} aria-label="Dark theme">
            <SunIcon className="cg-sun" />
            <MoonIcon className="cg-moon" />
          </button>
        </div>
        <nav className="cg-drawer-nav" aria-label="Sections">
          <h3>{DOCS.title}</h3>
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} aria-current={active === s.id ? "location" : undefined} onClick={(e) => go(e, s.id)}>
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="cg-drawer-foot">
          <button type="button" className="cg-btn cg-btn-block" onClick={join}>
            <span className="cg-btn-inner">{FORM.button}</span>
          </button>
        </div>
      </div>

      <div className="cg-page">
        <aside className="cg-left">
          <nav className="cg-left-nav" aria-label="Sections">
            <div className="cg-left-group">
              <h3>{DOCS.title}</h3>
              <ul>
                {SECTIONS.map((s) => (
                  <li key={s.id}>
                    <a href={`#${s.id}`} aria-current={active === s.id ? "location" : undefined} onClick={(e) => go(e, s.id)}>
                      <span>{s.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        </aside>

        <main className="cg-main">
          <div className="cg-container">
            <div className="cg-grid">
              <div className="cg-col">{children}</div>
              <div className="cg-toc-wrap">
                <nav className="cg-toc" aria-label="On this page">
                  <div className="cg-toc-inner">
                    <div className="cg-toc-rail" />
                    <div className="cg-toc-bar" ref={tocBar} style={{ transform: "translateY(0)", height: 0 }} />
                    <ul ref={tocList}>
                      {SECTIONS.map((s) => (
                        <li key={s.id} data-id={s.id}>
                          <a href={`#${s.id}`} data-active={active === s.id} onClick={(e) => go(e, s.id)}>
                            {s.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                </nav>
              </div>
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
