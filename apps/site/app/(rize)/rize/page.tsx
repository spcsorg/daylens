import type { CSSProperties } from "react";
import Image from "next/image";
import { Geist } from "next/font/google";
import {
  ASSISTANT_NAMES,
  AUDIENCES,
  CONTROLS,
  EXAMPLE_LABEL,
  EXAMPLE_NOTE,
  FEATURES,
  FOOTER,
  FORM,
  HERO,
  LABELS,
  NEVER,
  PROBLEMS,
  RECORDS,
  STEPS,
} from "../../_v2/copy";
import { ICONS, SCREENS, SEARCH } from "../../_v2/day";
import { Faq } from "../_rize/Faq";
import { Nav } from "../_rize/Nav";
import { NAV_LINKS } from "../_rize/links";
import { WaitlistForm } from "../_rize/WaitlistForm";

const geist = Geist({ subsets: ["latin"], weight: ["400", "500"], display: "swap", preload: false });

const d = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;
const crop = (w: number, ml: number, mt: number) => ({ "--w": `${w}%`, "--ml": `${ml}%`, "--mt": `${mt}%` }) as CSSProperties;

const sentences = (text: string) => text.match(/[^.]+\./g)?.map((s) => s.trim()) ?? [text];

const FACTS = [FEATURES.time.short, FEATURES.privacy.short, FEATURES.ai.short];

const PRIVACY_COLS = [
  { title: LABELS.records, items: RECORDS },
  { title: LABELS.never, items: NEVER },
  { title: LABELS.controls, items: CONTROLS },
];

const TILES = [
  { name: ASSISTANT_NAMES[0], icon: ICONS.claude, x: 22, y: 30 },
  { name: ASSISTANT_NAMES[1], icon: ICONS.codex, x: 22, y: 66 },
  { name: ASSISTANT_NAMES[2], icon: ICONS.cursor, x: 78, y: 30 },
  { name: ASSISTANT_NAMES[3], icon: null, x: 78, y: 66 },
];

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="rz-s-icon">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="rz-s-open">
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

