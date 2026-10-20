import Image from "next/image";
import { EXAMPLE_LABEL, FAQ, FEATURES, FOOTER, FORM, HERO, LABELS, NEVER, RECORDS, STEPS, DOCS, SUPERLOGICAL } from "../../_v2/copy";
import { SCREENS } from "../../_v2/day";
import { Cover } from "../_beam/Cover";
import { FaqItem } from "../_beam/Faq";
import { HeroWindow } from "../_beam/HeroWindow";
import { Check, XMark } from "../_beam/icons";
import { Nav } from "../_beam/Nav";
import { RevealObserver } from "../_beam/Reveal";
import { SearchWindow } from "../_beam/SearchWindow";
import { WaitlistForm } from "../_beam/WaitlistForm";

const split = HERO.title.lastIndexOf(", ");
const TITLE_LEAD = HERO.title.slice(0, split + 1);
const TITLE_COVER = HERO.title.slice(split + 2);

const CARD_SIZES = "(min-width: 1024px) 740px, (min-width: 768px) 920px, 120vw";

type Card = { title: string; body: string; shot: React.ReactNode; example?: boolean; wide?: boolean; delay: number };

const CARDS: Card[] = [
  {
    title: FEATURES.hours.title,
    body: FEATURES.hours.body,
    example: true,
    delay: 0,
    shot: <Image src={SCREENS.today.src} alt={SCREENS.today.alt} width={SCREENS.today.w} height={SCREENS.today.h} sizes={CARD_SIZES} className="b-shot-img" />,
  },
  { title: FEATURES.search.title, body: FEATURES.search.body, delay: 90, shot: <SearchWindow /> },
  {
    title: FEATURES.ask.title,
    body: FEATURES.ask.body,
    example: true,
    wide: true,
    delay: 180,
    shot: <Image src={SCREENS.ask.src} alt={SCREENS.ask.alt} width={SCREENS.ask.w} height={SCREENS.ask.h} sizes={CARD_SIZES} className="b-shot-img" />,
  },
  {
    title: FEATURES.assistants.title,
    body: `${FEATURES.assistants.body} ${FEATURES.assistants.note}`,
    wide: true,
    delay: 270,
    shot: (
      <Image
        src={SCREENS.assistants.src}
        alt={SCREENS.assistants.alt}
        width={SCREENS.assistants.w}
        height={SCREENS.assistants.h}
        sizes={CARD_SIZES}
        className="b-shot-img"
      />
    ),
  },
];

const assistantsFaq = FAQ.findIndex((f) => f.q === "What can connected assistants do?");

const REASONS = [
  { title: FEATURES.time.title, body: FEATURES.time.body },
  { title: FEATURES.ai.title, body: FEATURES.ai.body },
  { title: FEATURES.privacy.title, body: FEATURES.privacy.short },
  { title: FEATURES.fix.title, body: FEATURES.fix.body },
  { title: "Keep apps out.", body: FEATURES.privacy.keepOut },
  { title: FAQ[assistantsFaq].q, body: FAQ[assistantsFaq].a },
];

const FAQS = FAQ.filter((_, i) => i !== assistantsFaq);