export default function Page() {
  return (
    <div id="top" className="rz">
      <Nav />
      <main>
        <section className="rz-hero">
          <div className="rz-hero-frame" aria-hidden="true" />
          <div className="rz-hero-inner">
            <div className="rz-in" style={d(40)}>
              <h1 className="rz-h1">{HERO.titleLong}</h1>
            </div>
            <div className="rz-in" style={d(240)}>
              <p className="rz-hero-sub">{HERO.sub}</p>
            </div>
            <div className="rz-in rz-hero-form" style={d(340)}>
              <WaitlistForm variant="hero" inputId="rz-email-hero" />
            </div>
            <div className="rz-in rz-hero-shot" style={d(40)}>
              <Image
                src={SCREENS.today.src}
                width={SCREENS.today.w}
                height={SCREENS.today.h}
                alt={SCREENS.today.alt}
                sizes="(min-width: 1200px) 1100px, calc(100vw - 48px)"
                quality={80}
                priority
              />
            </div>
            <p className="rz-note">{EXAMPLE_NOTE}</p>
          </div>
        </section>

        <div className="rz-wrap">
          <section className="rz-facts">
            <div className="rz-facts-grid">
              {FACTS.map((f) => (
                <p key={f}>{f}</p>
              ))}
            </div>
          </section>

          <section id="join" className="rz-join">
            <div className="rz-join-in">
              <h2 className="rz-h2">{FORM.closingTitle}</h2>
              <p className="rz-join-sub">{HERO.tagline}</p>
              <WaitlistForm variant="block" inputId="rz-email-join" />
            </div>
          </section>

          <section className="rz-problems">
            <div className="rz-in-6xl">
              <div className="rz-head">
                <h2 className="rz-h2">Why Daylens</h2>
              </div>
              <div className="rz-cols">
                {PROBLEMS.map((p) => (
                  <div key={p.title} className="rz-col">
                    <h3 className="rz-col-h">{p.title}</h3>
                    <p className="rz-col-p">{p.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="rz-aud">
            <div className="rz-in-6xl">
              <div className="rz-in" style={d(40)}>
                <h2 className="rz-h2 rz-aud-h2">Who it&apos;s for</h2>
              </div>
              <div className="rz-aud-grid">
                {AUDIENCES.map((a, i) => (
                  <div key={a.title} className="rz-in" style={d(40 + i * 40)}>
                    <div className="rz-aud-card">
                      <h3 className="rz-aud-h">{a.title}</h3>
                      <ul className="rz-aud-ul">
                        {sentences(a.body).map((s) => (
                          <li key={s}>
                            <span aria-hidden="true">•</span>
                            {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section id="how" className="rz-how">
            <div className="rz-head rz-head--how">
              <p className="rz-eyebrow">{LABELS.how}</p>
              <h2 className="rz-h2">{HERO.title}</h2>
              <p className="rz-how-sub">{HERO.subShort}</p>
            </div>
            <div className="rz-how-grid">
              <div className="rz-how-shot">
                <div className="rz-pane rz-pane--how">
                  <Image
                    src={SCREENS.morning.src}
                    width={SCREENS.morning.w}
                    height={SCREENS.morning.h}
                    alt={SCREENS.morning.alt}
                    sizes="(min-width: 768px) 60vw, 150vw"
                    quality={80}
                    className="rz-crop"
                    style={crop(115, -22.8, -15.2)}
                  />
                </div>
                <p className="rz-shot-label">{EXAMPLE_LABEL}</p>
              </div>
              <div className="rz-steps">
                {STEPS.map((s) => (
                  <div key={s.title} className="rz-step">
                    <h3 className="rz-step-h">{s.title}</h3>
                    <p className="rz-step-p">{s.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section id="features" className="rz-feat">
            <div className="rz-head">
              <p className="rz-eyebrow rz-eyebrow--3">{LABELS.features}</p>
              <h2 className="rz-h2">{FEATURES.hours.title}</h2>
              <p className="rz-feat-sub">{FEATURES.hours.body}</p>
            </div>
            <div className="rz-grid">
              <div className="rz-row">
                <div className="rz-card">
                  <div className="rz-card-text">
                    <h3 className="rz-card-h">{FEATURES.ask.title}</h3>
                    <p className="rz-card-p">{FEATURES.ask.body}</p>
                  </div>
                  <div className="rz-card-shot">
                    <div className="rz-pane rz-pane--window">
                      <Image
                        src={SCREENS.ask.src}
                        width={SCREENS.ask.w}
                        height={SCREENS.ask.h}
                        alt={SCREENS.ask.alt}
                        sizes="(min-width: 768px) 60vw, 110vw"
                        quality={80}
                      />
                    </div>
                  </div>
                </div>
                <div className="rz-card">
                  <div className="rz-card-text">
                    <h3 className="rz-card-h">{FEATURES.search.title}</h3>
                    <p className="rz-card-p">{FEATURES.search.body}</p>
                  </div>
                  <div className="rz-card-shot">
                    <div className={`rz-pane rz-pane--app ${geist.className}`}>
                      <div className="rz-s-box" role="img" aria-label={SCREENS.find.alt}>
                        <div className="rz-s-q">
                          <SearchIcon />
                          <span>{SEARCH.query}</span>
                        </div>
                        <div className="rz-s-r">
                          <Image src={SEARCH.result.icon} alt="" width={28} height={28} unoptimized />
                          <div className="rz-s-t">
                            <span className="rz-s-name">{SEARCH.result.name}</span>
                            <span className="rz-s-meta">{SEARCH.result.meta}</span>
                          </div>
                          <OpenIcon />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="rz-row rz-row--b">
                <div className="rz-card">
                  <div className="rz-card-text">
                    <h3 className="rz-card-h">{FEATURES.fix.title}</h3>
                    <p className="rz-card-p">{FEATURES.fix.body}</p>
                  </div>
                  <div className="rz-card-shot">
                    <div className="rz-pane rz-pane--app">
                      <Image
                        src={SCREENS.today.src}
                        width={SCREENS.today.w}
                        height={SCREENS.today.h}
                        alt={SCREENS.today.alt}
                        sizes="(min-width: 768px) 55vw, 140vw"
                        quality={80}
                        className="rz-crop"
                        style={crop(134.4, -30.5, -6.6)}
                      />
                    </div>
                  </div>
                </div>
                <div className="rz-card">
                  <div className="rz-card-text">
                    <h3 className="rz-card-h">{FEATURES.assistants.short}</h3>
                    <p className="rz-card-p">{FEATURES.assistants.note}</p>
                  </div>
                  <div className="rz-card-shot">
                    <div className="rz-pane rz-pane--app">
                      <Image
                        src={SCREENS.assistants.src}
                        width={SCREENS.assistants.w}
                        height={SCREENS.assistants.h}
                        alt={SCREENS.assistants.alt}
                        sizes="(min-width: 768px) 90vw, 170vw"
                        quality={80}
                        className="rz-crop"
                        style={crop(167.5, -34.3, -8.2)}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <p className="rz-grid-note">{EXAMPLE_NOTE}</p>
          </section>

          <section id="privacy" className="rz-priv">
            <div className="rz-in-6xl">
              <div className="rz-priv-head">
                <p className="rz-eyebrow rz-eyebrow--light">{LABELS.privacy}</p>
                <h2 className="rz-priv-h2">{FEATURES.privacy.title}</h2>
              </div>
              <div className="rz-priv-cols">
                {PRIVACY_COLS.map((c) => (
                  <div key={c.title} className="rz-priv-col">
                    <h3 className="rz-priv-h3">{c.title}</h3>
                    <ul className="rz-priv-ul">
                      {c.items.map((it) => (
                        <li key={it}>{it}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <p className="rz-priv-note">{FEATURES.privacy.body}</p>
              <div className="rz-pills">
                {[NAV_LINKS[0], { href: "#assistants", label: LABELS.assistants }, NAV_LINKS[3]].map((l) => (
                  <a key={l.href} className="rz-pill" href={l.href}>
                    {l.label}
                  </a>
                ))}
              </div>
            </div>
          </section>

          <section id="assistants" className="rz-int">
            <div className="rz-in-6xl rz-int-head">
              <p className="rz-eyebrow rz-eyebrow--3">{LABELS.assistants}</p>
              <h2 className="rz-h2">{FEATURES.assistants.title}</h2>
              <p className="rz-int-p">{FEATURES.assistants.body}</p>
              <ul className="rz-chips" aria-label={LABELS.assistants}>
                {ASSISTANT_NAMES.map((n) => (
                  <li key={n} className="rz-chip">
                    {n}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rz-int-box" aria-hidden="true">
              <svg className="rz-int-lines">
                <defs>
                  <marker id="rz-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0 0 10 5 0 10z" />
                  </marker>
                </defs>
                {TILES.map((t) => {
                  const left = t.x < 50;
                  return (
                    <line
                      key={t.name}
                      x1={`${left ? 42 : 58}%`}
                      y1={`${t.y < 50 ? 44 : 56}%`}
                      x2={`${left ? t.x + 8.5 : t.x - 8.5}%`}
                      y2={`${t.y}%`}
                      markerEnd="url(#rz-arrow)"
                    />
                  );
                })}
              </svg>
              <div className="rz-tile rz-tile--main" style={{ left: "50%", top: "50%" }}>
                <Image src="/icons/daylens.svg" alt="" width={64} height={64} unoptimized />
                <span className="rz-tile-name">Daylens</span>
              </div>
              {TILES.map((t) => (
                <div key={t.name} className={`rz-tile${t.icon ? "" : " rz-tile--any"}`} style={{ left: `${t.x}%`, top: `${t.y}%` }}>
                  {t.icon ? <Image src={t.icon} alt="" width={40} height={40} unoptimized /> : null}
                  <span className="rz-tile-name">{t.name}</span>
                </div>
              ))}
            </div>
          </section>

          <section id="faq" className="rz-faq">
            <div className="rz-faq-in">
              <div className="rz-in" style={d(40)}>
                <h2 className="rz-h2 rz-faq-h2">{LABELS.faqTitle}</h2>
              </div>
              <div className="rz-in" style={d(140)}>
                <Faq />
              </div>
            </div>
          </section>

          <section className="rz-cta">
            <div className="rz-cta-in">
              <h2 className="rz-h2 rz-cta-h2">{FORM.closingTitleAlt}</h2>
              <p className="rz-cta-p">{HERO.eyebrow}</p>
              <WaitlistForm variant="cta" inputId="rz-email-cta" />
            </div>
            <div className="rz-collage" aria-hidden="true">
              <div className="rz-collage-plane">
                {[SCREENS.ask, SCREENS.today, SCREENS.assistants].map((s) => (
                  <Image key={s.src} src={s.src} width={s.w} height={s.h} alt="" sizes="(min-width: 768px) 40vw, 50vw" quality={80} />
                ))}
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="rz-foot">
        <nav className="rz-foot-nav" aria-label="Footer">
          <div className="rz-foot-grid">
            <div className="rz-foot-brand">
              <a className="rz-wordmark" href="#top">
                Daylens
              </a>
            </div>
            <ul className="rz-foot-ul">
              {[...NAV_LINKS, { href: "#assistants", label: LABELS.assistants }, { href: "#join", label: LABELS.join }].map((l) => (
                <li key={l.href}>
                  <a href={l.href}>{l.label}</a>
                </li>
              ))}
            </ul>
          </div>
        </nav>
        <div className="rz-foot-bot">
          <p>{FOOTER.copyright}</p>
        </div>
      </footer>
    </div>
  );
}