export default function Page() {
  return (
    <>
      <Nav />
      <main className="b-main">
        <section className="b-hero" id="hero">
          <div className="b-container b-hero-inner">
            <div className="b-hero-copy">
              <p className="b-eyebrow b-rise" style={{ "--i": 0 } as React.CSSProperties}>
                {HERO.eyebrow}
              </p>
              <h1 className="b-h1 b-rise" style={{ "--i": 1 } as React.CSSProperties}>
                {TITLE_LEAD} <Cover>{TITLE_COVER}</Cover>
              </h1>
              <p className="b-hero-sub b-rise" style={{ "--i": 2 } as React.CSSProperties}>
                {HERO.sub}
              </p>
              <div className="b-rise b-hero-form" style={{ "--i": 3 } as React.CSSProperties}>
                <WaitlistForm />
              </div>
            </div>
            <div className="b-hero-media b-rise-media">
              <div className="b-hero-frame">
                <p className="b-example">{EXAMPLE_LABEL}</p>
                <HeroWindow />
              </div>
            </div>
          </div>
        </section>

        <section className="b-section b-gray" id="features">
          <div className="b-container b-stack">
            <div className="b-head">
              <h2 className="b-h2">{STEPS[1].title}.</h2>
              <p className="b-lead">{DOCS.sub}</p>
            </div>
            <div className="b-features">
              {CARDS.map((c) => (
                <div key={c.title} data-reveal="" className={c.wide ? "b-reveal b-wide" : "b-reveal"} style={{ "--d": `${c.delay}ms` } as React.CSSProperties}>
                  <article className="b-card">
                    <div className="b-card-text">
                      <h3 className="b-h3">{c.title}</h3>
                      <p className="b-card-p">{c.body}</p>
                    </div>
                    <div className="b-shot">
                      {c.shot}
                      {c.example ? <span className="b-shot-label">{EXAMPLE_LABEL}</span> : null}
                    </div>
                  </article>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="b-section b-gray" id="more">
          <div className="b-container b-stack">
            <div className="b-head b-head-center">
              <h2 className="b-h2">More in Daylens.</h2>
              <p className="b-lead">{HERO.subShort}</p>
            </div>
            <div className="b-reasons">
              {REASONS.map((r, i) => (
                <div key={r.title} data-reveal="" className="b-reveal" style={{ "--d": `${i * 70}ms` } as React.CSSProperties}>
                  <article className="b-reason">
                    <p>
                      <strong>{r.title}</strong> {r.body}
                    </p>
                  </article>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="b-section b-white" id="privacy">
          <div className="b-container b-stack">
            <div className="b-head">
              <h2 className="b-h2">{SUPERLOGICAL.recordsTitle}</h2>
              <p className="b-lead">{FEATURES.privacy.body}</p>
            </div>
            <div className="b-plans">
              <div className="b-plan">
                <div className="b-plan-top">
                  <h3 className="b-plan-name">{LABELS.records}</h3>
                  <p className="b-plan-sub">{SUPERLOGICAL.recordsIntro}</p>
                  <ul className="b-plan-list">
                    {RECORDS.map((r) => (
                      <li key={r}>
                        <Check className="b-plan-mark" />
                        <p>{r}</p>
                      </li>
                    ))}
                  </ul>
                </div>
                <a href="#hero" data-join="" className="b-btn b-btn-soft b-btn-lg">
                  {FORM.buttonShort}
                </a>
              </div>
              <div className="b-plan">
                <div className="b-plan-top">
                  <h3 className="b-plan-name">{LABELS.never}</h3>
                  <p className="b-plan-sub">{SUPERLOGICAL.neverTitle}</p>
                  <ul className="b-plan-list">
                    {NEVER.map((r) => (
                      <li key={r}>
                        <XMark className="b-plan-mark" />
                        <p>{r}</p>
                      </li>
                    ))}
                  </ul>
                  <p className="b-plan-foot">{FEATURES.privacy.keepOut}</p>
                </div>
                <a href="#hero" data-join="" className="b-btn b-btn-dark b-btn-lg">
                  {FORM.buttonShort}
                </a>
              </div>
            </div>
          </div>
        </section>

        <section className="b-section b-white" id="faqs">
          <div className="b-container b-faq-grid">
            <div>
              <h2 className="b-h2">{LABELS.faqTitle}</h2>
            </div>
            <div className="b-faq-list">
              {FAQS.map((f, i) => (
                <FaqItem key={f.q} id={`faq-${i + 1}`} q={f.q} a={f.a} />
              ))}
            </div>
          </div>
        </section>
      </main>
      <footer className="b-footer">
        <div className="b-footer-band">
          <div className="b-container b-footer-inner">
            <nav aria-label="Footer">
              <ul className="b-footer-links">
                <li>
                  <a href="#features">{LABELS.features}</a>
                </li>
                <li>
                  <a href="#privacy">{LABELS.privacy}</a>
                </li>
                <li>
                  <a href="#faqs">{LABELS.faq}</a>
                </li>
              </ul>
            </nav>
            <div className="b-copy">{FOOTER.copyright}</div>
          </div>
        </div>
      </footer>
      <RevealObserver />
    </>
  );
}
